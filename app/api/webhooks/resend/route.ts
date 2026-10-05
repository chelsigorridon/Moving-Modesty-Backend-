import { Resend } from "resend";
import { applyEmailDeliveryEvent } from "@/lib/email-delivery";
import { reportFailure } from "@/lib/monitoring";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret || !process.env.RESEND_API_KEY) return Response.json({ error: "Webhook is not configured." }, { status: 503 });
  if (Number(request.headers.get("content-length")) > 100000) return new Response(null, { status: 413 });
  const raw = await request.text();
  if (raw.length > 100000) return new Response(null, { status: 413 });
  let event: unknown;
  try {
    event = new Resend(process.env.RESEND_API_KEY).webhooks.verify({ payload: raw, webhookSecret: secret, headers: { id: request.headers.get("svix-id") || "", timestamp: request.headers.get("svix-timestamp") || "", signature: request.headers.get("svix-signature") || "" } });
  } catch {
    // Invalid/forged signatures must never change email history or trigger alerts.
    return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
  }
  try {
    const result = await applyEmailDeliveryEvent(event);
    return Response.json({ accepted: true, ...result });
  } catch (error) {
    const incident = await reportFailure(error, { operation: "email_webhook" });
    return Response.json({ error: "Temporary webhook processing failure.", errorRef: incident.reference }, { status: 503 });
  }
}
