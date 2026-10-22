import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { getOrderSyncConfiguration } from "@/lib/integrations/bobgo/order-sync-policy";
import { getLinkedBookingConfiguration } from "@/lib/integrations/bobgo/linked-booking-policy";
import { preparedSyncCredentials } from "@/lib/integrations/bobgo/order-sync-runtime";
import { createLinkedBookingTransport } from "@/lib/integrations/bobgo/linked-booking-transport";
import { inspectLinkedBookingPermissions, linkedWaybillChangePermissions } from "@/lib/integrations/bobgo/permissions";

export const dynamic = "force-dynamic";
export function OPTIONS() { return apiOptions(); }
export async function GET(request: Request) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const sync = getOrderSyncConfiguration(), linked = getLinkedBookingConfiguration();
  const status = { orderSyncEnabled: sync.enabled, linkedBookingEnabled: linked.enabled, newOrdersFrom: sync.createdAfter || null,
    scope: "new_orders_only", automaticWaybillBooking: false, historicalImport: false };
  try {
    const credentials = preparedSyncCredentials(sync);
    if (!credentials) return apiJson({ ...status, connected: false }, { status: 503 });
    const permissions = await createLinkedBookingTransport(sync, credentials.token).readPermissions();
    const copying = inspectLinkedBookingPermissions(permissions, ["API_/orders:GET", "API_/orders:POST"]);
    const booking = inspectLinkedBookingPermissions(permissions), cancellation = inspectLinkedBookingPermissions(permissions, linkedWaybillChangePermissions);
    return apiJson({ ...status, connected: true, orderSyncPermissions: copying.allowed, bookingPermissions: booking.allowed, cancellationPermissions: cancellation.allowed,
      checkScope: "configuration_and_permissions_GET_only" }, { status: copying.allowed && booking.allowed && cancellation.allowed ? 200 : 503 });
  } catch { return apiJson({ ...status, connected: false, error: "Bob Go sales-channel configuration needs checking." }, { status: 503 }); }
}
