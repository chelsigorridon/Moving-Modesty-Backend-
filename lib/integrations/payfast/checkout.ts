import "server-only";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resolveCheckoutItem } from "@/lib/checkout-catalogue";
import { requireDatabase } from "@/lib/db";
import { customers, orderItems, orders, payments } from "@/lib/db/schema";
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

function safeReturnUrl(storeUrl: string, state: "processing" | "cancelled", orderNumber: string) {
  const url = new URL("/checkout", `${storeUrl}/`);
  url.searchParams.set("payment", state);
  url.searchParams.set("order", orderNumber);
  return url.toString();
}

export async function createPayFastCheckout(input: PayFastCheckoutInput, requestUrl: string) {
  const configuration = requirePayFastConfiguration();
  const database = requireDatabase();
  const [order] = await database
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      deliveryMethod: orders.deliveryMethod,
      subtotal: orders.subtotal,
      deliveryFee: orders.deliveryFee,
      total: orders.total,
      firstName: customers.firstName,
      lastName: customers.lastName,
      email: customers.email,
      phone: customers.phone,
    })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(and(
      eq(orders.orderNumber, input.orderNumber),
      eq(orders.checkoutToken, input.checkoutToken),
    ))
    .limit(1);

  if (!order) throw new PayFastCheckoutError("This checkout session could not be found.", 404);
  if (order.paymentStatus === "paid") throw new PayFastCheckoutError("This order has already been paid.", 409);
  if (order.status === "cancelled") throw new PayFastCheckoutError("This order has been cancelled.", 409);
  if (order.deliveryMethod === "to_be_confirmed") {
    throw new PayFastCheckoutError("Choose delivery or collection before paying.", 409);
  }

  const lines = await database
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

  await database
    .insert(payments)
    .values({
      orderId: order.id,
      merchantPaymentId: order.orderNumber,
      status: "pending",
      amount,
    })
    .onConflictDoUpdate({
      target: payments.orderId,
      set: {
        merchantPaymentId: order.orderNumber,
        status: "pending",
        amount,
        providerStatus: null,
        failureReason: null,
        updatedAt: new Date(),
      },
    });

  const fields: PayFastField[] = [
    ["merchant_id", configuration.merchantId],
    ["merchant_key", configuration.merchantKey],
    ["return_url", safeReturnUrl(configuration.storeUrl, "processing", order.orderNumber)],
    ["cancel_url", safeReturnUrl(configuration.storeUrl, "cancelled", order.orderNumber)],
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
}
