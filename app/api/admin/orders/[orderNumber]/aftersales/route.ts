import { getRequestAdmin } from "@/lib/auth";
import { apiJson, apiOptions } from "@/lib/api-response";
import { aftersalesInput, AftersalesConflict } from "@/lib/aftersales-input";
import { updateAftersales } from "@/lib/aftersales";
import { getAdminSnapshot } from "@/lib/admin-data";
import { sendRefundRecordedEmail } from "@/lib/email";
import { reportFailure } from "@/lib/monitoring";

export function OPTIONS() { return apiOptions(); }

export async function POST(request: Request, context: RouteContext<"/api/admin/orders/[orderNumber]/aftersales">) {
  const admin = await getRequestAdmin(request);
  if (!admin) return apiJson({ error: "Unauthorized" }, { status: 401 });
  if (!["owner", "manager"].includes(admin.role)) return apiJson({ error: "Only the store owner or manager can manage returns and refund records." }, { status: 403 });
  const parsed = aftersalesInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: "Check the required return or refund fields, quantities and confirmation." }, { status: 400 });
  const { orderNumber } = await context.params;
  try {
    const saved = await updateAftersales(orderNumber, parsed.data, admin.email);
    if (!saved) return apiJson({ error: "Order not found." }, { status: 404 });
    let warning: string | undefined;
    if (saved.refundId) {
      try { await sendRefundRecordedEmail(orderNumber, saved.refundId); }
      catch { warning = "Refund record saved, but the confirmation email failed. Open Email notifications to retry."; }
    }
    const snapshot = await getAdminSnapshot().catch(async error => { await reportFailure(error, { operation: "admin_load" }); return null; });
    if (!snapshot) warning ??= "Saved. Refresh orders shortly to load the updated return/refund history; do not enter it again as a new record.";
    const message = parsed.data.action === "record_refund" ? "PayFast refund recorded. No money was transferred by the portal."
      : parsed.data.action === "receive_return" ? "Return receipt saved. Only the stock quantities you confirmed were restored."
      : parsed.data.action === "return_waybill" ? "Return waybill reference saved. This did not book or pay for a courier."
      : "Return approved. Arrange its waybill separately in Bob Go.";
    return apiJson({ order: snapshot?.orders.find(row => row.id === orderNumber), saved: true, message, warning });
  } catch (error) {
    const duplicate = error && typeof error === "object" && "code" in error && error.code === "23505";
    if (error instanceof AftersalesConflict || duplicate) return apiJson({ error: duplicate ? "This return or refund reference is already recorded. Refresh the order." : (error as Error).message }, { status: 409 });
    const incident = await reportFailure(error, { operation: "admin_update", orderNumber });
    return apiJson({ error: "Could not confirm this change. Refresh the order before retrying with the same details.", errorRef: incident.reference }, { status: 503 });
  }
}
