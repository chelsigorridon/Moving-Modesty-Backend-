import { deliveryRunnerAuthorized, runDeliveryUpdates } from "@/lib/integrations/bobgo/delivery-runtime";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  if (!deliveryRunnerAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try { return Response.json(await runDeliveryUpdates(true)); }
  catch { return Response.json({ error: "Delivery updates need checking." }, { status: 503 }); }
}
