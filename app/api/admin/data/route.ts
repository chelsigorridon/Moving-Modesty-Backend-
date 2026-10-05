import { getAdminSnapshot } from "@/lib/admin-data";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { findNearbyBobGoLocation } from "@/lib/integrations/bobgo/client";
import { getBobGoConfiguration } from "@/lib/integrations/bobgo/configuration";
import { getPayFastConfiguration } from "@/lib/integrations/payfast/configuration";
import { reportFailure, resolveFailures } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return apiOptions();
}

const CONSTANTIA_EMPORIUM = {
  lat: -34.02937198,
  lng: 18.44505579,
  lengthCm: 25,
  widthCm: 20.5,
  heightCm: 3.5,
  weightKg: 0.412,
};

async function getBobGoSetupStatus() {
  const config = getBobGoConfiguration();
  if (!config.apiTokenConfigured || config.pickupPointLocationId) return null;

  try {
    const lookup = await findNearbyBobGoLocation(CONSTANTIA_EMPORIUM);
    const match = lookup.matches[0] ?? null;
    return { target: "Constantia Emporium", match, matchCount: lookup.matches.length };
  } catch (error) {
    await reportFailure(error, { operation: "courier_connection" });
    return { target: "Constantia Emporium", match: null, matchCount: 0 };
  }
}

export async function GET(request: Request) {
  if (!getRequestAdmin(request)) return apiJson({ error: "Unauthorized" }, { status: 401 });
  try {
    const [snapshot, bobGoSetup] = await Promise.all([
      getAdminSnapshot(),
      getBobGoSetupStatus(),
    ]);
    const bobGo = getBobGoConfiguration();
    await resolveFailures("admin_load");
    return apiJson({ ...snapshot, bobGoSetup, paymentEnvironment: getPayFastConfiguration().environment,
      bobGoConnection: { environment: bobGo.environment, enabled: bobGo.enabled,
        configured: Boolean(bobGo.apiTokenConfigured && bobGo.pickupPointLocationId && bobGo.pickupPointProviderSlug && bobGo.senderEmail && bobGo.senderPhone) } });
  } catch (error) {
    const incident = await reportFailure(error, { operation: "admin_load" });
    return apiJson(
      { error: "Admin data could not be loaded. Please try again shortly.", errorRef: incident.reference },
      { status: 503 }
    );
  }
}
