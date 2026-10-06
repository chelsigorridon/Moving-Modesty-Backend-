import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { getOrderTrace } from "@/lib/order-trace";
import { reportFailure } from "@/lib/monitoring";

export function OPTIONS() { return apiOptions(); }
export async function GET(request: Request, context: { params: Promise<{ orderNumber: string }> }) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const { orderNumber } = await context.params;
  try {
    const trace = await getOrderTrace(orderNumber);
    return trace ? apiJson(trace) : apiJson({ error: "Order not found." }, { status: 404 });
  } catch (error) {
    const incident = await reportFailure(error, { operation: "admin_load" });
    return apiJson({ error: "Order trace is temporarily unavailable.", errorRef: incident.reference }, { status: 503 });
  }
}
