import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { record, textValue } from "./protocol.ts";

export const deliveryWebhookTopics = new Set([
  "tracking/updated", "shipment_submission_status/updated", "shipment_charged_amount/updated",
  "shipment_charged_weight/updated", "shipment_health_status/updated",
]);
export const webhookBodyLimit = 262_144;
export function verifyDeliverySignature(raw: Uint8Array, supplied: string | null, secret: string) {
  if (!secret || !supplied || !/^[A-Za-z0-9+/]{43}=$/.test(supplied)) return false;
  // Bob Go uses the literal secret string, not hex-decoded bytes.
  const expected = createHmac("sha256", secret).update(raw).digest("base64");
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
export type DeliveryEvent = { id: string; topic: string; remoteId: string; tracking: string };
export function deliveryEvent(raw: Uint8Array, topic: string, environment: string): DeliveryEvent | null {
  if (!deliveryWebhookTopics.has(topic)) return null;
  const body = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
  const remoteId = topic === "tracking/updated" ? "" : textValue(body.id);
  const tracking = textValue(topic === "tracking/updated" ? body.shipment_tracking_reference : body.tracking_reference);
  if ((remoteId && !/^[1-9]\d{0,18}$/.test(remoteId)) || !/^[a-z0-9/_-]{1,100}$/i.test(tracking)) throw new Error("Invalid delivery notification.");
  return { id: createHash("sha256").update(`${environment}\0${topic}\0`).update(raw).digest("hex"), topic, remoteId, tracking };
}
export async function readDeliveryBody(request: Request) {
  if (Number(request.headers.get("content-length")) > webhookBodyLimit) throw new RangeError("Webhook body too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing webhook body.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > webhookBodyLimit) throw new RangeError("Webhook body too large.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks);
}
