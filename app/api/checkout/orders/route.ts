import { apiJson, apiOptions } from "@/lib/api-response";
import { CheckoutValidationError, checkoutOrderSchema, upsertCheckoutOrder } from "@/lib/checkout-order";
import { CheckoutConflictError } from "@/lib/checkout-safety";
import { DiscountValidationError } from "@/lib/discount-input";
import { reportFailure, resolveFailures } from "@/lib/monitoring";
import { readLimitedJson, RequestBodyError } from "@/lib/request-body";
import { consumeCheckoutAttempt } from "@/lib/checkout-rate-limit";

export function OPTIONS() {
  return apiOptions();
}

export async function POST(request: Request) {
  try {
    const parsed = checkoutOrderSchema.safeParse(await readLimitedJson(request, 32_768));
    if (!parsed.success) {
      return apiJson(
        { error: parsed.error.issues[0]?.message ?? "Check your checkout details." },
        { status: 400 },
      );
    }

    const limit = await consumeCheckoutAttempt(request, "save");
    if (!limit.allowed) return apiJson({ error: "Too many checkout attempts. Please wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
    const order = await upsertCheckoutOrder(parsed.data);
    await resolveFailures("checkout_save");
    return apiJson({ order });
  } catch (error) {
    if (error instanceof RequestBodyError) return apiJson({ error: error.message }, { status: error.status });
    const expected = error instanceof CheckoutConflictError || error instanceof CheckoutValidationError || error instanceof DiscountValidationError;
    const incident = expected ? null : await reportFailure(error, { operation: "checkout_save" });
    return apiJson(
      { error: expected && error instanceof Error ? error.message : "Your order could not be saved. Please try again shortly.", errorRef: incident?.reference,
        code: error instanceof CheckoutConflictError ? error.code : undefined },
      { status: error instanceof CheckoutConflictError ? 409 : expected ? 400 : 503 },
    );
  }
}
