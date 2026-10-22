"use client";
import { useState, type CSSProperties } from "react";
import OrderCards from "./order-cards";

const samples = [
  { id: "DEMO-001", customer: "Sample Customer One", total: 549, paymentStatus: "Paid", status: "Ready", deliveryMethod: "Courier", placedAt: "22 Oct, 10:15", item: "Hawa Tri-Instant · Black · Small", guidance: "Check delivery details and compare courier quotes." },
  { id: "DEMO-002", customer: "Sample Customer Two", total: 420, paymentStatus: "Paid", status: "Confirmed", deliveryMethod: "Collection", placedAt: "22 Oct, 09:40", item: "Amina Tie-Back · Lavender", guidance: "Prepare the order for customer collection." },
  { id: "DEMO-003", customer: "Sample Customer Three", total: 549, paymentStatus: "Paid", status: "New", deliveryMethod: "Courier", placedAt: "21 Oct, 16:20", item: "Hawa Tri-Instant · Grey · Small", guidance: "Review the paid order before preparing the parcel." },
];
const formatMoney = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 });
export default function OrderCardsReview({ portalStyles }: { portalStyles: string }) {
  const [selectedId, setSelectedId] = useState(""), [search, setSearch] = useState("");
  const selected = samples.find(order => order.id === selectedId);
  const orders = samples.filter(order => `${order.id} ${order.customer}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <main className="mm-admin mm-order-cards-review" style={{ position: "relative", width: "100%", containerType: "inline-size", background: "#F5F3F0", color: "#302A24",
    "--mm-surface": "#EEEAE6", "--mm-soft": "#CDD2CE", "--mm-ink": "#302A24", "--mm-muted": "#746D65", "--mm-sage": "#7D896D", "--mm-border": "#A69E95" } as CSSProperties}>
    <style>{portalStyles + `.mm-order-cards-review{max-width:1040px;margin:0 auto;min-height:100vh}.mm-order-cards-review h3{font-family:inherit}body{margin:0;background:#F5F3F0}`}</style>
    <div className="mm-admin__page">
      <p className="mm-admin__eyebrow">MOVING MODESTY / PRIVATE REVIEW</p>
      <div className="mm-admin__notice">Preview only · Sample orders. Opening and closing cards does not change or send anything.</div>
      <div className="mm-admin__header"><h1 className="mm-admin__title">Orders</h1></div>
      <p className="mm-admin__helper">Select an order to open its details. Select it again to close.</p>
      <div className="mm-admin__filters"><button type="button" className="mm-admin__filter is-active" aria-pressed="true">Needs attention</button></div>
      <label className="mm-admin__field">Find an order<input type="search" value={search} placeholder="Order number or name" onChange={event => { setSearch(event.target.value); setSelectedId(""); }} /></label>
      <p className="mm-admin__helper">{orders.length} orders shown</p>
      <div className="mm-admin__orders-layout"><OrderCards orders={orders} selectedId={selectedId} onSelect={setSelectedId}
        empty={<div className="mm-admin__empty"><strong>No matching orders</strong><span>Clear your search to see the sample orders.</span></div>}
        renderSummary={(order, expanded) => <>
          <span className="mm-admin__order-card-top"><strong>{order.customer}</strong><strong className="mm-admin__order-amount">{formatMoney.format(order.total)}</strong></span>
          <span className="mm-admin__badges"><em className="mm-admin__badge mm-admin__badge--paid">Paid</em><em className="mm-admin__badge">{order.status}</em><span>{order.deliveryMethod}</span></span>
          <span className="mm-admin__order-summary-footer"><span className="mm-admin__order-meta">{order.id} · {order.placedAt}</span><span className="mm-admin__order-toggle-label">{expanded ? "Close details" : "View details"}</span></span>
        </>}
        renderDetails={close => selected ? <article className="mm-admin__detail" aria-label={`Details for ${selected.id}`}>
          <button type="button" className="mm-admin__text-button mm-admin__close-details" onClick={close}>Close details</button>
          <div className="mm-admin__detail-heading"><p className="mm-admin__eyebrow">ORDER DETAILS</p><h2>{selected.customer}</h2><p className="mm-admin__order-meta">{selected.id} · {selected.placedAt}</p></div>
          <div className="mm-admin__badges"><em className="mm-admin__badge mm-admin__badge--paid">Paid</em><em className="mm-admin__badge">{selected.status}</em><span>{selected.deliveryMethod}</span></div>
          <section className="mm-admin__next-step"><p className="mm-admin__eyebrow">YOUR NEXT STEP</p><p>{selected.guidance}</p><p className="mm-admin__helper">Delivery and payment actions are not connected in this preview.</p></section>
          <section className="mm-admin__detail-block"><h3>Customer</h3><p>{selected.customer}</p><p>customer@example.invalid</p></section>
          <section className="mm-admin__detail-block"><h3>Items</h3><p>1 × {selected.item}</p></section>
          <section className="mm-admin__detail-block"><h3>Payment</h3><p>Paid · {formatMoney.format(selected.total)}</p></section>
          <section className="mm-admin__detail-block"><h3>Fulfilment</h3><p>{selected.deliveryMethod}</p><p>{selected.deliveryMethod === "Collection" ? "Arrange customer collection." : "20 Example Road, Example Suburb, Cape Town"}</p></section>
          <button type="button" className="mm-admin__text-button mm-admin__close-details" onClick={close}>Close details</button>
        </article> : null} /></div>
    </div>
  </main>;
}
