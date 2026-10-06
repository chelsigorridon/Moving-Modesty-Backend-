import { saveProduct } from "@/lib/admin-data";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { productInputSchema } from "@/lib/product-input";
import { reportFailure, resolveFailures } from "@/lib/monitoring";

export function OPTIONS() {
  return apiOptions();
}

export async function PATCH(request: Request, context: RouteContext<"/api/admin/products/[slug]">) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const parsed = productInputSchema.safeParse(body);
  if (!parsed.success) {
    return apiJson({ error: parsed.error.issues[0]?.message ?? "Check the product information." }, { status: 400 });
  }
  const { slug } = await context.params;
  try {
    const product = await saveProduct(parsed.data, slug);
    if (!product) return apiJson({ error: "Product not found." }, { status: 404 });
    await resolveFailures("admin_product");
    return apiJson({ product });
  } catch (error) {
    const incident = await reportFailure(error, { operation: "admin_product" });
    return apiJson(
      { error: "The product could not be updated. Please try again shortly.", errorRef: incident.reference },
      { status: 503 }
    );
  }
}
