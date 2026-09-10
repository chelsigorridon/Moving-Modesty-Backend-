import { saveProduct } from "@/lib/admin-data";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { productInputSchema } from "@/lib/product-input";

export function OPTIONS() {
  return apiOptions();
}

export async function PATCH(request: Request, context: RouteContext<"/api/admin/products/[slug]">) {
  if (!getRequestAdmin(request)) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const parsed = productInputSchema.safeParse(body);
  if (!parsed.success) {
    return apiJson({ error: parsed.error.issues[0]?.message ?? "Check the product information." }, { status: 400 });
  }
  const { slug } = await context.params;
  try {
    const product = await saveProduct(parsed.data, slug);
    if (!product) return apiJson({ error: "Product not found." }, { status: 404 });
    return apiJson({ product });
  } catch (error) {
    return apiJson(
      { error: error instanceof Error ? error.message : "The product could not be updated." },
      { status: 503 }
    );
  }
}
