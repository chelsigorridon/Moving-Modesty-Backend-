import "server-only";
import { createBobGoSyncTransport, BobGoSyncTransportError } from "./order-sync-transport";
import type { OrderSyncConfiguration } from "./order-sync-policy";
import { remoteId } from "./linked-booking-policy";
import { record } from "./protocol";

export function createLinkedBookingTransport(config: OrderSyncConfiguration, token: string, fetcher: typeof fetch = fetch) {
  const reader = createBobGoSyncTransport(config, token, fetcher);
  const base = config.environment === "production" ? "https://api.bobgo.co.za/v2" : "https://api.sandbox.bobgo.co.za/v2";
  async function request(path: string, method: "GET" | "POST" | "PATCH", payload?: Record<string, unknown>, timeout = 12000) {
    try {
      // No redirects, no POST retries, no browser-supplied host or credential.
      const response = await fetcher(`${base}${path}`, { method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeout),
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "bobgo-channel-identifier": config.channelRef,
          ...(payload ? { "Content-Type": "application/json" } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      if (!response.ok) { await response.body?.cancel(); throw new BobGoSyncTransportError(response.status); }
      const stream = response.body?.getReader(); if (!stream) throw new BobGoSyncTransportError();
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const { done, value } = await stream.read(); if (done) break; size += value.length;
        if (size > 1_000_000) throw new BobGoSyncTransportError(); chunks.push(value); } }
      finally { await stream.cancel().catch(() => undefined); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) { throw error instanceof BobGoSyncTransportError ? error : new BobGoSyncTransportError(); }
  }
  return { findOrders: reader.findOrders, readShipment: reader.readShipment, readOrderFulfillments: reader.readOrderFulfillments,
    readPermissions: () => request("/general-data", "GET"),
    readCollections: () => request("/accounts/address-books?limit=100&offset=0", "GET"),
    async readOrder(id: string) {
      const body = record(await request(`/orders?${new URLSearchParams({ id: remoteId(id), include_relations: "true", limit: "2", offset: "0" })}`, "GET"));
      if (!Array.isArray(body.orders) || body.orders.length !== 1 || String(record(body.orders[0]).id) !== id) throw new BobGoSyncTransportError();
      return body.orders[0];
    },
    updateOrder: (payload: Record<string, unknown>) => request("/orders", "PATCH", payload),
    orderRates: (payload: Record<string, unknown>) => request("/orders/rates", "POST", payload, 8000),
    createFulfillment: (payload: Record<string, unknown>) => request("/order-fulfillments", "POST", payload),
    // Bob Go's dashboard cancels the fulfilment by its own ID. This also
    // releases the order's fulfilled quantities; cancelling only the shipment
    // would not safely authorise a replacement order fulfilment.
    cancelFulfillment: (id: string) => request("/order-fulfillments/cancel", "POST", { id: Number(remoteId(id)) }),
  };
}
export type LinkedBookingProvider = ReturnType<typeof createLinkedBookingTransport>;
