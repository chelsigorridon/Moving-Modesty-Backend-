"use client";
import { useRef, useState, type FormEvent } from "react";
import type { AdminOrder } from "@/lib/admin-types";
import DeliveryEditor from "./delivery-editor";
import ParcelEditor from "./parcel-editor";

type Rate = { providerName: string; serviceName: string; amount: number; quoteToken: string };
type Snapshot = { order: AdminOrder | null; enabled: boolean; archived: boolean };
type Action = { order?: AdminOrder; message?: string };
const money = (amount: number) => `R${amount.toFixed(2)}`;

export default function CourierTest() {
  // Keep owner credentials/session in memory only. Sandbox payment opens in a
  // separate tab, so returning from it cannot accidentally submit a live form.
  const [token, setToken] = useState(""), [showPassword, setShowPassword] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [editing, setEditing] = useState(false);
  const [parcel, setParcel] = useState({ weightGrams: "", lengthCm: "", widthCm: "", heightCm: "" });
  const [measured, setMeasured] = useState(false), [rates, setRates] = useState<Rate[]>([]), [choice, setChoice] = useState("");
  const [approved, setApproved] = useState("");
  const [archiveConfirmed, setArchiveConfirmed] = useState(false);
  const order = snapshot?.order, selected = rates.find(rate => rate.quoteToken === choice);
  function clearQuotes() { setRates([]); setChoice(""); setApproved(""); }
  async function request<T>(path: string, body?: unknown, method = "POST", session = token): Promise<T> {
    const response = await fetch(path, { method: body === undefined ? "GET" : method, cache: "no-store",
      headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The request could not be confirmed. Refresh before continuing.");
    return result;
  }
  async function run(callback: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try { await callback(); } catch (caught) { setError(caught instanceof Error ? caught.message : "Request failed. Refresh before continuing."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function refresh(session = token) { setSnapshot(await request<Snapshot>("/api/admin/courier-test", undefined, "GET", session)); clearQuotes(); setMeasured(false); }
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    await run(async () => {
      const result = await request<{ token: string }>("/api/admin/login", { email: String(data.get("email") || ""), password: String(data.get("password") || "") });
      setToken(result.token); await refresh(result.token);
    });
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget), value = (key: string) => String(data.get(key) || "").trim();
    await run(async () => { setSnapshot(await request<Snapshot>("/api/admin/courier-test", { action: "create", confirm: data.has("confirm"),
      contact: { name: "Test Test", email: value("email"), phone: value("phone") },
      address: { company: "", line1: value("line1"), line2: value("line2"), suburb: value("suburb"), city: value("city"), province: value("province"), postalCode: value("postalCode") } })); });
  }
  async function payment() {
    await run(async () => {
      const result = await request<{ action: string; fields: Record<string, string> }>("/api/admin/courier-test", { action: "payment" });
      if (result.action !== "https://sandbox.payfast.co.za/eng/process") throw new Error("Payment stopped: this must use PayFast sandbox, never the live payment gateway.");
      const form = document.createElement("form"); form.method = "POST"; form.action = result.action; form.target = "_blank"; form.rel = "noopener noreferrer";
      for (const [name, value] of Object.entries(result.fields)) { const field = document.createElement("input"); field.type = "hidden"; field.name = name; field.value = value; form.appendChild(field); }
      document.body.appendChild(form); form.submit(); form.remove();
      setNotice("PayFast sandbox opened in a separate tab. Complete its simulated payment, then return here and refresh. A browser return alone does not verify payment.");
    });
  }
  async function update(path: string, body: unknown, method = "POST") {
    const result = await request<Action>(path, body, method);
    if (result.order) setSnapshot(current => current ? { ...current, order: result.order! } : current);
    else await refresh();
    clearQuotes(); setNotice(result.message || "Saved.");
  }
  const path = order ? `/api/admin/orders/${encodeURIComponent(order.id)}` : "";
  const details = order?.deliveryDetails;
  const testDetails = details && !details.plan ? { ...details, draftPlan: { ...details.draftPlan,
    collection: { kind: "pickup_point" as const, contact: details.draftPlan.collection.contact, point: { id: "", providerSlug: "", name: "Choose your drop-off point" } } } } : details;
  return <main className="courier-test mm-admin">
    <p className="courier-test__eyebrow">MOVING MODESTY / OWNER-ONLY TEST</p><h1>One real courier test</h1>
    <p className="mm-admin__notice"><strong>Sandbox payment · Real courier cost.</strong> The R5 order amount is simulated—no customer payment is received. Bob Go booking is real and chargeable. Sales-channel sync stays off. Cancelling a waybill does not guarantee a refund or stop a driver already on the way.</p>
    <p>No product stock or normal order emails are used. Bob Go or the courier may still send delivery notifications.</p>
    {error ? <p className="mm-admin__error" role="alert">{error}</p> : null}{notice ? <p className="mm-admin__notice" role="status">{notice}</p> : null}
    {!token ? <form onSubmit={signIn} className="courier-test__card"><h2>Owner sign-in</h2><p>Use the existing Moving Modesty administrator account. Do not enter Bob Go or PayFast credentials here.</p>
      <label className="mm-admin__field">Email<input name="email" type="email" autoComplete="username" required /></label>
      <label className="mm-admin__field">Password<input name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required /></label>
      <button type="button" className="mm-admin__text-button" aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? "Hide password" : "Show password"}</button>
      <button className="mm-admin__button" disabled={busy}>{busy ? "Checking…" : "Sign in"}</button></form>
      : <><div className="courier-test__actions"><button className="mm-admin__secondary-button" disabled={busy} onClick={() => void run(() => refresh())}>Refresh TEST order</button>
        <button className="mm-admin__text-button" disabled={busy} onClick={() => void run(async () => { await request("/api/admin/logout", {}); setToken(""); setSnapshot(null); clearQuotes(); })}>Sign out</button></div>
      {snapshot?.archived ? <p className="mm-admin__notice">The single TEST order has been archived. No further test order will be created.</p>
      : !order ? !snapshot?.enabled ? <p className="mm-admin__notice">The private test is disabled. Nothing has been created.</p> : <form onSubmit={create} className="courier-test__card"><h2>1. Create the single TEST order</h2>
        <p>Recipient: <strong>Test Test</strong>. Enter a real delivery address and contact details. You will choose the drop-off point and type the packed measurements later; nothing is booked now.</p>
        <div className="courier-test__grid">{([["email", "Contact email", "email"], ["phone", "Contact phone", "tel"], ["line1", "Street address", "text"], ["line2", "Address line 2 (optional)", "text"], ["suburb", "Suburb", "text"], ["city", "City", "text"], ["province", "Province", "text"], ["postalCode", "Postal code", "text"]] as const).map(([name, label, type]) => <label key={name} className="mm-admin__field">{label}<input name={name} type={type} required={name !== "line2"} /></label>)}</div>
        <label className="mm-delivery__check"><input type="checkbox" name="confirm" required />Create one clearly labelled TEST order. I understand its PayFast payment will not be real.</label><button className="mm-admin__button" disabled={busy}>Create TEST order—not a waybill</button></form>
      : <section className="courier-test__card"><h2>{order.id}</h2><p><strong>{order.customer}</strong> · {order.paymentStatus === "Paid" ? "Sandbox payment verified—no funds received" : order.paymentStatus} · {order.status}</p>
        <p>{order.address}</p><p>Waybill: <strong>{order.shipping?.trackingNumber || "Not booked"}</strong></p>
        {order.paymentStatus !== "Paid" ? <><button className="mm-admin__button" disabled={busy || !snapshot?.enabled} onClick={() => void payment()}>Open PayFast sandbox—simulate R5</button><p>After paying in sandbox, use Refresh TEST order. Only a verified server notification can confirm it.</p></> : <>
          {order.workflow?.nextStatus && ["Preparing", "Ready"].includes(order.workflow.nextStatus) ? <button className="mm-admin__secondary-button" disabled={busy} onClick={() => void run(() => update(path, { status: order.workflow!.nextStatus }, "PATCH"))}>{order.workflow.actionLabel}</button> : null}
          {testDetails ? <DeliveryEditor key={testDetails.revision} details={testDetails} disabled={busy} onEditingChange={value => { setEditing(value); clearQuotes(); setMeasured(false); }}
            save={async payload => { await update(`${path}/delivery`, payload, "PATCH"); setMeasured(false); }}
            searchPoints={query => request(`/api/admin/bobgo/pickup-points?q=${encodeURIComponent(query)}`)}
            changeWaybill={testDetails.waybillChange?.action === "prepare_replacement" ? undefined : async payload => { await update(`${path}/shipment-change`, payload); }} /> : null}
          {order.status === "Ready" && details?.plan && details.canEdit && !editing ? <section className="courier-test__quotes">
            <ParcelEditor value={parcel} disabled={busy} change={value => { setParcel(value); setMeasured(false); clearQuotes(); }} loadPackages={async () => (await request<{ packages: Array<{ id: string; name: string; lengthCm: number; widthCm: number; heightCm: number }> }>("/api/admin/bobgo/packages")).packages} />
            <label className="mm-delivery__check"><input type="checkbox" checked={measured} disabled={busy} onChange={event => { setMeasured(event.target.checked); clearQuotes(); }} />I have checked the real packed measurements, chosen drop-off point and delivery address.</label>
            <button className="mm-admin__button" disabled={busy || !measured || Object.values(parcel).some(value => !Number(value))} onClick={() => void run(async () => {
              const result = await request<{ rates: Rate[] }>(`${path}/shipment`, { action: "quote", additionalCover: false, parcel: Object.fromEntries(Object.entries(parcel).map(([key, value]) => [key, Number(value)])) });
              setRates(result.rates); setChoice(""); setApproved("");
            })}>Get live courier quotes—no booking</button>
            {rates.length ? <><label className="mm-admin__field">Courier and service<select value={choice} disabled={busy} onChange={event => { setChoice(event.target.value); setApproved(""); }}><option value="">Choose a live quote</option>{rates.map(rate => <option key={rate.quoteToken} value={rate.quoteToken}>{rate.providerName} · {rate.serviceName} · {money(rate.amount)}</option>)}</select></label>
              {selected ? <><p className="mm-admin__notice"><strong>Quoted real courier cost: {money(selected.amount)}</strong> to Zarina’s Bob Go account. The sandbox payment does not pay this cost. Final courier charges can differ after weighing or measuring. One booking attempt only; an uncertain result must be checked, not retried.</p>
                <label className="mm-delivery__check"><input type="checkbox" checked={approved === choice} disabled={busy} onChange={event => setApproved(event.target.checked ? choice : "")} />I approve this real booking quoted at {money(selected.amount)}. I understand final courier charges can vary and cancellation/refund is not guaranteed.</label>
                <button className="mm-admin__button" disabled={busy || approved !== choice} onClick={() => void run(async () => {
                  const approval = await request<{ costApproval: string }>("/api/admin/courier-test", { action: "approve_cost", quoteToken: selected.quoteToken, amount: selected.amount, confirmRealCharge: true });
                  await update(`${path}/book-shipment`, { quoteToken: selected.quoteToken, confirm: true, testCostApproval: approval.costApproval });
                })}>Book real TEST waybill · {money(selected.amount)}</button></> : null}</> : null}
          </section> : null}
          {["Booked", "Booking"].includes(order.shipping?.status || "") ? <button className="mm-admin__secondary-button" disabled={busy} onClick={() => void run(() => update(`${path}/shipment`, { action: "refresh" }))}>Check live shipment status</button> : null}
          {order.shipping?.status === "Booked" ? <button className="mm-admin__secondary-button" disabled={busy} onClick={() => void run(async () => { const result = await request<{ url: string }>(`${path}/shipment`, { action: "waybill" }); window.open(result.url, "_blank", "noopener,noreferrer"); })}>Download real waybill</button> : null}
          {order.shipping?.status === "Cancelled" ? <p className="mm-admin__notice">Bob Go confirms this TEST waybill is cancelled. The single test cannot book a replacement. Its history is retained.</p> : null}
        </>}
        {!["Booking", "Booked"].includes(order.shipping?.status || "") ? <details><summary>Finish & archive this TEST</summary><p>Clear this TEST from the working orders list while keeping its payment and delivery history. This does not cancel a courier booking or refund any courier charge.</p>
          <label className="mm-delivery__check"><input type="checkbox" checked={archiveConfirmed} disabled={busy} onChange={event => setArchiveConfirmed(event.target.checked)} />I am finished with this TEST and want to archive it.</label>
          <button className="mm-admin__secondary-button" disabled={busy || !archiveConfirmed} onClick={() => void run(async () => { setSnapshot(await request<Snapshot>("/api/admin/courier-test", { action: "archive", confirm: true })); clearQuotes(); })}>Archive only this TEST order</button></details> : null}
      </section>}
    </>}
  </main>;
}
