export type OrderSyncConfiguration = { enabled: boolean; environment: "sandbox" | "production"; channelRef: string; createdAfter?: string };

// One persisted activation boundary, shared by sync and linked booking. Never
// derive this from Date.now(): redeploys must not move the historical boundary.
export function newOrderConfiguration(flag: string, env: Record<string, string | undefined> = process.env): OrderSyncConfiguration {
  const start = env.BOBGO_NEW_ORDERS_FROM || "";
  if (env.VERCEL_ENV !== "production" || env[flag] !== "true" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(start)
    || !Number.isFinite(Date.parse(start)) || new Date(start).toISOString() !== start) {
    return { enabled: false, environment: "sandbox", channelRef: "not-activated" };
  }
  return { enabled: true, environment: "production", channelRef: "movingmodesty.com", createdAfter: start };
}

export function validSyncScope(config: OrderSyncConfiguration) {
  return config.createdAfter ? Number.isFinite(Date.parse(config.createdAfter)) : config.environment !== "production";
}

export function isOrderInSyncScope(order: { createdAt: Date }, config: OrderSyncConfiguration) {
  return validSyncScope(config) && Number.isFinite(order.createdAt?.getTime())
    && (!config.createdAfter || order.createdAt.getTime() >= Date.parse(config.createdAfter));
}
