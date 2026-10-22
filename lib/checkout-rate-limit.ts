import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { requireDatabase } from "./db";
import { diagnosticRateLimits } from "./db/schema";

const WINDOW_MS = 15 * 60 * 1000;

/** Durable, atomic limits shared by instances; no IP addresses stored in plaintext. */
export async function consumeCheckoutAttempt(request: Request, operation: "save" | "recover" | "payment") {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("Checkout request protection is not configured.");
  // Only the platform-overwritten header is trusted in production.
  const client = process.env.VERCEL_ENV ? request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || "unknown" : "local";
  const key = (scope: string, value: string) => "checkout:" + createHmac("sha256", secret)
    .update(JSON.stringify([process.env.VERCEL_ENV || "local", operation, scope, value])).digest("hex");
  const buckets = [{ key: key("client", client), limit: 60 }, { key: key("global", "all"), limit: 1_000 }]
    .sort((a, b) => a.key.localeCompare(b.key));
  const now = new Date();
  return requireDatabase().transaction(async transaction => {
    for (const bucket of buckets) {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${bucket.key}, 0))`);
    }
    for (const bucket of buckets) {
      const [row] = await transaction.select().from(diagnosticRateLimits).where(eq(diagnosticRateLimits.key, bucket.key));
      if (row && row.expiresAt > now && row.count >= bucket.limit) {
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000)) };
      }
    }
    for (const bucket of buckets) {
      await transaction.insert(diagnosticRateLimits).values({ key: bucket.key, expiresAt: new Date(now.getTime() + WINDOW_MS) })
        .onConflictDoUpdate({ target: diagnosticRateLimits.key, set: {
          count: sql`case when ${diagnosticRateLimits.expiresAt} <= ${now} then 1 else ${diagnosticRateLimits.count} + 1 end`,
          expiresAt: sql`case when ${diagnosticRateLimits.expiresAt} <= ${now} then ${new Date(now.getTime() + WINDOW_MS)} else ${diagnosticRateLimits.expiresAt} end`,
        } });
    }
    return { allowed: true, retryAfter: 0 };
  });
}
