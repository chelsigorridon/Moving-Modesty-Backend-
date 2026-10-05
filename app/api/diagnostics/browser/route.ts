import { createHmac } from "node:crypto";
import { eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { contactOriginAllowed } from "@/lib/contact-input";
import { requireDatabase } from "@/lib/db";
import { diagnosticRateLimits } from "@/lib/db/schema";
import { reportFailure } from "@/lib/monitoring";

const storeUrl = process.env.STORE_URL || "https://holistic-brand-492217.framer.app";
const input = z.object({ surface: z.enum(["checkout", "contact", "admin"]), code: z.enum(["browser_network", "browser_timeout"]) }).strict();
function allowed(request: Request) { return contactOriginAllowed(request.headers.get("origin"), request.url, storeUrl); }
function headers(request: Request) { return { "Access-Control-Allow-Origin": request.headers.get("origin") || "null", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin", "Cache-Control": "no-store" }; }
export function OPTIONS(request: Request) { return new Response(null, { status: allowed(request) ? 204 : 403, headers: allowed(request) ? headers(request) : {} }); }

export async function POST(request: Request) {
  if (!allowed(request)) return new Response(null, { status: 403 });
  const respond = (status: number, body?: unknown) => body ? Response.json(body, { status, headers: headers(request) }) : new Response(null, { status, headers: headers(request) });
  if (!request.headers.get("content-type")?.includes("application/json")) return respond(415);
  if (Number(request.headers.get("content-length")) > 512) return respond(413);
  const raw = await request.text();
  if (raw.length > 512) return respond(413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return respond(400); }
  const parsed = input.safeParse(body);
  if (!parsed.success) return respond(400);
  if (!process.env.AUTH_SECRET) return respond(503);
  try {
    const database = requireDatabase();
    const sourceIp = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const hour = Math.floor(Date.now() / 3600000);
    const clientKey = createHmac("sha256", process.env.AUTH_SECRET).update(`diagnostics:${hour}:${sourceIp}`).digest("hex");
    const globalKey = `browser:${hour}`;
    const expiresAt = new Date((hour + 1) * 3600000);
    const permitted = await database.transaction(async transaction => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended('mm-browser-diagnostics', 0))`);
      await transaction.delete(diagnosticRateLimits).where(lt(diagnosticRateLimits.expiresAt, new Date()));
      const [global] = await transaction.select().from(diagnosticRateLimits).where(eq(diagnosticRateLimits.key, globalKey));
      const [client] = await transaction.select().from(diagnosticRateLimits).where(eq(diagnosticRateLimits.key, clientKey));
      if ((global?.count || 0) >= 500 || (client?.count || 0) >= 12) return false;
      for (const key of [clientKey, globalKey]) await transaction.insert(diagnosticRateLimits).values({ key, expiresAt }).onConflictDoUpdate({ target: diagnosticRateLimits.key, set: { count: sql`${diagnosticRateLimits.count} + 1` } });
      return true;
    });
    if (!permitted) return respond(429);
    // Anonymous reports are untrusted: no order links, raw error text or alert emails.
    const incident = await reportFailure(null, { operation: `browser_${parsed.data.surface}`, code: parsed.data.code, severity: "warning", alert: false });
    return respond(202, { errorRef: incident.reference });
  } catch { return respond(503); } // Never recursively report failures of this reporting endpoint.
}
