import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { requireDatabase } from "@/lib/db";
import { errorAlerts, orders, systemErrors } from "@/lib/db/schema";

export function OPTIONS() { return apiOptions(); }
export async function GET(request: Request) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  try {
    const database = requireDatabase();
    const incidents = await database.select({ id: systemErrors.id, reference: systemErrors.reference, orderNumber: orders.orderNumber, source: systemErrors.source, operation: systemErrors.operation, code: systemErrors.code, summary: systemErrors.summary, severity: systemErrors.severity, environment: systemErrors.environment, httpStatus: systemErrors.httpStatus, occurrences: systemErrors.occurrences, firstSeenAt: systemErrors.firstSeenAt, lastSeenAt: systemErrors.lastSeenAt, resolvedAt: systemErrors.resolvedAt })
      .from(systemErrors).leftJoin(orders, eq(systemErrors.orderId, orders.id)).orderBy(desc(systemErrors.lastSeenAt)).limit(100);
    const alerts = await database.select({ incidentId: errorAlerts.incidentId, status: errorAlerts.status, createdAt: errorAlerts.createdAt }).from(errorAlerts).orderBy(desc(errorAlerts.createdAt)).limit(25);
    return apiJson({ incidents, alerts, alertRecipientConfigured: Boolean((process.env.ERROR_ALERT_EMAIL ?? "moody.tech@gmail.com").trim() && process.env.RESEND_API_KEY), webhookConfigured: Boolean(process.env.RESEND_WEBHOOK_SECRET) });
  } catch { return apiJson({ error: "Diagnostics are unavailable. Check Vercel logs and the database migration." }, { status: 503 }); }
}
export async function PATCH(request: Request) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!z.object({ id: z.uuid() }).safeParse(body).success) return apiJson({ error: "Choose an incident ID." }, { status: 400 });
  try {
    const [incident] = await requireDatabase().update(systemErrors).set({ resolvedAt: new Date() }).where(and(eq(systemErrors.id, body.id), isNull(systemErrors.resolvedAt))).returning({ id: systemErrors.id });
    return apiJson({ resolved: Boolean(incident) });
  } catch { return apiJson({ error: "The incident could not be resolved." }, { status: 503 }); }
}
