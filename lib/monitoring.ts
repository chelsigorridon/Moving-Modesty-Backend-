import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { Resend } from "resend";
import { requireDatabase } from "./db";
import { errorAlerts, orders, systemErrors } from "./db/schema";
import { classifyError, errorReasons, operations, safeHttpStatus, type ErrorCode, type Operation } from "./monitoring-policy";

type FailureContext = { operation: Operation; orderId?: string; orderNumber?: string; code?: ErrorCode; severity?: "warning" | "error"; alert?: boolean };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function reportFailure(error: unknown, context: FailureContext) {
  const reference = randomUUID();
  const operation = Object.hasOwn(operations, context.operation) ? context.operation : "server_request";
  const source = operations[operation];
  const code = context.code && Object.hasOwn(errorReasons, context.code) ? context.code : classifyError(error);
  const severity = context.severity === "warning" ? "warning" : "error";
  const environment = process.env.VERCEL_ENV === "production" ? "production" : process.env.VERCEL_ENV === "preview" ? "preview" : "local";
  const safe = { reference, source, operation, code, summary: errorReasons[code], severity, environment, httpStatus: safeHttpStatus(error) };
  console.error("[Moving Modesty incident]", JSON.stringify(safe));
  try {
    const database = requireDatabase();
    // Only a real stored order may be associated with an incident.
    const [order] = context.orderId && uuid.test(context.orderId)
      ? await database.select({ id: orders.id, number: orders.orderNumber }).from(orders).where(eq(orders.id, context.orderId)).limit(1)
      : context.orderNumber && /^MM-[A-Z0-9-]{1,48}$/i.test(context.orderNumber)
        ? await database.select({ id: orders.id, number: orders.orderNumber }).from(orders).where(eq(orders.orderNumber, context.orderNumber)).limit(1) : [];
    const fingerprint = createHash("sha256").update(`${environment}:${operation}:${code}:${order?.id || "general"}`).digest("hex");
    const now = new Date();
    const [incident] = await database.insert(systemErrors).values({ ...safe, fingerprint, orderId: order?.id })
      .onConflictDoUpdate({ target: systemErrors.fingerprint, set: { lastSeenAt: now, resolvedAt: null, occurrences: sql`${systemErrors.occurrences} + 1` } }).returning();
    if (incident.reference !== reference) console.error("[Moving Modesty incident group]", JSON.stringify({ reference: incident.reference, attemptReference: reference, occurrences: incident.occurrences }));
    if (context.alert !== false && severity === "error" && source !== "browser") {
      try { await sendTechnicalAlert(incident, order?.number); }
      catch { console.error("[Moving Modesty monitoring]", JSON.stringify({ reference, code: "technical_alert_reservation_failed" })); }
    }
    return { reference: incident.reference, persisted: true };
  } catch {
    // Database outages must not hide the original failure or expose raw SQL in logs.
    console.error("[Moving Modesty monitoring]", JSON.stringify({ reference, code: "incident_storage_unavailable", fallback: "server_log" }));
    return { reference, persisted: false };
  }
}

async function sendTechnicalAlert(incident: typeof systemErrors.$inferSelect, orderNumber?: string) {
  // Local demos/development and preview deployments must not send live alerts.
  if (incident.environment !== "production") return;
  const recipient = (process.env.ERROR_ALERT_EMAIL ?? "moody.tech@gmail.com").trim();
  if (!recipient || !process.env.RESEND_API_KEY || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(recipient)) return;
  const database = requireDatabase();
  const hour = new Date(Math.floor(Date.now() / 3600000) * 3600000);
  // Group by cause, not customer/order, and cap all technical email alerts at 5/hour.
  const dedupeKey = `${incident.environment}:${incident.operation}:${incident.code}:${hour.toISOString()}`;
  const alert = await database.transaction(async transaction => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended('mm-technical-alerts', 0))`);
    const [recent] = await transaction.select({ value: count() }).from(errorAlerts).where(gte(errorAlerts.createdAt, hour));
    if (recent.value >= 5) return null;
    return (await transaction.insert(errorAlerts).values({ incidentId: incident.id, dedupeKey }).onConflictDoNothing({ target: errorAlerts.dedupeKey }).returning())[0] || null;
  });
  if (!alert) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const from = process.env.RESEND_FROM_EMAIL?.trim() || "Moving Modesty <onboarding@resend.dev>";
    const lines = ["Moving Modesty technical alert", `Environment: ${incident.environment}`, `Operation: ${incident.operation}`, `Cause: ${incident.code}`, incident.summary, `Reference: ${incident.reference}`, ...(orderNumber ? [`Order: ${orderNumber}`] : []), ...(incident.httpStatus ? [`HTTP status: ${incident.httpStatus}`] : []), "No customer details or credentials are included.", "Check the authenticated /api/admin/diagnostics endpoint and Vercel logs. Repeated causes are grouped; alerts are limited to five per hour."];
    const result = await Promise.race([
      new Resend(process.env.RESEND_API_KEY!).emails.send({ from, to: recipient, subject: `[Moving Modesty] ${incident.environment}: ${incident.operation} failed`, text: lines.join("\n") }, { idempotencyKey: `mm-error:${createHash("sha256").update(dedupeKey).digest("hex")}` }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Technical alert timeout")), 8000); }),
    ]);
    if (result.error || !result.data?.id) throw new Error("Technical alert not accepted");
    await database.update(errorAlerts).set({ status: "sent", resendEmailId: result.data.id }).where(eq(errorAlerts.id, alert.id));
  } catch {
    await database.update(errorAlerts).set({ status: "failed" }).where(eq(errorAlerts.id, alert.id)).catch(() => undefined);
    console.error("[Moving Modesty monitoring]", JSON.stringify({ reference: incident.reference, code: "technical_alert_failed" }));
    // Never recursively send an alert about an alert failure.
  } finally { if (timeout) clearTimeout(timeout); }
}

export async function resolveFailures(operation: Operation, orderId?: string) {
  try {
    const database = requireDatabase();
    if (orderId && !uuid.test(orderId)) {
      orderId = (await database.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, orderId)).limit(1))[0]?.id;
      if (!orderId) return;
    }
    await database.update(systemErrors).set({ resolvedAt: new Date() })
      .where(and(eq(systemErrors.operation, operation), orderId ? eq(systemErrors.orderId, orderId) : isNull(systemErrors.orderId), isNull(systemErrors.resolvedAt)));
  } catch { /* Monitoring must not turn a successful operation into a failure. */ }
}

export async function getOperationalIssues() {
  const database = requireDatabase();
  return database.select().from(systemErrors).where(and(isNull(systemErrors.resolvedAt), inArray(systemErrors.source, ["courier", "payment", "email", "contact", "checkout", "admin", "server"]))).orderBy(desc(systemErrors.lastSeenAt)).limit(100);
}
