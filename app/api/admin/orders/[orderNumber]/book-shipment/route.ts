import { getAdminSnapshot } from "@/lib/admin-data";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { bookCourierShipment, ShippingConflict } from "@/lib/integrations/bobgo/shipping";

export const maxDuration = 60;

export function OPTIONS() {
  return apiOptions();
}

export async function POST(request: Request, context: RouteContext<"/api/admin/orders/[orderNumber]/book-shipment">) {
  if (!getRequestAdmin(request)) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const { orderNumber } = await context.params;

  try {
    const body = await request.json().catch(() => null);
    if (typeof body?.quoteToken !== "string" || body.confirm !== true) return apiJson({ error: "Approve a fresh courier quote before booking." }, { status: 400 });
    const result = await bookCourierShipment(orderNumber, body.quoteToken);
    const snapshot = await getAdminSnapshot();
    return apiJson({ ...result, order: snapshot.orders.find(item => item.id === orderNumber) });
  } catch (error) {
    return apiJson(
      { error: error instanceof Error ? error.message : "Shipment could not be booked. Check Bob Go before retrying." },
      { status: error instanceof ShippingConflict ? 409 : 503 },
    );
  }
}
