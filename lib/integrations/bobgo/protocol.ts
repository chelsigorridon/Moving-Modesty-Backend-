import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const parcelInput = z.object({
  weightGrams: z.number().int().min(1).max(30_000),
  lengthCm: z.number().positive().max(150).multipleOf(0.01),
  widthCm: z.number().positive().max(150).multipleOf(0.01),
  heightCm: z.number().positive().max(150).multipleOf(0.01),
});
export type PackedParcel = z.infer<typeof parcelInput>;
export type BobGoAddress = {
  company: string; street_address: string; local_area: string; city: string;
  zone: string; country: string; code: string;
};
export type CourierRate = { providerSlug: string; providerName: string; serviceCode: string; serviceName: string; amount: number };
export type ApprovedQuote = CourierRate & {
  version: 1; orderNumber: string; fingerprint: string; expires: number;
  environment: "sandbox" | "production"; parcel: PackedParcel;
  collectionAddress: BobGoAddress; declaredValue: number;
};
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
export function textValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
export function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function signQuote(quote: ApprovedQuote, secret: string) {
  const payload = Buffer.from(JSON.stringify(quote)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(`bobgo-quote:${payload}`).digest("base64url")}`;
}
export function verifyQuote(token: string, secret: string, now = Date.now()): ApprovedQuote {
  const parts = token.split(".");
  if (parts.length !== 2 || token.length > 10_000) throw new Error("Invalid courier quote. Get a new quote.");
  const [payload, supplied] = parts;
  const expected = createHmac("sha256", secret).update(`bobgo-quote:${payload}`).digest("base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new Error("Invalid courier quote. Get a new quote.");
  const quote = JSON.parse(Buffer.from(payload, "base64url").toString()) as ApprovedQuote;
  if (quote.version !== 1 || !Number.isFinite(quote.expires) || quote.expires <= now) throw new Error("The courier quote expired. Get a new quote.");
  return quote;
}
export function parseRates(value: unknown, providerSlug: string): CourierRate[] {
  const result: CourierRate[] = [];
  for (const provider of records(record(value).provider_rate_requests)) {
    if (provider.provider_slug !== providerSlug || provider.status !== "success") continue;
    for (const rate of records(provider.responses)) {
      const amount = Number(rate.rate_amount);
      const service = record(rate.service_level);
      const code = textValue(rate.service_level_code);
      if (rate.status !== "success" || !Number.isFinite(amount) || amount <= 0 || !code) continue;
      result.push({ providerSlug, providerName: textValue(provider.provider_name) || providerSlug,
        serviceCode: code, serviceName: textValue(service.name) || code, amount });
    }
  }
  return result.sort((a, b) => a.amount - b.amount);
}
export function parseLocation(value: unknown, id: string, provider: string, checkCapacity = true): { name: string; address: BobGoAddress } {
  const candidates: Record<string, unknown>[] = [];
  function walk(item: unknown) {
    if (Array.isArray(item)) { item.forEach(walk); return; }
    const current = record(item);
    if (textValue(current.id ?? current.location_id) === id) candidates.push(current);
    Object.values(current).forEach(child => { if (child && typeof child === "object") walk(child); });
  }
  walk(value);
  const location = candidates.find(item => textValue(item.provider_slug) === provider && item.active === true && item.type === "locker");
  if (!location) throw new Error("The configured Bob Go drop-off point is unavailable for this parcel. Check the locker and parcel size in Bob Go.");
  if (checkCapacity && Array.isArray(location.compartment_errors) && location.compartment_errors.length) throw new Error("Bob Go reports no available matching compartment at this locker. Check capacity and the packed dimensions before trying again.");
  // Locations currently return comma-delimited addresses, while shipment/rate
  // endpoints require structured addresses. Parse the fixed country/province/
  // postcode/city/suburb suffix; preserve all remaining street/building parts.
  let address = record(location.address);
  if (typeof location.address === "string") {
    const parts = location.address.split(",").map(part => part.trim()).filter(Boolean);
    if (parts.length < 6 || parts.at(-1) !== "ZA") throw new Error("Bob Go did not return a complete South African locker address.");
    const country = parts.pop(); const zone = parts.pop(); const code = parts.pop();
    const city = parts.pop(); const local_area = parts.pop();
    address = { company: textValue(location.name), street_address: parts.join(", "), local_area, city, zone, country, code };
  }
  const normalized = {
    company: textValue(address.company), street_address: textValue(address.street_address),
    local_area: textValue(address.local_area), city: textValue(address.city), zone: textValue(address.zone),
    country: textValue(address.country), code: textValue(address.code),
  };
  if (!normalized.street_address || !normalized.city || !normalized.zone || !/^\d{4}$/.test(normalized.code) || normalized.country !== "ZA") throw new Error("Bob Go did not return a complete drop-off address. Please check the pickup point setup.");
  return { name: textValue(location.name), address: normalized };
}
export function parcelPayload(parcel: PackedParcel, orderNumber: string) {
  return [{ description: `Moving Modesty order ${orderNumber}`, submitted_length_cm: parcel.lengthCm,
    submitted_width_cm: parcel.widthCm, submitted_height_cm: parcel.heightCm,
    submitted_weight_kg: parcel.weightGrams / 1000, custom_parcel_reference: orderNumber }];
}
export function submissionIsBooked(value: unknown) {
  const shipment = record(value);
  return shipment.submission_status === "success" && Boolean(shipment.id && shipment.tracking_reference)
    && shipment.collection_location_type === "locker" && shipment.delivery_location_type === "door";
}
