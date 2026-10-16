import "server-only";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { requireDatabase } from "./db";
import { addresses, bobgoOrderSync, courierSettings, orderDeliveryHistory, orders, orderStatusHistory, shipments } from "./db/schema";
import { deliveryEditBlocker, deliveryEditInput } from "./delivery-input";
import { resolveCourierPlan } from "./integrations/bobgo/delivery";

export class DeliveryEditConflict extends Error {}

export async function saveOrderDelivery(orderNumber: string, value: unknown, changedBy: string) {
  const input = deliveryEditInput.parse(value);
  // Lookups only: no rate request, shipment, cancellation, email or payment.
  const resolved = input.action === "delivery" ? await resolveCourierPlan(input.plan) : null;
  return requireDatabase().transaction(async tx => {
    const [order] = await tx.select().from(orders).where(eq(orders.orderNumber, orderNumber)).for("update");
    if (!order || order.archivedAt) throw new DeliveryEditConflict("Order not found.");
    if (order.deliveryRevision !== input.expectedRevision) throw new DeliveryEditConflict("This order was edited elsewhere. Refresh it before saving your changes.");
    const [shipment] = await tx.select().from(shipments).where(eq(shipments.orderId, order.id)).for("update");
    const revision = order.deliveryRevision + 1;
    if (input.action === "private_note") {
      if ((order.privateNote || "") === input.note) return { revision: order.deliveryRevision, message: "Private note is already saved. It is not sent to Bob Go or the customer." };
      await tx.update(orders).set({ privateNote: input.note, deliveryRevision: revision, updatedAt: new Date() }).where(eq(orders.id, order.id));
      await tx.insert(orderDeliveryHistory).values({ orderId: order.id, revision, action: input.action,
        before: { privateNote: order.privateNote || "" }, after: { privateNote: input.note }, changedBy });
      return { revision, message: "Private note saved. It is not sent to Bob Go or the customer." };
    }
    const blocker = deliveryEditBlocker(order, shipment);
    if (blocker) throw new DeliveryEditConflict(blocker);
    if (!resolved) throw new DeliveryEditConflict("Check the delivery setup before saving.");
    const delivery = resolved.delivery;
    // Insert an order-specific address rather than overwriting a shared customer's
    // address. Billing/customer/payment snapshots and every monetary value stay intact.
    const [address] = await tx.insert(addresses).values({ customerId: order.customerId,
      recipientName: delivery.contact.name, line1: delivery.address.street_address, line2: "",
      suburb: delivery.address.local_area, city: delivery.address.city, province: delivery.address.zone,
      postalCode: delivery.address.code, countryCode: "ZA" }).returning({ id: addresses.id });
    await tx.update(orders).set({ courierPlan: resolved.plan, deliveryNotes: resolved.plan.deliveryInstructions,
      deliveryAddressId: address.id, deliveryRevision: revision, updatedAt: new Date() }).where(eq(orders.id, order.id));
    // A saved courier address cannot silently amend an already-submitted Bob Go
    // order. Preserve its ID/submission guard and immediately expose the mismatch.
    await tx.update(bobgoOrderSync).set({ status: "needs_attention", lastErrorCode: "delivery_changed", updatedAt: new Date() })
      .where(and(eq(bobgoOrderSync.orderId, order.id), or(isNotNull(bobgoOrderSync.submittedAt), isNotNull(bobgoOrderSync.remoteOrderId))));
    if (shipment) await tx.update(shipments).set({ status: "not_ready", serviceLevelCode: null,
      bookingSnapshot: null, pickupPointLocationId: resolved.collection.point?.id || null,
      senderLocationName: resolved.collection.point?.name || resolved.collection.contact.name,
      lastError: null, updatedAt: new Date() }).where(eq(shipments.id, shipment.id));
    if (input.rememberCollection) await tx.insert(courierSettings).values({ id: "sender", collection: resolved.plan.collection, updatedBy: changedBy })
      .onConflictDoUpdate({ target: courierSettings.id, set: { collection: resolved.plan.collection, updatedBy: changedBy, updatedAt: new Date() } });
    await tx.insert(orderDeliveryHistory).values({ orderId: order.id, revision, action: input.action,
      before: { plan: order.courierPlan, deliveryAddressId: order.deliveryAddressId, deliveryInstructions: order.deliveryNotes },
      after: { plan: resolved.plan, deliveryAddressId: address.id, collectionRemembered: input.rememberCollection }, changedBy });
    await tx.insert(orderStatusHistory).values({ orderId: order.id, fromStatus: order.status, toStatus: order.status,
      note: "Delivery details edited before waybill booking. Previous courier quotes invalidated; payment and customer delivery fee unchanged." });
    return { revision, message: "Delivery details saved. Get a fresh courier quote before booking. The customer's order total is unchanged." };
  });
}
