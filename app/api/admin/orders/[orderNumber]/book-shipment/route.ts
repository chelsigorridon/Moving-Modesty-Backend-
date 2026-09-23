import { getAdminSnapshot } from "@/lib/admin-data";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";

export function OPTIONS() {
  return apiOptions();
}

export async function POST(request: Request, context: RouteContext<"/api/admin/orders/[orderNumber]/book-shipment">) {
  if (!getRequestAdmin(request)) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const { orderNumber } = await context.params;

  try {
    const snapshot = await getAdminSnapshot();
    const order = snapshot.orders.find((item) => item.id === orderNumber);
    if (!order) return apiJson({ error: "Order not found." }, { status: 404 });
    if (!order.shipping) {
      return apiJson({ error: "This order is not set to delivery." }, { status: 409 });
    }
    if (!order.shipping.bookingEnabled) {
      return apiJson({
        error: "This shipment is not ready to book.",
        blockers: order.shipping.blockers,
        shipping: order.shipping,
      }, { status: 409 });
    }

    return apiJson({
      error: "Bob Go sandbox booking is scaffolded but no external booking call is enabled yet.",
      shipping: order.shipping,
    }, { status: 501 });
  } catch (error) {
    return apiJson(
      { error: error instanceof Error ? error.message : "Shipment readiness could not be checked." },
      { status: 503 },
    );
  }
}
