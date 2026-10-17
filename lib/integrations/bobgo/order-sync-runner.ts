import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { requireDatabase } from "../../db";
import { bobgoOrderSync, orders, shipments } from "../../db/schema";
import { createBobGoOrderSyncService, type BobGoOrderSyncProvider } from "./order-sync";
import type { OrderSyncConfiguration } from "./order-sync-policy";

type Database = ReturnType<typeof requireDatabase>;
type Report = (orderId: string, kind: "sync" | "tracking", failed: boolean) => Promise<void>;
export function createBobGoSyncRunner(database: Database, provider: BobGoOrderSyncProvider, config: OrderSyncConfiguration,
  report: Report = async () => {}, clock: () => number = Date.now) {
  const service = createBobGoOrderSyncService(database, provider, config, clock);
  return async function run() {
    const result = { enabled: config.enabled, ordersChecked: 0, waybillLinksChecked: 0, shipmentsChecked: 0, needsAttention: 0 };
    if (!config.enabled) return result;
    const started = clock(), now = new Date(started);
    // Only the payment outbox is processed; never bulk-import historical orders.
    const jobs = await database.select({ orderId: bobgoOrderSync.orderId }).from(bobgoOrderSync)
      .where(and(eq(bobgoOrderSync.environment, config.environment), eq(bobgoOrderSync.channelRef, config.channelRef),
        inArray(bobgoOrderSync.status, ["queued", "retry", "checking", "syncing"]), lte(bobgoOrderSync.nextAttemptAt, now),
        or(isNull(bobgoOrderSync.leaseExpiresAt), lte(bobgoOrderSync.leaseExpiresAt, now))))
      .orderBy(asc(bobgoOrderSync.nextAttemptAt)).limit(2);
    for (const job of jobs) {
      if (clock() - started > 45000) break;
      try { const outcome = await service.sync(job.orderId); result.ordersChecked++;
        const failed = ["needs_attention", "retry", "checking"].includes(outcome.status); if (failed) result.needsAttention++;
        await report(job.orderId, "sync", failed);
      } catch { result.needsAttention++; await report(job.orderId, "sync", true); }
    }
    const cutoff = new Date(clock() - 5 * 60000);
    // Discover only fulfilled copies of this channel's already-synced orders.
    // No account-wide shipment scan, historical order import or booking call.
    const unlinked = await database.select({ orderId: bobgoOrderSync.orderId }).from(bobgoOrderSync)
      .leftJoin(shipments, eq(shipments.orderId, bobgoOrderSync.orderId))
      .where(and(eq(bobgoOrderSync.environment, config.environment), eq(bobgoOrderSync.channelRef, config.channelRef),
        eq(bobgoOrderSync.status, "synced"), isNotNull(bobgoOrderSync.remoteOrderId),
        or(isNull(bobgoOrderSync.waybillLinkCheckedAt), lte(bobgoOrderSync.waybillLinkCheckedAt, cutoff)),
        or(isNull(shipments.id), inArray(shipments.status, ["not_ready", "ready_to_book"]))))
      .orderBy(sql`${bobgoOrderSync.waybillLinkCheckedAt} asc nulls first`, asc(bobgoOrderSync.syncedAt)).limit(2);
    for (const item of unlinked) {
      // Four bounded provider reads may take 32 seconds. Reserve that budget
      // within a conservative 60-second invocation, including tracking.
      if (clock() - started > 10000) break;
      try { const outcome = await service.refreshWaybillLink(item.orderId); result.waybillLinksChecked++;
        const failed = outcome.status === "needs_attention"; if (failed) result.needsAttention++;
        await report(item.orderId, "sync", failed);
      } catch { result.needsAttention++; await report(item.orderId, "sync", true); }
    }
    const due = await database.select({ orderId: shipments.orderId }).from(shipments)
      .where(and(eq(shipments.provider, `bobgo-${config.environment}`), eq(shipments.status, "booked"),
        or(isNull(shipments.courierCheckedAt), lte(shipments.courierCheckedAt, cutoff)),
        or(isNull(shipments.courierStatus), inArray(shipments.courierStatus, ["pending-collection", "collected", "at-hub", "in-transit", "at-destination-hub", "out-for-delivery", "delivery-exception"]))))
      .orderBy(sql`${shipments.courierCheckedAt} asc nulls first`, asc(shipments.createdAt)).limit(2);
    for (const item of due) {
      if (clock() - started > 45000) break;
      const reserved = await database.transaction(async tx => {
        await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, item.orderId)).for("update");
        const [current] = await tx.select().from(shipments).where(eq(shipments.orderId, item.orderId)).for("update");
        if (!current || current.provider !== `bobgo-${config.environment}` || current.status !== "booked"
          || current.courierStatus === "delivered" || current.courierStatus === "cancelled"
          || (current.courierCheckedAt && current.courierCheckedAt > cutoff)) return false;
        await tx.update(shipments).set({ courierCheckedAt: new Date(clock()) }).where(eq(shipments.id, current.id));
        return true;
      });
      if (!reserved) continue;
      try { const outcome = await service.refreshTracking(item.orderId); result.shipmentsChecked++;
        const failed = outcome.status === "needs_attention"; if (failed) result.needsAttention++;
        await report(item.orderId, "tracking", failed);
      } catch { result.needsAttention++; await report(item.orderId, "tracking", true); }
    }
    return result;
  };
}
