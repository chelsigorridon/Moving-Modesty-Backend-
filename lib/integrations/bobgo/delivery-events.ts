import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { requireDatabase } from "../../db";
import { bobgoDeliveryEvents, shipments } from "../../db/schema";
import type { DeliveryEvent } from "./webhook-policy";

export function createDeliveryEventQueue(database: ReturnType<typeof requireDatabase>, environment: "production" | "sandbox",
  refresh: (shipmentId: string) => Promise<unknown>, clock = () => Date.now()) {
  async function enqueue(event: DeliveryEvent) {
    const matches = await database.select({ id: shipments.id, tracking: shipments.trackingNumber, remote: shipments.providerShipmentId }).from(shipments)
      .where(and(eq(shipments.provider, `bobgo-${environment}`), inArray(shipments.status, ["booking", "booked"]),
        event.remoteId ? eq(shipments.providerShipmentId, event.remoteId) : eq(shipments.trackingNumber, event.tracking))).limit(2);
    if (matches.length !== 1 || (matches[0].tracking && matches[0].tracking !== event.tracking)) return { queued: false, ignored: true };
    const now = new Date(clock());
    const saved = await database.insert(bobgoDeliveryEvents).values({ id: event.id, shipmentId: matches[0].id, environment, topic: event.topic,
      nextAttemptAt: now, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: bobgoDeliveryEvents.id }).returning({ id: bobgoDeliveryEvents.id });
    return { queued: saved.length === 1, duplicate: saved.length === 0 };
  }
  async function drain(limit = 2) {
    let processed = 0, failed = 0;
    for (let i = 0; i < Math.min(5, Math.max(0, limit)); i++) {
      const lease = randomUUID(), now = new Date(clock());
      const job = await database.transaction(async tx => {
        const [row] = await tx.select().from(bobgoDeliveryEvents).where(and(eq(bobgoDeliveryEvents.environment, environment),
          inArray(bobgoDeliveryEvents.status, ["queued", "processing"]), lte(bobgoDeliveryEvents.nextAttemptAt, now),
          or(isNull(bobgoDeliveryEvents.leaseExpiresAt), lte(bobgoDeliveryEvents.leaseExpiresAt, now))))
          .orderBy(bobgoDeliveryEvents.createdAt).limit(1).for("update", { skipLocked: true });
        if (!row) return null;
        await tx.update(bobgoDeliveryEvents).set({ status: "processing", leaseToken: lease, leaseExpiresAt: new Date(clock() + 120_000), attempts: row.attempts + 1, updatedAt: now })
          .where(eq(bobgoDeliveryEvents.id, row.id));
        return row;
      });
      if (!job) break;
      try {
        // Always GET the provider's current record; never apply webhook status.
        await refresh(job.shipmentId);
        await database.update(bobgoDeliveryEvents).set({ status: "processed", processedAt: new Date(clock()), lastErrorCode: null,
          leaseToken: null, leaseExpiresAt: null, updatedAt: new Date(clock()) })
          .where(and(eq(bobgoDeliveryEvents.id, job.id), eq(bobgoDeliveryEvents.leaseToken, lease)));
        processed++;
      } catch {
        await database.update(bobgoDeliveryEvents).set({ status: job.attempts >= 7 ? "needs_attention" : "queued", lastErrorCode: "shipment_readback_failed",
          nextAttemptAt: new Date(clock() + Math.min(24 * 60 * 60_000, 15 * 60_000 * 2 ** Math.min(job.attempts, 7))),
          leaseToken: null, leaseExpiresAt: null, updatedAt: new Date(clock()) })
          .where(and(eq(bobgoDeliveryEvents.id, job.id), eq(bobgoDeliveryEvents.leaseToken, lease)));
        failed++;
      }
    }
    return { processed, failed };
  }
  return { enqueue, drain };
}
