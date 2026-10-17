import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { getAdminSnapshot } from "@/lib/admin-data";
import { waybillChangeInput } from "@/lib/integrations/bobgo/waybill-change-policy";
import { changeOrderWaybill, WaybillChangeConflict } from "@/lib/integrations/bobgo/waybill-change";
import { reportFailure } from "@/lib/monitoring";

export const maxDuration = 60;
export function OPTIONS() { return apiOptions(); }
export async function POST(request: Request, context: { params: Promise<{ orderNumber: string }> }) {
  const admin = await getRequestAdmin(request);
  if (!admin || admin.role !== "owner") return apiJson({ error: "Unauthorized" }, { status: 401 });
  const parsed = waybillChangeInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: "Confirm the current waybill and refresh the order before continuing." }, { status: 400 });
  const { orderNumber } = await context.params;
  try {
    const result = await changeOrderWaybill(orderNumber, parsed.data, admin.email);
    const snapshot = await getAdminSnapshot().catch(() => null);
    return apiJson({ ...result, order: snapshot?.orders.find(order => order.id === orderNumber),
      warning: snapshot ? undefined : "Refresh this order to see the latest delivery state before continuing." });
  } catch (error) {
    if (error instanceof WaybillChangeConflict) return apiJson({ error: error.message }, { status: 409 });
    const incident = await reportFailure(error, { operation: "courier_cancel", orderNumber });
    return apiJson({ error: "The waybill change could not be confirmed. Refresh the order and check cancellation status. Do not repeat cancellation or book another waybill.", errorRef: incident.reference }, { status: 503 });
  }
}
