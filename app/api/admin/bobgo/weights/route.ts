import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { getShippingWeights, saveShippingWeights, shippingWeightInput, ShippingWeightConflict } from "@/lib/shipping-weights";

export function OPTIONS() { return apiOptions(); }
export async function GET(request: Request) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  try { return apiJson({ weights: await getShippingWeights() }); }
  catch { return apiJson({ error: "Product weights could not be loaded." }, { status: 503 }); }
}
export async function PATCH(request: Request) {
  const owner = await getRequestAdmin(request);
  if (!owner) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const parsed = shippingWeightInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: "Use measured whole grams between 1 and 30000, and confirm the measurements." }, { status: 400 });
  try { return apiJson(await saveShippingWeights(parsed.data, owner.email)); }
  catch (error) { return apiJson({ error: error instanceof ShippingWeightConflict ? error.message : "Product weights could not be saved." }, { status: error instanceof ShippingWeightConflict ? 409 : 503 }); }
}
