import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { getAdminSnapshot } from "@/lib/admin-data";
import { deliveryEditInput } from "@/lib/delivery-input";
import { DeliveryEditConflict, saveOrderDelivery } from "@/lib/delivery-management";
import { reportFailure } from "@/lib/monitoring";

export function OPTIONS() { return apiOptions(); }
export async function PATCH(request: Request, context: { params: Promise<{ orderNumber: string }> }) {
  const admin = await getRequestAdmin(request);
  if (!admin) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const parsed = deliveryEditInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: parsed.error.issues[0]?.message || "Check the delivery details." }, { status: 400 });
  const { orderNumber } = await context.params;
  try {
    const saved = await saveOrderDelivery(orderNumber, parsed.data, admin.email);
    const snapshot = await getAdminSnapshot().catch(() => null);
    return apiJson({ ...saved, order: snapshot?.orders.find(order => order.id === orderNumber),
      warning: snapshot ? undefined : "Changes saved. Refresh orders to see the latest details." });
  } catch (error) {
    if (error instanceof DeliveryEditConflict) return apiJson({ error: error.message }, { status: 409 });
    const incident = await reportFailure(error, { operation: "admin_update", orderNumber });
    return apiJson({ error: "Delivery details could not be saved. No courier booking was created.", errorRef: incident.reference }, { status: 503 });
  }
}
