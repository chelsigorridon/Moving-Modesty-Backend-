import { apiJson, apiOptions } from "@/lib/api-response";
import { CheckoutValidationError, checkoutOrderSchema, upsertCheckoutOrder } from "@/lib/checkout-order";

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
    return apiJson({ order: await upsertCheckoutOrder(parsed.data) });
  } catch (error) {
    return apiJson(
      { error: error instanceof Error ? error.message : "Your order could not be saved." },
      { status: error instanceof CheckoutValidationError ? 400 : 503 },
    );
  }
}
