import "server-only";
import type { BobGoOrderPayload, OrderSyncConfiguration } from "./order-sync-policy";
import type { BobGoOrderSyncProvider } from "./order-sync";

export class BobGoSyncTransportError extends Error {
  readonly status?: number;
  constructor(status?: number) { super("Bob Go order synchronisation could not be verified."); this.name = "BobGoSyncTransportError"; this.status = status; }
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
// Unknown envelopes are errors, never an empty list that could authorise a POST.
function list(value: unknown, key: "orders" | "shipments") {
  const rows = Array.isArray(value) ? value : object(value)[key];
  if (!Array.isArray(rows) || rows.length > 2 || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new BobGoSyncTransportError();
  return rows as Record<string, unknown>[];
}
export function createBobGoSyncTransport(config: OrderSyncConfiguration, token: string, fetcher: typeof fetch = fetch): BobGoOrderSyncProvider {
  if (!config.enabled || !config.channelRef || config.channelRef === "not-activated" || /[\s\r\n]/.test(config.channelRef) || !token.trim() || /[\s\r\n]/.test(token) || token.startsWith("PASTE_")) throw new BobGoSyncTransportError();
  const base = config.environment === "production" ? "https://api.bobgo.co.za/v2" : "https://api.sandbox.bobgo.co.za/v2";
  async function request(path: string, payload?: BobGoOrderPayload) {
    try {
      const response = await fetcher(`${base}${path}`, { method: payload ? "POST" : "GET", redirect: "error", cache: "no-store",
        // A sales-channel key authenticates together with its store identifier.
        // Bearer-only requests can return 401 even when the key is valid.
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "bobgo-channel-identifier": config.channelRef, ...(payload ? { "Content-Type": "application/json" } : {}) },
        signal: AbortSignal.timeout(8000), ...(payload ? { body: JSON.stringify(payload) } : {}) });
      if (!response.ok) { await response.body?.cancel(); throw new BobGoSyncTransportError(response.status); }
      if (Number(response.headers.get("content-length")) > 1_000_000) { await response.body?.cancel(); throw new BobGoSyncTransportError(); }
      const reader = response.body?.getReader(); if (!reader) throw new BobGoSyncTransportError();
      let size = 0; const chunks: Uint8Array[] = [];
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1_000_000) throw new BobGoSyncTransportError(); chunks.push(value); } }
      finally { await reader.cancel().catch(() => undefined); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) { throw error instanceof BobGoSyncTransportError ? error : new BobGoSyncTransportError(); }
  }
  return {
    async findOrders(number: string) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/.test(number)) throw new BobGoSyncTransportError();
      // Include archived records: an archived copy still prevents duplication.
      const query = new URLSearchParams({ channel_order_number: number, limit: "2", offset: "0" });
      const active = list(await request(`/orders?${query}`), "orders");
      query.set("archived", "true"); const archived = list(await request(`/orders?${query}`), "orders");
      const unique = new Map<string, Record<string, unknown>>();
      for (const row of [...active, ...archived]) {
        if (row.channel_order_number !== number || !/^[1-9]\d{0,18}$/.test(String(row.id || ""))) throw new BobGoSyncTransportError();
        unique.set(String(row.id), row);
      }
      return [...unique.values()];
    },
    async createOrder(payload) { const result = await request("/orders", payload); return object(result).order || result; },
    async readShipment(id: string) {
      if (!/^[1-9]\d{0,18}$/.test(id)) throw new BobGoSyncTransportError();
      const rows = list(await request(`/shipments?${new URLSearchParams({ id, limit: "2", offset: "0" })}`), "shipments");
      if (rows.length !== 1 || String(rows[0].id) !== id) throw new BobGoSyncTransportError();
      return rows[0];
    },
  };
}
