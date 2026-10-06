import { readFileSync } from "node:fs";
import { Resend } from "resend";

// Usage: node --env-file=<secure env file> scripts/sync-cancellation-template.mjs
// No emails are sent. Do not log API keys or environment values.
if (!process.env.RESEND_API_KEY) throw new Error("A secure Resend API key from the Moving Modesty account is required.");
const resend = new Resend(process.env.RESEND_API_KEY);
const alias = process.env.RESEND_ORDER_CANCELLED_TEMPLATE || "customer-order-cancelled";
const html = readFileSync(new URL("../email-templates/customer-order-cancelled.html", import.meta.url), "utf8");
const payload = { name: "Moving Modesty — Order cancelled", alias, html,
  subject: "Your order has been cancelled · {{{ORDER_NUMBER}}}", replyTo: "movingmodesty@gmail.com",
  variables: [{ key: "CUSTOMER_NAME", type: "string", fallbackValue: "there" },
    { key: "ORDER_NUMBER", type: "string", fallbackValue: "Your order" },
    { key: "STORE_URL", type: "string", fallbackValue: "https://holistic-brand-492217.framer.app" }] };
const existing = await resend.templates.get(alias);
if (existing.error && existing.error.statusCode !== 404) throw new Error(`Template lookup failed (${existing.error.statusCode || existing.error.name}).`);
const result = existing.data ? await resend.templates.update(existing.data.id, payload) : await resend.templates.create(payload);
if (result.error) throw new Error(`Template save failed (${result.error.statusCode || result.error.name}).`);
const published = await resend.templates.publish(existing.data?.id || result.data.id);
if (published.error) throw new Error(`Template publish failed (${published.error.statusCode || published.error.name}).`);
const verified = await resend.templates.get(alias);
if (verified.error || verified.data?.status !== "published") throw new Error("The template was not confirmed published.");
console.log(JSON.stringify({ alias, id: verified.data.id, status: verified.data.status, emailsSent: 0 }));
