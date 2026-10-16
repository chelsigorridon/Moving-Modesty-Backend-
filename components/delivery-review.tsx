"use client";
import { useState, type ComponentProps } from "react";
import DeliveryEditor from "./delivery-editor";
import OrderSyncStatus from "./order-sync-status";
import OrderSyncReview from "./order-sync-review";
import ParcelEditor from "./parcel-editor";
import ShippingWeightSettings from "./shipping-weight-settings";
import { getOrderSyncConfiguration, orderSyncView } from "@/lib/integrations/bobgo/order-sync-policy";
import { deliveryEditInput } from "@/lib/delivery-input";

type Details = ComponentProps<typeof DeliveryEditor>["details"];
const contact = { name: "TEST Sender", email: "sender@example.invalid", phone: "0821234567" };
const examplePlan: Details["draftPlan"] = { version: 1,
  collection: { kind: "door", contact, address: { company: "Moving Modesty — DEMO", line1: "10 Example Street", line2: "", suburb: "Example Suburb", city: "Cape Town", province: "Western Cape", postalCode: "7800" } },
  delivery: { kind: "door", contact: { name: "TEST Customer", email: "customer@example.invalid", phone: "0827654321" },
    address: { company: "", line1: "20 Example Road", line2: "", suburb: "Example Suburb", city: "Cape Town", province: "Western Cape", postalCode: "7800" } },
  collectionInstructions: "", deliveryInstructions: "", customerApprovedPickup: false };
const examplePoints = [
  { id: "91001", providerSlug: "demo-a", name: "DEMO Cape Town Locker", description: "Example Suburb, Cape Town — not a real booking location", type: "locker" },
  { id: "91002", providerSlug: "demo-a", name: "DEMO Cape Town Counter", description: "Example Suburb, Cape Town — not a real booking location", type: "counter" },
  { id: "91003", providerSlug: "demo-b", name: "DEMO Second Courier Counter", description: "Cape Town — different example courier", type: "counter" },
];

export default function DeliveryReview() {
  const [details, setDetails] = useState<Details>({ revision: 0, plan: null, draftPlan: examplePlan, privateNote: "", canEdit: true });
  const [booked, setBooked] = useState(false), [quoted, setQuoted] = useState(false), [choice, setChoice] = useState("0");
  const [editingDelivery, setEditingDelivery] = useState(false);
  const [parcel, setParcel] = useState({ weightGrams: "", lengthCm: "", widthCm: "", heightCm: "" });
  const [measured, setMeasured] = useState(false);
  const [weights, setWeights] = useState([{ id: "demo-weight", product: "DEMO scarf — not a real stock item", colour: "Example", size: "Example size", grams: null as number | null }]);
  const viewDetails: Details = booked ? { ...details, plan: details.plan || examplePlan, draftPlan: details.plan || examplePlan, canEdit: false,
    blockedReason: "This waybill is booked or may still be processing. Changes must be confirmed in Bob Go; editing this order locally cannot amend the courier booking." } : details;
  const selectedPointProvider = details.plan?.collection.kind === "pickup_point" ? details.plan.collection.point.providerSlug
    : details.plan?.delivery.kind === "pickup_point" ? details.plan.delivery.point.providerSlug : undefined;
  const rates = selectedPointProvider ? [{ name: `Example courier ${selectedPointProvider} · Pickup-point service`, amount: 89 }]
    : [{ name: "Example Courier A · Economy", amount: 95 }, { name: "Example Courier B · Express", amount: 115 }, { name: "Example Courier C · Economy", amount: 105 }];
  return <main className="mm-admin mm-delivery-review">
    <style>{reviewCss}</style>
    <p className="mm-delivery-review__eyebrow">MOVING MODESTY / PRIVATE DELIVERY REVIEW</p>
    <h1>Delivery setup & courier choices</h1>
    <p className="mm-admin__notice">Review only. Sample customer, addresses, pickup points and rates. Nothing here connects to Neon, Bob Go, PayFast or email. Changes disappear on refresh.</p>
    <p className="mm-admin__helper">Check delivery details → choose package → compare couriers → approve booking → print waybill.</p>
    <OrderSyncStatus value={orderSyncView(undefined, getOrderSyncConfiguration().enabled)} />
    <div className="mm-delivery__actions"><button type="button" className={!booked ? "mm-admin__button" : "mm-admin__secondary-button"} aria-pressed={!booked}
      onClick={() => { setBooked(false); setQuoted(false); setEditingDelivery(false); }}>Before booking</button>
      <button type="button" className={booked ? "mm-admin__button" : "mm-admin__secondary-button"} aria-pressed={booked}
        onClick={() => { setBooked(true); setQuoted(false); setEditingDelivery(false); }}>View already-booked example</button></div>
    <section className="mm-delivery-review__order"><h2>TEST order · Paid · {booked ? "Waybill booked" : "Ready for courier"}</h2>
      <p>Products: R450 · Delivery paid by customer: R99 · Order total: R549</p>
      <p className="mm-admin__helper">The courier cost is separate. Changing the delivery setup does not change the customer’s paid total.</p>
      {booked ? <><p>Example tracking reference: DEMO-NOT-A-REAL-WAYBILL</p><p>Booked courier: <strong>Example Courier B · Express</strong> · DEMO ONLY</p></> : null}
      <DeliveryEditor key={`${booked}:${details.revision}`} details={viewDetails} onEditingChange={editing => { setEditingDelivery(editing); setQuoted(false); setMeasured(false); }} save={async payload => {
        const parsed = deliveryEditInput.safeParse(payload);
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || "Check the delivery details.");
        if (parsed.data.expectedRevision !== details.revision) throw new Error("Refresh the demo before saving.");
        const input = parsed.data;
        if (input.action === "delivery" && booked) throw new Error("A booked waybill cannot be changed locally.");
        setDetails(current => ({ ...current, revision: current.revision + 1,
          ...(input.action === "delivery" ? { plan: input.plan, draftPlan: input.plan } : { privateNote: input.note }) }));
        setQuoted(false);
      }} searchPoints={async query => ({ points: examplePoints.filter(point => `${point.name} ${point.description}`.toLowerCase().includes(query.trim().toLowerCase())) })} />
      {!booked && details.plan && !editingDelivery ? <section className="mm-delivery-review__quotes">
        <ParcelEditor value={parcel} change={value => { setParcel(value); setMeasured(false); setQuoted(false); }} loadPackages={async () => [
          { id: "example-flyer", name: "DEMO flyer — check your real package", lengthCm: 40, widthCm: 32, heightCm: 6 },
          { id: "example-box", name: "DEMO small box — check your real package", lengthCm: 25, widthCm: 20.5, heightCm: 3.5 },
        ]} />
        <label className="mm-delivery__check"><input type="checkbox" checked={measured} onChange={event => { setMeasured(event.target.checked); setQuoted(false); }} />I have checked the packed dimensions, weight and delivery address.</label>
        {!quoted ? <button type="button" className="mm-admin__button" disabled={!measured || Object.values(parcel).some(value => !Number(value))} onClick={() => { setQuoted(true); setChoice("0"); }}>Compare example courier quotes</button> : null}
        {quoted ? <><h3>3. Choose courier & book</h3><label className="mm-admin__field">Courier and service<select value={choice} onChange={event => setChoice(event.target.value)}>{rates.map((rate, index) => <option key={rate.name} value={index}>{rate.name} · R{rate.amount}</option>)}</select></label>
        <p>Example courier cost: R{rates[Number(choice)]?.amount}. These are not live prices.</p>
          <button type="button" className="mm-admin__button" disabled>Real booking disabled in this review</button></> : null}
      </section> : null}
    </section>
    <OrderSyncReview />
    <ShippingWeightSettings request={async changes => {
      const next = weights.map(row => { const changed = changes?.find(change => change.id === row.id); return { ...row, grams: changed ? changed.grams : row.grams }; });
      if (changes) setWeights(next); return next;
    }} />
  </main>;
}

const reviewCss = `
body{margin:0;background:#eeeae6}.mm-delivery-review{--mm-border:#a69e95;--mm-surface:#f5f3f0;--mm-ink:#302a24;--mm-sage:#7d896d;--mm-soft:#e3e6de;max-width:1000px;margin:auto;padding:32px;color:var(--mm-ink);font-family:Jost,Inter,Arial,sans-serif;line-height:1.5}
.mm-delivery-review *{box-sizing:border-box}.mm-delivery-review :is(h2,h3,h4){font-family:inherit}.mm-delivery-review h1{font-family:Montserrat,Inter,Arial,sans-serif;font-size:28px;font-weight:500;line-height:1.25;margin:8px 0 18px}.mm-delivery-review h2{font-size:19px;font-weight:500;margin:0 0 12px}.mm-delivery-review h3{font-size:16px;font-weight:500}
.mm-delivery-review__eyebrow{font-size:11px;letter-spacing:.12em;color:#746d65}.mm-delivery-review__order{margin-top:24px;padding:24px;background:#f5f3f0;border:1px solid var(--mm-border)}.mm-delivery-review__quotes{display:grid;gap:12px;margin-top:20px;border-top:1px solid var(--mm-border);padding-top:12px}
.mm-delivery-review__simulation{margin:20px 0;padding:16px;border:1px dashed var(--mm-border);border-radius:8px;overflow-wrap:anywhere}.mm-delivery-review__simulation>summary{cursor:pointer;font-weight:500}.mm-delivery-review__simulation>.mm-admin__field{margin-top:16px}
.mm-delivery-review :is(button,input,select,textarea){font:inherit}.mm-delivery-review button,.mm-delivery-review a{min-height:44px}.mm-delivery-review button{cursor:pointer}.mm-delivery-review button:disabled{opacity:.5;cursor:not-allowed}
.mm-delivery-review :is(input,select,textarea){border:1px solid var(--mm-border);background:#fffdf9;color:var(--mm-ink);border-radius:8px;padding:11px 12px}.mm-delivery-review :is(button,input,select,textarea,a,summary):focus-visible{outline:3px solid #667650;outline-offset:3px}
.mm-delivery-review .mm-admin__field{display:grid;gap:6px;font-size:13px}.mm-delivery-review .mm-admin__field :is(input,select,textarea){width:100%;min-width:0}.mm-delivery-review textarea{resize:vertical}
.mm-delivery-review :is(.mm-admin__button,.mm-admin__secondary-button){padding:11px 16px;border:1px solid var(--mm-border);border-radius:6px;color:var(--mm-ink);background:transparent}.mm-delivery-review .mm-admin__button{background:#687657;color:white;border-color:#687657}
.mm-delivery-review .mm-admin__text-button{border:0;background:none;text-decoration:underline;padding:8px;color:var(--mm-ink)}.mm-delivery-review .mm-admin__notice{padding:14px 18px;border-left:3px solid #7d896d;background:#e3e6de;font-size:14px}.mm-delivery-review .mm-admin__helper{font-size:13px;color:#62594f}.mm-delivery-review .mm-admin__error{padding:12px;background:#f1e0da;color:#762b20;border-left:3px solid #8b3e2f}
@media(max-width:600px){.mm-delivery-review{padding:20px 12px}.mm-delivery-review h1{font-size:23px}.mm-delivery-review__order{padding:16px}.mm-delivery-review>.mm-delivery__actions>button{width:100%}}
`;
