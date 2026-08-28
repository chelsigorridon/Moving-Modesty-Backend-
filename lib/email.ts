import { Resend } from "resend";
import type { Order, OrderStatus } from "./store-data";

const apiKey = process.env.RESEND_API_KEY;
const resend = apiKey ? new Resend(apiKey) : null;

const messages: Record<OrderStatus, { subject: string; heading: string; body: string }> = {
  New: { subject: "We received your Moving Modesty order", heading: "Thank you for your order", body: "Your order is safely with us. We’ll confirm it as soon as payment and stock have been checked." },
  Confirmed: { subject: "Your order is confirmed", heading: "Your order is confirmed", body: "Payment and stock have been confirmed. Your order will move into preparation next." },
  Processing: { subject: "We’re preparing your order", heading: "Your order is being prepared", body: "Our team is carefully picking and packing your Moving Modesty pieces." },
  Ready: { subject: "Your order is ready", heading: "Your order is ready", body: "Your order has been packed and is ready for collection or delivery." },
  Dispatched: { subject: "Your order is on its way", heading: "Your order has been dispatched", body: "Your parcel has left us. Any available tracking details are included below." },
  Delivered: { subject: "Your order has been delivered", heading: "Delivered with care", body: "We hope you love your Moving Modesty pieces. Thank you for supporting our store." },
};

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

export async function sendOrderStatusEmail(order: Order, status: OrderStatus) {
  if (!resend) return { skipped: true as const, reason: "RESEND_API_KEY is not configured" };
  const message = messages[status];
  const from = process.env.RESEND_FROM_EMAIL ?? "Moving Modesty <orders@movingmodesty.co.za>";
  const storeUrl = process.env.STORE_URL ?? "https://movingmodesty.co.za";
  const idempotencyKey = `order-${order.id}-${status.toLowerCase()}`;
  const result = await resend.emails.send({
    from,
    to: order.email,
    subject: `${message.subject} · ${order.id}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:auto;color:#292522"><p style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#737d65">Moving Modesty</p><h1 style="font-family:Georgia,serif;font-weight:400">${message.heading}</h1><p>Hello ${escapeHtml(order.customer.split(" ")[0])},</p><p style="line-height:1.7;color:#625b55">${message.body}</p><div style="margin:28px 0;padding:20px;background:#f7f5f1"><strong>${escapeHtml(order.id)}</strong><p style="margin:8px 0 0">Current status: ${escapeHtml(status)}</p></div><a href="${storeUrl}" style="display:inline-block;padding:13px 18px;background:#737d65;color:white;text-decoration:none">Visit Moving Modesty</a></div>`,
  }, { idempotencyKey });
  if (result.error) throw new Error(result.error.message);
  return { skipped: false as const, id: result.data?.id, idempotencyKey };
}
