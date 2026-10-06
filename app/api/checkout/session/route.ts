import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { apiJson, apiOptions } from "@/lib/api-response";
import { requireDatabase } from "@/lib/db";
import { addresses, customers, orderItems, orders } from "@/lib/db/schema";
import { readOrderCustomer } from "@/lib/checkout-safety";
import { reportFailure } from "@/lib/monitoring";

export const runtime = "nodejs";

const sessionInput = z.object({
  checkoutToken: z.string().uuid(),
  orderNumber: z.string().trim().min(6).max(80),
});

export function OPTIONS() { return apiOptions(); }

// The random checkout token is a bearer secret. An order number alone must
// never reveal a customer's details. POST keeps that secret out of URL logs.
export async function POST(request: Request) {
  const parsed = sessionInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: "This checkout session is unavailable." }, { status: 400 });
  try {
    const database = requireDatabase();
    const [order] = await database.select({
      id: orders.id, orderNumber: orders.orderNumber, paymentStatus: orders.paymentStatus,
      status: orders.status, deliveryMethod: orders.deliveryMethod, deliveryAddressId: orders.deliveryAddressId,
      subtotal: orders.subtotal, deliveryFee: orders.deliveryFee, total: orders.total,
      firstName: customers.firstName, lastName: customers.lastName, email: customers.email, phone: customers.phone,
      customerSnapshot: orders.customerSnapshot,
    }).from(orders).innerJoin(customers, eq(orders.customerId, customers.id))
      .where(and(eq(orders.checkoutToken, parsed.data.checkoutToken), eq(orders.orderNumber, parsed.data.orderNumber), isNull(orders.archivedAt))).limit(1);
    if (!order) return apiJson({ error: "This checkout session is unavailable." }, { status: 404 });
    const customer = readOrderCustomer(order.customerSnapshot, order);
    const [address] = order.deliveryAddressId && order.deliveryMethod === "courier"
      ? await database.select({ line1: addresses.line1, line2: addresses.line2, suburb: addresses.suburb,
        city: addresses.city, province: addresses.province, postalCode: addresses.postalCode }).from(addresses)
        .where(eq(addresses.id, order.deliveryAddressId)).limit(1) : [];
    const items = await database.select({ sku: orderItems.sku, quantity: orderItems.quantity,
      price: orderItems.unitPrice, name: orderItems.productName, productSnapshot: orderItems.productSnapshot })
      .from(orderItems).where(eq(orderItems.orderId, order.id));
    return apiJson({ session: {
      orderNumber: order.orderNumber, paymentStatus: order.paymentStatus, status: order.status,
      fulfilmentMethod: order.deliveryMethod === "courier" ? "delivery" : order.deliveryMethod,
      customer: { ...customer, phone: customer.phone ?? "" },
      address: address ?? null, items, subtotal: Number(order.subtotal), deliveryFee: Number(order.deliveryFee), total: Number(order.total),
    } });
  } catch (error) {
    const incident = await reportFailure(error, { operation: "checkout_recover" });
    return apiJson({ error: "We couldn't restore checkout. Please try again shortly.", errorRef: incident.reference }, { status: 503 });
  }
}
