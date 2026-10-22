import { getAdminOverview, getAdminSnapshot } from "@/lib/admin-data";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { getBobGoConfiguration } from "@/lib/integrations/bobgo/configuration";
import { getPayFastConfiguration } from "@/lib/integrations/payfast/configuration";
import { reportFailure } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return apiOptions();
}

export async function GET(request: Request) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  try {
    const url = new URL(request.url);
    const orderNumber = url.searchParams.get("order");
    const view = url.searchParams.get("view");
    if (orderNumber && (orderNumber.length > 80 || !/^[-a-z0-9]+$/i.test(orderNumber))) return apiJson({ error: "Invalid order number." }, { status: 400 });
    const snapshot = orderNumber ? await getAdminSnapshot({ orderNumber, includeProducts: false })
      : view ? await getAdminOverview(view === "orders" || view === "dashboard") : await getAdminSnapshot();
    if (orderNumber && !snapshot.orders.length) return apiJson({ error: "Order not found." }, { status: 404 });
    const bobGo = getBobGoConfiguration();
    // Reading the portal must not silently resolve an alert or write to orders.
    return apiJson({ ...snapshot, bobGoSetup: null, paymentEnvironment: getPayFastConfiguration().environment,
      bobGoConnection: { environment: bobGo.environment, enabled: bobGo.enabled,
        configured: bobGo.apiTokenConfigured } });
  } catch (error) {
    const incident = await reportFailure(error, { operation: "admin_load" });
    return apiJson(
      { error: "Admin data could not be loaded. Please try again shortly.", errorRef: incident.reference },
      { status: 503 }
    );
  }
}
