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
};

export function getBobGoConfiguration(): BobGoConfiguration {
  const environment = process.env.BOBGO_ENVIRONMENT === "production"
    ? "production"
    : "sandbox";

  return {
    enabled: process.env.BOBGO_INTEGRATION_ENABLED === "true",
    environment,
    apiBaseUrl: environment === "production"
      ? "https://api.bobgo.co.za"
      : "https://sandbox.bobgo.co.za",
    apiTokenConfigured: Boolean(process.env.BOBGO_API_TOKEN?.trim()),
    senderName: process.env.BOBGO_SENDER_NAME?.trim() || "Moving Modesty",
    senderEmail: process.env.BOBGO_SENDER_EMAIL?.trim() || "",
    senderPhone: process.env.BOBGO_SENDER_PHONE?.trim() || "",
    senderLocationName: process.env.BOBGO_SENDER_LOCATION_NAME?.trim() || "Constantia Emporium",
    pickupPointLocationId: process.env.BOBGO_PICKUP_POINT_LOCATION_ID?.trim() || undefined,
  };
}
