import { z } from "zod";
import { getAdminSnapshot, updateOrderStatus } from "@/lib/admin-data";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { sendOrderStatusEmail } from "@/lib/email";
import { OrderWorkflowConflict } from "@/lib/order-workflow";
import { reportFailure, resolveFailures } from "@/lib/monitoring";

const updateSchema = z.object({
  status: z.enum(["New", "Confirmed", "Preparing", "Ready", "Dispatched", "Collected", "Delivered", "Cancelled"]),
});

export function OPTIONS() {
  return apiOptions();
}

export async function PATCH(request: Request, context: RouteContext<"/api/admin/orders/[orderNumber]">) {
  if (!getRequestAdmin(request)) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: "Choose a valid order status." }, { status: 400 });
  const { orderNumber } = await context.params;
  try {
    const order = await updateOrderStatus(orderNumber, parsed.data.status);
    if (!order) return apiJson({ error: "Order not found." }, { status: 404 });
    await resolveFailures("admin_update", orderNumber);
    // A notification failure must not suggest that the saved status was lost.
    let email: Awaited<ReturnType<typeof sendOrderStatusEmail>> | { failed: true };
    let warning: string | undefined;
    try {
      email = await sendOrderStatusEmail(order, parsed.data.status);
    } catch {
      email = { failed: true };
      warning = "Order saved, but the customer email failed. Open Email notifications on this order to retry.";
    }
    // A transient history-read failure must not misreport an accepted email as failed.
    const snapshot = await getAdminSnapshot().catch(async error => { await reportFailure(error, { operation: "admin_load" }); return null; });
    if (!snapshot) warning ??= "Order saved. Refresh orders shortly to see the latest notification history.";
    return apiJson({ order: snapshot?.orders.find(item => item.id === orderNumber) ?? order, email, warning });
  } catch (error) {
    const incident = error instanceof OrderWorkflowConflict ? null : await reportFailure(error, { operation: "admin_update", orderNumber });
    return apiJson(
      { error: error instanceof OrderWorkflowConflict ? error.message : "The order could not be updated. Please try again shortly.", errorRef: incident?.reference },
      { status: error instanceof OrderWorkflowConflict ? 409 : 503 }
    );
  }
}
