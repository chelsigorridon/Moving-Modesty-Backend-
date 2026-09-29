import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const PAYFAST_HOSTS = [
  "www.payfast.co.za",
  "sandbox.payfast.co.za",
  "w1w.payfast.co.za",
  "w2w.payfast.co.za",
] as const;

function normalizeIp(value: string) {
  const cleaned = value.trim().replace(/^::ffff:/, "");
  return cleaned.startsWith("[") && cleaned.endsWith("]") ? cleaned.slice(1, -1) : cleaned;
}

export function requestSourceIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0];
  const candidate = forwarded ?? request.headers.get("x-real-ip") ?? "";
  const normalized = normalizeIp(candidate);
  return isIP(normalized) ? normalized : null;
}

export async function isPayFastSourceIp(sourceIp: string): Promise<boolean | null> {
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
