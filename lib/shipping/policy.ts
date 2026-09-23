export const STANDARD_DELIVERY_FEE = 99;
export const FREE_DELIVERY_THRESHOLD = 1500;

export type ShippingMethod = "delivery" | "collection" | "to_be_confirmed";

export type ShippingQuote = {
  subtotal: number;
  deliveryFee: number;
  total: number;
  qualifiesForFreeDelivery: boolean;
  amountUntilFreeDelivery: number;
};

function money(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateShippingQuote(
  subtotal: number,
  method: ShippingMethod,
): ShippingQuote {
  const safeSubtotal = money(Math.max(0, subtotal));
  const qualifiesForFreeDelivery = safeSubtotal >= FREE_DELIVERY_THRESHOLD;
  const deliveryFee = method === "delivery" && safeSubtotal > 0 && !qualifiesForFreeDelivery
    ? STANDARD_DELIVERY_FEE
    : 0;

  return {
    subtotal: safeSubtotal,
    deliveryFee,
    total: money(safeSubtotal + deliveryFee),
    qualifiesForFreeDelivery,
    amountUntilFreeDelivery: method === "delivery"
      ? money(Math.max(0, FREE_DELIVERY_THRESHOLD - safeSubtotal))
      : 0,
  };
}
