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
import { isOrderInSyncScope } from "./activation-policy";

export function isSyncRunnerAuthorized(request: Request, secret = process.env.CRON_SECRET) {
  if (!secret || secret.length < 32 || secret.startsWith("replace-")) return false;
  const supplied = request.headers.get("authorization") || "";
  if (supplied.length > 512) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(supplied), digest(`Bearer ${secret}`));
}

// Credentials alone cannot activate syncing; the policy also requires explicit
// production switches and the persisted new-order cutoff.
export function preparedSyncCredentials(config: OrderSyncConfiguration) {
  if (!config.enabled) return null;
  const token = process.env.BOBGO_ORDER_SYNC_API_TOKEN?.trim(), channel = process.env.BOBGO_ORDER_SYNC_CHANNEL_REF?.trim();
  const courier = getBobGoConfiguration();
  if (!token || !channel || channel !== config.channelRef || courier.environment !== config.environment
    || (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production")) throw new Error("Bob Go sync is not configured for this deployment.");
  const domain = new URL(process.env.STORE_URL || "");
  if (domain.protocol !== "https:" || domain.username || domain.password || domain.port
    || domain.pathname !== "/" || domain.search || domain.hash || /(^|\.)(framer\.app|localhost|vercel\.app)$/.test(domain.hostname)
    || /^\d+\.\d+\.\d+\.\d+$/.test(domain.hostname) || domain.hostname !== channel) throw new Error("The final store domain does not match the Bob Go channel identifier.");
  return { token };
}

export async function runConfiguredBobGoSync() {
  const config = getOrderSyncConfiguration(), credentials = preparedSyncCredentials(config);
  if (!credentials) return { enabled: false, ordersChecked: 0, waybillLinksChecked: 0, shipmentsChecked: 0, needsAttention: 0 };
  const provider = createBobGoSyncTransport(config, credentials.token);
  return createBobGoSyncRunner(requireDatabase(), provider, config, async (orderId, kind, failed) => {
    const operation = kind === "sync" ? "courier_sync" : "courier_tracking";
    if (failed) await reportFailure(null, { operation, orderId, code: "provider_request" });
    else await resolveFailures(operation, orderId);
  })();
}

// Called only after a verified payment response. Never backfill order history,
// wait for a daily cron, or mix customer payment success with provider failure.
export async function syncConfiguredPaidOrder(orderId: string) {
  const config = getOrderSyncConfiguration();
  if (!config.enabled) return { status: "disabled" };
  const database = requireDatabase();
  const [order] = await database.select({ createdAt: orders.createdAt }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order || !isOrderInSyncScope(order, config)) return { status: "ineligible" };
  const credentials = preparedSyncCredentials(config);
  if (!credentials) return { status: "disabled" };
  const result = await createBobGoOrderSyncService(database, createBobGoSyncTransport(config, credentials.token), config).sync(orderId);
  if (["needs_attention", "retry", "checking"].includes(result.status)) await reportFailure(null, { operation: "courier_sync", orderId, code: "provider_request", alert: false });
  else if (result.status === "synced") await resolveFailures("courier_sync", orderId);
  return result;
}

export async function retryConfiguredBobGoSync(orderNumber: string) {
  const config = getOrderSyncConfiguration(), credentials = preparedSyncCredentials(config);
  if (!credentials) return { status: "disabled" };
  const database = requireDatabase();
  const [order] = await database.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
  if (!order) return { status: "ineligible" };
  const service = createBobGoOrderSyncService(database, createBobGoSyncTransport(config, credentials.token), config);
  const result = await service.retry(order.id);
  return result.status === "queued" ? service.sync(order.id) : result;
}

export async function checkConfiguredBobGoWaybillLink(orderNumber: string) {
  const config = getOrderSyncConfiguration(), credentials = preparedSyncCredentials(config);
  if (!credentials) return { status: "disabled" };
  const database = requireDatabase();
  const [order] = await database.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
  if (!order) return { status: "ineligible" };
  return createBobGoOrderSyncService(database, createBobGoSyncTransport(config, credentials.token), config).refreshWaybillLink(order.id);
}
