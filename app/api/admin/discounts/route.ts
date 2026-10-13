import { apiJson, apiOptions } from "@/lib/api-response";
import { apiOriginAllowed } from "@/lib/api-security";
import { getRequestAdmin } from "@/lib/auth";
import { discountsEnabled, listDiscounts, saveDiscount } from "@/lib/discounts";
import { discountSaveSchema, DiscountConflictError, DiscountValidationError } from "@/lib/discount-input";
import { reportFailure } from "@/lib/monitoring";

export const runtime = "nodejs";
export function OPTIONS() { return apiOptions(); }
async function authorized(request: Request) {
  const admin = await getRequestAdmin(request);
  return admin && ["owner", "manager"].includes(admin.role) ? admin : null;
}
export async function GET(request: Request) {
  if (!await authorized(request)) return apiJson({ error: "Unauthorized" }, { status: 401 });
  if (!discountsEnabled()) return apiJson({ error: "Discounts have not been activated." }, { status: 503 });
  try { return apiJson(await listDiscounts()); }
  catch (error) { const incident = await reportFailure(error, { operation: "admin_update" }); return apiJson({ error: "Discounts could not be loaded.", errorRef: incident.reference }, { status: 503 }); }
}
export async function POST(request: Request) {
  if (!apiOriginAllowed(request)) return apiJson({ error: "Origin not allowed." }, { status: 403 });
  const admin = await authorized(request);
  if (!admin) return apiJson({ error: "Unauthorized" }, { status: 401 });
  if (!discountsEnabled()) return apiJson({ error: "Discounts have not been activated." }, { status: 503 });
  const parsed = discountSaveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: parsed.error.issues[0]?.message || "Check the discount information." }, { status: 400 });
  try { return apiJson({ discount: await saveDiscount(parsed.data, admin.email) }); }
  catch (error) {
    if (error instanceof DiscountConflictError || error instanceof DiscountValidationError) return apiJson({ error: error.message }, { status: error instanceof DiscountConflictError ? 409 : 400 });
    const incident = await reportFailure(error, { operation: "admin_update" });
    return apiJson({ error: "The save could not be confirmed. Reload Discounts before trying again.", errorRef: incident.reference }, { status: 503 });
  }
}
