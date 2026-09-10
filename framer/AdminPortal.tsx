import {
    startTransition,
    useEffect,
    useMemo,
    useState,
    type CSSProperties,
    type FormEvent,
    type ReactNode,
} from "react"
import { addPropertyControls, ControlType, useIsStaticRenderer } from "framer"

type View = "login" | "dashboard" | "orders" | "products"
type OrderStatus =
    | "New"
    | "Confirmed"
    | "Processing"
    | "Ready"
    | "Dispatched"
    | "Delivered"

interface OrderItem {
    name: string
    variant: string
    quantity: number
    price: number
}

interface AdminOrder {
    id: string
    customer: string
    email: string
    phone: string
    placedAt: string
    total: number
    paymentStatus: "Paid" | "Pending"
    status: OrderStatus
    deliveryMethod: "Courier" | "Collection" | "To be confirmed"
    address?: string
    items: OrderItem[]
}

interface Snapshot {
    orders: AdminOrder[]
}

interface AdminPortalProps {
    view: View
    apiBaseUrl: string
    background: string
    surface: string
    softSurface: string
    ink: string
    muted: string
    sage: string
    border: string
    style?: CSSProperties
}

const emptySnapshot: Snapshot = { orders: [] }

const money = new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    maximumFractionDigits: 0,
})
function normalizeBaseUrl(value: string) {
    return value.trim().replace(/\/$/, "")
}

function token() {
    if (typeof window === "undefined") return ""
    return window.sessionStorage.getItem("moving_modesty_admin_token") || ""
}

function route(path: string) {
    if (typeof window !== "undefined") window.location.href = path
}

function badgeClass(status: string) {
    return `mm-admin__badge mm-admin__badge--${status.toLowerCase().replaceAll(" ", "-")}`
}

/**
 * Moving Modesty admin portal data surface.
 *
 * @framerIntrinsicWidth 920
 * @framerIntrinsicHeight 780
 * @framerSupportedLayoutWidth any-prefer-fixed
 * @framerSupportedLayoutHeight auto
 */
export default function AdminPortal(props: AdminPortalProps) {
    const {
        view = "dashboard",
        apiBaseUrl = "",
        background = "#F5F3F0",
        surface = "#EEEAE6",
        softSurface = "#CDD2CE",
        ink = "#302A24",
        muted = "#746D65",
        sage = "#7D896D",
        border = "#A69E95",
        style,
    } = props

    const isStatic = useIsStaticRenderer()
    const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot)
    const [loading, setLoading] = useState(false)
    const [notice, setNotice] = useState("")
    const [selectedOrderId, setSelectedOrderId] = useState("")
    const [orderFilter, setOrderFilter] = useState("All orders")

    const backendConfigured = Boolean(normalizeBaseUrl(apiBaseUrl))
    const liveEnabled = backendConfigured && !isStatic

    useEffect(() => {
        if (!liveEnabled || view === "login") return
        const adminToken = token()
        if (!adminToken) {
            route("/admin/login")
            return
        }
        let active = true
        startTransition(() => setLoading(true))
        fetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/data`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        })
            .then(async (response) => {
                if (response.status === 401) {
                    route("/admin/login")
                    throw new Error("Please sign in again.")
                }
                const data = await response.json().catch(() => null)
                if (!response.ok) throw new Error(data?.error || "The admin data could not be loaded.")
                return data
            })
            .then((data: Snapshot) => {
                if (!active) return
                startTransition(() => {
                    setSnapshot(data)
                    setSelectedOrderId(data.orders[0]?.id || "")
                    setNotice("")
                })
            })
            .catch((error: Error) => {
                if (!active) return
                startTransition(() => setNotice(error.message))
            })
            .finally(() => {
                if (active) startTransition(() => setLoading(false))
            })
        return () => {
            active = false
        }
    }, [apiBaseUrl, liveEnabled, view])

    const selectedOrder =
        snapshot.orders.find((order) => order.id === selectedOrderId) || snapshot.orders[0]

    const filteredOrders = useMemo(() => {
        if (orderFilter === "Paid") return snapshot.orders.filter((order) => order.paymentStatus === "Paid")
        if (orderFilter === "Pending") return snapshot.orders.filter((order) => order.paymentStatus === "Pending")
        return snapshot.orders
    }, [orderFilter, snapshot.orders])

    async function updateOrderStatus(order: AdminOrder, status: OrderStatus) {
        if (!liveEnabled) {
            startTransition(() => setNotice("Open the Framer preview to manage live orders."))
            return
        }
        startTransition(() => setLoading(true))
        try {
            const response = await fetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/orders/${order.id}`, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token()}`,
                },
                body: JSON.stringify({ status }),
            })
            if (!response.ok) throw new Error("The order status could not be updated.")
            const data = await response.json()
            startTransition(() => {
                setSnapshot((current) => ({
                    ...current,
                    orders: current.orders.map((item) => (item.id === order.id ? data.order : item)),
                }))
                setNotice(`${order.id} updated. The customer email has been queued when Resend is configured.`)
            })
        } catch (error) {
            startTransition(() => setNotice(error instanceof Error ? error.message : "Update failed."))
        } finally {
            startTransition(() => setLoading(false))
        }
    }

    function logout() {
        if (typeof window !== "undefined") window.sessionStorage.removeItem("moving_modesty_admin_token")
        route("/admin/login")
    }

    const cssVariables = {
        ...style,
        position: "relative",
        width: "100%",
        minHeight: view === "login" ? 560 : 720,
        containerType: "inline-size",
        background,
        color: ink,
        "--mm-surface": surface,
        "--mm-soft": softSurface,
        "--mm-ink": ink,
        "--mm-muted": muted,
        "--mm-sage": sage,
        "--mm-border": border,
    } as CSSProperties

    return (
        <section className="mm-admin" style={cssVariables} aria-busy={loading}>
            <style>{styles}</style>
            {view === "login" ? (
                <LoginView apiBaseUrl={apiBaseUrl} liveEnabled={liveEnabled} backendConfigured={backendConfigured} />
            ) : (
                <div className="mm-admin__page">
                    {notice ? <div className="mm-admin__notice">{notice}</div> : null}
                    {view === "dashboard" ? (
                        <DashboardView snapshot={snapshot} logout={logout} />
                    ) : view === "orders" ? (
                        <OrdersView
                            orders={filteredOrders}
                            selected={selectedOrder}
                            selectedOrderId={selectedOrderId}
                            setSelectedOrderId={setSelectedOrderId}
                            filter={orderFilter}
                            setFilter={setOrderFilter}
                            updateOrderStatus={updateOrderStatus}
                            loading={loading}
                        />
                    ) : (
                        <ProductsView />
                    )}
                </div>
            )}
        </section>
    )
}

function LoginView({ apiBaseUrl, liveEnabled, backendConfigured }: { apiBaseUrl: string; liveEnabled: boolean; backendConfigured: boolean }) {
    const [email, setEmail] = useState("")
    const [password, setPassword] = useState("")
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState("")

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        if (!liveEnabled) {
            startTransition(() => setError(backendConfigured ? "Open the Framer preview to sign in." : "Admin connection is unavailable."))
            return
        }
        startTransition(() => {
            setLoading(true)
            setError("")
        })
        try {
            const response = await fetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
            })
            const data = await response.json()
            if (!response.ok || !data.token) throw new Error(data.error || "Sign-in failed.")
            if (typeof window !== "undefined") {
                window.sessionStorage.setItem("moving_modesty_admin_token", data.token)
            }
            route("/admin")
        } catch (caught) {
            startTransition(() => setError(caught instanceof Error ? caught.message : "Sign-in failed."))
        } finally {
            startTransition(() => setLoading(false))
        }
    }

    return (
        <div className="mm-admin__login-stage">
            <form className="mm-admin__login-card" onSubmit={submit}>
                <p className="mm-admin__eyebrow">MOVING MODESTY / ADMIN</p>
                <h1 className="mm-admin__login-title">Sign in</h1>
                <p className="mm-admin__lead">Administrator access only.</p>
                <label className="mm-admin__field">
                    <span>Email address</span>
                    <input
                        type="email"
                        autoComplete="username"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        required
                    />
                </label>
                <label className="mm-admin__field">
                    <span>Password</span>
                    <input
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="Password"
                        required
                    />
                </label>
                {error ? <p className="mm-admin__error" role="alert">{error}</p> : null}
                <button className="mm-admin__button" type="submit" disabled={loading}>
                    {loading ? "Signing in…" : "Sign in"}
                </button>
                <p className="mm-admin__helper">
                    {backendConfigured ? "Secure administrator session." : ""}
                </p>
            </form>
        </div>
    )
}

function PageHeader({ eyebrow, title, action, onAction }: { eyebrow: string; title: string; action: string; onAction: () => void }) {
    return (
        <header className="mm-admin__header">
            <div>
                <p className="mm-admin__eyebrow">{eyebrow}</p>
                <h1 className={`mm-admin__title ${title === "Dashboard" ? "mm-admin__title--dashboard" : ""}`}>{title}</h1>
            </div>
            <button className="mm-admin__button" type="button" onClick={onAction}>{action}</button>
        </header>
    )
}

function DashboardView({ snapshot, logout }: { snapshot: Snapshot; logout: () => void }) {
    const paidRevenue = snapshot.orders
        .filter((order) => order.paymentStatus === "Paid")
        .reduce((sum, order) => sum + order.total, 0)
    const stats = [
        ["New orders", snapshot.orders.filter((order) => order.status === "New").length],
        ["Processing", snapshot.orders.filter((order) => order.status === "Processing").length],
        ["Ready", snapshot.orders.filter((order) => order.status === "Ready").length],
        ["Revenue", money.format(paidRevenue)],
    ]
    return (
        <>
            <PageHeader eyebrow="ADMIN PORTAL" title="Dashboard" action="Log out" onAction={logout} />
            <div className="mm-admin__stats">
                {stats.map(([label, value]) => (
                    <article className="mm-admin__stat" key={String(label)}>
                        <p>{label}</p>
                        <strong>{value}</strong>
                    </article>
                ))}
            </div>
            <div className="mm-admin__section-heading">
                <h2>Recent orders</h2>
                <button className="mm-admin__button" type="button" onClick={() => route("/admin/orders")}>Manage orders</button>
            </div>
            <div className="mm-admin__order-table">
                {snapshot.orders.length === 0 ? (
                    <div className="mm-admin__empty"><strong>No orders yet</strong><span>New customer orders will appear here.</span></div>
                ) : null}
                {snapshot.orders.slice(0, 5).map((order) => (
                    <button className="mm-admin__order-row" type="button" key={order.id} onClick={() => route("/admin/orders")}>
                        <strong>{order.id}</strong>
                        <span>{order.customer}</span>
                        <span>{order.placedAt}</span>
                        <span>{money.format(order.total)}</span>
                        <em className={badgeClass(order.status)}>{order.status}</em>
                    </button>
                ))}
            </div>
            <div className="mm-admin__quick-grid">
                <article className="mm-admin__quick-card">
                    <h3>Products</h3>
                    <p>Product content and collection items are managed directly in Framer CMS.</p>
                    <span className="mm-admin__muted-label">CMS is the storefront source of truth</span>
                </article>
                <article className="mm-admin__quick-card">
                    <h3>Delivery</h3>
                    <p>Courier, collection, or to be confirmed per order.</p>
                    <span className="mm-admin__muted-label">Provider-neutral for now</span>
                </article>
            </div>
        </>
    )
}

function OrdersView({
    orders,
    selected,
    selectedOrderId,
    setSelectedOrderId,
    filter,
    setFilter,
    updateOrderStatus,
    loading,
}: {
    orders: AdminOrder[]
    selected?: AdminOrder
    selectedOrderId: string
    setSelectedOrderId: (id: string) => void
    filter: string
    setFilter: (filter: string) => void
    updateOrderStatus: (order: AdminOrder, status: OrderStatus) => void
    loading: boolean
}) {
    return (
        <>
            <PageHeader eyebrow="ADMIN / ORDERS" title="Orders" action="Back to dashboard" onAction={() => route("/admin")} />
            <div className="mm-admin__filters" role="group" aria-label="Order filters">
                {["All orders", "Pending", "Paid"].map((label) => (
                    <button
                        className={`mm-admin__button ${filter === label ? "is-active" : ""}`}
                        type="button"
                        key={label}
                        onClick={() => setFilter(label)}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <div className="mm-admin__orders-layout">
                <div className="mm-admin__order-list">
                    {orders.map((order) => (
                        <button
                            className={`mm-admin__order-card ${selectedOrderId === order.id ? "is-selected" : ""}`}
                            type="button"
                            key={order.id}
                            onClick={() => setSelectedOrderId(order.id)}
                        >
                            <span className="mm-admin__order-card-top">
                                <strong>{order.id}</strong>
                                <em className={badgeClass(order.status)}>{order.status}</em>
                            </span>
                            <span>{order.customer}</span>
                            <span>{order.placedAt}</span>
                            <strong>{money.format(order.total)}</strong>
                        </button>
                    ))}
                </div>
                {selected ? (
                    <article className="mm-admin__detail">
                        <p className="mm-admin__eyebrow">SELECTED ORDER</p>
                        <h2>{selected.id}</h2>
                        <Detail title="Customer">
                            <p>{selected.customer}</p><p>{selected.email}</p><p>{selected.phone}</p>
                        </Detail>
                        <Detail title="Items">
                            {selected.items.map((item, index) => (
                                <p key={`${item.name}-${index}`}>{item.quantity} × {item.name} · {item.variant} · {money.format(item.price)}</p>
                            ))}
                        </Detail>
                        <Detail title="Payment">
                            <p>{selected.paymentStatus} · {money.format(selected.total)}</p>
                        </Detail>
                        <Detail title="Fulfilment">
                            <p>{selected.deliveryMethod}</p><p>{selected.address || "Collection address to be confirmed."}</p>
                        </Detail>
                        <div className="mm-admin__actions">
                            <button className="mm-admin__button" type="button" disabled={loading || selected.status === "Ready"} onClick={() => updateOrderStatus(selected, "Ready")}>Mark ready</button>
                            <button className="mm-admin__button" type="button" disabled={loading || selected.status === "Dispatched"} onClick={() => updateOrderStatus(selected, "Dispatched")}>Mark dispatched</button>
                            <button className="mm-admin__button" type="button" disabled={loading || selected.status === "Delivered"} onClick={() => updateOrderStatus(selected, "Delivered")}>Mark delivered</button>
                        </div>
                    </article>
                ) : <div className="mm-admin__empty"><strong>No orders yet</strong><span>Orders matching this view will appear here.</span></div>}
            </div>
        </>
    )
}

function Detail({ title, children }: { title: string; children: ReactNode }) {
    return <section className="mm-admin__detail-block"><h3>{title}</h3>{children}</section>
}

function ProductsView() {
    return (
        <>
            <PageHeader eyebrow="ADMIN / PRODUCTS" title="Products" action="Back to dashboard" onAction={() => route("/admin")} />
            <div className="mm-admin__cms-note">
                <p className="mm-admin__eyebrow">FRAMER CMS</p>
                <h2>Products are managed in the CMS</h2>
                <p>
                    Add and edit product collection items directly in Framer. The admin portal no longer imports,
                    updates, or publishes storefront products.
                </p>
            </div>
        </>
    )
}

const styles = `
.mm-admin, .mm-admin * { box-sizing: border-box; }
.mm-admin { font-family: Inter, Arial, sans-serif; font-size: 15px; line-height: 1.45; }
.mm-admin button, .mm-admin input, .mm-admin select, .mm-admin textarea { font: inherit; }
.mm-admin button { color: inherit; }
.mm-admin__page { display: flex; flex-direction: column; gap: 30px; padding: 40px; width: 100%; }
.mm-admin__notice { border: 1px solid var(--mm-border); background: var(--mm-soft); padding: 12px 16px; }
.mm-admin__header, .mm-admin__section-heading, .mm-admin__product-toolbar, .mm-admin__order-card-top, .mm-admin__actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.mm-admin__eyebrow { margin: 0 0 8px; color: var(--mm-muted); font-size: 12px; font-weight: 700; letter-spacing: .08em; }
.mm-admin__title { margin: 0; color: #fff; font-family: Montserrat, Inter, sans-serif; font-size: clamp(46px, 6vw, 72px); font-weight: 400; letter-spacing: -.035em; line-height: .95; text-transform: uppercase; }
.mm-admin__title--dashboard { color: var(--mm-ink); }
.mm-admin__button { appearance: none; border: 0; border-radius: 0; background: var(--mm-sage); color: #fff !important; cursor: pointer; font-weight: 700; padding: 13px 20px; transition: opacity .18s ease; }
.mm-admin__button:hover { opacity: .82; }
.mm-admin__button:disabled { cursor: not-allowed; opacity: .45; }
.mm-admin__button.is-active { box-shadow: inset 0 0 0 2px var(--mm-ink); }
.mm-admin__secondary-button, .mm-admin__text-button { appearance: none; border: 1px solid var(--mm-border); background: transparent; color: var(--mm-ink); cursor: pointer; font-weight: 700; padding: 12px 18px; }
.mm-admin__text-button { border: 0; padding: 8px 0; text-decoration: underline; }
.mm-admin__stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.mm-admin__stat { min-height: 132px; margin: 0; border: 1px solid var(--mm-border); background: var(--mm-surface); padding: 24px; }
.mm-admin__stat p { margin: 0 0 12px; text-transform: uppercase; }
.mm-admin__stat strong { display: block; font-family: Montserrat, Inter, sans-serif; font-size: 38px; font-weight: 500; }
.mm-admin__section-heading h2 { margin: 0; font-family: Montserrat, Inter, sans-serif; font-size: 42px; font-weight: 500; letter-spacing: -.04em; text-transform: uppercase; }
.mm-admin__order-table, .mm-admin__order-list, .mm-admin__product-list { display: flex; flex-direction: column; background: var(--mm-border); gap: 1px; }
.mm-admin__order-row { display: grid; grid-template-columns: .8fr 1.2fr 1fr .8fr .7fr; align-items: center; gap: 16px; width: 100%; border: 0; background: var(--mm-surface); padding: 18px; text-align: left; cursor: pointer; }
.mm-admin__order-row:hover, .mm-admin__order-card:hover, .mm-admin__order-card.is-selected { background: var(--mm-soft); }
.mm-admin__order-row em, .mm-admin__product-row em { justify-self: end; }
.mm-admin__badge { display: inline-block; border: 1px solid var(--mm-border); background: #E3E8DF; color: #536047; font-size: 11px; font-style: normal; font-weight: 700; padding: 3px 8px; white-space: nowrap; }
.mm-admin__badge--pending, .mm-admin__badge--new, .mm-admin__badge--low-stock { background: #F1E7D2; color: #765C35; }
.mm-admin__badge--delivered, .mm-admin__badge--active, .mm-admin__badge--paid { background: #E1E9DD; color: #4E6545; }
.mm-admin__quick-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.mm-admin__quick-card { border: 1px solid var(--mm-border); background: var(--mm-surface); padding: 26px; }
.mm-admin__quick-card h3 { margin: 0 0 8px; font-size: 21px; }
.mm-admin__quick-card p { margin: 0 0 18px; color: var(--mm-muted); letter-spacing: .05em; text-transform: uppercase; }
.mm-admin__cms-note { border: 1px solid var(--mm-border); background: var(--mm-surface); padding: clamp(28px, 6vw, 64px); }
.mm-admin__cms-note h2 { max-width: 720px; margin: 0 0 18px; font-family: Montserrat, Inter, sans-serif; font-size: clamp(34px, 5vw, 58px); font-weight: 500; letter-spacing: -.04em; line-height: 1; text-transform: uppercase; }
.mm-admin__cms-note > p:last-child { max-width: 680px; margin: 0; color: var(--mm-muted); font-size: 17px; line-height: 1.65; }
.mm-admin__muted-label { color: var(--mm-muted); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.mm-admin__filters { display: flex; flex-wrap: wrap; gap: 12px; }
.mm-admin__orders-layout { display: grid; grid-template-columns: minmax(260px, .9fr) minmax(360px, 1.1fr); align-items: start; gap: 24px; }
.mm-admin__order-card { display: flex; flex-direction: column; gap: 8px; width: 100%; border: 0; background: var(--mm-surface); cursor: pointer; padding: 18px; text-align: left; }
.mm-admin__detail { display: flex; flex-direction: column; gap: 20px; border: 1px solid var(--mm-border); background: var(--mm-surface); padding: 28px; }
.mm-admin__detail > h2 { margin: -4px 0 4px; font-family: Montserrat, Inter, sans-serif; font-size: 42px; font-weight: 500; }
.mm-admin__detail-block { border: 1px solid var(--mm-border); background: var(--mm-soft); padding: 17px; }
.mm-admin__detail-block h3, .mm-admin__detail-block p { margin: 0; }
.mm-admin__detail-block h3 { margin-bottom: 8px; font-size: 20px; }
.mm-admin__detail-block p + p { margin-top: 5px; }
.mm-admin__actions { justify-content: flex-start; flex-wrap: wrap; }
.mm-admin__product-toolbar input, .mm-admin__field input, .mm-admin__field select, .mm-admin__field textarea { width: min(320px, 100%); border: 1px solid var(--mm-border); border-radius: 10px; background: var(--mm-surface); color: var(--mm-ink); padding: 13px 15px; outline: none; }
.mm-admin__product-toolbar input:focus, .mm-admin__field input:focus, .mm-admin__field select:focus, .mm-admin__field textarea:focus { border-color: var(--mm-sage); box-shadow: 0 0 0 2px color-mix(in srgb, var(--mm-sage) 22%, transparent); }
.mm-admin__product-editor { display: flex; flex-direction: column; gap: 24px; border: 1px solid var(--mm-border); background: var(--mm-soft); padding: 26px; }
.mm-admin__editor-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.mm-admin__editor-heading h2 { margin: 0; font-family: Montserrat, Inter, sans-serif; font-size: 32px; font-weight: 500; text-transform: uppercase; }
.mm-admin__editor-heading--variants { align-items: center; border-top: 1px solid var(--mm-border); padding-top: 22px; }
.mm-admin__editor-help { margin: 0; color: var(--mm-muted); }
.mm-admin__editor-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.mm-admin__field--wide { grid-column: 1 / -1; }
.mm-admin__field--wide input, .mm-admin__field--wide textarea { width: 100%; }
.mm-admin__variant-editor-list { display: flex; flex-direction: column; gap: 12px; }
.mm-admin__variant-editor { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; margin: 0; border: 1px solid var(--mm-border); background: var(--mm-surface); padding: 16px; }
.mm-admin__variant-editor legend { padding: 0 8px; color: var(--mm-muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.mm-admin__variant-editor .mm-admin__field input { width: 100%; }
.mm-admin__product-card { background: var(--mm-surface); }
.mm-admin__product-row { display: grid; grid-template-columns: 58px 1.5fr repeat(3, .7fr) .8fr auto; align-items: center; gap: 16px; background: var(--mm-surface); padding: 16px; }
.mm-admin__product-row h3, .mm-admin__product-row p { margin: 0; }
.mm-admin__product-row h3 { font-size: 19px; }
.mm-admin__product-row p:not(.mm-admin__eyebrow) { color: var(--mm-muted); }
.mm-admin__product-thumb { display: grid; place-items: center; width: 56px; height: 68px; overflow: hidden; border: 1px solid var(--mm-border); background: var(--mm-soft); color: var(--mm-muted); font-size: 22px; }
.mm-admin__product-thumb img { width: 100%; height: 100%; object-fit: cover; }
.mm-admin__variant-list { display: flex; flex-direction: column; border-top: 1px solid var(--mm-border); background: var(--mm-soft); }
.mm-admin__variant-row { display: grid; grid-template-columns: 1.05fr 1.4fr .75fr .55fr auto; align-items: center; gap: 16px; padding: 12px 16px 12px 90px; }
.mm-admin__variant-row + .mm-admin__variant-row { border-top: 1px solid color-mix(in srgb, var(--mm-border) 55%, transparent); }
.mm-admin__variant-row span { display: flex; flex-direction: column; min-width: 0; }
.mm-admin__variant-row small { margin-bottom: 3px; color: var(--mm-muted); font-size: 9px; font-weight: 700; letter-spacing: .08em; }
.mm-admin__variant-row em { justify-self: end; }
.mm-admin__inventory-note { border: 1px solid var(--mm-border); background: var(--mm-soft); padding: 24px; }
.mm-admin__inventory-note p:last-child { margin: 0; max-width: 780px; letter-spacing: .04em; text-transform: uppercase; }
.mm-admin__empty { display: flex; flex-direction: column; gap: 6px; background: var(--mm-surface); color: var(--mm-muted); padding: 28px; }
.mm-admin__empty strong { color: var(--mm-ink); font-size: 18px; }
.mm-admin__login-stage { display: grid; min-height: 720px; place-items: center; background: var(--mm-soft); padding: 32px 20px; }
.mm-admin__login-card { display: flex; flex-direction: column; gap: 18px; width: min(440px, 100%); border: 1px solid var(--mm-border); background: var(--mm-surface); padding: 40px; }
.mm-admin__login-title { margin: 2px 0 0; font-family: Montserrat, Inter, sans-serif; font-size: 42px; font-weight: 500; letter-spacing: -.04em; text-transform: uppercase; }
.mm-admin__lead { margin: 0 0 2px; letter-spacing: .08em; text-transform: uppercase; }
.mm-admin__field { display: flex; flex-direction: column; gap: 8px; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.mm-admin__field input, .mm-admin__field select { width: 100%; height: 48px; text-transform: none; }
.mm-admin__field textarea { width: 100%; resize: vertical; text-transform: none; }
.mm-admin__error { margin: 0; color: #8A342C; font-size: 13px; }
.mm-admin__helper { margin: 0; color: var(--mm-muted); font-size: 13px; }
@container (max-width: 900px) {
  .mm-admin__page { padding: 28px 24px; }
  .mm-admin__stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mm-admin__orders-layout { grid-template-columns: 1fr; }
  .mm-admin__editor-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mm-admin__variant-editor { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .mm-admin__product-row { grid-template-columns: 56px 1.4fr repeat(2, .7fr) auto; }
  .mm-admin__product-row > :nth-child(4), .mm-admin__product-row > :nth-child(6) { display: none; }
  .mm-admin__variant-row { padding-left: 16px; }
}
@container (max-width: 620px) {
  .mm-admin__page { gap: 22px; padding: 24px 18px; }
  .mm-admin__header, .mm-admin__section-heading, .mm-admin__product-toolbar { align-items: flex-start; flex-direction: column; }
  .mm-admin__title { font-size: 44px; }
  .mm-admin__stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mm-admin__quick-grid { grid-template-columns: 1fr; }
  .mm-admin__section-heading h2 { font-size: 34px; }
  .mm-admin__order-row { grid-template-columns: 1fr auto; }
  .mm-admin__order-row > :nth-child(3), .mm-admin__order-row > :nth-child(4) { display: none; }
  .mm-admin__product-toolbar, .mm-admin__product-toolbar input { width: 100%; }
  .mm-admin__product-editor { padding: 20px; }
  .mm-admin__editor-heading, .mm-admin__editor-heading--variants { align-items: flex-start; flex-direction: column; }
  .mm-admin__editor-grid { grid-template-columns: 1fr; }
  .mm-admin__variant-editor { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mm-admin__product-row { grid-template-columns: 48px 1fr auto; }
  .mm-admin__product-row > :nth-child(3), .mm-admin__product-row > :nth-child(4), .mm-admin__product-row > :nth-child(5), .mm-admin__product-row > :nth-child(6) { display: none; }
  .mm-admin__product-thumb { width: 46px; height: 56px; }
  .mm-admin__variant-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mm-admin__variant-row em { justify-self: start; }
  .mm-admin__login-card { padding: 28px; }
}
@container (max-width: 430px) {
  .mm-admin__stats { grid-template-columns: 1fr; }
  .mm-admin__variant-editor, .mm-admin__variant-row { grid-template-columns: 1fr; }
}
`

addPropertyControls(AdminPortal, {
    view: {
        type: ControlType.Enum,
        title: "View",
        options: ["login", "dashboard", "orders", "products"],
        optionTitles: ["Login", "Dashboard", "Orders", "Products"],
        defaultValue: "dashboard",
    },
    apiBaseUrl: {
        type: ControlType.String,
        title: "Vercel API",
        defaultValue: "",
        placeholder: "https://admin-api.vercel.app",
    },
    background: { type: ControlType.Color, title: "Background", defaultValue: "#F5F3F0" },
    surface: { type: ControlType.Color, title: "Surface", defaultValue: "#EEEAE6" },
    softSurface: { type: ControlType.Color, title: "Soft Surface", defaultValue: "#CDD2CE" },
    ink: { type: ControlType.Color, title: "Text", defaultValue: "#302A24" },
    muted: { type: ControlType.Color, title: "Muted", defaultValue: "#746D65" },
    sage: { type: ControlType.Color, title: "Action", defaultValue: "#7D896D" },
    border: { type: ControlType.Color, title: "Border", defaultValue: "#A69E95" },
})
