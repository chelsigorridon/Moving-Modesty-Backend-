import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNull, lte, notInArray, or } from "drizzle-orm";
import { requireDatabase } from "../../db";
import { shipments } from "../../db/schema";
import { reportFailure, resolveFailures } from "../../monitoring";
import { getBobGoConfiguration } from "./configuration";
import { bobGoRequest } from "./client";
import { createDirectShipmentTracking } from "./tracking";
import { createDeliveryEventQueue } from "./delivery-events";

export function deliveryUpdatesConfiguration() {
  const courier = getBobGoConfiguration(), secret = process.env.BOBGO_WEBHOOK_SECRET;
  // Independent from automatic sales-channel order copying, which stays off.
  const enabled = process.env.BOBGO_DELIVERY_UPDATES_ENABLED === "true";
  if (!enabled) return null;
  if (!courier.enabled || !courier.apiTokenConfigured || !secret || secret.startsWith("PASTE_")
    || (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") || courier.environment !== "production") throw new Error("Bob Go delivery updates are not configured.");
  return { environment: courier.environment, secret };
}
export function deliveryRunnerAuthorized(request: Request, secret = process.env.CRON_SECRET) {
  if (!secret || secret.length < 32 || secret.startsWith("replace-")) return false;
  const supplied = request.headers.get("authorization") || "";
  if (supplied.length > 512) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(supplied), digest(`Bearer ${secret}`));
}
export function configuredDeliveryQueue(environment: "production" | "sandbox") {
  const database = requireDatabase();
  const tracker = createDirectShipmentTracking(database, environment,
    path => bobGoRequest(path, undefined, { operation: "courier_tracking" }));
  return createDeliveryEventQueue(database, environment, tracker.refresh);
}
export async function runDeliveryUpdates(reconcile = false) {
  const config = deliveryUpdatesConfiguration();
  if (!config) return { enabled: false, processed: 0, failed: 0 };
  try {
    const result = await configuredDeliveryQueue(config.environment).drain();
    let shipmentsChecked = 0;
    if (reconcile) {
      // Bounded recovery for notifications that never arrived. This is a GET,
      // not an order import or another booking. The scheduler is configured
      // separately; merely deploying this file does not activate one.
      const database = requireDatabase(), now = new Date(), cutoff = new Date(Date.now() - 15 * 60_000);
      const [due] = await database.select({ id: shipments.id }).from(shipments).where(and(eq(shipments.provider, `bobgo-${config.environment}`),
        inArray(shipments.status, ["booking", "booked"]), or(isNull(shipments.courierCheckedAt), lte(shipments.courierCheckedAt, cutoff)),
        or(isNull(shipments.courierStatus), notInArray(shipments.courierStatus, ["delivered", "finalised", "returned-to-sender", "cancelled", "cancelled-by-courier"]))))
        .orderBy(shipments.courierCheckedAt, shipments.updatedAt).limit(1);
      if (due) {
        await database.update(shipments).set({ courierCheckedAt: now }).where(eq(shipments.id, due.id));
        try {
          await createDirectShipmentTracking(database, config.environment,
            path => bobGoRequest(path, undefined, { operation: "courier_tracking" })).refresh(due.id);
          shipmentsChecked++;
        } catch { result.failed++; }
      }
    }
    if (result.failed) await reportFailure(null, { operation: "courier_webhook", code: "provider_request" });
    else if (result.processed) await resolveFailures("courier_webhook");
    return { enabled: true, shipmentsChecked, ...result };
  } catch (error) { await reportFailure(error, { operation: "courier_webhook" }); throw error; }
}
