import { isSyncRunnerAuthorized, runConfiguredBobGoSync } from "@/lib/integrations/bobgo/order-sync-runtime";
import { reportFailure } from "@/lib/monitoring";

export const runtime = "nodejs";
export const maxDuration = 120;
export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!isSyncRunnerAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  try {
    const result = await runConfiguredBobGoSync();
    return Response.json(result, { status: result.enabled ? 200 : 503, headers });
  } catch {
    const incident = await reportFailure(null, { operation: "courier_sync", code: "configuration" });
    return Response.json({ error: "Bob Go sync could not run.", errorRef: incident.reference }, { status: 503, headers });
  }
}
