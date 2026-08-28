import { Download, Filter, Search } from "lucide-react";
import Link from "next/link";
import { currency, orders, statusTone } from "@/lib/store-data";

export const metadata = { title: "Orders" };

export default function OrdersPage() {
  return (
    <>
      <header className="page-header page-header-top">
        <div><p className="eyebrow">Sales</p><h1>Orders</h1><p className="page-intro">Track payment, preparation and delivery from one place.</p></div>
        <button className="button button-secondary" type="button"><Download size={16} /> Export orders</button>
      </header>

      <section className="summary-strip" aria-label="Order status summary">
        <div><small>All orders</small><strong>48</strong></div><div><small>New</small><strong>3</strong></div>
        <div><small>In progress</small><strong>7</strong></div><div><small>Ready</small><strong>2</strong></div>
        <div><small>Completed</small><strong>36</strong></div>
      </section>

      <section className="panel data-panel">
        <div className="toolbar">
          <label className="search-field"><Search size={16} /><span className="sr-only">Search orders</span><input placeholder="Search order, customer or email" /></label>
          <div className="toolbar-actions">
            <select aria-label="Filter by status" defaultValue="all"><option value="all">All statuses</option><option>New</option><option>Processing</option><option>Ready</option><option>Delivered</option></select>
            <button className="icon-button" type="button" aria-label="More filters"><Filter size={17} /></button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="orders-table">
            <thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Payment</th><th>Fulfilment</th><th>Delivery</th><th>Total</th><th /></tr></thead>
            <tbody>{orders.map((order) => (
              <tr key={order.id}>
                <td><Link className="order-link" href={`/orders/${order.id}`}>{order.id}</Link></td>
                <td><div className="table-person"><span>{order.customer.split(" ").map((part) => part[0]).join("")}</span><div><strong>{order.customer}</strong><small>{order.email}</small></div></div></td>
                <td className="muted-cell">{order.placedAt}</td>
                <td><span className={`payment payment-${order.paymentStatus.toLowerCase()}`}>{order.paymentStatus}</span></td>
                <td><span className={`status status-${statusTone(order.status)}`}><i />{order.status}</span></td>
                <td className="muted-cell">{order.deliveryMethod}</td><td><strong>{currency.format(order.total)}</strong></td>
                <td><Link className="row-arrow" href={`/orders/${order.id}`} aria-label={`View ${order.id}`}>→</Link></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <div className="pagination"><span>Showing 1–5 of 48 orders</span><div><button disabled>Previous</button><button>Next</button></div></div>
      </section>
    </>
  );
}
