import { createHash, timingSafeEqual } from "node:crypto";

export type PayFastField = readonly [name: string, value: string | number | null | undefined];

function encodePayFastValue(value: string) {
  return encodeURIComponent(value.trim())
    .replace(/[!'()*~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

export function payFastParameterString(fields: readonly PayFastField[], passphrase?: string) {
  const parameters = fields
    .filter(([name, value]) => name !== "signature" && value !== null && value !== undefined && String(value).trim() !== "")
    .map(([name, value]) => `${name}=${encodePayFastValue(String(value))}`);

  if (passphrase?.trim()) parameters.push(`passphrase=${encodePayFastValue(passphrase)}`);
  return parameters.join("&");
}

export function createPayFastSignature(fields: readonly PayFastField[], passphrase?: string) {
  return createHash("md5").update(payFastParameterString(fields, passphrase)).digest("hex");
}

export function signaturesMatch(received: string, expected: string) {
  const left = Buffer.from(received.toLowerCase(), "utf8");
  const right = Buffer.from(expected.toLowerCase(), "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function fieldsFromSearchParams(params: URLSearchParams): PayFastField[] {
  return Array.from(params.entries(), ([name, value]) => [name, value] as const);
}
