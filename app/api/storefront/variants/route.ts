import { apiJson } from "@/lib/api-response";
import { storefrontSizes } from "@/lib/catalogue-storefront";
export async function GET(request: Request) {
  const base = new URL(request.url).searchParams.get("base") || "";
  if (!/^[A-Za-z0-9-]{2,100}$/.test(base)) return apiJson({ error: "Invalid product." }, { status: 400 });
  try { return apiJson({ variants: (await storefrontSizes(base)).filter(Boolean) }); }
  catch { return apiJson({ error: "Product availability could not be checked. Please try again." }, { status: 503 }); }
}
