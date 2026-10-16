import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { requireDatabase } from "../../db";
import { reportFailure, resolveFailures } from "../../monitoring";
import { getBobGoConfiguration } from "./configuration";
import { getOrderSyncConfiguration, type OrderSyncConfiguration } from "./order-sync-policy";
import { createBobGoSyncTransport } from "./order-sync-transport";
import { createBobGoSyncRunner } from "./order-sync-runner";
import { createBobGoOrderSyncService } from "./order-sync";
import { eq } from "drizzle-orm";
import { orders } from "../../db/schema";

export function isSyncRunnerAuthorized(request: Request, secret = process.env.CRON_SECRET) {
  if (!secret || secret.length < 32 || secret.startsWith("replace-")) return false;
  const supplied = request.headers.get("authorization") || "";
  if (supplied.length > 512) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(supplied), digest(`Bearer ${secret}`));
}

// This gate stays closed even when credentials are added. Enabling the policy
// is a separate reviewed release after domain/channel/provider acceptance tests.
export function preparedSyncCredentials(config: OrderSyncConfiguration) {
  if (!config.enabled) return null;
  const token = process.env.BOBGO_ORDER_SYNC_API_TOKEN?.trim(), channel = process.env.BOBGO_ORDER_SYNC_CHANNEL_REF?.trim();
  const courier = getBobGoConfiguration();
  if (!token || !channel || channel !== config.channelRef || courier.environment !== config.environment
    || (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production")) throw new Error("Bob Go sync is not configured for this deployment.");
  const domain = new URL(process.env.STORE_URL || "");
  if (domain.protocol !== "https:" || domain.username || domain.password || domain.port
    || domain.pathname !== "/" || domain.search || domain.hash || /(^|\.)(framer\.app|localhost|vercel\.app)$/.test(domain.hostname)
    || /^\d+\.\d+\.\d+\.\d+$/.test(domain.hostname)) throw new Error("The final store domain is not configured.");
  return { token };
}

export async function runConfiguredBobGoSync() {
  const config = getOrderSyncConfiguration(), credentials = preparedSyncCredentials(config);
  if (!credentials) return { enabled: false, ordersChecked: 0, shipmentsChecked: 0, needsAttention: 0 };
  const provider = createBobGoSyncTransport(config, credentials.token);
  return createBobGoSyncRunner(requireDatabase(), provider, config, async (orderId, kind, failed) => {
    const operation = kind === "sync" ? "courier_sync" : "courier_tracking";
    if (failed) await reportFailure(null, { operation, orderId, code: "provider_request" });
    else await resolveFailures(operation, orderId);
  })();
}

export async function retryConfiguredBobGoSync(orderNumber: string) {
  const config = getOrderSyncConfiguration(), credentials = preparedSyncCredentials(config);
  if (!credentials) return { status: "disabled" };
  const database = requireDatabase();
  const [order] = await database.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
  if (!order) return { status: "ineligible" };
  // Retry only queues the existing job. The background runner performs read-back.
  return createBobGoOrderSyncService(database, createBobGoSyncTransport(config, credentials.token), config).retry(order.id);
}
