import { saveProduct } from "@/lib/admin-data";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { productInputSchema } from "@/lib/product-input";

export function OPTIONS() {
  return apiOptions();
}

export async function POST(request: Request) {
  if (!getRequestAdmin(request)) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const parsed = productInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiJson({ error: parsed.error.issues[0]?.message ?? "Check the product information." }, { status: 400 });
  }
  try {
    const product = await saveProduct(parsed.data);
    return apiJson({ product }, { status: 201 });
  } catch (error) {
    return apiJson(
      { error: error instanceof Error ? error.message : "The product could not be created." },
      { status: 503 }
    );
  }
}
