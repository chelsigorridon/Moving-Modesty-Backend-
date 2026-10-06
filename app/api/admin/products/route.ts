import { saveProduct } from "@/lib/admin-data";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { productInputSchema } from "@/lib/product-input";
import { reportFailure, resolveFailures } from "@/lib/monitoring";

export function OPTIONS() {
  return apiOptions();
}

export async function POST(request: Request) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const parsed = productInputSchema.safeParse(body);
  if (!parsed.success) {
    return apiJson({ error: parsed.error.issues[0]?.message ?? "Check the product information." }, { status: 400 });
  }
  try {
    const product = await saveProduct(parsed.data);
    if (!product) return apiJson({ error: "The product could not be created." }, { status: 503 });
    await resolveFailures("admin_product");
    return apiJson({ product }, { status: 201 });
  } catch (error) {
    const incident = await reportFailure(error, { operation: "admin_product" });
    return apiJson(
      { error: "The product could not be created. Please try again shortly.", errorRef: incident.reference },
      { status: 503 }
    );
  }
}
