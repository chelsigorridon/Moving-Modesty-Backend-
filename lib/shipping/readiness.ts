export type ShipmentReadinessInput = {
  deliveryMethod: "courier" | "collection" | "to_be_confirmed";
  paymentStatus: "pending" | "paid" | "failed" | "refunded";
  hasDeliveryAddress: boolean;
  weightGrams?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  integrationEnabled: boolean;
  apiTokenConfigured: boolean;
  senderContactConfigured: boolean;
  pickupPointLocationId?: string;
};

export function shipmentBookingBlockers(input: ShipmentReadinessInput): string[] {
  const blockers: string[] = [];
  if (input.deliveryMethod !== "courier") blockers.push("This order is not set to delivery.");
  if (input.paymentStatus !== "paid") blockers.push("Payment must be confirmed first.");
  if (!input.hasDeliveryAddress) blockers.push("A delivery address is required.");
  if (!input.weightGrams) blockers.push("Packed weight is still required.");
  if (!input.lengthCm || !input.widthCm || !input.heightCm) {
    blockers.push("Packed length, width and height are still required.");
  }
  if (!input.pickupPointLocationId) {
    blockers.push("The Bob Go API pickup-point ID still needs to be confirmed.");
  }
  if (!input.senderContactConfigured) blockers.push("Private sender contact details are incomplete.");
  if (!input.apiTokenConfigured) blockers.push("The Bob Go API token is not configured.");
  if (!input.integrationEnabled) blockers.push("Bob Go booking is intentionally disabled.");
  return blockers;
}
