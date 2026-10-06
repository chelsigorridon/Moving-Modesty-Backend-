import { getAdminSnapshot } from "@/lib/admin-data";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { bookCourierShipment, ShippingConflict } from "@/lib/integrations/bobgo/shipping";
import { reportFailure } from "@/lib/monitoring";

export const maxDuration = 60;

export function OPTIONS() {
  return apiOptions();
}

export async function POST(request: Request, context: RouteContext<"/api/admin/orders/[orderNumber]/book-shipment">) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const { orderNumber } = await context.params;

  try {
    const body = await request.json().catch(() => null);
    if (typeof body?.quoteToken !== "string" || body.confirm !== true) return apiJson({ error: "Approve a fresh courier quote before booking." }, { status: 400 });
    const result = await bookCourierShipment(orderNumber, body.quoteToken);
    const snapshot = await getAdminSnapshot();
    return apiJson({ ...result, order: snapshot.orders.find(item => item.id === orderNumber) });
  } catch (error) {
    const previousRef = error && typeof error === "object" && "errorRef" in error ? error.errorRef : undefined;
    const incident = previousRef || error instanceof ShippingConflict ? null : await reportFailure(error, { operation: "courier_book", orderNumber });
    return apiJson(
      { error: error instanceof ShippingConflict ? error.message : "Shipment could not be confirmed. Check Bob Go before retrying.", errorRef: previousRef || incident?.reference },
      { status: error instanceof ShippingConflict ? 409 : 503 },
    );
  }
}
