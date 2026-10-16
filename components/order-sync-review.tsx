"use client";
import { useRef, useState } from "react";
import OrderSyncStatus from "./order-sync-status";
import { buildBobGoOrderPayload, matchRemoteOrder, orderSyncView, type OrderSyncState, type OrderSyncErrorCode } from "@/lib/integrations/bobgo/order-sync-policy";

const samplePayload = () => buildBobGoOrderPayload({ orderNumber: "MM-SYNC-DEMO", contact: { name: "TEST Customer", email: "customer@example.invalid", phone: "0821234567" },
  address: { company: "", line1: "20 Example Road", line2: "", suburb: "Example Suburb", city: "Cape Town", province: "Western Cape", postalCode: "7800" },
  subtotal: 450, deliveryFee: 99, total: 549, discountAmount: 0,
  items: [{ sku: "DEMO-NOT-FOR-SALE", description: "Example product — not for sale", quantity: 1, unitPrice: 450, weightGrams: 120 }] });

export default function OrderSyncReview() {
  const [scenario, setScenario] = useState("success"), [status, setStatus] = useState<OrderSyncState>("queued");
  const [errorCode, setErrorCode] = useState<OrderSyncErrorCode | null>(null), [creates, setCreates] = useState(0), [notifications, setNotifications] = useState(1);
  const [tracking, setTracking] = useState(false);
  const remote = useRef<ReturnType<typeof samplePayload> & { id: number } | null>(null);
  const hasAttempted = useRef(false);
  function reset(next = scenario) {
    remote.current = null; hasAttempted.current = false; setScenario(next); setStatus("queued"); setErrorCode(null);
    setCreates(0); setNotifications(1); setTracking(false);
  }
  function run() {
    if (status === "synced") return;
    const payload = samplePayload();
    if (remote.current) {
      if (matchRemoteOrder(remote.current, payload)) { setStatus("synced"); setErrorCode(null); }
      else { setStatus("needs_attention"); setErrorCode("remote_mismatch"); }
      return;
    }
    if (!hasAttempted.current && scenario === "outage") {
      hasAttempted.current = true; setStatus("retry"); setErrorCode("lookup_failed"); return;
    }
    hasAttempted.current = true;
    remote.current = { ...payload, id: 90001 }; setCreates(count => count + 1);
    if (scenario === "timeout") { setStatus("checking"); setErrorCode("create_unconfirmed"); }
    else { setStatus("synced"); setErrorCode(null); }
  }
  const view = orderSyncView({ status, lastErrorCode: errorCode, remoteOrderId: status === "synced" ? "90001 — DEMO ONLY" : null }, true);
  return <details className="mm-delivery-review__simulation">
    <summary>Try order-sync examples — review only</summary>
    <p className="mm-admin__helper">This is an in-browser simulation using sample data. It does not run the database worker, contact Bob Go or create a waybill. The database worker is covered separately by automated tests. The 120 g weight below is an example, not a verified Moving Modesty weight.</p>
    <label className="mm-admin__field">Example scenario<select value={scenario} onChange={event => reset(event.target.value)}>
      <option value="success">Successful order sync</option><option value="outage">Bob Go temporarily unavailable</option><option value="timeout">Order created, but response timed out</option>
    </select></label>
    <OrderSyncStatus value={view} />
    <div className="mm-delivery__actions"><button type="button" className="mm-admin__button" disabled={status === "synced"} onClick={run}>
      {status === "synced" ? "Example already synced" : status === "checking" ? "Check existing example order" : status === "retry" ? "Service restored — retry example" : "Run simulated sync"}</button>
      <button type="button" className="mm-admin__secondary-button" onClick={() => setNotifications(count => count + 1)}>Repeat payment notification</button>
      <button type="button" className="mm-admin__text-button" onClick={() => reset()}>Reset example</button></div>
    <p>Example payment notifications: <strong>{notifications}</strong> · Sync jobs: <strong>1</strong> · Bob Go order copies: <strong>{creates}</strong></p>
    <p>Example payment stays <strong>Paid · R549</strong>. No extra payment, stock deduction or waybill is created by synchronising an order.</p>
    {status === "synced" ? <><button type="button" className="mm-admin__secondary-button" onClick={() => setTracking(true)}>Show example shipment tracking update</button>
      {tracking ? <p role="status">Example courier reports: <strong>delivered</strong>. This is tracking information, not a refund, stock change or new booking.</p> : null}</> : null}
  </details>;
}
