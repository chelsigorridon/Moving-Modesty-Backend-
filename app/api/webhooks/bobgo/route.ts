import { after } from "next/server";
import { configuredDeliveryQueue, deliveryUpdatesConfiguration, runDeliveryUpdates } from "@/lib/integrations/bobgo/delivery-runtime";
import { deliveryEvent, readDeliveryBody, verifyDeliverySignature } from "@/lib/integrations/bobgo/webhook-policy";
import { reportFailure } from "@/lib/monitoring";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  let config;
  try { config = deliveryUpdatesConfiguration(); } catch { return Response.json({ error: "Delivery updates are not configured." }, { status: 503 }); }
  if (!config) return Response.json({ error: "Delivery updates are not enabled." }, { status: 503 });
  if (request.headers.get("x-bobgroup-type") !== "webhook" || !/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) return new Response(null, { status: 400 });
  let raw: Uint8Array;
  try { raw = await readDeliveryBody(request); }
  catch (error) { return new Response(null, { status: error instanceof RangeError ? 413 : 400 }); }
  if (!verifyDeliverySignature(raw, request.headers.get("bobgo-webhook-signature"), config.secret)) return new Response(null, { status: 401 });
  let event;
  try { event = deliveryEvent(raw, request.headers.get("x-bobgroup-topic") || "", config.environment); }
  catch { return new Response(null, { status: 400 }); }
  if (!event) return Response.json({ accepted: true, ignored: true });
  try {
    const result = await configuredDeliveryQueue(config.environment).enqueue(event);
    // Persist first, acknowledge within the provider's 20-second deadline.
    // A protected runner can recover the durable queue if this invocation stops.
    if (!result.ignored) after(async () => { await runDeliveryUpdates().catch(() => undefined); });
    return Response.json({ accepted: true });
  } catch (error) {
    await reportFailure(error, { operation: "courier_webhook" });
    return Response.json({ error: "Temporary delivery notification failure." }, { status: 503 });
  }
}
