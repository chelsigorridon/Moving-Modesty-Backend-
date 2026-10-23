"use client";
/* eslint-disable react-hooks/refs -- The compiled portal stores this async transport; ref reads happen only when its effects request sample data, never during render. */
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";

const sample = { id: "MM-LOCAL-TRACKING", customer: "Sample Customer", email: "sample@example.invalid", phone: "0000000000", placedAt: "23 Oct, 01:15 SAST", total: 519,
  deliveryFee: 99, paymentStatus: "Paid", status: "Ready", deliveryMethod: "Courier", address: "Sample delivery address, Cape Town", items: [{ name: "Sample scarf", variant: "Example", quantity: 1, price: 420 }],
  workflow: { nextStatus: null, canCancel: false, guidance: "Local sample only." },
  shipping: { provider: "Bob Go", status: "Booked", courierStatus: "pending-collection", environment: "production", senderLocationName: "Sample collection address", trackingNumber: "LOCAL-SAMPLE-ONLY", courierName: "Example courier", serviceName: "Example service", bookingEnabled: false, blockers: [], weightGrams: 267, lengthCm: 25, widthCm: 20, heightCm: 3 } };

/** Real portal code; all transport is a closed, in-memory GET-only fixture. */
export default function TrackingReliabilityReview({ source }: { source: string }) {
  const remote = React.useRef("Booked"), offline = React.useRef(false);
  const [status, setStatus] = React.useState("Booked"), [failed, setFailed] = React.useState(false);
  const [reads, setReads] = React.useState(0), [generation, setGeneration] = React.useState(0);
  const Portal = React.useMemo(() => {
    const mod = { exports: {} as { default: React.ComponentType<{ view: string; apiBaseUrl: string }> } };
    const dependencies: Record<string, unknown> = { react: React, "react/jsx-runtime": jsxRuntime,
      framer: { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => false } };
    new Function("require", "module", "exports", "fetch", source)((name: string) => {
      if (!(name in dependencies)) throw new Error("Unexpected preview dependency"); return dependencies[name];
    }, mod, mod.exports, async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(url);
      if (parsed.origin !== "https://local-review.invalid" || parsed.pathname !== "/api/admin/data" || (init.method || "GET") !== "GET") throw new Error("This action is disabled in the local review.");
      setReads(value => value + 1);
      if (offline.current) throw new TypeError("Simulated offline status read");
      const full = Boolean(parsed.searchParams.get("order"));
      const order = { ...sample, detailsLoaded: full, items: full ? sample.items : [],
        shipping: { ...sample.shipping, status: remote.current, courierStatus: remote.current === "Cancelled" ? "cancelled" : "pending-collection" } };
      return Response.json({ orders: [order], bobGoConnection: { enabled: false, configured: false, environment: "production" } });
    });
    return mod.exports.default;
  }, [source]);
  return <main style={{ maxWidth: 1040, margin: "0 auto", padding: "20px 12px", color: "#302A24", fontFamily: "Inter, Arial, sans-serif" }}>
    <style>{`body{margin:0;background:#F5F3F0}.tracking-review-tools{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:16px 0}.tracking-review-tools button{min-height:44px;border:1px solid #a69e95;padding:10px 14px;color:#302a24;background:#eeEae6;font:inherit;cursor:pointer}`}</style>
    <h1 style={{ fontSize: 24 }}>Tracking · local review</h1>
    <p>Sample data only. No live requests, bookings or sync changes.</p>
    <div className="tracking-review-tools">
      <button type="button" onClick={() => { remote.current = "Cancelled"; setStatus("Cancelled"); window.dispatchEvent(new Event("focus")); }}>Simulate courier cancellation</button>
      <button type="button" aria-pressed={failed} onClick={() => { offline.current = !offline.current; setFailed(offline.current); }}>Simulated connection: {failed ? "Offline" : "Online"}</button>
      <button type="button" onClick={() => { remote.current = "Booked"; offline.current = false; setStatus("Booked"); setFailed(false); setReads(0); setGeneration(value => value + 1); }}>Reset sample</button>
    </div>
    <p style={{ fontSize: 14 }}>Sample server status: <strong>{status}</strong> · Read-only requests: {reads}. Updates on return to this tab or every minute while visible. Edits pause background checks.</p>
    <Portal key={generation} view="orders" apiBaseUrl="https://local-review.invalid" />
  </main>;
}
