import "server-only";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resolveCheckoutItem } from "@/lib/checkout-catalogue";
import { requireDatabase } from "@/lib/db";
import { addresses, customers, orderItems, orders, payments } from "@/lib/db/schema";
import { checkoutOrderSchema } from "@/lib/checkout-input";
import { isPaymentFinal, readOrderCustomer } from "@/lib/checkout-safety";
import { calculateShippingQuote } from "@/lib/shipping/policy";
import { requirePayFastConfiguration } from "./configuration";
import { createPayFastSignature, type PayFastField } from "./signature";

export const payFastCheckoutSchema = z.object({
  orderNumber: z.string().trim().min(6).max(80),
  checkoutToken: z.string().uuid(),
});

export type PayFastCheckoutInput = z.infer<typeof payFastCheckoutSchema>;

export class PayFastCheckoutError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function cents(value: string | number | null) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) throw new PayFastCheckoutError("The order total is invalid.", 409);
  return Math.round(amount * 100);
}

function paymentReturnUrl(
  requestUrl: string,
  state: "processing" | "cancelled",
  orderNumber: string,
  checkoutToken: string,
) {
  const url = new URL("/api/payments/payfast/return", requestUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("order", orderNumber);
  url.searchParams.set("token", checkoutToken);
  return url.toString();
}

function diagnosticReason(stage: string, message: string) {
  return `${stage}: ${message}`.slice(0, 500);
}

export async function recordPayFastCheckoutFailure(input: PayFastCheckoutInput, message: string) {
  const database = requireDatabase();
  await database.transaction(async (transaction) => {
  const [order] = await transaction
    .select({ id: orders.id, total: orders.total, paymentStatus: orders.paymentStatus, status: orders.status, archivedAt: orders.archivedAt })
    .from(orders)
    .where(and(
      eq(orders.orderNumber, input.orderNumber),
      eq(orders.checkoutToken, input.checkoutToken),
    ))
    .for("update").limit(1);

  if (!order || order.archivedAt || isPaymentFinal(order.paymentStatus) || order.status !== "new") return;
  const now = new Date();
  const failureReason = diagnosticReason("PayFast checkout setup failed", message);

    await transaction
      .insert(payments)
      .values({
        orderId: order.id,
        merchantPaymentId: input.orderNumber,
        status: "failed",
        amount: order.total,
        providerStatus: "CHECKOUT_ERROR",
        failureReason,
      })
      .onConflictDoUpdate({
        target: payments.orderId,
        set: {
          merchantPaymentId: input.orderNumber,
          status: "failed",
          amount: order.total,
          providerStatus: "CHECKOUT_ERROR",
          failureReason,
          updatedAt: now,
        },
      });

    await transaction
      .update(orders)
      .set({ paymentStatus: "failed", updatedAt: now })
      .where(eq(orders.id, order.id));
  });
}

export async function createPayFastCheckout(input: PayFastCheckoutInput, requestUrl: string) {
  const configuration = requirePayFastConfiguration();
  const database = requireDatabase();
  return database.transaction(async (transaction) => {
  // One lock order across checkout edits, payment creation, returns and ITNs.
  // No PayFast network request is made while this transaction is open.
  const [order] = await transaction
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      archivedAt: orders.archivedAt,
      paymentStatus: orders.paymentStatus,
      deliveryMethod: orders.deliveryMethod,
      deliveryAddressId: orders.deliveryAddressId,
      subtotal: orders.subtotal,
      deliveryFee: orders.deliveryFee,
      total: orders.total,
      firstName: customers.firstName,
      lastName: customers.lastName,
      email: customers.email,
      phone: customers.phone,
      customerSnapshot: orders.customerSnapshot,
    })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(and(
      eq(orders.orderNumber, input.orderNumber),
      eq(orders.checkoutToken, input.checkoutToken),
    ))
    .for("update", { of: orders }).limit(1);

  if (!order) throw new PayFastCheckoutError("This checkout session could not be found.", 404);
  if (order.archivedAt) throw new PayFastCheckoutError("This checkout has been archived. Please start a new checkout.", 409);
  Object.assign(order, readOrderCustomer(order.customerSnapshot, order));
  if (isPaymentFinal(order.paymentStatus) || order.status !== "new") throw new PayFastCheckoutError("This order is paid or closed. Please start a new checkout.", 409);
  if (order.deliveryMethod === "to_be_confirmed") {
    throw new PayFastCheckoutError("Choose delivery or collection before paying.", 409);
  }

  const lines = await transaction
    .select({ sku: orderItems.sku, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));
  if (lines.length === 0) throw new PayFastCheckoutError("This order has no items.", 409);

  const currentSubtotal = lines.reduce((sum, line) => {
    const product = resolveCheckoutItem(line.sku);
    if (!product) throw new PayFastCheckoutError(`${line.sku} is no longer available. Please refresh your cart.`, 409);
    return sum + product.price * line.quantity;
  }, 0);
  const fulfilmentMethod = order.deliveryMethod === "courier" ? "delivery" : "collection";
  const [address] = order.deliveryAddressId && fulfilmentMethod === "delivery"
    ? await transaction.select().from(addresses).where(eq(addresses.id, order.deliveryAddressId)).limit(1) : [];
  const validation = checkoutOrderSchema.safeParse({ checkoutToken: input.checkoutToken, stage: "complete",
    customer: { firstName: order.firstName, lastName: order.lastName, email: order.email, phone: order.phone },
    fulfilmentMethod, address: address ? { ...address, line2: address.line2 ?? "" } : undefined, items: lines });
  if (!validation.success) throw new PayFastCheckoutError(validation.error.issues[0]?.message ?? "Please check your checkout details.", 409);
  const quote = calculateShippingQuote(currentSubtotal, fulfilmentMethod);
  if (
    cents(order.subtotal) !== cents(quote.subtotal) ||
    cents(order.deliveryFee) !== cents(quote.deliveryFee) ||
    cents(order.total) !== cents(quote.total)
  ) {
    throw new PayFastCheckoutError("The order price has changed. Please return to your cart and try again.", 409);
  }

  const amount = quote.total.toFixed(2);
  const notifyUrl = new URL("/api/payments/payfast/notify", requestUrl).toString();
  if (!notifyUrl.startsWith("https://") && process.env.NODE_ENV === "production") {
    throw new PayFastCheckoutError("The PayFast notification URL must use HTTPS.", 503);
  }

  const checkoutStartedAt = new Date();
    await transaction
      .insert(payments)
      .values({
        orderId: order.id,
        merchantPaymentId: order.orderNumber,
        provider: `payfast-${configuration.environment}`,
        status: "pending",
        amount,
        providerStatus: "CHECKOUT_STARTED",
      })
      .onConflictDoUpdate({
        target: payments.orderId,
        set: {
          merchantPaymentId: order.orderNumber,
          provider: `payfast-${configuration.environment}`,
          status: "pending",
          amount,
          providerStatus: "CHECKOUT_STARTED",
          failureReason: null,
          updatedAt: checkoutStartedAt,
        },
      });

    await transaction
      .update(orders)
      .set({ paymentStatus: "pending", updatedAt: checkoutStartedAt })
      .where(eq(orders.id, order.id));

  const fields: PayFastField[] = [
    ["merchant_id", configuration.merchantId],
    ["merchant_key", configuration.merchantKey],
    ["return_url", paymentReturnUrl(requestUrl, "processing", order.orderNumber, input.checkoutToken)],
    ["cancel_url", paymentReturnUrl(requestUrl, "cancelled", order.orderNumber, input.checkoutToken)],
    ["notify_url", notifyUrl],
    ["name_first", order.firstName],
    ["name_last", order.lastName],
    ["email_address", order.email],
    ["cell_number", order.phone],
    ["m_payment_id", order.orderNumber],
    ["amount", amount],
    ["item_name", `Moving Modesty order ${order.orderNumber}`],
    ["item_description", `${lines.length} product line${lines.length === 1 ? "" : "s"}`],
  ];
  const signature = createPayFastSignature(fields, configuration.passphrase);

  return {
    action: configuration.processUrl,
    environment: configuration.environment,
    fields: Object.fromEntries([...fields, ["signature", signature]].map(([name, value]) => [name, String(value)])),
  };
  });
}
