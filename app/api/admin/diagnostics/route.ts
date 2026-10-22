import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { requireDatabase } from "@/lib/db";
import { errorAlerts, orders, systemErrors } from "@/lib/db/schema";

export function OPTIONS() { return apiOptions(); }
const queryInput = z.object({
  status: z.enum(["open", "resolved", "all"]).default("all"),
  page: z.string().regex(/^\d{1,6}$/).transform(Number).default(0),
});
const resolutionInput = z.object({
  id: z.uuid(),
  confirmed: z.literal(true),
  // Occurrences only increase, including when a resolved incident reopens.
  expectedOccurrences: z.number().int().positive(),
}).strict();
const pageSize = 50;

export async function GET(request: Request) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const input = queryInput.safeParse({ status: url.searchParams.get("status") ?? undefined, page: url.searchParams.get("page") ?? undefined });
  if (!input.success) return apiJson({ error: "Choose open or resolved alerts and a valid page." }, { status: 400 });
  try {
    const database = requireDatabase();
    const { status, page } = input.data;
    const incidents = await database.select({ id: systemErrors.id, reference: systemErrors.reference, orderNumber: orders.orderNumber, source: systemErrors.source, operation: systemErrors.operation, code: systemErrors.code, summary: systemErrors.summary, severity: systemErrors.severity, environment: systemErrors.environment, httpStatus: systemErrors.httpStatus, occurrences: systemErrors.occurrences, firstSeenAt: systemErrors.firstSeenAt, lastSeenAt: systemErrors.lastSeenAt, resolvedAt: systemErrors.resolvedAt })
      .from(systemErrors).leftJoin(orders, eq(systemErrors.orderId, orders.id))
      .where(status === "open" ? isNull(systemErrors.resolvedAt) : status === "resolved" ? isNotNull(systemErrors.resolvedAt) : undefined)
      .orderBy(desc(systemErrors.lastSeenAt), desc(systemErrors.id)).limit(pageSize + 1).offset(page * pageSize);
    const [counts] = await database.select({
      open: sql<number>`count(*) filter (where ${systemErrors.resolvedAt} is null)::int`,
      resolved: sql<number>`count(*) filter (where ${systemErrors.resolvedAt} is not null)::int`,
    }).from(systemErrors);
    const alerts = await database.select({ incidentId: errorAlerts.incidentId, status: errorAlerts.status, createdAt: errorAlerts.createdAt }).from(errorAlerts).orderBy(desc(errorAlerts.createdAt)).limit(25);
    return apiJson({ incidents: incidents.slice(0, pageSize), counts, pagination: { page, pageSize, hasMore: incidents.length > pageSize }, alerts, alertRecipientConfigured: Boolean((process.env.ERROR_ALERT_EMAIL ?? "moody.tech@gmail.com").trim() && process.env.RESEND_API_KEY), webhookConfigured: Boolean(process.env.RESEND_WEBHOOK_SECRET) });
  } catch { return apiJson({ error: "Diagnostics are unavailable. Check Vercel logs and the database migration." }, { status: 503 }); }
}
export async function PATCH(request: Request) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const input = resolutionInput.safeParse(await request.json().catch(() => null));
  if (!input.success) return apiJson({ error: "Review the alert and confirm before marking it resolved." }, { status: 400 });
  try {
    const database = requireDatabase();
    const { id, expectedOccurrences } = input.data;
    const [incident] = await database.update(systemErrors).set({ resolvedAt: new Date() })
      .where(and(eq(systemErrors.id, id), eq(systemErrors.occurrences, expectedOccurrences), isNull(systemErrors.resolvedAt)))
      .returning({ id: systemErrors.id });
    if (incident) return apiJson({ resolved: true });
    const [current] = await database.select({ occurrences: systemErrors.occurrences, resolvedAt: systemErrors.resolvedAt })
      .from(systemErrors).where(eq(systemErrors.id, id)).limit(1);
    if (!current) return apiJson({ error: "This alert could not be found. Refresh the list." }, { status: 404 });
    if (current.occurrences !== expectedOccurrences) return apiJson({ error: "This alert happened again. Refresh and review the latest details before resolving it." }, { status: 409 });
    if (current.resolvedAt) return apiJson({ resolved: true, alreadyResolved: true });
    return apiJson({ error: "This alert changed. Refresh and review it again." }, { status: 409 });
  } catch { return apiJson({ error: "The incident could not be resolved." }, { status: 503 }); }
}
