import { z } from "zod";
import { updateOrderStatus } from "@/lib/admin-data";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { sendOrderStatusEmail } from "@/lib/email";

const updateSchema = z.object({
  status: z.enum(["New", "Confirmed", "Processing", "Ready", "Dispatched", "Delivered"]),
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
    const email = await sendOrderStatusEmail(order, parsed.data.status);
    return apiJson({ order, email });
  } catch (error) {
    return apiJson(
      { error: error instanceof Error ? error.message : "The order could not be updated." },
      { status: 503 }
    );
  }
}
