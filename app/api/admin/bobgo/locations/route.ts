import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { findNearbyBobGoLocation } from "@/lib/integrations/bobgo/client";
import { getBobGoConfiguration } from "@/lib/integrations/bobgo/configuration";

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
  if (!getRequestAdmin(request)) return apiJson({ error: "Unauthorized" }, { status: 401 });

  const config = getBobGoConfiguration();
  if (!config.apiTokenConfigured) {
    return apiJson({ error: "Bob Go API token is not configured." }, { status: 503 });
  }

  try {
    const lookup = await findNearbyBobGoLocation(CONSTANTIA_EMPORIUM);
    return apiJson({
      bookingEnabled: config.enabled,
      target: "Constantia Emporium",
      match: lookup.matches[0] ?? null,
      matchCount: lookup.matches.length,
    });
  } catch (error) {
    return apiJson(
      { error: error instanceof Error ? error.message : "The Bob Go location lookup could not be completed." },
      { status: 502 },
    );
  }
}
