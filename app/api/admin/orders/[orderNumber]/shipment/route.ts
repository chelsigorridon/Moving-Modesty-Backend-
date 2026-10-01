import { z } from "zod";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { getAdminSnapshot } from "@/lib/admin-data";
import { getCourierQuotes, getCourierWaybill, refreshCourierShipment, ShippingConflict } from "@/lib/integrations/bobgo/shipping";
import { parcelInput } from "@/lib/integrations/bobgo/protocol";

export const maxDuration = 60;
export function OPTIONS() { return apiOptions(); }
const actionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("quote"), parcel: parcelInput, additionalCover: z.boolean() }),
  z.object({ action: z.literal("refresh") }), z.object({ action: z.literal("waybill") }),
]);
export async function POST(request: Request, context: { params: Promise<{ orderNumber: string }> }) {
  if (!getRequestAdmin(request)) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const body = actionInput.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiJson({ error: "Enter a valid packed weight in grams and length, width and height in centimetres." }, { status: 400 });
  const { orderNumber } = await context.params;
  try {
    const input = body.data;
    if (input.action === "waybill") return apiJson(await getCourierWaybill(orderNumber));
    const result = input.action === "quote" ? await getCourierQuotes(orderNumber, input.parcel, input.additionalCover)
      : await refreshCourierShipment(orderNumber);
    const snapshot = await getAdminSnapshot();
    return apiJson({ ...result, order: snapshot.orders.find(order => order.id === orderNumber) });
  } catch (error) {
    return apiJson({ error: error instanceof Error ? error.message : "Bob Go could not complete this request." }, { status: error instanceof ShippingConflict ? 409 : 502 });
  }
}
