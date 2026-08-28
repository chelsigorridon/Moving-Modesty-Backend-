import { ArrowLeft, Check, Mail, MapPin, MoreHorizontal, Phone, Printer, Truck } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { currency, orders, statusTone } from "@/lib/store-data";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = orders.find((item) => item.id.toLowerCase() === decodeURIComponent(id).toLowerCase());
  if (!order) notFound();

  return (
    <>
      <Link className="back-link" href="/orders"><ArrowLeft size={15} /> Back to orders</Link>
      <header className="order-detail-header">
        <div><div className="title-with-status"><h1>{order.id}</h1><span className={`status status-${statusTone(order.status)}`}><i />{order.status}</span></div><p className="page-intro">Placed {order.placedDate}</p></div>
        <div className="header-actions"><button className="icon-button labeled" type="button"><Printer size={16} /> Print</button><button className="icon-button" type="button" aria-label="More order actions"><MoreHorizontal size={18} /></button></div>
      </header>

      <div className="order-detail-grid">
        <div className="detail-stack">
          <section className="panel detail-card">
            <div className="panel-heading"><div><p className="eyebrow">Purchase</p><h2>Order items</h2></div><span>{order.items.reduce((sum, item) => sum + item.quantity, 0)} items</span></div>
            <div className="line-items">{order.items.map((item, index) => (
              <div className="line-item" key={`${item.name}-${index}`}>
                <Image src={item.image} alt="" width={62} height={76} className="line-item-image" />
                <div><strong>{item.name}</strong><small>{item.variant}</small><small>Qty {item.quantity}</small></div><strong>{currency.format(item.price * item.quantity)}</strong>
              </div>
            ))}</div>
            <div className="order-totals"><div><span>Subtotal</span><strong>{currency.format(order.total)}</strong></div><div><span>Delivery</span><strong>To be confirmed</strong></div><div className="total-line"><span>Total</span><strong>{currency.format(order.total)}</strong></div></div>
          </section>

          <section className="panel detail-card">
            <div className="panel-heading"><div><p className="eyebrow">Progress</p><h2>Order timeline</h2></div></div>
            <ol className="timeline">
              <li className="timeline-complete"><span><Check size={12} /></span><div><strong>Order received</strong><small>28 August 2026 · Confirmation email sent</small></div></li>
              <li className={order.paymentStatus === "Paid" ? "timeline-complete" : ""}><span>{order.paymentStatus === "Paid" ? <Check size={12} /> : "2"}</span><div><strong>Payment confirmed</strong><small>{order.paymentStatus === "Paid" ? "Payment recorded successfully" : "Waiting for payment"}</small></div></li>
              <li><span>3</span><div><strong>Prepare order</strong><small>Update when items are being packed</small></div></li>
              <li><span>4</span><div><strong>Dispatch or collection</strong><small>Delivery details can be added later</small></div></li>
            </ol>
          </section>
        </div>

        <aside className="detail-stack">
          <section className="panel action-card"><p className="eyebrow">Next action</p><h2>Confirm this order</h2><p>Check the payment and stock, then move the order into processing.</p><button className="button button-primary button-full" type="button">Mark as confirmed</button><button className="button button-secondary button-full" type="button">Send customer update</button></section>
          <section className="panel detail-card compact-card"><div className="panel-heading"><div><p className="eyebrow">Customer</p><h2>{order.customer}</h2></div></div><div className="contact-list"><a href={`mailto:${order.email}`}><Mail size={16} /><span>{order.email}</span></a><a href={`tel:${order.phone}`}><Phone size={16} /><span>{order.phone}</span></a></div></section>
          <section className="panel detail-card compact-card"><div className="panel-heading"><div><p className="eyebrow">Fulfilment</p><h2>{order.deliveryMethod}</h2></div><Truck size={20} /></div><div className="address-block">{order.address ? <><MapPin size={16} /><p>{order.address}</p></> : <p>Customer will collect this order.</p>}</div><Link className="text-link" href="/delivery">Manage delivery details →</Link></section>
        </aside>
      </div>
    </>
  );
}
