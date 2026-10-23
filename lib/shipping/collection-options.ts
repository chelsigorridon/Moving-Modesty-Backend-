import type { CourierPlan } from "../delivery-input";

// Store alternatives independently of the selected method. No provider calls,
// address inference or writes: callers persist only on an explicit user save.
export function withCollectionOptions(plan: CourierPlan, defaults: NonNullable<CourierPlan["collectionOptions"]> = {}): CourierPlan {
  const collectionOptions = { ...defaults, ...plan.collectionOptions };
  if (plan.collection.kind === "door") {
    collectionOptions.door = plan.collection;
    if (plan.collectionSchedule) collectionOptions.doorSchedule = plan.collectionSchedule;
  } else collectionOptions.pickupPoint = plan.collection;
  return { ...plan, collectionOptions };
}
