import { collectionRateSchedule, collectionScheduleProblem, type CollectionSchedule } from "../../shipping/collection-schedule.ts";
import type { CourierPlan } from "../../delivery-input.ts";
import { normalizeBobGoText } from "./address-policy.ts";

// Verified against Bob Go's own FulfillPage -> orders module (22 Oct 2026):
// PATCH /orders and POST /order-fulfillments both use this preset field.
// https://my.bobgo.co.za/static/js/route-deps~orders~11-BueYmFxo.js
// Owner approved preferred hours as driver instructions, not structured slots.
export function linkedCollectionDateFields(schedule?: CollectionSchedule) {
  return collectionRateSchedule(schedule);
}

export function linkedCollectionInstructions(instructions: string, schedule?: CollectionSchedule) {
  if (!schedule) return instructions;
  const problem = collectionScheduleProblem(schedule);
  if (problem) throw new Error(problem);
  const preference = `Preferred collection hours: ${schedule.date}, ${schedule.after}-${schedule.before} SAST. Requested, not a guaranteed time slot.`;
  const existing = instructions.trim();
  const combined = existing.endsWith(preference) ? existing : [existing, preference].filter(Boolean).join("\n");
  if (combined.length > 1000) throw new Error("Shorten the collection instructions to leave room for the preferred hours.");
  return combined;
}

export function linkedCollectionProblem(plan: CourierPlan, now: number) {
  if (plan.collection.kind === "pickup_point") return plan.collectionSchedule ? "Collection dates and hours do not apply to a locker or counter drop-off." : "";
  return collectionScheduleProblem(plan.collectionSchedule, true, now);
}

export function linkedCollectionDateMatches(value: unknown, schedule?: CollectionSchedule) {
  if (!schedule) return true; // Existing pre-schedule bookings remain reconcilable.
  if (collectionScheduleProblem(schedule) || typeof value !== "string") return false;
  // Bob Go may canonicalise a requested date to midnight. Hours are a separate
  // preference, so compare the actual South African calendar date, not the hour.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value === schedule.date;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const instant = Date.parse(value);
  return Number.isFinite(instant) && new Date(instant + 2 * 60 * 60_000).toISOString().slice(0, 10) === schedule.date;
}

export function linkedCollectionShipmentMatches(value: Record<string, unknown>, schedule: CollectionSchedule | undefined, instructions: string) {
  return !schedule || linkedCollectionDateMatches(value.collection_min_date, schedule)
    && normalizeBobGoText(value.instructions_collection) === normalizeBobGoText(instructions);
}
