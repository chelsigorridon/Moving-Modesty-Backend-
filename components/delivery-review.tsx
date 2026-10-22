"use client";
import { useId, useState, type ComponentProps } from "react";
import DeliveryEditor from "./delivery-editor";
import DeliveryProgress from "./delivery-progress";
import DeliveryStepFlow from "./delivery-step-flow";
import OrderSyncStatus from "./order-sync-status";
import OrderSyncReview from "./order-sync-review";
import ParcelEditor from "./parcel-editor";
import ShippingWeightSettings from "./shipping-weight-settings";
import DeliveryAdvancedSettings from "./delivery-advanced-settings";
import { getOrderSyncConfiguration, orderSyncView } from "@/lib/integrations/bobgo/order-sync-policy";
import { deliveryEditInput } from "@/lib/delivery-input";
import { waybillChangeInput } from "@/lib/integrations/bobgo/waybill-change-policy";
import { movingModestyBoxPreset, zarinaProductMeasurements } from "@/lib/shipping/owner-measurements";
import { collectionScheduleProblem } from "@/lib/shipping/collection-schedule";

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
  const [details, setDetails] = useState<Details>({ revision: 0, plan: null, draftPlan: examplePlan, privateNote: "", canEdit: true, collectionTimeMode: "preferred_instructions" });
  const [booked, setBooked] = useState(false), [quoted, setQuoted] = useState(false), [choice, setChoice] = useState("0");
  const [editingDelivery, setEditingDelivery] = useState(false);
  const [reviewDetails, setReviewDetails] = useState(false);
  const [waybillStage, setWaybillStage] = useState<"cancel_waybill" | "check_cancellation" | "prepare_replacement">("cancel_waybill");
  const [waybillNotice, setWaybillNotice] = useState("");
  const [parcel, setParcel] = useState({ weightGrams: "", lengthCm: String(movingModestyBoxPreset.lengthCm), widthCm: String(movingModestyBoxPreset.widthCm), heightCm: String(movingModestyBoxPreset.heightCm) });
  const [measured, setMeasured] = useState(false);
  const [weights, setWeights] = useState(zarinaProductMeasurements.map((row, index) => ({ id: `demo-weight-${index}`, product: row.product, colour: "DEMO colour", size: row.size, grams: null as number | null })));
  const viewDetails: Details = booked ? { ...details, plan: details.plan || examplePlan, draftPlan: details.plan || examplePlan, canEdit: false,
    waybillChange: { action: waybillStage, trackingNumber: "DEMO-NOT-A-REAL-WAYBILL" },
    blockedReason: waybillStage === "prepare_replacement" ? "This waybill is cancelled. Prepare replacement delivery to edit the address or choose a new courier."
      : "This waybill is booked. Confirm cancellation before changing delivery." } : details;
  const selectedPointProvider = details.plan?.collection.kind === "pickup_point" ? details.plan.collection.point.providerSlug
    : details.plan?.delivery.kind === "pickup_point" ? details.plan.delivery.point.providerSlug : undefined;
  const rates = selectedPointProvider ? [{ name: `Example courier ${selectedPointProvider} · Pickup-point service`, amount: 89 }]
    : [{ name: "Example Courier A · Economy", amount: 95 }, { name: "Example Courier B · Express", amount: 115 }, { name: "Example Courier C · Economy", amount: 105 }];
  const cancellationPending = booked && waybillStage === "check_cancellation";
  const cancelled = booked && waybillStage === "prepare_replacement";
  const scheduleProblem = details.plan?.collection.kind === "door" ? collectionScheduleProblem(details.plan.collectionSchedule, true) : "";
  const progressStep = cancelled || cancellationPending || editingDelivery || reviewDetails || !viewDetails.plan || !booked && Boolean(scheduleProblem) ? 1 : booked ? 4 : quoted ? 3 : 2;
  const quoteHintId = useId();
  const missingMeasurements = Object.entries(parcel).some(([key, value]) => {
    const amount = Number(value);
    return !Number.isFinite(amount) || amount < (key === "weightGrams" ? 1 : 0.01) || amount > (key === "weightGrams" ? 30000 : 150) || key === "weightGrams" && !Number.isInteger(amount);
  });
  function showExample(stage?: typeof waybillStage) {
    setBooked(Boolean(stage)); setWaybillStage(stage || "cancel_waybill"); setWaybillNotice(""); setQuoted(false); setEditingDelivery(false); setMeasured(false); setReviewDetails(false);
  }
  return <main className="mm-admin mm-delivery-review">
    <style>{reviewCss}</style>
    <p className="mm-delivery-review__eyebrow">MOVING MODESTY / PRIVATE DELIVERY REVIEW</p>
    <h1>Arrange delivery</h1>
    <p className="mm-admin__notice">Preview only · Sample details and prices. Nothing is sent or booked.</p>
    <details className="mm-delivery-review__examples"><summary>Preview other order stages</summary><div className="mm-delivery__actions"><button type="button" className={!booked ? "mm-admin__button" : "mm-admin__secondary-button"} aria-pressed={!booked}
      onClick={() => showExample()}>Before booking</button>
      <button type="button" className={booked && !cancelled && !cancellationPending ? "mm-admin__button" : "mm-admin__secondary-button"} aria-pressed={booked && !cancelled && !cancellationPending}
        onClick={() => showExample("cancel_waybill")}>View already-booked example</button>
      <button type="button" className={cancelled ? "mm-admin__button" : "mm-admin__secondary-button"} aria-pressed={cancelled}
        onClick={() => showExample("prepare_replacement")}>View cancelled example</button></div></details>
    <section className="mm-delivery-review__order"><h2>TEST order · Paid · {booked ? waybillStage === "prepare_replacement" ? "Waybill cancelled" : waybillStage === "check_cancellation" ? "Cancellation pending" : "Waybill booked" : "Ready for courier"}</h2>
      <DeliveryProgress current={progressStep} paused={cancelled || cancellationPending} />
      <DeliveryStepFlow current={progressStep} locked={booked} onReview={step => { setReviewDetails(step === 1); setQuoted(false); setMeasured(false); }}>
      <DeliveryEditor guided key={`${booked}:${waybillStage}:${details.revision}`} details={viewDetails} onContinue={() => setReviewDetails(false)} onEditingChange={editing => { setEditingDelivery(editing); setReviewDetails(editing); setQuoted(false); setMeasured(false); }} save={async payload => {
        const parsed = deliveryEditInput.safeParse(payload);
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || "Check the delivery details.");
        if (parsed.data.expectedRevision !== details.revision) throw new Error("Refresh the demo before saving.");
        const input = parsed.data;
        if (input.action === "delivery" && booked) throw new Error("A booked waybill cannot be changed locally.");
        setDetails(current => ({ ...current, revision: current.revision + 1,
          ...(input.action === "delivery" ? { plan: input.plan, draftPlan: input.plan } : { privateNote: input.note }) }));
        setQuoted(false); setReviewDetails(false);
      }} changeWaybill={async payload => {
        const input = waybillChangeInput.parse(payload);
        if (input.expectedRevision !== details.revision) throw new Error("Refresh the demo before continuing.");
        if (input.action === "cancel_waybill") { setWaybillStage("check_cancellation"); setWaybillNotice("DEMO: cancellation requested. Check cancellation status before editing."); }
        else if (input.action === "check_cancellation") { setWaybillStage("prepare_replacement"); setWaybillNotice("DEMO: Bob Go cancellation confirmed. You can prepare a replacement."); }
        else {
          setDetails(current => ({ ...current, revision: current.revision + 1, canEdit: true, plan: current.plan || examplePlan, draftPlan: current.plan || examplePlan,
            previousWaybills: [...(current.previousWaybills || []), { trackingNumber: "DEMO-NOT-A-REAL-WAYBILL", courierName: "Example Courier B", status: "Cancelled", replacedAt: new Date().toISOString() }] }));
          setBooked(false); setMeasured(false); setQuoted(false); setParcel({ weightGrams: "", lengthCm: "", widthCm: "", heightCm: "" });
          setWaybillNotice("DEMO: old waybill kept in history. Edit the address, reconfirm packed measurements and compare fresh courier quotes. No real change was made.");
        }
      }} searchPoints={async query => ({ points: examplePoints.filter(point => `${point.name} ${point.description}`.toLowerCase().includes(query.trim().toLowerCase())) })} />
      {!booked && details.plan && !editingDelivery ? <section className="mm-delivery-review__quotes">
        <ParcelEditor value={parcel} change={value => { setParcel(value); setMeasured(false); setQuoted(false); }} loadPackages={async () => [
          { id: "example-flyer", name: "DEMO flyer — check your real package", lengthCm: 40, widthCm: 32, heightCm: 6 },
          { id: "example-box", name: "DEMO small box — check your real package", lengthCm: 25, widthCm: 20.5, heightCm: 3.5 },
        ]} />
        <label className="mm-delivery__check"><input type="checkbox" checked={measured} onChange={event => { setMeasured(event.target.checked); setQuoted(false); }} />Dimensions and packed weight checked.</label>
        <p id={quoteHintId} className="mm-admin__helper mm-delivery__action-hint">{scheduleProblem || (missingMeasurements ? "Enter valid box dimensions and a packed weight (1–30,000 g)." : !measured ? "Tick to confirm the parcel." : "Comparing prices does not book a courier.")}</p>
        <button type="button" className="mm-admin__button mm-delivery__primary-action" aria-describedby={quoteHintId} disabled={!measured || missingMeasurements || Boolean(scheduleProblem)} onClick={() => { setQuoted(true); setChoice("0"); }}>Compare couriers</button>
      </section> : null}
      {quoted ? <section className="mm-delivery-review__quotes"><h3>3. Choose a courier</h3><label className="mm-admin__field">Courier and service<select value={choice} onChange={event => setChoice(event.target.value)}>{rates.map((rate, index) => <option key={rate.name} value={index}>{rate.name} · R{rate.amount}</option>)}</select></label>
        <p><strong>Courier cost: R{rates[Number(choice)]?.amount}</strong></p><p className="mm-admin__helper">Paid by Zarina to Bob Go. Customer paid R99 delivery.</p>
        <button type="button" className="mm-admin__button mm-delivery__primary-action" disabled>Booking disabled in preview</button><p className="mm-admin__helper">Sample prices only.</p></section> : null}
      {booked ? <section><h3>4. Print & track</h3><p>Waybill: <strong>DEMO-NOT-A-REAL-WAYBILL</strong></p><p>Example Courier B · Booked</p>
        <button type="button" className="mm-admin__button mm-delivery__primary-action" disabled>Print waybill PDF</button><p className="mm-admin__helper">Printing and tracking are disabled in preview.</p>
        <p>Attach the waybill before handing over the parcel.</p><button type="button" className="mm-admin__secondary-button" onClick={() => setReviewDetails(true)}>View delivery details & changes</button></section> : null}
      </DeliveryStepFlow>
      {booked && !cancelled && !cancellationPending && reviewDetails ? <button type="button" className="mm-admin__secondary-button" onClick={() => setReviewDetails(false)}>Back to waybill</button> : null}
      {waybillNotice ? <p className="mm-admin__notice" role="status">{waybillNotice}</p> : null}
    </section>
    <DeliveryAdvancedSettings>
      <OrderSyncStatus value={orderSyncView(undefined, getOrderSyncConfiguration().enabled)} />
      <ShippingWeightSettings request={async changes => {
        const next = weights.map(row => { const changed = changes?.find(change => change.id === row.id); return { ...row, grams: changed ? changed.grams : row.grams }; });
        if (changes) setWeights(next); return next;
      }} />
      <OrderSyncReview />
    </DeliveryAdvancedSettings>
  </main>;
}

const reviewCss = `
body{margin:0;background:#eeeae6}.mm-delivery-review{--mm-border:#a69e95;--mm-surface:#f5f3f0;--mm-ink:#302a24;--mm-sage:#7d896d;--mm-soft:#e3e6de;max-width:1000px;margin:auto;padding:32px;color:var(--mm-ink);font-family:Jost,Inter,Arial,sans-serif;line-height:1.5}
.mm-delivery-review *{box-sizing:border-box}.mm-delivery-review :is(h2,h3,h4){font-family:inherit}.mm-delivery-review h1{font-family:Montserrat,Inter,Arial,sans-serif;font-size:28px;font-weight:500;line-height:1.25;margin:8px 0 18px}.mm-delivery-review h2{font-size:19px;font-weight:500;margin:0 0 12px}.mm-delivery-review h3{font-size:16px;font-weight:500}
.mm-delivery-review__eyebrow{font-size:11px;letter-spacing:.12em;color:#746d65}.mm-delivery-review__order{margin-top:24px;padding:24px;background:#f5f3f0;border:1px solid var(--mm-border)}.mm-delivery-review__quotes{display:grid;gap:12px}.mm-delivery-review__examples>summary{min-height:44px;align-content:center;cursor:pointer}.mm-delivery-review__examples .mm-delivery__actions{padding:12px 0}
.mm-delivery-review__simulation{margin:20px 0;padding:16px;border:1px dashed var(--mm-border);border-radius:8px;overflow-wrap:anywhere}.mm-delivery-review__simulation>summary{cursor:pointer;font-weight:500}.mm-delivery-review__simulation>.mm-admin__field{margin-top:16px}
.mm-delivery-review :is(button,input,select,textarea){font:inherit}.mm-delivery-review button,.mm-delivery-review a{min-height:44px}.mm-delivery-review button{cursor:pointer}.mm-delivery-review button:disabled{opacity:.5;cursor:not-allowed}
.mm-delivery-review :is(input,select,textarea){border:1px solid var(--mm-border);background:#fffdf9;color:var(--mm-ink);border-radius:8px;padding:11px 12px}.mm-delivery-review :is(button,input,select,textarea,a,summary):focus-visible{outline:3px solid #667650;outline-offset:3px}
.mm-delivery-review .mm-admin__field{display:grid;gap:6px;font-size:13px}.mm-delivery-review .mm-admin__field :is(input,select,textarea){width:100%;min-width:0}.mm-delivery-review textarea{resize:vertical}
.mm-delivery-review :is(.mm-admin__button,.mm-admin__secondary-button){padding:11px 16px;border:1px solid var(--mm-border);border-radius:6px;color:var(--mm-ink);background:transparent}.mm-delivery-review .mm-admin__button{background:#536047;color:white;border-color:#536047}
.mm-delivery-review .mm-admin__text-button{border:0;background:none;text-decoration:underline;padding:8px;color:var(--mm-ink)}.mm-delivery-review .mm-admin__notice{padding:14px 18px;border-left:3px solid #7d896d;background:#e3e6de;font-size:14px}.mm-delivery-review .mm-admin__helper{font-size:13px;color:#62594f}.mm-delivery-review .mm-admin__error{padding:12px;background:#f1e0da;color:#762b20;border-left:3px solid #8b3e2f}
@media(max-width:600px){.mm-delivery-review{padding:20px 12px}.mm-delivery-review h1{font-size:23px}.mm-delivery-review__order{padding:16px}.mm-delivery-review>.mm-delivery__actions>button{width:100%}}
`;
