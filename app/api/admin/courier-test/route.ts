import { z } from "zod";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { getAdminSnapshot } from "@/lib/admin-data";
import { requireDatabase } from "@/lib/db";
import { createLiveCourierTestService, liveCourierTestInput, LiveCourierTestConflict } from "@/lib/live-courier-test";
import { reportFailure } from "@/lib/monitoring";

export const maxDuration = 60;
export function OPTIONS() { return apiOptions(); }
const actionInput = z.discriminatedUnion("action", [
  liveCourierTestInput.extend({ action: z.literal("create") }),
  z.object({ action: z.literal("payment") }),
  z.object({ action: z.literal("archive"), confirm: z.literal(true) }),
  z.object({ action: z.literal("approve_cost"), quoteToken: z.string().min(1).max(10000), amount: z.number().positive(), confirmRealCharge: z.literal(true) }),
]);
async function owner(request: Request) {
  const admin = await getRequestAdmin(request);
  return admin?.role === "owner" ? admin : null;
}
async function snapshot() {
  const service = createLiveCourierTestService(requireDatabase()), record = await service.current();
  const data = record ? await getAdminSnapshot() : null;
  return { order: data?.orders.find(order => order.id === record?.orderNumber) || null,
    archived: Boolean(record?.archivedAt), enabled: process.env.LIVE_COURIER_TEST_ENABLED === "true" };
}
export async function GET(request: Request) {
  if (!(await owner(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  try { return apiJson(await snapshot()); }
  catch { return apiJson({ error: "The private test could not be loaded." }, { status: 503 }); }
}
export async function POST(request: Request) {
  const admin = await owner(request);
  if (!admin) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const parsed = actionInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: parsed.error.issues[0]?.message || "Check the TEST details." }, { status: 400 });
  try {
    const service = createLiveCourierTestService(requireDatabase()), input = parsed.data;
    if (input.action === "create") { await service.create(input, admin.email); return apiJson(await snapshot()); }
    if (input.action === "archive") { await service.archive(admin.email); return apiJson(await snapshot()); }
    const record = await service.current();
    if (!record) throw new LiveCourierTestConflict("Create the single TEST order first.");
    if (input.action === "payment") return apiJson(await service.checkout(record.orderNumber, request.url));
    return apiJson(await service.approve(record.orderNumber, input.quoteToken, input.amount, admin.email));
  } catch (error) {
    if (error instanceof LiveCourierTestConflict) return apiJson({ error: error.message }, { status: 409 });
    const incident = await reportFailure(error, { operation: "admin_update" });
    return apiJson({ error: "The TEST request could not be completed. No courier booking was requested.", errorRef: incident.reference }, { status: 503 });
  }
}
