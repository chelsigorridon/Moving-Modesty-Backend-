import { z } from "zod";
import { apiJson, apiOptions } from "@/lib/api-response";
import { apiOriginAllowed } from "@/lib/api-security";
import { checkoutPricing } from "@/lib/discounts";
import { discountCodeSchema, DiscountValidationError } from "@/lib/discount-input";
import { resolveLiveCheckoutItem } from "@/lib/catalogue-storefront";
import { reportFailure } from "@/lib/monitoring";

export const runtime = "nodejs";
export function OPTIONS() { return apiOptions(); }
const schema = z.object({ code: discountCodeSchema, fulfilmentMethod: z.enum(["delivery", "collection", "to_be_confirmed"]),
  items: z.array(z.object({ sku: z.string().trim().min(3).max(80), quantity: z.number().int().min(1).max(10) })).min(1).max(20) });
export async function POST(request: Request) {
  if (!apiOriginAllowed(request)) return apiJson({ error: "Origin not allowed." }, { status: 403 });
  const checked = schema.safeParse(await request.json().catch(() => null));
  if (!checked.success) return apiJson({ error: checked.error.issues[0]?.message || "Check your discount code and cart." }, { status: 400 });
  try {
    const quantities = new Map<string, number>();
    checked.data.items.forEach(item => { const sku = item.sku.toUpperCase(); quantities.set(sku, (quantities.get(sku) || 0) + item.quantity); });
    if ([...quantities.values()].some(quantity => quantity > 10)) throw new DiscountValidationError("Limit each variant to 10 items per order.");
    const lines = await Promise.all([...quantities].map(async ([sku, quantity]) => {
      const product = await resolveLiveCheckoutItem(sku);
      if (!product || !product.available) throw new DiscountValidationError("A product is no longer available. Please refresh your cart.");
      return { sku: product.sku, productId: product.productId, lineTotal: product.price * quantity };
    }));
    const quote = await checkoutPricing(checked.data.code, lines, checked.data.fulfilmentMethod);
    // The preview is not a payment reservation or trusted client-side total.
    // Order save and PayFast independently validate the code again.
    return apiJson({ quote });
  } catch (error) {
    if (error instanceof DiscountValidationError) return apiJson({ error: error.message }, { status: 400 });
    const incident = await reportFailure(error, { operation: "checkout_save" });
    return apiJson({ error: "The code could not be checked. Please try again.", errorRef: incident.reference }, { status: 503 });
  }
}
