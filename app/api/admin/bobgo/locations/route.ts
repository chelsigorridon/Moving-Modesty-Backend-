import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { findNearbyBobGoLocation, getConfiguredBobGoLocation } from "@/lib/integrations/bobgo/client";
import { getBobGoConfiguration } from "@/lib/integrations/bobgo/configuration";
import { parseLocation } from "@/lib/integrations/bobgo/protocol";
import { reportFailure } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

const CONSTANTIA_EMPORIUM = {
  lat: -34.02937198,
  lng: 18.44505579,
  lengthCm: 25,
  widthCm: 20.5,
  heightCm: 3.5,
  weightKg: 0.412,
};

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
    if (config.pickupPointLocationId && config.pickupPointProviderSlug) {
      const location = parseLocation(await getConfiguredBobGoLocation(), config.pickupPointLocationId, config.pickupPointProviderSlug, false);
      return apiJson({ connected: true, environment: config.environment, bookingEnabled: config.enabled,
        target: location.name || config.senderLocationName, locationId: config.pickupPointLocationId,
        provider: config.pickupPointProviderSlug, senderContactConfigured: Boolean(config.senderEmail && config.senderPhone) });
    }
    const lookup = await findNearbyBobGoLocation(CONSTANTIA_EMPORIUM);
    return apiJson({
      bookingEnabled: config.enabled,
      connected: false,
      environment: config.environment,
      target: "Constantia Emporium",
      match: lookup.matches[0] ?? null,
      matchCount: lookup.matches.length,
    });
  } catch (error) {
    const recorded = error && typeof error === "object" && "errorRef" in error ? error.errorRef : null;
    const incident = recorded ? null : await reportFailure(error, { operation: "courier_connection" });
    return apiJson(
      { error: "The Bob Go connection check could not be completed. Ask website support to check the account configuration.", errorRef: recorded || incident?.reference },
      { status: 502 },
    );
  }
}
