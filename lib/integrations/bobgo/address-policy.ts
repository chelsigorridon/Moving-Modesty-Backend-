import { normalizeCheckoutProvince } from "../../checkout-input.ts";

export const normalizeBobGoText = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value).trim().replace(/\s+/g, " ").toLowerCase() : "";
export function normalizeBobGoCountry(value: unknown) {
  const country = normalizeBobGoText(value);
  return ["za", "south africa"].includes(country) ? "ZA" : country;
}
export function normalizeBobGoProvince(value: unknown) {
  const codes: Record<string, string> = { EC: "Eastern Cape", FS: "Free State", GP: "Gauteng", KZN: "KwaZulu-Natal", LP: "Limpopo", MP: "Mpumalanga", NC: "Northern Cape", NW: "North West", WC: "Western Cape" };
  const text = String(value ?? "").trim();
  return normalizeCheckoutProvince(codes[text.toUpperCase()] || text);
}
export function bobGoAddressesMatch(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  return ["street_address", "local_area", "city", "code"].every(key => normalizeBobGoText(actual[key]) === normalizeBobGoText(expected[key]))
    && normalizeBobGoCountry(actual.country) === normalizeBobGoCountry(expected.country)
    && normalizeBobGoProvince(actual.zone) === normalizeBobGoProvince(expected.zone);
}
