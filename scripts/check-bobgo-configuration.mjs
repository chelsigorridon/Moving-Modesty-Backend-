// Run with `vercel env run -e production -- node scripts/check-bobgo-configuration.mjs`.
// Vercel does not export Secret values. Never mistake that for a missing credential.
console.log(JSON.stringify({
  courierEnvironment: ["production", "sandbox"].includes(process.env.BOBGO_ENVIRONMENT) ? process.env.BOBGO_ENVIRONMENT : "not-readable",
  courierBookingEnabled: process.env.BOBGO_INTEGRATION_ENABLED === "true",
  senderContactConfigured: Boolean(process.env.BOBGO_SENDER_EMAIL && process.env.BOBGO_SENDER_PHONE),
  legacyPickupPointConfigured: Boolean(process.env.BOBGO_PICKUP_POINT_LOCATION_ID && process.env.BOBGO_PICKUP_POINT_PROVIDER_SLUG),
  automaticSyncInvoked: false, ordersCreated: 0, waybillsCreated: 0,
}));
