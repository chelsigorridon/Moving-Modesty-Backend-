import { z } from "zod";
import { getAdminSnapshot } from "@/lib/admin-data";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { NotificationRetryConflict, retryOrderNotification } from "@/lib/email";
import { reportFailure } from "@/lib/monitoring";

export function OPTIONS() { return apiOptions(); }

export async function POST(request: Request, context: RouteContext<"/api/admin/orders/[orderNumber]/notifications">) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({ notificationId: z.uuid() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: "Choose a valid failed notification." }, { status: 400 });
  const { orderNumber } = await context.params;
  try {
    const order = (await getAdminSnapshot()).orders.find(item => item.id === orderNumber);
    if (!order) return apiJson({ error: "Order not found." }, { status: 404 });
    try {
      const email = await retryOrderNotification(order, parsed.data.notificationId);
      const snapshot = await getAdminSnapshot().catch(() => null);
      const refreshed = snapshot?.orders.find(item => item.id === orderNumber) ?? {
        ...order, notifications: order.notifications?.map(event => event.id === parsed.data.notificationId ? { ...event, status: "sent" as const, retryable: false } : event),
      };
      return apiJson({ order: refreshed, email });
    } catch (error) {
      const incident = error instanceof NotificationRetryConflict ? null
        : error && typeof error === "object" && "errorRef" in error ? { reference: String(error.errorRef) }
        : await reportFailure(error, { operation: "email_send", orderNumber, alert: false });
      const snapshot = await getAdminSnapshot().catch(() => null);
      const refreshed = snapshot?.orders.find(item => item.id === orderNumber) ?? order;
      return apiJson({ order: refreshed, error: error instanceof NotificationRetryConflict ? error.message : "Email could not be submitted. The order is unchanged; try again later or contact the customer directly.", errorRef: incident?.reference },
        { status: error instanceof NotificationRetryConflict ? 409 : 503 });
    }
  } catch (error) {
    const incident = await reportFailure(error, { operation: "admin_load" });
    return apiJson({ error: "Notification history is temporarily unavailable. Try again shortly.", errorRef: incident.reference }, { status: 503 });
  }
}
