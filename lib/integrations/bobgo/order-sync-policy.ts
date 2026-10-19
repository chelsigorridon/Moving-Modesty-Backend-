import { z } from "zod";
import { courierAddressInput, courierContactInput } from "../../delivery-input.ts";
import { bobGoAddressesMatch } from "./address-policy.ts";

export type OrderSyncState = "queued" | "syncing" | "retry" | "checking" | "synced" | "needs_attention";
export type OrderSyncConfiguration = { enabled: boolean; environment: "sandbox" | "production"; channelRef: string };

// Deliberately not environment-switchable in this review release. There is no
// activation until domain/channel setup, weights and shipment/order linkage
// have been verified. The prepared transport/runner cannot bypass this gate.
export function getOrderSyncConfiguration(): OrderSyncConfiguration {
  return { enabled: false, environment: "sandbox", channelRef: "not-activated" };
}

export const orderSyncMessages = {
  weights_missing: "Verified individual product weights are still needed.",
  invalid_order: "Check the delivery contact, address and order items before syncing.",
  discounted_order: "Discounted order values need their Bob Go mapping verified before syncing.",
  lookup_failed: "Bob Go could not be checked. Sync can be retried without changing payment.",
  create_unconfirmed: "Bob Go has not confirmed the order. Check for an existing order before any retry.",
  remote_mismatch: "The Bob Go order does not match safely. Website support must check it; do not create another.",
  duplicate_remote: "More than one matching Bob Go order was found. Website support must reconcile them.",
  delivery_changed: "Delivery changed after submission. The Bob Go copy needs checking; no new order was created.",
  ineligible: "This order is no longer eligible for delivery synchronisation.",
  shipment_exists: "A waybill is already booked or processing. Reconcile the existing shipment instead of creating an unfulfilled Bob Go order.",
} as const;
export type OrderSyncErrorCode = keyof typeof orderSyncMessages;
export class OrderSyncInputError extends Error {
  readonly code: OrderSyncErrorCode;
  constructor(code: OrderSyncErrorCode) { super(orderSyncMessages[code]); this.code = code; }
}

const itemInput = z.object({ sku: z.string().trim().min(1).max(160), description: z.string().trim().min(1).max(300),
  unitPrice: z.number().finite().nonnegative().multipleOf(0.01), quantity: z.number().int().positive().max(1000),
  weightGrams: z.number().int().min(1).max(30000) });
export type BobGoOrderSource = {
  orderNumber: string; contact: { name: string; email: string; phone: string };
  address: { company: string; line1: string; line2: string; suburb: string; city: string; province: string; postalCode: string };
  deliveryFee: number; subtotal: number; total: number; discountAmount: number;
  items: Array<{ sku: string; description: string; unitPrice: number; quantity: number; weightGrams?: number | null }>;
};
export type BobGoOrderPayload = {
  channel_order_number: string; customer_name: string; customer_surname: string; customer_email: string; customer_phone: string;
  currency: "ZAR"; buyer_selected_shipping_cost: number; buyer_selected_shipping_method: string; payment_status: "paid";
  delivery_address: { company: string; street_address: string; local_area: string; city: string; zone: string; country: "ZA"; code: string };
  order_items: Array<{ description: string; sku: string; unit_price: number; qty: number; unit_weight_kg: number }>;
};
const moneyCents = (value: number) => Math.round(value * 100);
// PostgreSQL JSONB reorders object keys. Compare content canonically while
// retaining array order; ordinary JSON.stringify would report false edits.
export function stableOrderPayload(value: unknown) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export function buildBobGoOrderPayload(source: BobGoOrderSource): BobGoOrderPayload {
  if (!source.items.length || source.items.some(item => !Number.isInteger(item.weightGrams) || Number(item.weightGrams) < 1)) throw new OrderSyncInputError("weights_missing");
  const contact = courierContactInput.safeParse(source.contact), address = courierAddressInput.safeParse(source.address);
  const items = z.array(itemInput).min(1).max(100).safeParse(source.items);
  const names = source.contact.name.trim().split(/\s+/);
  const totals = [source.subtotal, source.deliveryFee, source.total, source.discountAmount];
  if (!contact.success || !address.success || !items.success || names.length < 2 || !/^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/.test(source.orderNumber)
    || totals.some(value => !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(moneyCents(value)) || Math.abs(value * 100 - moneyCents(value)) > 0.00001)
    || moneyCents(source.discountAmount) > moneyCents(source.subtotal)
    || moneyCents(source.subtotal) - moneyCents(source.discountAmount) + moneyCents(source.deliveryFee) !== moneyCents(source.total)
    || source.items.reduce((sum, item) => sum + moneyCents(item.unitPrice) * item.quantity, 0) !== moneyCents(source.subtotal)) {
    throw new OrderSyncInputError("invalid_order");
  }
  return { channel_order_number: source.orderNumber, customer_name: names[0], customer_surname: names.slice(1).join(" "),
    customer_email: contact.data.email, customer_phone: contact.data.phone, currency: "ZAR", payment_status: "paid",
    buyer_selected_shipping_cost: source.deliveryFee, buyer_selected_shipping_method: "Website delivery — courier selected when booking",
    delivery_address: { company: address.data.company, street_address: [address.data.line1, address.data.line2].filter(Boolean).join(", "),
      local_area: address.data.suburb, city: address.data.city, zone: address.data.province, country: "ZA", code: address.data.postalCode },
    order_items: discountedBobGoItems(items.data, moneyCents(source.discountAmount)) };
}

// Allocate the recorded merchandise discount in integer cents, largest remainder
// first. Split a line into two price tiers only when quantity prevents an exact
// cent-valued unit price. Total quantities, weights and paid total stay exact.
function discountedBobGoItems(items: Array<z.infer<typeof itemInput>>, discount: number): BobGoOrderPayload["order_items"] {
  const gross = items.map(item => moneyCents(item.unitPrice) * item.quantity), subtotal = gross.reduce((sum, value) => sum + value, 0);
  const shares = gross.map((value, index) => { const numerator = BigInt(discount) * BigInt(value), denominator = BigInt(subtotal || 1);
    return { index, cents: Number(numerator / denominator), remainder: numerator % denominator }; });
  let remaining = discount - shares.reduce((sum, row) => sum + row.cents, 0);
  for (const row of [...shares].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) if (remaining > 0) { row.cents++; remaining--; }
  return items.flatMap((item, index) => {
    const net = gross[index] - shares[index].cents, lower = Math.floor(net / item.quantity), higherQty = net % item.quantity;
    const base = { description: item.description, sku: item.sku, unit_weight_kg: item.weightGrams / 1000 };
    return [ ...(item.quantity > higherQty ? [{ ...base, unit_price: lower / 100, qty: item.quantity - higherQty }] : []),
      ...(higherQty ? [{ ...base, unit_price: (lower + 1) / 100, qty: higherQty }] : []) ];
  });
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
const normal = (value: unknown) => typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
export function matchRemoteOrder(remote: unknown, expected: BobGoOrderPayload): string | null {
  const row = object(remote), address = object(row.delivery_address), id = typeof row.id === "number" || typeof row.id === "string" ? String(row.id) : "";
  if (!/^[1-9]\d{0,18}$/.test(id) || row.channel_order_number !== expected.channel_order_number || row.payment_status !== "paid"
    || row.currency !== "ZAR" || normal(row.customer_email) !== normal(expected.customer_email)
    || normal(row.customer_name) !== normal(expected.customer_name) || normal(row.customer_surname) !== normal(expected.customer_surname)
    || courierContactInput.shape.phone.safeParse(row.customer_phone).data !== expected.customer_phone
    || row.buyer_selected_shipping_cost === null || !Number.isFinite(Number(row.buyer_selected_shipping_cost)) || moneyCents(Number(row.buyer_selected_shipping_cost)) !== moneyCents(expected.buyer_selected_shipping_cost)) return null;
  if (!bobGoAddressesMatch(address, expected.delivery_address)) return null;
  if (!Array.isArray(row.order_items) || row.order_items.length !== expected.order_items.length) return null;
  const numberPresent = (value: unknown) => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value));
  if (row.order_items.some(value => { const item = object(value); return !numberPresent(item.qty) || !numberPresent(item.unit_price) || !numberPresent(item.unit_weight_kg); })) return null;
  const remoteItems = row.order_items.map(value => { const item = object(value); return [item.sku, Number(item.qty), moneyCents(Number(item.unit_price)), Number(item.unit_weight_kg)]; }).sort();
  const expectedItems = expected.order_items.map(item => [item.sku, item.qty, moneyCents(item.unit_price), item.unit_weight_kg]).sort();
  return JSON.stringify(remoteItems) === JSON.stringify(expectedItems) ? id : null;
}

const waybillLinkMessages: Record<string, string> = {
  fulfillment_lookup_failed: "The existing Bob Go waybill could not be checked. No new shipment was booked.",
  fulfillment_mismatch: "The Bob Go fulfilment or waybill does not match safely. Support must check it; do not book another.",
  fulfillment_multiple: "Bob Go reports multiple or split fulfilments. Support must reconcile them; no waybill was replaced.",
  fulfillment_conflict: "Delivery details or an existing waybill conflict with Bob Go. Support must check both records before another booking.",
};
export function orderSyncView(row?: { status: string; lastErrorCode: string | null; remoteOrderId: string | null; waybillLinkErrorCode?: string | null }, enabled = false, linkedBookingEnabled = false) {
  const status = !enabled ? "Not enabled" : !row ? "Waiting to sync" : row.waybillLinkErrorCode ? "Needs attention" : ({ queued: "Waiting to sync", syncing: "Syncing", retry: "Needs attention", checking: "Needs checking", needs_attention: "Needs attention", synced: "Synced with Bob Go" } as Record<string, string>)[row.status] || "Needs attention";
  return { status, message: !enabled ? "Order synchronisation is not activated. Payment and manual courier booking are separate."
    : row?.lastErrorCode ? linkedBookingEnabled && row.lastErrorCode === "delivery_changed"
      ? "Delivery details changed. Compare couriers here to update the existing Bob Go order before booking; no second order will be created."
      : orderSyncMessages[row.lastErrorCode as OrderSyncErrorCode] || orderSyncMessages.invalid_order
    : row?.waybillLinkErrorCode ? waybillLinkMessages[row.waybillLinkErrorCode] || waybillLinkMessages.fulfillment_mismatch
    : row?.remoteOrderId ? linkedBookingEnabled ? "Compare couriers and book the waybill here against this existing Bob Go order. Do not create a second booking in Bob Go."
      : "Book this linked order in Bob Go. Its existing waybill will be checked and linked back; do not book a separate shipment in the portal." : undefined,
    remoteOrderId: enabled ? row?.remoteOrderId || undefined : undefined };
}
