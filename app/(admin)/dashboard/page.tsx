import { ArrowRight, CalendarDays, CircleAlert, PackageCheck, ShoppingBag, TrendingUp } from "lucide-react";
import Link from "next/link";

const recentOrders = [
  { id: "MM-1048", customer: "Naledi Mokoena", date: "28 Aug, 10:42", total: "R 1,498", status: "New", tone: "new" },
  { id: "MM-1047", customer: "Aisha Khan", date: "28 Aug, 09:16", total: "R 899", status: "Processing", tone: "processing" },
  { id: "MM-1046", customer: "Zanele Dlamini", date: "27 Aug, 16:03", total: "R 2,147", status: "Ready", tone: "ready" },
  { id: "MM-1045", customer: "Samira Jacobs", date: "27 Aug, 12:38", total: "R 749", status: "Delivered", tone: "delivered" },
];

export default function DashboardPage() {
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Friday, 28 August</p>
          <h1>Good morning, Zarina</h1>
          <p className="page-intro">Here&apos;s what is happening with Moving Modesty today.</p>
        </div>
        <Link className="button button-primary" href="/orders">
          View all orders <ArrowRight size={17} />
        </Link>
      </header>

      <section className="metrics-grid" aria-label="Store summary">
        <article className="metric-card metric-featured">
          <div className="metric-icon"><ShoppingBag size={20} /></div>
          <p>New orders</p>
          <div className="metric-value-row"><strong>3</strong><span className="trend"><TrendingUp size={13} /> 2 today</span></div>
          <small>Waiting for confirmation</small>
        </article>
        <article className="metric-card">
          <div className="metric-icon"><PackageCheck size={20} /></div>
          <p>In progress</p>
          <div className="metric-value-row"><strong>7</strong></div>
          <small>Across processing and ready</small>
        </article>
        <article className="metric-card">
          <div className="metric-icon"><CalendarDays size={20} /></div>
          <p>Sales this month</p>
          <div className="metric-value-row"><strong>R 18,240</strong></div>
          <small>From 21 completed orders</small>
        </article>
        <article className="metric-card metric-warning">
          <div className="metric-icon"><CircleAlert size={20} /></div>
          <p>Low stock</p>
          <div className="metric-value-row"><strong>4</strong></div>
          <small>Variants need attention</small>
        </article>
      </section>

      <div className="dashboard-grid">
        <section className="panel orders-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Latest activity</p><h2>Recent orders</h2></div>
            <Link className="text-link" href="/orders">Manage orders <ArrowRight size={15} /></Link>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Order</th><th>Customer</th><th>Placed</th><th>Total</th><th>Status</th></tr></thead>
              <tbody>
                {recentOrders.map((order) => (
                  <tr key={order.id}>
                    <td><Link className="order-link" href={`/orders/${order.id}`}>{order.id}</Link></td>
                    <td>{order.customer}</td><td className="muted-cell">{order.date}</td><td>{order.total}</td>
                    <td><span className={`status status-${order.tone}`}><i />{order.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="panel attention-panel">
          <div className="panel-heading"><div><p className="eyebrow">To do</p><h2>Needs attention</h2></div><span className="count-pill">4</span></div>
          <ul className="attention-list">
            <li><span className="product-swatch swatch-black" /><div><strong>Amina Abaya · Black · 54</strong><small>Only 1 remaining</small></div><Link href="/inventory">Review</Link></li>
            <li><span className="product-swatch swatch-lilac" /><div><strong>Amina Abaya · Lilac · 56</strong><small>Only 2 remaining</small></div><Link href="/inventory">Review</Link></li>
            <li><span className="product-swatch swatch-pink" /><div><strong>Hawa Dress · Soft Pink · 52</strong><small>Out of stock</small></div><Link href="/inventory">Review</Link></li>
          </ul>
          <Link className="button button-secondary button-full" href="/inventory">Open inventory</Link>
        </aside>
      </div>

      <section className="setup-note">
        <div className="setup-icon">02</div>
        <div><p className="eyebrow">Store setup</p><h3>Choose your delivery workflow</h3><p>Orders can be processed manually now. Connect a delivery partner whenever you&apos;re ready.</p></div>
        <Link className="button button-light" href="/delivery">Set up delivery <ArrowRight size={16} /></Link>
      </section>
    </>
  );
}
