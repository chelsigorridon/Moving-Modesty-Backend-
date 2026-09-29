import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const PAYFAST_HOSTS = [
  "www.payfast.co.za",
  "sandbox.payfast.co.za",
  "w1w.payfast.co.za",
  "w2w.payfast.co.za",
] as const;

// PayFast's published server ranges. DNS results are retained as a fallback
// because PayFast also documents its payment hostnames as valid sources.
const PAYFAST_IPV4_RANGES = [
  "197.97.145.144/28",
  "41.74.179.192/27",
  "102.216.36.0/28",
  "102.216.36.128/28",
  "144.126.193.139/32",
] as const;

function normalizeIp(value: string) {
  const cleaned = value.trim().replace(/^::ffff:/, "");
  return cleaned.startsWith("[") && cleaned.endsWith("]") ? cleaned.slice(1, -1) : cleaned;
}

function ipv4ToInteger(value: string) {
  const octets = value.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  return octets.reduce((result, octet) => ((result << 8) | octet) >>> 0, 0);
}

function isIpv4InCidr(value: string, cidr: string) {
  const [network, prefixValue] = cidr.split("/");
  const addressInteger = ipv4ToInteger(value);
  const networkInteger = ipv4ToInteger(network);
  const prefix = Number(prefixValue);
  if (addressInteger === null || networkInteger === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressInteger & mask) >>> 0 === (networkInteger & mask) >>> 0;
}

export function isPublishedPayFastIp(value: string) {
  const normalized = normalizeIp(value);
  return isIP(normalized) === 4 && PAYFAST_IPV4_RANGES.some((cidr) => isIpv4InCidr(normalized, cidr));
}

export function requestSourceIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0];
  const candidate = forwarded ?? request.headers.get("x-real-ip") ?? "";
  const normalized = normalizeIp(candidate);
  return isIP(normalized) ? normalized : null;
}

export async function isPayFastSourceIp(sourceIp: string): Promise<boolean | null> {
  if (isPublishedPayFastIp(sourceIp)) return true;

  const results = await Promise.all(PAYFAST_HOSTS.map(async (hostname) => {
    try {
      return await lookup(hostname, { all: true });
    } catch {
      return [];
    }
  }));
  const validAddresses = new Set(results.flat().map(({ address }) => normalizeIp(address)));
  if (validAddresses.size === 0) return null;
  return validAddresses.has(normalizeIp(sourceIp));
}
