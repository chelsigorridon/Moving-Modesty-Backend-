import { z } from "zod";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { getAdminSnapshot } from "@/lib/admin-data";
import { getCourierQuotes, getCourierWaybill, refreshCourierShipment, ShippingConflict } from "@/lib/integrations/bobgo/shipping";
import { parcelInput } from "@/lib/integrations/bobgo/protocol";
import { reportFailure } from "@/lib/monitoring";

export const maxDuration = 60;
export function OPTIONS() { return apiOptions(); }
const actionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("quote"), parcel: parcelInput, additionalCover: z.boolean() }),
  z.object({ action: z.literal("refresh") }), z.object({ action: z.literal("waybill") }),
]);
export async function POST(request: Request, context: { params: Promise<{ orderNumber: string }> }) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
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
    const previousRef = error && typeof error === "object" && "errorRef" in error ? error.errorRef : undefined;
    const incident = previousRef || error instanceof ShippingConflict ? null : await reportFailure(error, { operation: body.data.action === "quote" ? "courier_quote" : body.data.action === "waybill" ? "courier_waybill" : "courier_refresh", orderNumber });
    return apiJson({ error: error instanceof ShippingConflict ? error.message : "Courier request failed. Please try again shortly; check Bob Go before booking again.", errorRef: previousRef || incident?.reference }, { status: error instanceof ShippingConflict ? 409 : 502 });
  }
}
