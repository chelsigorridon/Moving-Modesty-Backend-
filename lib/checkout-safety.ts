type CheckoutState = { status: string; paymentStatus: string };

export class CheckoutConflictError extends Error {
  readonly code: string;
  constructor(message: string, code = "CHECKOUT_CLOSED") {
    super(message);
    this.code = code;
  }
}

export function isPaymentFinal(status: string) {
  return status === "paid" || status === "refunded";
}

type OrderCustomer = { firstName: string; lastName: string; email: string; phone: string | null };
export function readOrderCustomer(snapshot: unknown, fallback: OrderCustomer): OrderCustomer {
  if (snapshot && typeof snapshot === "object") {
    const value = snapshot as Record<string, unknown>;
    if (["firstName", "lastName", "email", "phone"].every(key => typeof value[key] === "string")) {
      return { firstName: value.firstName as string, lastName: value.lastName as string, email: value.email as string, phone: value.phone as string };
    }
  }
  return { firstName: fallback.firstName, lastName: fallback.lastName, email: fallback.email, phone: fallback.phone };
}

export function assertCheckoutEditable(order: CheckoutState) {
  if (isPaymentFinal(order.paymentStatus) || order.status !== "new") {
    throw new CheckoutConflictError("This order is already paid or closed. Please start a new checkout.");
  }
}

export function sameCheckoutContents(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function checkoutContentSnapshot(input: {
  customer: { firstName: string; lastName: string; email: string; phone: string | null };
  deliveryMethod: string;
  address?: { line1: string; line2?: string | null; suburb?: string | null; city: string; province: string; postalCode: string } | null;
  items: Array<{ sku: string; quantity: number }>;
  total: string | number;
}) {
  return {
    customer: { firstName: input.customer.firstName, lastName: input.customer.lastName,
      email: input.customer.email.toLowerCase(), phone: input.customer.phone ?? "" },
    deliveryMethod: input.deliveryMethod,
    address: input.deliveryMethod === "courier" && input.address ? {
      line1: input.address.line1, line2: input.address.line2 || "", suburb: input.address.suburb || "",
      city: input.address.city, province: input.address.province, postalCode: input.address.postalCode,
    } : null,
    items: [...input.items].sort((a, b) => a.sku.localeCompare(b.sku)),
    total: Number(input.total).toFixed(2),
  };
}
