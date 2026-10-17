import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { checkConfiguredBobGoWaybillLink, retryConfiguredBobGoSync } from "@/lib/integrations/bobgo/order-sync-runtime";

export function OPTIONS() { return apiOptions(); }
export async function POST(request: Request, context: { params: Promise<{ orderNumber: string }> }) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null), { orderNumber } = await context.params;
  if (body?.confirm !== true || !["retry", "check_waybill"].includes(body?.action) || !/^MM-[A-Z0-9-]{1,70}$/i.test(orderNumber)) return apiJson({ error: "Confirm the order-sync check." }, { status: 400 });
  try {
    const result = await (body.action === "check_waybill" ? checkConfiguredBobGoWaybillLink(orderNumber) : retryConfiguredBobGoSync(orderNumber));
    return apiJson(result, { status: result.status === "disabled" ? 503 : result.status === "ineligible" ? 409 : 200 });
  } catch { return apiJson({ error: "Order sync needs checking. No duplicate order was requested." }, { status: 503 }); }
}
