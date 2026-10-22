import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { bobGoRequest } from "@/lib/integrations/bobgo/client";
import { getBobGoConfiguration } from "@/lib/integrations/bobgo/configuration";
import { reportFailure } from "@/lib/monitoring";
import { getOrderSyncConfiguration } from "@/lib/integrations/bobgo/order-sync-policy";
import { getLinkedBookingConfiguration } from "@/lib/integrations/bobgo/linked-booking-policy";
import { preparedSyncCredentials } from "@/lib/integrations/bobgo/order-sync-runtime";
import { createLinkedBookingTransport } from "@/lib/integrations/bobgo/linked-booking-transport";
import { inspectLinkedBookingPermissions, linkedBookingPermissions, linkedWaybillChangePermissions } from "@/lib/integrations/bobgo/permissions";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return apiOptions();
}

export async function GET(request: Request) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });

  const config = getBobGoConfiguration();
  if (!config.apiTokenConfigured) {
    return apiJson({ error: "Bob Go API token is not configured." }, { status: 503 });
  }

  try {
    // Read-only account access, independent of a locker/provider/parcel. Never
    // expose returned orders or mistake this for a successful courier booking.
    const response = await bobGoRequest("/orders?limit=1&offset=0", undefined, { operation: "courier_connection" });
    if (!response || typeof response !== "object") throw new Error("Invalid Bob Go connection response.");
    const sync = getOrderSyncConfiguration(), linked = getLinkedBookingConfiguration();
    if (sync.enabled) {
      const credentials = preparedSyncCredentials(sync);
      if (!credentials || !linked.enabled || linked.createdAfter !== sync.createdAfter) throw new Error("Linked activation is incomplete.");
      const permissions = await createLinkedBookingTransport(sync, credentials.token).readPermissions();
      if (!inspectLinkedBookingPermissions(permissions, [...linkedBookingPermissions, ...linkedWaybillChangePermissions, "API_/orders:POST"]).allowed) throw new Error("Sales-channel permissions are incomplete.");
    }
    return apiJson({ connected: true, environment: config.environment, bookingEnabled: config.enabled,
      target: sync.enabled ? "New-order sync and linked booking enabled. Sales-channel permissions verified; older orders excluded."
        : "Collection and delivery are chosen per order", newOrdersFrom: sync.createdAfter || null, checkScope: sync.enabled ? "account_and_channel_permissions_read_only" : "account_read_only" });
  } catch (error) {
    const recorded = error && typeof error === "object" && "errorRef" in error ? error.errorRef : null;
    const incident = recorded ? null : await reportFailure(error, { operation: "courier_connection" });
    return apiJson(
      { error: "The Bob Go connection check could not be completed. Ask website support to check the account configuration.", errorRef: recorded || incident?.reference },
      { status: 502 },
    );
  }
}
