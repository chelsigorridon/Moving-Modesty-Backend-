import { getAdminSnapshot } from "@/lib/admin-data";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { findNearbyBobGoLocation } from "@/lib/integrations/bobgo/client";
import { getBobGoConfiguration } from "@/lib/integrations/bobgo/configuration";
import { getPayFastConfiguration } from "@/lib/integrations/payfast/configuration";

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
    if (match) console.info("[Bob Go setup] Constantia Emporium match", JSON.stringify(match));
    return { target: "Constantia Emporium", match, matchCount: lookup.matches.length };
  } catch (error) {
    console.warn(
      "[Bob Go setup] Location lookup failed",
      error instanceof Error ? error.message : "Unknown lookup error",
    );
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
    return apiJson({ ...snapshot, bobGoSetup, paymentEnvironment: getPayFastConfiguration().environment });
  } catch (error) {
    return apiJson(
      { error: error instanceof Error ? error.message : "Admin data could not be loaded." },
      { status: 503 }
    );
  }
}
