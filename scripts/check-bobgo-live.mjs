// Read-only diagnostics. Never imports the application, database or sync runner.
// Only status codes, public origins and response field names are reported.
const report = { automaticSyncInvoked: false, ordersCreated: 0, waybillsCreated: 0 };
const inspect = async (url, headers = {}) => {
  const response = await fetch(url, { method: "GET", redirect: "manual", cache: "no-store", headers, signal: AbortSignal.timeout(15000) });
  if (Number(response.headers.get("content-length")) > 1000000) { await response.body?.cancel(); throw new Error("Oversized response"); }
  return response;
};
try {
  // With no order/token parameters this route redirects before any DB access.
  const response = await inspect("https://movingmodesty.vercel.app/api/payments/payfast/return");
  const location = response.headers.get("location");
  report.productionStore = { httpStatus: response.status, redirectOrigin: location ? new URL(location).origin : null,
    matchesFinalDomain: location ? new URL(location).origin === "https://movingmodesty.com" : false };
  await response.body?.cancel();
  const store = await inspect("https://movingmodesty.com/");
  report.publicDomain = { httpStatus: store.status }; await store.body?.cancel();
} catch { report.productionStoreCheckFailed = true; }
const token = process.env.BOBGO_ORDER_SYNC_API_TOKEN?.trim(), channel = process.env.BOBGO_ORDER_SYNC_CHANNEL_REF?.trim();
if (token && channel) {
  const headers = { Accept: "application/json", Authorization: `Bearer ${token}`, "bobgo-channel-identifier": channel };
  try {
    const response = await inspect("https://api.bobgo.co.za/v2/orders?limit=1&offset=0", headers);
    report.channel = { httpStatus: response.status, identifierMatchesFinalDomain: channel === "movingmodesty.com" };
    if (response.ok) {
      // Bounded reader: do not log order IDs, values, addresses or contacts.
      const reader = response.body.getReader(); let size = 0; const chunks = [];
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
        if (size > 1000000) throw new Error("Oversized response"); chunks.push(value); } }
      finally { await reader.cancel().catch(() => {}); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")), rows = Array.isArray(body) ? body : body?.orders;
      report.channel.recognizedOrderResponse = Array.isArray(rows);
      report.channel.exampleOrderFieldNames = rows?.[0] ? Object.keys(rows[0]) : [];
    } else await response.body?.cancel();
  } catch { report.channelCheckFailed = true; }
}
console.log(JSON.stringify(report));
