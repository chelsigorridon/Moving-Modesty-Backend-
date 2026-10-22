export type CollectionSchedule = { date: string; after: string; before: string };

export function southAfricaToday(now = Date.now()) {
  return new Date(now + 2 * 60 * 60_000).toISOString().slice(0, 10);
}

export function collectionScheduleProblem(schedule: CollectionSchedule | undefined, current = false, now = Date.now()): string {
  if (!schedule || typeof schedule.date !== "string" || typeof schedule.after !== "string" || typeof schedule.before !== "string") return "Choose a collection date and an available time window before comparing couriers.";
  const date = schedule.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00Z`))
    || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) return "Choose a valid collection date.";
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!time.test(schedule.after) || !time.test(schedule.before) || schedule.after < "08:00" || schedule.before > "17:00" || schedule.after >= schedule.before) return "Choose a start and end time between 08:00 and 17:00, with the end after the start.";
  if (current && (date < southAfricaToday(now) || Date.parse(`${date}T${schedule.before}:00+02:00`) <= now)) return "The collection date or time window has passed. Choose a new schedule and compare couriers again.";
  return "";
}

export function collectionScheduleLabel(schedule: CollectionSchedule) {
  return `${schedule.date} · ${schedule.after}–${schedule.before} SAST`;
}

export function collectionRateSchedule(schedule?: CollectionSchedule) {
  if (!schedule) return {};
  const problem = collectionScheduleProblem(schedule);
  if (problem) throw new Error(problem);
  return { requested_collection_date: `${schedule.date}T${schedule.after}:00+02:00` };
}

export function collectionShipmentSchedule(schedule?: CollectionSchedule) {
  if (!schedule) return {};
  const date = collectionRateSchedule(schedule).requested_collection_date;
  return { collection_min_date: date, collection_after: `${schedule.after}:00`, collection_before: `${schedule.before}:00` };
}
