import { apiJson, apiOptions } from "@/lib/api-response";
import { CheckoutValidationError, checkoutOrderSchema, upsertCheckoutOrder } from "@/lib/checkout-order";
import { CheckoutConflictError } from "@/lib/checkout-safety";
import { reportFailure, resolveFailures } from "@/lib/monitoring";

export function OPTIONS() {
  return apiOptions();
}

export async function POST(request: Request) {
  const parsed = checkoutOrderSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiJson(
      { error: parsed.error.issues[0]?.message ?? "Check your checkout details." },
      { status: 400 },
    );
  }

  try {
    const order = await upsertCheckoutOrder(parsed.data);
    await resolveFailures("checkout_save");
    return apiJson({ order });
  } catch (error) {
    const expected = error instanceof CheckoutConflictError || error instanceof CheckoutValidationError;
    const incident = expected ? null : await reportFailure(error, { operation: "checkout_save" });
    return apiJson(
      { error: expected && error instanceof Error ? error.message : "Your order could not be saved. Please try again shortly.", errorRef: incident?.reference,
        code: error instanceof CheckoutConflictError ? error.code : undefined },
      { status: error instanceof CheckoutConflictError ? 409 : error instanceof CheckoutValidationError ? 400 : 503 },
    );
  }
}
