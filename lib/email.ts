import "server-only";

import { Resend, type CreateEmailOptions } from "resend";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { createHmac } from "node:crypto";
import type { ContactInput } from "./contact-input";
import { requireDatabase } from "./db";
import { customers, emailEvents, orderItems, orders } from "./db/schema";
import type { Order, OrderStatus } from "./store-data";

const apiKey = process.env.RESEND_API_KEY;
const resend = apiKey ? new Resend(apiKey) : null;
const testSender = "Moving Modesty <onboarding@resend.dev>";

const messages: Record<OrderStatus, { subject: string; heading: string; body: string }> = {
  New: { subject: "We received your Moving Modesty order", heading: "Thank you for your order", body: "Your order is safely with us. We’ll confirm it as soon as payment and stock have been checked." },
  Confirmed: { subject: "Your order is confirmed", heading: "Your order is confirmed", body: "Payment and stock have been confirmed. Your order will move into preparation next." },
  Preparing: { subject: "We’re preparing your order", heading: "Your order is being prepared", body: "Our team is carefully picking and packing your Moving Modesty pieces." },
  Ready: { subject: "Your order is ready", heading: "Your order is ready", body: "Your order has been packed and is ready for collection or delivery." },
  Dispatched: { subject: "Your order is on its way", heading: "Your order has been dispatched", body: "Your parcel has left us. Any available tracking details are included below." },
  Collected: { subject: "Your order has been collected", heading: "Collected with care", body: "Your Moving Modesty order has been collected. Thank you for supporting our store." },
  Delivered: { subject: "Your order has been delivered", heading: "Delivered with care", body: "We hope you love your Moving Modesty pieces. Thank you for supporting our store." },
  Cancelled: { subject: "Your order has been cancelled", heading: "Order cancelled", body: "Your order has been cancelled. Please contact us if you need any help." },
};

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function money(value: string | number | null | undefined) {
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    minimumFractionDigits: 2,
  }).format(Number(value ?? 0));
}

function configuredSender() {
  const configured = process.env.RESEND_FROM_EMAIL?.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  if (!configured) return testSender;
  const address = "[^\\s<>@]+@[^\\s<>@]+\\.[^\\s<>@]+";
  const validSender = new RegExp(`^(?:${address}|[^<>]+\\s<${address}>)$`);
  return validSender.test(configured) ? configured : testSender;
}

function emailShell(content: string) {
  const storeUrl = process.env.STORE_URL ?? "https://holistic-brand-492217.framer.app";
  const logoUrl = process.env.EMAIL_LOGO_URL ?? "https://movingmodesty.vercel.app/brand/moving-modesty-email-logo.png";
  return `<div style="margin:0;background:#ece9e5;padding:32px 16px;font-family:Arial,sans-serif;color:#302a24"><div style="max-width:620px;margin:auto;background:#fff;border:1px solid #d8d2ca"><div style="padding:26px 28px;text-align:center;background:#fff;border-bottom:1px solid #d8d2ca"><a href="${storeUrl}" style="display:inline-block;text-decoration:none"><img src="${logoUrl}" width="150" alt="Moving Modesty" style="display:block;width:150px;max-width:100%;height:auto;margin:0 auto;border:0"></a></div><div style="padding:32px 28px">${content}</div><div style="padding:20px 28px;background:#f4f1ed;color:#746d65;font-size:12px;line-height:1.6"><a href="${storeUrl}" style="color:#667458">Visit Moving Modesty</a><br>Questions? Reply to this email or contact movingmodesty@gmail.com.</div></div></div>`;
}

type RecordedEmailInput = {
  orderId: string | null;
  recipient: string;
  template: string;
  idempotencyKey: string;
  replyTo?: string;
} & (
  | { subject: string; html: string; hostedTemplate?: never }
  | { hostedTemplate: { id: string; variables: Record<string, string | number> }; subject?: never; html?: never }
);

async function sendRecordedEmail(input: RecordedEmailInput) {
  if (!resend) return { skipped: true as const, reason: "RESEND_API_KEY is not configured" };
  const database = requireDatabase();
  const [existing] = await database
    .select({ id: emailEvents.id, status: emailEvents.status })
    .from(emailEvents)
    .where(eq(emailEvents.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing?.status === "sent" || existing?.status === "delivered") {
    return { skipped: true as const, reason: "This notification was already sent" };
  }

  const [event] = existing
    ? [existing]
    : await database
      .insert(emailEvents)
      .values({
        orderId: input.orderId,
        recipient: input.recipient,
        template: input.template,
        idempotencyKey: input.idempotencyKey,
        status: "queued",
      })
      .onConflictDoNothing({ target: emailEvents.idempotencyKey })
      .returning({ id: emailEvents.id, status: emailEvents.status });

  const eventId = event?.id ?? (await database
    .select({ id: emailEvents.id })
    .from(emailEvents)
    .where(eq(emailEvents.idempotencyKey, input.idempotencyKey))
    .limit(1))[0]?.id;
  if (!eventId) throw new Error("The email notification could not be queued.");

  try {
    const from = configuredSender();
    const email: CreateEmailOptions = input.hostedTemplate
      ? { from, to: input.recipient, template: input.hostedTemplate }
      : { from, to: input.recipient, subject: input.subject, html: input.html, replyTo: input.replyTo };
    const result = await resend.emails.send(email, { idempotencyKey: input.idempotencyKey });
    if (result.error) throw new Error(result.error.message);
    await database
      .update(emailEvents)
      .set({ status: "sent", resendEmailId: result.data?.id, errorMessage: null })
      .where(eq(emailEvents.id, eventId));
    return { skipped: false as const, id: result.data?.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown email delivery error";
    await database
      .update(emailEvents)
      .set({ status: "failed", errorMessage: message.slice(0, 500) })
      .where(eq(emailEvents.id, eventId));
    throw error;
  }
}

export class ContactRateLimitError extends Error {}

export async function sendContactMessage(input: ContactInput, sourceIp: string) {
  if (!resend || !process.env.AUTH_SECRET) throw new Error("Contact email is not configured.");
  const database = requireDatabase();
  const sourceHash = createHmac("sha256", process.env.AUTH_SECRET).update(`contact:${sourceIp}`).digest("hex");
  const template = `contact-${sourceHash}`;
  const idempotencyKey = `contact-message:${input.submissionId}`;
  const recipient = process.env.ORDER_NOTIFICATION_EMAIL?.trim() || "movingmodesty@gmail.com";

  // A database lock and durable reservations enforce the limit across Vercel
  // instances. Retrying the same submission does not consume another slot.
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${template}, 0))`);
    const [existing] = await transaction.select({ id: emailEvents.id }).from(emailEvents)
      .where(eq(emailEvents.idempotencyKey, idempotencyKey)).limit(1);
    if (existing) return;
    const [recent] = await transaction.select({ value: count() }).from(emailEvents)
      .where(and(eq(emailEvents.template, template), gte(emailEvents.createdAt, new Date(Date.now() - 60 * 60 * 1000))));
    if (recent.value >= 5) throw new ContactRateLimitError("Please wait before sending another message, or contact us on WhatsApp.");
    await transaction.insert(emailEvents).values({ recipient, template, idempotencyKey, status: "queued" })
      .onConflictDoNothing({ target: emailEvents.idempotencyKey });
  });

  return sendRecordedEmail({
    orderId: null, recipient, template, idempotencyKey, replyTo: input.email,
    subject: "New Moving Modesty website enquiry",
    html: emailShell(`<h1 style="font-size:24px;font-weight:400">Website enquiry</h1><p><strong>Name:</strong> ${escapeHtml(input.name)}<br><strong>Email:</strong> ${escapeHtml(input.email)}</p><p style="white-space:pre-wrap;line-height:1.6">${escapeHtml(input.message)}</p>`),
  });
}

export async function sendPaidOrderEmails(orderId: string) {
  const database = requireDatabase();
  const [order] = await database
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      paymentStatus: orders.paymentStatus,
      subtotal: orders.subtotal,
      deliveryFee: orders.deliveryFee,
      total: orders.total,
      deliveryMethod: orders.deliveryMethod,
      firstName: customers.firstName,
      lastName: customers.lastName,
      email: customers.email,
      phone: customers.phone,
    })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) throw new Error("The paid order could not be found for its email notification.");
  if (order.paymentStatus !== "paid") return { skipped: true as const, reason: "Payment is not confirmed" };

  const items = await database
    .select({
      name: orderItems.productName,
      variant: orderItems.variantName,
      quantity: orderItems.quantity,
      lineTotal: orderItems.lineTotal,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));
  const fulfilment = order.deliveryMethod === "courier" ? "Delivery" : "Collection";
  const customerNextStep = order.deliveryMethod === "courier"
    ? "You will receive your delivery details soon."
    : "You will receive a message soon with your collection details.";
  const customerItems = items
    .map((item) => `${item.quantity} × ${item.name}${item.variant ? ` — ${item.variant}` : ""}`)
    .join(" · ");
  const ownerEmail = process.env.ORDER_NOTIFICATION_EMAIL?.trim() || "movingmodesty@gmail.com";

  const [customer, owner] = await Promise.all([
    sendRecordedEmail({
      orderId: order.id,
      recipient: order.email,
      template: "paid-order-customer",
      idempotencyKey: `order-${order.orderNumber}-paid-customer`,
      hostedTemplate: {
        id: process.env.RESEND_PAYMENT_CONFIRMED_TEMPLATE?.trim() || "customer-payment-confirmed",
        variables: {
          CUSTOMER_NAME: order.firstName,
          ORDER_NUMBER: order.orderNumber,
          ORDER_ITEMS: customerItems || "Your Moving Modesty order",
          SUBTOTAL: money(order.subtotal),
          DELIVERY_FEE: Number(order.deliveryFee ?? 0) === 0 ? "Free" : money(order.deliveryFee),
          ORDER_TOTAL: money(order.total),
          FULFILMENT_METHOD: fulfilment,
          NEXT_STEP: customerNextStep,
        },
      },
    }),
    sendRecordedEmail({
      orderId: order.id,
      recipient: ownerEmail,
      template: "paid-order-owner",
      idempotencyKey: `order-${order.orderNumber}-paid-owner`,
      hostedTemplate: {
        id: process.env.RESEND_ADMIN_NEW_ORDER_TEMPLATE?.trim() || "admin-new-paid-order",
        variables: {
          ORDER_NUMBER: order.orderNumber,
          CUSTOMER_NAME: `${order.firstName} ${order.lastName}`.trim(),
          CUSTOMER_EMAIL: order.email,
          CUSTOMER_PHONE: order.phone || "No phone supplied",
          ORDER_ITEMS: customerItems || "No order items were recorded",
          SUBTOTAL: money(order.subtotal),
          DELIVERY_FEE: Number(order.deliveryFee ?? 0) === 0 ? "Free" : money(order.deliveryFee),
          ORDER_TOTAL: money(order.total),
          FULFILMENT_METHOD: fulfilment,
          ADMIN_PORTAL_URL: process.env.FRAMER_ADMIN_URL?.trim() || "https://holistic-brand-492217.framer.app",
        },
      },
    }),
  ]);
  return { skipped: false as const, customer, owner };
}

export async function resendPaidOrderEmails(orderNumber: string) {
  const database = requireDatabase();
  const [order] = await database
    .select({ id: orders.id, paymentStatus: orders.paymentStatus })
    .from(orders)
    .where(eq(orders.orderNumber, orderNumber))
    .limit(1);
  if (!order) throw new Error("Order not found.");
  if (order.paymentStatus !== "paid") throw new Error("Payment has not been confirmed for this order.");
  return sendPaidOrderEmails(order.id);
}

export async function sendOrderStatusEmail(order: Order, status: OrderStatus) {
  if (!resend) return { skipped: true as const, reason: "RESEND_API_KEY is not configured" };
  const message = messages[status];
  const from = configuredSender();
  const storeUrl = process.env.STORE_URL ?? "https://movingmodesty.co.za";
  const idempotencyKey = `order-${order.id}-${status.toLowerCase()}`;
  const result = await resend.emails.send({
    from,
    to: order.email,
    subject: `${message.subject} · ${order.id}`,
    html: emailShell(`<p style="margin:0 0 8px;color:#7d896d;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase">Order update</p><h1 style="margin:0 0 18px;font-family:Georgia,serif;font-size:34px;font-weight:400">${message.heading}</h1><p>Hello ${escapeHtml(order.customer.split(" ")[0])},</p><p style="line-height:1.7;color:#625b55">${message.body}</p><div style="margin:28px 0;padding:20px;background:#f7f5f1"><strong>${escapeHtml(order.id)}</strong><p style="margin:8px 0 0">Current status: ${escapeHtml(status)}</p></div><a href="${storeUrl}" style="display:inline-block;padding:13px 18px;background:#737d65;color:white;text-decoration:none">Visit Moving Modesty</a>`),
  }, { idempotencyKey });
  if (result.error) throw new Error(result.error.message);
  return { skipped: false as const, id: result.data?.id, idempotencyKey };
}
