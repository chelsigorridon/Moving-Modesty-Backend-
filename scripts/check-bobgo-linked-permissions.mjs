// GET only. No app imports, database access, sync runner, orders, rates or bookings.
// Run with a securely populated environment; never print credentials/provider bodies.
import { inspectLinkedBookingPermissions, linkedWaybillChangePermissions } from "../lib/integrations/bobgo/permissions.ts";

const report = { syncInvoked: false, ordersCreated: 0, waybillsCreated: 0, method: "GET" };
const token = process.env.BOBGO_ORDER_SYNC_API_TOKEN?.trim();
const channel = process.env.BOBGO_ORDER_SYNC_CHANNEL_REF?.trim();
const environment = process.env.BOBGO_ENVIRONMENT;
if (!token || !channel || !["sandbox", "production"].includes(environment)) {
  console.log(JSON.stringify({ ...report, status: "credentials_unavailable" }));
  process.exitCode = 1;
} else {
  const base = environment === "production" ? "https://api.bobgo.co.za/v2" : "https://api.sandbox.bobgo.co.za/v2";
  try {
    const response = await fetch(`${base}/general-data`, { method: "GET", redirect: "error", cache: "no-store",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "bobgo-channel-identifier": channel },
      signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); console.log(JSON.stringify({ ...report, environment, httpStatus: response.status, status: "permission_lookup_unavailable" })); }
    else {
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
        if (size > 1000000) throw new Error("Oversized response"); chunks.push(value); } }
      finally { await reader.cancel().catch(() => {}); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = inspectLinkedBookingPermissions(body);
      const cancellation = inspectLinkedBookingPermissions(body, linkedWaybillChangePermissions);
      console.log(JSON.stringify({ ...report, environment, httpStatus: response.status, ...result,
        cancellation,
        status: result.allowed ? "role_permissions_present_not_booking_acceptance" : result.known ? "required_permissions_missing" : "role_permissions_not_exposed" }));
    }
  } catch { console.log(JSON.stringify({ ...report, environment, status: "permission_lookup_failed" })); process.exitCode = 1; }
}
