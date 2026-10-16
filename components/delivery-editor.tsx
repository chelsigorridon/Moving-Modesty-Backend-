"use client";

import { useRef, useState, type FormEvent } from "react";
type CourierAddress = { company: string; line1: string; line2: string; suburb: string; city: string; province: string; postalCode: string };
type CourierContact = { name: string; email: string; phone: string };
type PickupPoint = { id: string; providerSlug: string; name: string };
type CourierEndpoint = { kind: "door"; contact: CourierContact; address: CourierAddress }
  | { kind: "pickup_point"; contact: CourierContact; point: PickupPoint };
type CourierPlan = { version: 1; collection: CourierEndpoint; delivery: CourierEndpoint;
  collectionInstructions: string; deliveryInstructions: string; customerApprovedPickup: boolean };

type DeliveryPointResult = PickupPoint & { description: string; type: string };
type DeliveryEditorDetails = { revision: number; plan: CourierPlan | null; draftPlan: CourierPlan; privateNote: string; canEdit: boolean; blockedReason?: string };
interface DeliveryEditorProps {
  details: DeliveryEditorDetails;
  disabled?: boolean;
  save: (payload: Record<string, unknown>) => Promise<void>;
  searchPoints: (query: string) => Promise<{ points: DeliveryPointResult[]; limited?: boolean }>;
  onEditingChange?: (editing: boolean) => void;
}
const emptyCourierAddress: CourierAddress = { company: "", line1: "", line2: "", suburb: "", city: "", province: "Western Cape", postalCode: "" };
const deliveryProvinces = ["Eastern Cape", "Free State", "Gauteng", "KwaZulu-Natal", "Limpopo", "Mpumalanga", "North West", "Northern Cape", "Western Cape"];

export default function DeliveryEditor({ details, disabled = false, save, searchPoints, onEditingChange }: DeliveryEditorProps) {
  const [editing, setEditing] = useState(false);
  const [editSide, setEditSide] = useState<"collection" | "delivery">("delivery");
  const [saving, setSaving] = useState(false);
  const [plan, setPlan] = useState<CourierPlan>(() => structuredClone(details.draftPlan));
  const [confirmed, setConfirmed] = useState(false);
  const [approvedPickup, setApprovedPickup] = useState(details.draftPlan.customerApprovedPickup);
  const [remember, setRemember] = useState(false);
  const [note, setNote] = useState(details.privateNote);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const doorAddresses = useRef({ collection: details.draftPlan.collection.kind === "door" ? details.draftPlan.collection.address : emptyCourierAddress,
    delivery: details.draftPlan.delivery.kind === "door" ? details.draftPlan.delivery.address : emptyCourierAddress });
  function changeEndpoint(side: "collection" | "delivery", endpoint: CourierEndpoint) {
    setPlan(current => ({ ...current, [side]: endpoint })); setConfirmed(false);
    if (endpoint.kind === "door") doorAddresses.current[side] = endpoint.address;
    if (side === "delivery") setApprovedPickup(false);
  }
  function changeKind(side: "collection" | "delivery", kind: "door" | "pickup_point") {
    const current = plan[side];
    changeEndpoint(side, kind === "door" ? { kind, contact: current.contact, address: doorAddresses.current[side] }
      : { kind, contact: current.contact, point: { id: "", providerSlug: "", name: "" } });
  }
  function readDeliveryForm(form: FormData) {
    const text = (name: string, fallback = "") => String(form.has(name) ? form.get(name) || "" : fallback).trim();
    function endpoint(side: "collection" | "delivery"): CourierEndpoint {
      const current = plan[side], contact = { name: text(`${side}.name`, current.contact.name), email: text(`${side}.email`, current.contact.email), phone: text(`${side}.phone`, current.contact.phone) };
      return current.kind === "pickup_point" ? { ...current, contact }
        : { kind: "door", contact, address: { company: text(`${side}.company`, current.address.company), line1: text(`${side}.line1`, current.address.line1), line2: text(`${side}.line2`, current.address.line2),
          suburb: text(`${side}.suburb`, current.address.suburb), city: text(`${side}.city`, current.address.city), province: text(`${side}.province`, current.address.province), postalCode: text(`${side}.postalCode`, current.address.postalCode) } };
    }
    return { ...plan, collection: endpoint("collection"), delivery: endpoint("delivery"),
      collectionInstructions: text("collectionInstructions", plan.collectionInstructions), deliveryInstructions: text("deliveryInstructions", plan.deliveryInstructions),
      customerApprovedPickup: plan.delivery.kind === "pickup_point" ? form.has("approvedPickup") : false };
  }
  async function saveDelivery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setMessage("");
    // Read this component's own form at submit time, including silent autofill.
    const form = new FormData(event.currentTarget), next = readDeliveryForm(form);
    if ([next.collection, next.delivery].some(value => value.kind === "pickup_point" && !value.point.id)) { setError("Choose each pickup point from the Bob Go search results."); return; }
    if (next.collection.kind === "pickup_point" && next.delivery.kind === "pickup_point" && next.collection.point.providerSlug !== next.delivery.point.providerSlug) {
      setError("Both pickup points must belong to the same courier. Choose another point or use door delivery."); return;
    }
    setSaving(true);
    try {
      await save({ action: "delivery", expectedRevision: details.revision, plan: next, confirmed: form.has("confirmed"), rememberCollection: form.has("remember") });
      setEditing(false); onEditingChange?.(false); setConfirmed(false); setMessage("Delivery setup saved. Get a fresh quote to choose a courier.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Delivery details could not be saved."); }
    finally { setSaving(false); }
  }
  async function savePrivateNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setMessage("");
    const next = String(new FormData(event.currentTarget).get("privateNote") || "");
    try { await save({ action: "private_note", expectedRevision: details.revision, note: next }); setMessage("Private note saved. It was not sent to Bob Go or the customer."); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Private note could not be saved."); }
  }
  function summaryEndpoint(value: CourierEndpoint, side: "collection" | "delivery") {
    return value.kind === "pickup_point" ? `${side === "collection" ? "Drop off" : "Customer collects"}: ${value.point.name}`
      : `${side === "collection" ? "Courier collects" : "Customer's door"}: ${[value.address.line1, value.address.line2, value.address.suburb, value.address.city, value.address.province, value.address.postalCode].filter(Boolean).join(", ") || "Address needed"}`;
  }
  const shownPlan = editing ? plan : details.plan || details.draftPlan;
  function edit(side: "collection" | "delivery") {
    setPlan(structuredClone(details.draftPlan)); setEditSide(side); setError(""); setConfirmed(false); setEditing(true); onEditingChange?.(true);
  }
  return <section className="mm-admin__delivery-editor" aria-label="Delivery setup and notes">
    <style>{deliveryEditorCss}</style>
    <div className="mm-delivery__heading"><strong>1. Check delivery details</strong><span className="mm-admin__helper">{details.plan ? "Confirmed" : "Check before continuing"}</span></div>
    <div className="mm-delivery__grid mm-delivery__summary">{(["collection", "delivery"] as const).map(side => <div className="mm-delivery__address-card" key={side}>
      <strong>{side === "collection" ? "From Zarina" : "To the customer"}</strong><p>{summaryEndpoint(shownPlan[side], side)}</p>
      <p className="mm-admin__helper">{shownPlan[side].contact.name}<br />{shownPlan[side].contact.phone}<br />{shownPlan[side].contact.email}</p>
      {details.canEdit && !editing ? <button type="button" className="mm-admin__text-button" disabled={disabled} onClick={() => edit(side)}>{side === "collection" ? "Change collection" : "Change customer delivery"}</button> : null}
    </div>)}</div>
    {!editing && (shownPlan.collectionInstructions || shownPlan.deliveryInstructions) ? <details><summary>Courier instructions</summary><p>{shownPlan.collectionInstructions}</p><p>{shownPlan.deliveryInstructions}</p></details> : null}
    {!editing && details.canEdit && details.plan ? <button type="button" className="mm-admin__text-button" disabled={disabled} onClick={() => edit("delivery")}>Edit courier instructions</button> : null}
    {!details.canEdit ? <div className="mm-admin__notice"><p>{details.blockedReason}</p>
      {details.blockedReason?.includes("waybill") ? <details><summary>Change an already-booked delivery</summary>
        <p>Address or courier changes must be confirmed by Bob Go or the courier. Their documented API does not provide booked-waybill editing. A courier change may require cancellation and a new paid booking.</p>
        <p>Do not create a second shipment while the first is active. Editing a private note below does not change the waybill.</p>
        <a href="https://app.bobgo.co.za/" target="_blank" rel="noopener noreferrer">Open Bob Go to arrange the change</a>
      </details> : null}</div> : null}
    {(editing || !details.plan) && details.canEdit ? <form onSubmit={saveDelivery} onChange={event => {
      const target: EventTarget = event.target;
      const name = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement ? target.name : "";
      // A checkbox click can be the first event after browser autofill. Capture
      // our own form before React rerenders controlled inputs with stale state.
      if (!name.endsWith(".kind")) {
        const next = readDeliveryForm(new FormData(event.currentTarget)); setPlan(next);
        for (const side of ["collection", "delivery"] as const) { const endpoint = next[side]; if (endpoint.kind === "door") doorAddresses.current[side] = endpoint.address; }
      }
      if (!["confirmed", "remember"].includes(name)) setConfirmed(false);
    }}><fieldset disabled={disabled || saving} className="mm-delivery__fieldset">
      {editing ? <><p className="mm-admin__helper">The other address stays unchanged. Saving does not book or pay for a courier.</p>
      <DeliveryEndpointFields key={editSide} side={editSide} value={plan[editSide]}
        changeKind={kind => changeKind(editSide, kind)} change={value => changeEndpoint(editSide, value)} searchPoints={searchPoints} />
      <details><summary>Courier instructions (optional)</summary><div className="mm-delivery__grid">
        <label className="mm-admin__field">Collection instructions<textarea name="collectionInstructions" maxLength={1000} rows={3} value={plan.collectionInstructions}
          onChange={event => setPlan(current => ({ ...current, collectionInstructions: event.target.value }))} placeholder="For the collecting courier" /></label>
        <label className="mm-admin__field">Delivery instructions<textarea name="deliveryInstructions" maxLength={1000} rows={3} value={plan.deliveryInstructions}
          onChange={event => setPlan(current => ({ ...current, deliveryInstructions: event.target.value }))} placeholder="Gate, access or delivery instructions" /></label>
      </div></details></> : null}
      {plan.delivery.kind === "pickup_point" ? <label className="mm-delivery__check"><input type="checkbox" name="approvedPickup" required checked={approvedPickup} onChange={event => setApprovedPickup(event.target.checked)} />The customer agreed to collect from this pickup point.</label> : null}
      {editing && editSide === "collection" ? <label className="mm-delivery__check"><input type="checkbox" name="remember" checked={remember} onChange={event => setRemember(event.target.checked)} />Use these sender collection details for future orders.</label> : null}
      <label className="mm-delivery__check"><input type="checkbox" name="confirmed" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I have checked these addresses and courier contact details.</label>
      {editing ? <p className="mm-admin__helper">Changes need a fresh courier quote. The customer’s paid total stays unchanged.</p> : null}
      <div className="mm-delivery__actions"><button type="submit" className="mm-admin__button" disabled={disabled || saving || !confirmed}>{saving ? "Saving…" : editing ? "Save delivery details" : "Confirm delivery details"}</button>
        {editing ? <button type="button" className="mm-admin__text-button" onClick={() => { setEditing(false); setPlan(structuredClone(details.draftPlan)); onEditingChange?.(false); setError(""); setConfirmed(false); }}>Cancel editing</button> : null}</div>
    </fieldset></form> : null}
    <details className="mm-delivery__private"><summary>Private order note</summary><p className="mm-admin__helper">For Zarina’s records only. Editable after booking; never sent to the courier or customer.</p>
      <form onSubmit={savePrivateNote}><label className="mm-admin__field">Private note<textarea name="privateNote" rows={3} maxLength={3000} value={note} onChange={event => setNote(event.target.value)} disabled={disabled} /></label>
        <button type="submit" className="mm-admin__secondary-button" disabled={disabled || note === details.privateNote}>Save private note</button></form>
    </details>
    {error ? <p className="mm-admin__error" role="alert">{error}</p> : null}
    {message ? <p className="mm-admin__helper" role="status">{message}</p> : null}
  </section>;
}

function DeliveryEndpointFields({ side, value, change, changeKind, searchPoints }: { side: "collection" | "delivery"; value: CourierEndpoint;
  change: (value: CourierEndpoint) => void; changeKind: (kind: "door" | "pickup_point") => void; searchPoints: DeliveryEditorProps["searchPoints"] }) {
  const [query, setQuery] = useState(""); const [points, setPoints] = useState<DeliveryPointResult[]>([]);
  const [searching, setSearching] = useState(false); const [error, setError] = useState(""); const [searched, setSearched] = useState(false); const [limited, setLimited] = useState(false);
  async function search() {
    if (query.trim().length < 2) { setError("Enter at least two letters of the place name or suburb."); return; }
    setSearching(true); setError("");
    try { const result = await searchPoints(query); setPoints(result.points); setLimited(Boolean(result.limited)); setSearched(true); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Pickup points could not be loaded."); }
    finally { setSearching(false); }
  }
  const title = side === "collection" ? "1. Where does the parcel leave from?" : "2. Where is it going?";
  return <section className="mm-delivery__endpoint" aria-label={side === "collection" ? "Sender collection details" : "Customer delivery details"}>
    <h4>{title}</h4><label className="mm-admin__field">{side === "collection" ? "Collection method" : "Delivery method"}
      <select name={`${side}.kind`} value={value.kind} onChange={event => changeKind(event.target.value as "door" | "pickup_point")}>
        <option value="door">{side === "collection" ? "Courier collects from an address" : "Deliver to the customer's door"}</option>
        <option value="pickup_point">{side === "collection" ? "Zarina drops off at a locker or counter" : "Customer collects at a locker or counter"}</option>
      </select></label>
    {value.kind === "pickup_point" ? <div className="mm-delivery__point-search">
      <label className="mm-admin__field">Find a Bob Go pickup point<input name={`${side}.search`} value={query} maxLength={100} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void search(); } }} placeholder="Place name, suburb or postcode" autoComplete="off" /></label>
      <button type="button" className="mm-admin__secondary-button" disabled={searching} onClick={() => { void search(); }}>{searching ? "Searching…" : "Search pickup points"}</button>
      {value.point.id ? <p className="mm-delivery__selected-point">Selected: <strong>{value.point.name}</strong> · Courier: {value.point.providerSlug}</p> : <p>Choose a point from the search results.</p>}
      {points.length ? <ul className="mm-delivery__point-results" aria-label={`${side} pickup point results`}>{points.map(point => <li key={`${point.providerSlug}:${point.id}`}>
        <button type="button" aria-pressed={point.id === value.point.id && point.providerSlug === value.point.providerSlug}
          onClick={() => change({ ...value, point: { id: point.id, providerSlug: point.providerSlug, name: point.name } })}>
          <strong>{point.name}</strong><span>{point.description}</span><span>{point.type === "counter" ? "Counter" : "Locker"} · {point.providerSlug}</span></button></li>)}</ul> : null}
      {searched && !points.length ? <p role="status">No matching points returned by Bob Go. Try a nearby suburb or another place name.</p> : null}
      {limited ? <p>Narrow your search to see more relevant results.</p> : null}
      <p className="mm-admin__helper">Pickup points can limit the eligible couriers. Availability and parcel capacity are checked again when quoting.</p>
      {error ? <p role="alert" className="mm-admin__error">{error}</p> : null}
    </div> : <div className="mm-delivery__grid">{([
      ["company", "Company (optional)", false], ["line1", "Street address", true], ["line2", "Unit / building (optional)", false],
      ["suburb", "Suburb", true], ["city", "City", true], ["postalCode", "Postal code", true],
    ] as const).map(([key, label, required]) => <label className="mm-admin__field" key={key}>{label}<input name={`${side}.${key}`} required={required}
      maxLength={key === "postalCode" ? 4 : key === "company" ? 150 : key === "city" || key === "suburb" ? 100 : 180} inputMode={key === "postalCode" ? "numeric" : "text"}
      value={value.address[key]} autoComplete={`section-${side} ${key === "postalCode" ? "postal-code" : key === "city" ? "address-level2" : key === "line1" ? "address-line1" : key === "line2" ? "address-line2" : key === "company" ? "organization" : "address-level3"}`}
      onChange={event => change({ ...value, address: { ...value.address, [key]: event.target.value } })} /></label>)}
      <label className="mm-admin__field">Province<select name={`${side}.province`} value={value.address.province} autoComplete={`section-${side} address-level1`}
        onChange={event => change({ ...value, address: { ...value.address, province: event.target.value as CourierAddress["province"] } })}>{deliveryProvinces.map(province => <option key={province}>{province}</option>)}</select></label>
    </div>}
    <div className="mm-delivery__grid">{([ ["name", "Courier contact name", "text"], ["email", "Courier contact email", "email"], ["phone", "Courier contact phone", "tel"] ] as const)
      .map(([key, label, type]) => <label className="mm-admin__field" key={key}>{label}<input required type={type} name={`${side}.${key}`} maxLength={key === "phone" ? 30 : key === "email" ? 180 : 160}
        autoComplete={`section-${side} ${key === "name" ? "name" : key === "email" ? "email" : "tel"}`} value={value.contact[key]}
        onChange={event => change({ ...value, contact: { ...value.contact, [key]: event.target.value } })} /></label>)}</div>
  </section>;
}

const deliveryEditorCss = `
.mm-admin__delivery-editor{margin:18px 0;padding:18px;border:1px solid var(--mm-border,#a69e95);border-radius:10px;min-width:0;overflow-wrap:anywhere}
.mm-admin__delivery-editor *{box-sizing:border-box}.mm-delivery__heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.mm-delivery__summary{margin:12px 0;font-size:14px}.mm-delivery__address-card{padding:14px;border:1px solid var(--mm-border,#a69e95);border-radius:8px}.mm-delivery__address-card p{margin:8px 0}.mm-delivery__fieldset{margin:16px 0 0;padding:0;border:0;min-width:0;display:grid;gap:16px}
.mm-delivery__endpoint{padding:16px 0;border-top:1px solid var(--mm-border,#a69e95);display:grid;gap:14px;min-width:0}.mm-delivery__endpoint h4{margin:0;font-size:15px}
.mm-delivery__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.mm-admin__delivery-editor .mm-admin__field{display:grid;align-content:start;gap:6px;min-width:0}
.mm-admin__delivery-editor .mm-admin__field :is(input,select,textarea){width:100%;min-width:0;max-width:100%;box-sizing:border-box}
.mm-delivery__check{display:flex;align-items:flex-start;gap:10px;font-size:14px;line-height:1.5}.mm-delivery__check input{flex:none;width:20px;height:20px;margin:1px 0}
.mm-delivery__actions{display:flex;gap:16px;flex-wrap:wrap;align-items:center}.mm-delivery__point-search{display:grid;gap:12px;min-width:0}.mm-delivery__point-search>button{justify-self:start}
.mm-delivery__point-results{list-style:none;margin:0;padding:0;max-height:280px;overflow:auto;display:grid;gap:8px}.mm-delivery__point-results button{display:grid;gap:5px;width:100%;padding:12px;text-align:left;border:1px solid var(--mm-border,#a69e95);border-radius:8px;background:transparent;color:inherit;cursor:pointer}
.mm-delivery__point-results button[aria-pressed=true]{border:2px solid var(--mm-sage,#7d896d);background:var(--mm-soft,#e8e9e2)}.mm-delivery__point-results span{font-size:13px}
.mm-delivery__selected-point{padding:12px;background:var(--mm-soft,#e8e9e2);border-radius:8px;font-size:14px}.mm-delivery__private{margin-top:18px;padding-top:14px;border-top:1px solid var(--mm-border,#a69e95)}
.mm-delivery__private summary{cursor:pointer}.mm-delivery__private form{display:grid;gap:12px;margin-top:12px}.mm-delivery__private button{justify-self:start}
@media(max-width:600px){.mm-admin__delivery-editor{padding:14px}.mm-delivery__grid{grid-template-columns:1fr}.mm-delivery__actions>button{width:100%}}
`;
