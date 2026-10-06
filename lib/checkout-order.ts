import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { assertCheckoutEditable, CheckoutConflictError, checkoutContentSnapshot, sameCheckoutContents } from "./checkout-safety";
import type { CheckoutOrderInput } from "./checkout-input";
import { db } from "./db";
import {
  addresses,
  customers,
  orderItems,
  orders,
  orderStatusHistory,
  payments,
  shipments,
} from "./db/schema";
import { resolveCheckoutItem, type CheckoutCatalogueItem } from "./checkout-catalogue";
import { calculateShippingQuote } from "./shipping/policy";
import { resolveVerifiedPackage } from "./shipping/packages";

export { checkoutOrderSchema, type CheckoutOrderInput } from "./checkout-input";

export class CheckoutValidationError extends Error {}

type ResolvedLine = {
  product: CheckoutCatalogueItem;
  quantity: number;
  lineTotal: number;
};

function resolveLines(items: CheckoutOrderInput["items"]): ResolvedLine[] {
  const quantities = new Map<string, number>();
  for (const item of items) {
    const sku = item.sku.toUpperCase();
    quantities.set(sku, (quantities.get(sku) ?? 0) + item.quantity);
  }

  return Array.from(quantities, ([sku, quantity]) => {
    if (quantity > 10) throw new CheckoutValidationError(`The quantity for ${sku} is too high.`);
    const product = resolveCheckoutItem(sku);
    if (!product) throw new CheckoutValidationError(`The product ${sku} is not available for checkout.`);
    return { product, quantity, lineTotal: product.price * quantity };
  });
}

function makeOrderNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `MM-${date}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

export async function upsertCheckoutOrder(input: CheckoutOrderInput, database = db) {
  const lines = resolveLines(input.items);
  if (!database) throw new Error("DATABASE_URL is not configured.");
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const quote = calculateShippingQuote(subtotal, input.fulfilmentMethod);
  const { deliveryFee, total } = quote;
  const verifiedPackage = resolveVerifiedPackage(lines.map(({ product, quantity }) => ({
    sku: product.sku,
    quantity,
  })));
  const email = input.customer.email.toLowerCase();
  const deliveryMethod = input.fulfilmentMethod === "delivery"
    ? "courier"
    : input.fulfilmentMethod === "collection"
      ? "collection"
      : "to_be_confirmed";

  const result = await database.transaction(async (transaction) => {
    // Serialize even the first save for this token. Payment and return handlers
    // also lock the order row, so a verified payment cannot race an edit.
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.checkoutToken}, 0))`);
    const [existingOrder] = await transaction
      .select({ id: orders.id, orderNumber: orders.orderNumber, deliveryAddressId: orders.deliveryAddressId,
        customerId: orders.customerId, customerSnapshot: orders.customerSnapshot, status: orders.status, paymentStatus: orders.paymentStatus,
        deliveryMethod: orders.deliveryMethod, total: orders.total, archivedAt: orders.archivedAt })
      .from(orders).where(eq(orders.checkoutToken, input.checkoutToken)).for("update").limit(1);
    if (existingOrder) {
      assertCheckoutEditable(existingOrder);
      const [attempt] = await transaction.select({ id: payments.id }).from(payments).where(eq(payments.orderId, existingOrder.id)).limit(1);
      if (attempt) {
        const [savedCustomer] = await transaction.select({ firstName: customers.firstName, lastName: customers.lastName,
          email: customers.email, phone: customers.phone }).from(customers).where(eq(customers.id, existingOrder.customerId!)).limit(1);
        const [savedAddress] = existingOrder.deliveryAddressId
          ? await transaction.select().from(addresses).where(eq(addresses.id, existingOrder.deliveryAddressId)).limit(1) : [];
        const savedItems = await transaction.select({ sku: orderItems.sku, quantity: orderItems.quantity }).from(orderItems).where(eq(orderItems.orderId, existingOrder.id));
        const snapshotCustomer = existingOrder.customerSnapshot ?? savedCustomer;
        const saved = snapshotCustomer && checkoutContentSnapshot({ customer: snapshotCustomer, deliveryMethod: existingOrder.deliveryMethod,
          address: savedAddress, items: savedItems, total: existingOrder.total });
        const requested = checkoutContentSnapshot({ customer: input.customer, deliveryMethod, address: input.address,
          items: lines.map(line => ({ sku: line.product.sku, quantity: line.quantity })), total });
        if (!saved || !sameCheckoutContents(saved, requested)) {
          throw new CheckoutConflictError("Payment has already started for this order. Changed details need a new checkout.", "CHECKOUT_CHANGED");
        }
        // Idempotent retry: never rewrite a submitted payment's order snapshot.
        return { orderNumber: existingOrder.orderNumber, created: false, paymentStatus: existingOrder.paymentStatus };
      }
    }
    const [customer] = await transaction
      .insert(customers)
      .values({
        email,
        firstName: input.customer.firstName,
        lastName: input.customer.lastName,
        phone: input.customer.phone,
      })
      .onConflictDoUpdate({
        target: customers.email,
        set: {
          firstName: input.customer.firstName,
          lastName: input.customer.lastName,
          phone: input.customer.phone,
          updatedAt: new Date(),
        },
      })
      .returning({ id: customers.id });

    let deliveryAddressId = existingOrder?.deliveryAddressId ?? null;
    if (deliveryMethod === "collection") {
      deliveryAddressId = null;
    } else if (input.address) {
      const addressValues = {
        customerId: customer.id,
        recipientName: `${input.customer.firstName} ${input.customer.lastName}`.trim(),
        line1: input.address.line1,
        line2: input.address.line2 || null,
        suburb: input.address.suburb,
        city: input.address.city,
        province: input.address.province,
        postalCode: input.address.postalCode,
        countryCode: "ZA",
        updatedAt: new Date(),
      };
      if (deliveryAddressId) {
        await transaction.update(addresses).set(addressValues).where(eq(addresses.id, deliveryAddressId));
      } else {
        const [createdAddress] = await transaction
          .insert(addresses)
          .values(addressValues)
          .returning({ id: addresses.id });
        deliveryAddressId = createdAddress.id;
      }
    }

    let orderId = existingOrder?.id;
    let orderNumber = existingOrder?.orderNumber;
    let created = false;

    if (orderId) {
      await transaction
        .update(orders)
        .set({
          customerId: customer.id,
          customerSnapshot: input.customer,
          deliveryAddressId,
          deliveryMethod,
          subtotal: subtotal.toFixed(2),
          deliveryFee: deliveryFee.toFixed(2),
          total: total.toFixed(2),
          updatedAt: new Date(),
        })
        .where(eq(orders.id, orderId));
      await transaction.delete(orderItems).where(eq(orderItems.orderId, orderId));
    } else {
      orderNumber = makeOrderNumber();
      const [createdOrder] = await transaction
        .insert(orders)
        .values({
          orderNumber,
          checkoutToken: input.checkoutToken,
          customerSnapshot: input.customer,
          customerId: customer.id,
          deliveryAddressId,
          status: "new",
          paymentStatus: "pending",
          deliveryMethod,
          subtotal: subtotal.toFixed(2),
          deliveryFee: deliveryFee.toFixed(2),
          total: total.toFixed(2),
        })
        .returning({ id: orders.id });
      orderId = createdOrder.id;
      created = true;
      await transaction.insert(orderStatusHistory).values({
        orderId,
        toStatus: "new",
        note: "Checkout started on the Moving Modesty storefront.",
      });
    }

    await transaction.insert(orderItems).values(lines.map(({ product, quantity, lineTotal }) => ({
      orderId: orderId!,
      productName: product.name,
      variantName: `${product.colour} · ${product.size}`,
      sku: product.sku,
      quantity,
      unitPrice: product.price.toFixed(2),
      lineTotal: lineTotal.toFixed(2),
      productSnapshot: {
        slug: product.slug,
        name: product.name,
        colour: product.colour,
        size: product.size,
        image: product.image,
      },
    })));

    if (deliveryMethod === "courier") {
      await transaction
        .insert(shipments)
        .values({
          orderId: orderId!,
          provider: "bobgo",
          status: "not_ready",
          senderLocationName: "Constantia Emporium",
          weightGrams: verifiedPackage?.weightGrams ?? null,
          lengthCm: verifiedPackage?.lengthCm.toFixed(2) ?? null,
          widthCm: verifiedPackage?.widthCm.toFixed(2) ?? null,
          heightCm: verifiedPackage?.heightCm.toFixed(2) ?? null,
        })
        .onConflictDoUpdate({
          target: shipments.orderId,
          set: {
            weightGrams: verifiedPackage?.weightGrams ?? null,
            lengthCm: verifiedPackage?.lengthCm.toFixed(2) ?? null,
            widthCm: verifiedPackage?.widthCm.toFixed(2) ?? null,
            heightCm: verifiedPackage?.heightCm.toFixed(2) ?? null,
            updatedAt: new Date(),
          },
        });
    } else {
      await transaction.delete(shipments).where(eq(shipments.orderId, orderId!));
    }

    return { orderNumber: orderNumber!, created, paymentStatus: "pending" as const };
  });

  return {
    orderNumber: result.orderNumber,
    created: result.created,
    stage: input.stage,
    fulfilmentMethod: input.fulfilmentMethod,
    subtotal,
    deliveryFee,
    total,
    qualifiesForFreeDelivery: quote.qualifiesForFreeDelivery,
    amountUntilFreeDelivery: quote.amountUntilFreeDelivery,
    paymentStatus: result.paymentStatus,
  };
}
