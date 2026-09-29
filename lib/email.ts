import "server-only";

import { Resend } from "resend";
import { eq } from "drizzle-orm";
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

async function sendRecordedEmail(input: {
  orderId: string;
  recipient: string;
  template: string;
  idempotencyKey: string;
  subject: string;
  html: string;
}) {
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
    const result = await resend.emails.send({
      from,
      to: input.recipient,
      subject: input.subject,
      html: input.html,
    }, { idempotencyKey: input.idempotencyKey });
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
  const itemRows = items.map((item) => `<tr><td style="padding:10px 0;border-bottom:1px solid #e3ded8"><strong>${item.quantity} × ${escapeHtml(item.name)}</strong><br><span style="color:#746d65;font-size:13px">${escapeHtml(item.variant)}</span></td><td style="padding:10px 0;border-bottom:1px solid #e3ded8;text-align:right">${money(item.lineTotal)}</td></tr>`).join("");
  const fulfilment = order.deliveryMethod === "courier" ? "Delivery" : "Collection";
  const customerNextStep = order.deliveryMethod === "courier"
    ? "You will receive your delivery details soon."
    : "You will receive a message soon with your collection details.";
  const totals = `<table style="width:100%;border-collapse:collapse;margin-top:20px"><tr><td style="padding:5px 0;color:#746d65">Subtotal</td><td style="padding:5px 0;text-align:right">${money(order.subtotal)}</td></tr><tr><td style="padding:5px 0;color:#746d65">Delivery</td><td style="padding:5px 0;text-align:right">${Number(order.deliveryFee ?? 0) === 0 ? "Free" : money(order.deliveryFee)}</td></tr><tr><td style="padding:12px 0 0;font-size:18px;font-weight:700">Total paid</td><td style="padding:12px 0 0;text-align:right;font-size:18px;font-weight:700">${money(order.total)}</td></tr></table>`;

  const customerHtml = emailShell(`<p style="margin:0 0 8px;color:#7d896d;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase">Payment confirmed</p><h1 style="margin:0 0 18px;font-family:Georgia,serif;font-size:34px;font-weight:400">Thank you for your order</h1><p style="line-height:1.7">Hello ${escapeHtml(order.firstName)}, your payment has been confirmed and order <strong>${escapeHtml(order.orderNumber)}</strong> is safely with us.</p><table style="width:100%;border-collapse:collapse;margin-top:22px">${itemRows}</table>${totals}<p style="margin:24px 0 0;padding:16px;background:#eef0e9"><strong>Fulfilment:</strong> ${fulfilment}</p><div style="margin:14px 0 0;padding:18px;border:1px solid #cfd5c6;background:#f7f8f4"><p style="margin:0 0 6px;color:#667458;font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase">What happens next</p><p style="margin:0;line-height:1.6">${customerNextStep}</p></div>`);
  const ownerHtml = emailShell(`<p style="margin:0 0 8px;color:#7d896d;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase">New paid order</p><h1 style="margin:0 0 18px;font-family:Georgia,serif;font-size:34px;font-weight:400">${escapeHtml(order.orderNumber)}</h1><p style="line-height:1.7"><strong>${escapeHtml(`${order.firstName} ${order.lastName}`)}</strong><br>${escapeHtml(order.email)}<br>${escapeHtml(order.phone ?? "No phone supplied")}</p><table style="width:100%;border-collapse:collapse;margin-top:22px">${itemRows}</table>${totals}<p style="margin:24px 0 0;padding:16px;background:#eef0e9"><strong>Fulfilment:</strong> ${fulfilment}</p>`);
  const ownerEmail = process.env.ORDER_NOTIFICATION_EMAIL?.trim() || "movingmodesty@gmail.com";

  const [customer, owner] = await Promise.all([
    sendRecordedEmail({
      orderId: order.id,
      recipient: order.email,
      template: "paid-order-customer",
      idempotencyKey: `order-${order.orderNumber}-paid-customer`,
      subject: `Payment confirmed · ${order.orderNumber}`,
      html: customerHtml,
    }),
    sendRecordedEmail({
      orderId: order.id,
      recipient: ownerEmail,
      template: "paid-order-owner",
      idempotencyKey: `order-${order.orderNumber}-paid-owner`,
      subject: `New paid order · ${order.orderNumber}`,
      html: ownerHtml,
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
