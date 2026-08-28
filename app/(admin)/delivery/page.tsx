import { Check, Clock3, PackageCheck, Plus, Store, Truck } from "lucide-react";

export const metadata = { title: "Delivery" };

export default function DeliveryPage() {
  return (
    <>
      <header className="page-header page-header-top"><div><p className="eyebrow">Fulfilment</p><h1>Delivery</h1><p className="page-intro">Start manually now and connect a courier when the business is ready.</p></div></header>
      <section className="delivery-callout"><div className="delivery-callout-icon"><Truck size={25} /></div><div><p className="eyebrow">Flexible by design</p><h2>No courier decision needed yet</h2><p>Orders can be packed, marked ready, and completed manually. The database keeps courier and tracking fields optional so a delivery service can be connected later.</p></div><span className="ready-chip"><Check size={14} /> Ready to use</span></section>
      <div className="delivery-grid">
        <section className="panel delivery-option selected-option"><div className="option-top"><span><PackageCheck size={22} /></span><em>Active</em></div><h2>Manual fulfilment</h2><p>Enter the courier, tracking number and delivery fee on each order.</p><ul><li><Check size={14} /> Works immediately</li><li><Check size={14} /> Supports any courier</li><li><Check size={14} /> No monthly integration cost</li></ul><button className="button button-secondary button-full" type="button">Manage defaults</button></section>
        <section className="panel delivery-option"><div className="option-top"><span><Store size={22} /></span></div><h2>Customer collection</h2><p>Let customers collect orders from a chosen location once they are ready.</p><ul><li><Check size={14} /> Custom collection instructions</li><li><Check size={14} /> Ready-for-collection email</li><li><Clock3 size={14} /> Collection times</li></ul><button className="button button-secondary button-full" type="button">Set collection details</button></section>
        <section className="panel delivery-option future-option"><div className="option-top"><span><Truck size={22} /></span><em>Later</em></div><h2>Courier integration</h2><p>Quote rates, book delivery and sync tracking when a partner is selected.</p><ul><li><Plus size={14} /> Courier API connection</li><li><Plus size={14} /> Automatic tracking</li><li><Plus size={14} /> Live delivery rates</li></ul><button className="button button-secondary button-full" type="button" disabled>Connect when ready</button></section>
      </div>
      <section className="panel workflow-panel"><div><p className="eyebrow">Order workflow</p><h2>How fulfilment works now</h2></div><ol><li><span>1</span><div><strong>Order confirmed</strong><small>Payment and stock checked</small></div></li><li><span>2</span><div><strong>Prepare items</strong><small>Pick and package the order</small></div></li><li><span>3</span><div><strong>Add delivery details</strong><small>Courier or customer collection</small></div></li><li><span>4</span><div><strong>Complete</strong><small>Customer receives an update</small></div></li></ol></section>
    </>
  );
}
