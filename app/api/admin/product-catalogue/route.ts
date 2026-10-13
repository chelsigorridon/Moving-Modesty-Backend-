import { z } from "zod";
import { apiJson, apiOptions } from "@/lib/api-response";
import { apiOriginAllowed } from "@/lib/api-security";
import { getRequestAdmin } from "@/lib/auth";
import { liveCatalogueEnabled, listLiveCatalogue, saveLiveCatalogue, initializeLiveCatalogue, publishLiveCatalogue } from "@/lib/catalogue-live";
import { CatalogueConflictError } from "@/lib/catalogue-drafts";
import { catalogueSaveSchema } from "@/lib/catalogue-input";
import { reportFailure } from "@/lib/monitoring";

export const maxDuration = 60;
export const runtime = "nodejs";
export function OPTIONS() { return apiOptions(); }
async function authorized(request: Request) {
  const admin = await getRequestAdmin(request);
  return admin && ["owner", "manager"].includes(admin.role) ? admin : null;
}
export async function GET(request: Request) {
  if (!await authorized(request)) return apiJson({ error: "Unauthorized" }, { status: 401 });
  if (!liveCatalogueEnabled()) return apiJson({ error: "Product management has not been activated." }, { status: 503 });
  try { const products = await listLiveCatalogue(); return apiJson({ products, needsSetup: !products.length }); }
  catch (error) { const incident = await reportFailure(error, { operation: "admin_product" }); return apiJson({ error: "Products could not be loaded.", errorRef: incident.reference }, { status: 503 }); }
}
export async function POST(request: Request) {
  if (!apiOriginAllowed(request)) return apiJson({ error: "Origin not allowed." }, { status: 403 });
  const admin = await authorized(request);
  if (!admin) return apiJson({ error: "Unauthorized" }, { status: 401 });
  if (!liveCatalogueEnabled()) return apiJson({ error: "Product management has not been activated." }, { status: 503 });
  const input = await request.json().catch(() => null);
  try {
    if (input?.action === "initialize") { await initializeLiveCatalogue(); return apiJson({ products: await listLiveCatalogue() }); }
    if (input?.action === "publish") {
      const checked = z.object({ id: z.string().uuid(), expectedRevision: z.number().int().positive() }).safeParse(input);
      if (!checked.success) return apiJson({ error: "Invalid publish request." }, { status: 400 });
      const product = await publishLiveCatalogue(checked.data.id, checked.data.expectedRevision, admin.email);
      return apiJson({ product, published: true, cmsSynced: true });
    }
    const checked = catalogueSaveSchema.extend({ stockVersion: z.string().regex(/^[a-f0-9]{64}$/).optional() }).safeParse(input);
    if (!checked.success) return apiJson({ error: checked.error.issues[0]?.message || "Check the product information." }, { status: 400 });
    return apiJson({ product: await saveLiveCatalogue(checked.data), published: false });
  } catch (error) {
    if (error instanceof CatalogueConflictError) return apiJson({ error: error.message }, { status: 409 });
    const incident = await reportFailure(error, { operation: "admin_product" });
    return apiJson({ error: "The operation could not be confirmed. Reload Products before retrying; your draft is retained.", errorRef: incident.reference }, { status: 503 });
  }
}
