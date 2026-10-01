import "server-only";

export type BobGoConfiguration = {
  enabled: boolean;
  environment: "sandbox" | "production";
  apiBaseUrl: string;
  apiTokenConfigured: boolean;
  senderName: string;
  senderEmail: string;
  senderPhone: string;
  senderLocationName: string;
  pickupPointLocationId?: string;
  pickupPointProviderSlug?: string;
};

export function getBobGoConfiguration(): BobGoConfiguration {
  const environment = process.env.BOBGO_ENVIRONMENT === "production"
    ? "production"
    : "sandbox";
  const configuredPickupPoint = process.env.BOBGO_PICKUP_POINT_LOCATION_ID?.trim();

  return {
    enabled: process.env.BOBGO_INTEGRATION_ENABLED === "true",
    environment,
    apiBaseUrl: environment === "production"
      ? "https://api.bobgo.co.za/v2"
      : "https://api.sandbox.bobgo.co.za/v2",
    apiTokenConfigured: hasConfiguredBobGoToken(),
    senderName: process.env.BOBGO_SENDER_NAME?.trim() || "Moving Modesty",
    senderEmail: process.env.BOBGO_SENDER_EMAIL?.trim() || "",
    senderPhone: process.env.BOBGO_SENDER_PHONE?.trim() || "",
    senderLocationName: process.env.BOBGO_SENDER_LOCATION_NAME?.trim() || "Constantia Emporium",
    pickupPointLocationId: configuredPickupPoint && !configuredPickupPoint.startsWith("PASTE_")
      ? configuredPickupPoint
      : undefined,
    pickupPointProviderSlug: process.env.BOBGO_PICKUP_POINT_PROVIDER_SLUG?.trim() || undefined,
  };
}

export function getBobGoApiToken() {
  const token = process.env.BOBGO_API_TOKEN?.trim();
  if (!token || token.startsWith("PASTE_")) {
    throw new Error("The Bob Go API token is not configured.");
  }
  return token;
}

function hasConfiguredBobGoToken() {
  const token = process.env.BOBGO_API_TOKEN?.trim();
  return Boolean(token && !token.startsWith("PASTE_"));
}
