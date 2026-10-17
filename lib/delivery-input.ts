import { z } from "zod";
import { normalizeCheckoutPhone, normalizeCheckoutProvince, southAfricanProvinces } from "./checkout-input.ts";

export const courierAddressInput = z.object({
  company: z.string().trim().max(150).default(""),
  line1: z.string().trim().min(2, "Enter the street address.").max(180),
  line2: z.string().trim().max(180).default(""),
  suburb: z.string().trim().min(2, "Enter the suburb.").max(100),
  city: z.string().trim().min(2, "Enter the city.").max(100),
  province: z.string().transform(normalizeCheckoutProvince).pipe(z.enum(southAfricanProvinces)),
  postalCode: z.string().trim().regex(/^\d{4}$/, "Enter a four-digit postal code."),
});
export const courierContactInput = z.object({
  name: z.string().trim().min(2, "Enter the contact name.").max(160),
  email: z.string().trim().email().max(180).toLowerCase(),
  phone: z.string().max(30).transform(normalizeCheckoutPhone)
    .refine(value => /^(?:0\d{9}|\+?27\d{9})$/.test(value), "Enter a valid South African contact number."),
});
export const pickupPointInput = z.object({
  id: z.string().trim().regex(/^[1-9]\d{0,11}$/, "Choose a Bob Go pickup point."),
  providerSlug: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/i),
  name: z.string().trim().min(1).max(200),
});
export const courierEndpointInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("door"), contact: courierContactInput, address: courierAddressInput }),
  z.object({ kind: z.literal("pickup_point"), contact: courierContactInput, point: pickupPointInput }),
]);
export const courierPlanInput = z.object({
  version: z.literal(1),
  collection: courierEndpointInput,
  delivery: courierEndpointInput,
  collectionInstructions: z.string().trim().max(1000).default(""),
  deliveryInstructions: z.string().trim().max(1000).default(""),
  customerApprovedPickup: z.boolean().default(false),
}).superRefine((plan, context) => {
  if (plan.collection.kind === "pickup_point" && plan.delivery.kind === "pickup_point"
    && plan.collection.point.providerSlug !== plan.delivery.point.providerSlug) {
    context.addIssue({ code: "custom", path: ["delivery", "point"], message: "Both pickup points must use the same courier." });
  }
  if (plan.delivery.kind === "pickup_point" && !plan.customerApprovedPickup) {
    context.addIssue({ code: "custom", path: ["customerApprovedPickup"], message: "Confirm that the customer agreed to collect from this pickup point." });
  }
});
export type CourierAddress = z.infer<typeof courierAddressInput>;
export type CourierContact = z.infer<typeof courierContactInput>;
export type PickupPoint = z.infer<typeof pickupPointInput>;
export type CourierEndpoint = z.infer<typeof courierEndpointInput>;
export type CourierPlan = z.infer<typeof courierPlanInput>;

export const deliveryEditInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delivery"), expectedRevision: z.number().int().nonnegative(), plan: courierPlanInput,
    confirmed: z.literal(true), rememberCollection: z.boolean().default(false) }),
  z.object({ action: z.literal("private_note"), expectedRevision: z.number().int().nonnegative(), note: z.string().trim().max(3000) }),
]);
export type DeliveryEditInput = z.infer<typeof deliveryEditInput>;

export function deliveryEditBlocker(order: { status: string; paymentStatus: string; deliveryMethod: string }, shipment?: { status: string; providerShipmentId?: string | null } | null) {
  if (order.deliveryMethod !== "courier") return "This order is not a courier delivery. Its paid delivery method has not been changed.";
  if (shipment && (["booking", "booked", "cancelled"].includes(shipment.status) || shipment.providerShipmentId)) return "This waybill is booked or may still be processing. Changes must be confirmed in Bob Go; editing this order locally cannot amend the courier booking.";
  if (!["new", "confirmed", "processing", "ready"].includes(order.status)) return "Delivery details cannot be changed at this order's current stage.";
  if (order.paymentStatus !== "paid") return "Wait for verified payment before changing the delivery setup.";
  return null;
}

export function courierRoute(plan: CourierPlan) {
  return { collection: plan.collection.kind, delivery: plan.delivery.kind };
}
export function courierRouteLabel(plan: CourierPlan) {
  const from = plan.collection.kind === "door" ? "Courier collects from sender" : `Drop off at ${plan.collection.point.name}`;
  const to = plan.delivery.kind === "door" ? "Customer's door" : `Customer collects at ${plan.delivery.point.name}`;
  return `${from} → ${to}`;
}
export function planProvider(plan: CourierPlan): string | undefined {
  return plan.collection.kind === "pickup_point" ? plan.collection.point.providerSlug
    : plan.delivery.kind === "pickup_point" ? plan.delivery.point.providerSlug : undefined;
}
export function bobGoDoorAddress(address: CourierAddress) {
  return { type: address.company ? "business" : "residential", company: address.company, street_address: [address.line1, address.line2].filter(Boolean).join(", "),
    local_area: address.suburb, city: address.city, zone: address.province, country: "ZA", code: address.postalCode };
}
