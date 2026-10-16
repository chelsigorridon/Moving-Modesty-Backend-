import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { bobGoRequest } from "@/lib/integrations/bobgo/client";
import { getBobGoConfiguration } from "@/lib/integrations/bobgo/configuration";
import { reportFailure } from "@/lib/monitoring";

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
    return apiJson({ connected: true, environment: config.environment, bookingEnabled: config.enabled,
      target: "Collection and delivery are chosen per order", checkScope: "account_read_only" });
  } catch (error) {
    const recorded = error && typeof error === "object" && "errorRef" in error ? error.errorRef : null;
    const incident = recorded ? null : await reportFailure(error, { operation: "courier_connection" });
    return apiJson(
      { error: "The Bob Go connection check could not be completed. Ask website support to check the account configuration.", errorRef: recorded || incident?.reference },
      { status: 502 },
    );
  }
}
