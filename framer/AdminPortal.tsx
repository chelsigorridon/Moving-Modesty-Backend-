import {
    startTransition,
    useEffect,
    useMemo,
    useRef,
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
    | "Preparing"
    | "Ready"
    | "Dispatched"
    | "Collected"
    | "Delivered"
    | "Cancelled"
type PaymentStatus = "Pending payment" | "Paid" | "Failed" | "Refunded"

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
    subtotal?: number
    deliveryFee?: number
    total: number
    paymentStatus: PaymentStatus
    payment?: {
        provider: "PayFast"
        environment?: "sandbox" | "production" | "unknown"
        providerStatus?: string
        providerPaymentId?: string
        failureReason?: string
        updatedAt?: string
    }
    status: OrderStatus
    deliveryMethod: "Courier" | "Collection" | "To be confirmed"
    address?: string
    items: OrderItem[]
    actionNeeded?: Array<{ message: string; reference?: string }>
    notifications?: Array<{ id: string; title: string; recipient: string; status: "queued" | "sent" | "delivered" | "failed"; createdAt: string; retryable: boolean; deliveryMessage?: string; deliveryEvent?: string }>
    shipping?: {
        provider: "Bob Go"
        status: "Not ready" | "Ready to book" | "Booking" | "Booked" | "Failed" | "Cancelled"
        senderLocationName: string
        pickupPointLocationId?: string
        weightGrams?: number
        lengthCm?: number
        widthCm?: number
        heightCm?: number
        waybillReference?: string
        trackingNumber?: string
        trackingUrl?: string
        lastError?: string
        serviceLevelCode?: string
        environment?: "sandbox" | "production"
        bookingEnabled: boolean
        blockers: string[]
    }
    workflow?: {
        nextStatus: OrderStatus | null
        actionLabel: string
        guidance: string
        canCancel: boolean
    }
}

interface Snapshot {
    orders: AdminOrder[]
    operationalNotice?: string
    paymentEnvironment?: "sandbox" | "production"
    bobGoConnection?: { environment: "sandbox" | "production"; enabled: boolean; configured: boolean }
    bobGoSetup?: {
        target: string
        match: Record<string, unknown> | null
        matchCount: number
    } | null
}
interface CourierConnectionCheck {
    status: "unchecked" | "checking" | "connected" | "error"
    message?: string
    location?: string
    checkedAt?: string
}
interface CourierQuote {
    providerName: string
    serviceCode: string
    serviceName: string
    amount: number
    quoteToken: string
}
interface ShippingResult {
    order?: AdminOrder
    rates?: CourierQuote[]
    expires?: number
    declaredValue?: number
    environment?: "sandbox" | "production"
    url?: string
    message?: string
}
type ShippingRequest = (order: AdminOrder, action: "quote" | "book" | "refresh" | "waybill", payload?: Record<string, unknown>) => Promise<ShippingResult>
type Confirmation = { title: string; description: string; run: () => void }
const courierMoney = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", minimumFractionDigits: 2 })

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

async function adminFetch(url: string, init?: RequestInit) {
    try { return await fetch(url, { ...init, signal: init?.signal || AbortSignal.timeout(45000) }) }
    catch (error) {
        if (error instanceof Error && ["TypeError", "TimeoutError", "AbortError"].includes(error.name)) {
            // Do not include tokens, URLs, form fields or customer data in telemetry.
            void fetch(`${new URL(url).origin}/api/diagnostics/browser`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ surface: "admin", code: error.name === "TypeError" ? "browser_network" : "browser_timeout" }), signal: AbortSignal.timeout(5000) }).catch(() => undefined)
        }
        throw error
    }
}

function apiErrorMessage(data: { error?: string; errorRef?: string } | null, fallback: string) {
    return `${data?.error || fallback}${data?.errorRef ? ` Reference: ${data.errorRef}` : ""}`
}

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

function rememberAdminReturnPath() {
    if (typeof window === "undefined") return
    const path = window.location.pathname
    if (path !== "/admin/login") window.sessionStorage.setItem("moving_modesty_admin_return", path + window.location.search)
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
    const [orderFilter, setOrderFilter] = useState("Needs attention")
    const [search, setSearch] = useState("")
    const [method, setMethod] = useState("All methods")
    const [refresh, setRefresh] = useState(0)
    const [loadState, setLoadState] = useState("loading")
    const [deliverySettingsOpen, setDeliverySettingsOpen] = useState(false)
    const [courierCheck, setCourierCheck] = useState<CourierConnectionCheck>({ status: "unchecked" })
    const accountRef = useRef<HTMLDetailsElement>(null)
    const accountSummaryRef = useRef<HTMLElement>(null)
    const mutationPending = useRef(false)

    const backendConfigured = Boolean(normalizeBaseUrl(apiBaseUrl))
    const liveEnabled = backendConfigured && !isStatic

    useEffect(() => {
        if (!liveEnabled || view === "login") return
        const adminToken = token()
        if (!adminToken) {
            rememberAdminReturnPath()
            route("/admin/login")
            return
        }
        let active = true
        startTransition(() => { setLoading(true); setLoadState("loading") })
        adminFetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/data`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        })
            .then(async (response) => {
                if (response.status === 401) {
                    route("/admin/login")
                    throw new Error("Please sign in again.")
                }
                const data = await response.json().catch(() => null)
                if (!response.ok) throw new Error(apiErrorMessage(data, "The admin data could not be loaded."))
                return data
            })
            .then((data: Snapshot) => {
                if (!active) return
                startTransition(() => {
                    setSnapshot(data)
                    const requested = new URLSearchParams(window.location.search).get("order")
                    setSelectedOrderId((current) => current || requested || data.orders[0]?.id || "")
                    if (requested) setOrderFilter("All orders")
                    setLoadState("ready")
                })
            })
            .catch((error: Error) => {
                if (!active) return
                startTransition(() => { setNotice(error.message); setLoadState("error") })
            })
            .finally(() => {
                if (active) startTransition(() => setLoading(false))
            })
        return () => {
            active = false
        }
    }, [apiBaseUrl, liveEnabled, view, refresh])

    const filteredOrders = useMemo(() => {
        const query = search.trim().toLowerCase()
        return snapshot.orders.filter((order) => {
            const matchesStatus = orderFilter === "All orders" ||
                (orderFilter === "Needs attention" && Boolean(order.actionNeeded?.length)) ||
                (orderFilter === "Needs attention" && order.paymentStatus === "Paid" &&
                    (order.status === "New" || order.status === "Confirmed" ||
                     (order.status === "Ready" && order.shipping?.status !== "Booking" && order.shipping?.status !== "Booked") ||
                     (!['Collected', 'Delivered', 'Cancelled'].includes(order.status) && order.shipping?.status === "Failed"))) ||
                (orderFilter === "In progress" && order.paymentStatus === "Paid" &&
                    (order.status === "Preparing" || order.status === "Dispatched" ||
                     (order.status === "Ready" && ['Booking', 'Booked'].includes(order.shipping?.status || ""))))
            return matchesStatus && (method === "All methods" || method === order.deliveryMethod) &&
                (!query || [order.id, order.customer, order.email].some((value) => value.toLowerCase().includes(query)))
        })
    }, [orderFilter, snapshot.orders, search, method])

    const selectedOrder =
        filteredOrders.find((order) => order.id === selectedOrderId) || filteredOrders[0]

    async function updateOrderStatus(order: AdminOrder, status: OrderStatus) {
        if (mutationPending.current) return
        if (!liveEnabled) {
            startTransition(() => setNotice("Open the Framer preview to manage live orders."))
            return
        }
        mutationPending.current = true
        startTransition(() => { setLoading(true); setNotice("") })
        try {
            const response = await adminFetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/orders/${order.id}`, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token()}`,
                },
                body: JSON.stringify({ status }),
            })
            const data = await response.json()
            if (!response.ok) {
                if (response.status === 409) setRefresh((current) => current + 1)
                throw new Error(apiErrorMessage(data, "The order status could not be updated."))
            }
            startTransition(() => {
                setSnapshot((current) => ({
                    ...current,
                    orders: current.orders.map((item) => (item.id === order.id ? data.order : item)),
                }))
                setNotice(data.warning || `${order.id} saved as ${status.toLowerCase()}. ${data.email?.skipped ? "No customer email was sent." : "Customer notification submitted."}`)
            })
        } catch (error) {
            startTransition(() => setNotice(error instanceof Error ? error.message : "Update failed."))
        } finally {
            mutationPending.current = false
            startTransition(() => setLoading(false))
        }
    }

    async function requestShipping(order: AdminOrder, action: "quote" | "book" | "refresh" | "waybill", payload: Record<string, unknown> = {}): Promise<ShippingResult> {
        if (mutationPending.current || !liveEnabled) throw new Error("Wait for the current action to finish, then try again.")
        mutationPending.current = true
        startTransition(() => { setLoading(true); setNotice("") })
        try {
            const endpoint = action === "book" ? "book-shipment" : "shipment"
            const response = await adminFetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/orders/${encodeURIComponent(order.id)}/${endpoint}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
                body: JSON.stringify(action === "book" ? { ...payload, confirm: true } : { ...payload, action }),
            })
            const data = await response.json().catch(() => null)
            if (!response.ok) {
                if (response.status === 401) route("/admin/login")
                throw new Error(apiErrorMessage(data, "Bob Go could not complete this request."))
            }
            startTransition(() => {
                if (data.order) setSnapshot((current) => ({ ...current, orders: current.orders.map(item => item.id === order.id ? data.order : item) }))
                if (data.message) setNotice(data.message)
            })
            return data as ShippingResult
        } catch (error) {
            if (action === "book") setRefresh(current => current + 1)
            const failure = error instanceof Error ? error : new Error("Bob Go request failed.")
            startTransition(() => setNotice(failure.message))
            throw failure
        } finally {
            mutationPending.current = false
            startTransition(() => setLoading(false))
        }
    }

    async function checkCourierConnection() {
        if (mutationPending.current || !liveEnabled) return
        mutationPending.current = true
        startTransition(() => { setLoading(true); setCourierCheck({ status: "checking" }) })
        try {
            const response = await adminFetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/bobgo/locations`, { headers: { Authorization: `Bearer ${token()}` } })
            const data = await response.json().catch(() => null)
            if (!response.ok || !data?.connected) throw new Error(data?.error || "The drop-off point is not configured.")
            startTransition(() => setCourierCheck({ status: "connected", location: data.target,
                message: data.bookingEnabled && data.senderContactConfigured ? "Manual booking is enabled." : "The connection works, but booking setup is incomplete.",
                checkedAt: new Date().toLocaleString("en-ZA") }))
        } catch (error) {
            startTransition(() => setCourierCheck({ status: "error", message: error instanceof Error ? error.message : "Connection check failed." }))
        } finally {
            mutationPending.current = false
            startTransition(() => setLoading(false))
        }
    }

    function openDeliverySettings() {
        if (accountRef.current) accountRef.current.open = false
        setDeliverySettingsOpen(true)
        if (courierCheck.status === "unchecked") void checkCourierConnection()
    }

    function closeDeliverySettings() {
        setDeliverySettingsOpen(false)
        accountSummaryRef.current?.focus()
    }

    async function retryNotification(order: AdminOrder, notificationId: string) {
        if (mutationPending.current || !liveEnabled) return
        mutationPending.current = true
        startTransition(() => setLoading(true))
        try {
            const response = await adminFetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/orders/${order.id}/notifications`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
                body: JSON.stringify({ notificationId }),
            })
            const data = await response.json().catch(() => null)
            if (data?.order) startTransition(() => setSnapshot(current => ({ ...current, orders: current.orders.map(item => item.id === order.id ? data.order : item) })))
            if (!response.ok) throw new Error(apiErrorMessage(data, "The notification could not be submitted."))
            startTransition(() => setNotice(`Notification submitted for ${order.id}. Submitted does not yet confirm delivery to the inbox.`))
        } catch (error) {
            startTransition(() => setNotice(error instanceof Error ? error.message : "Email resend failed."))
        } finally {
            mutationPending.current = false
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
                    <div className="mm-admin__utilities">
                        <AdminNav current={view} />
                        <div className="mm-admin__utility-actions">
                            <button type="button" className="mm-admin__text-button" disabled={loading} onClick={() => setRefresh((current) => current + 1)}>{loading ? "Updating…" : "Refresh orders"}</button>
                            <details className="mm-admin__account" ref={accountRef}>
                                <summary ref={accountSummaryRef}>Account</summary>
                                <div className="mm-admin__account-menu">
                                    <button type="button" className="mm-admin__text-button" aria-haspopup="dialog" onClick={openDeliverySettings}>Delivery settings</button>
                                    <a href="/" target="_blank" rel="noopener noreferrer">View website</a>
                                    <button type="button" className="mm-admin__text-button" onClick={logout}>Log out</button>
                                </div>
                            </details>
                        </div>
                    </div>
                    {notice ? <div className="mm-admin__notice" role="status">{notice}</div> : null}
                    {snapshot.operationalNotice ? <div className="mm-admin__notice" role="status">{snapshot.operationalNotice}</div> : null}
                    {liveEnabled && loadState !== "ready" ? (
                        <div className="mm-admin__empty" role="status"><strong>{loadState === "error" ? "Orders could not be loaded" : "Loading your orders…"}</strong><span>{loadState === "error" ? "Use Refresh orders to try again. No order data has been changed." : "Connecting securely to your store."}</span></div>
                    ) : view === "dashboard" ? (
                        <DashboardView snapshot={snapshot} logout={logout} />
                    ) : view === "orders" ? (
                        <OrdersView
                            orders={filteredOrders}
                            selected={selectedOrder}
                            selectedOrderId={selectedOrder?.id || ""}
                            setSelectedOrderId={setSelectedOrderId}
                            filter={orderFilter}
                            setFilter={setOrderFilter}
                            search={search}
                            setSearch={setSearch}
                            method={method}
                            setMethod={setMethod}
                            updateOrderStatus={updateOrderStatus}
                            requestShipping={requestShipping}
                            bobGoConnection={snapshot.bobGoConnection}
                            retryNotification={retryNotification}
                            loading={loading}
                        />
                    ) : (
                        <ProductsView />
                    )}
                    <DeliverySettings open={deliverySettingsOpen} close={closeDeliverySettings} connection={snapshot.bobGoConnection}
                        check={courierCheck} checking={courierCheck.status === "checking"} disabled={loading || !liveEnabled || loadState !== "ready"}
                        checkConnection={checkCourierConnection} paymentEnvironment={snapshot.paymentEnvironment} />
                </div>
            )}
        </section>
    )
}

function DeliverySettings({ open, close, connection, check, checking, disabled, checkConnection, paymentEnvironment }: {
    open: boolean
    close: () => void
    connection?: Snapshot["bobGoConnection"]
    check: CourierConnectionCheck
    checking: boolean
    disabled: boolean
    checkConnection: () => void
    paymentEnvironment?: Snapshot["paymentEnvironment"]
}) {
    const dialogRef = useRef<HTMLDialogElement>(null)
    useEffect(() => {
        const dialog = dialogRef.current
        if (open && dialog && !dialog.open) dialog.showModal()
        if (!open && dialog?.open) dialog.close()
        return () => { if (dialog?.open) dialog.close() }
    }, [open])
    const ready = connection?.enabled && connection.configured
    return <dialog className="mm-admin__dialog mm-admin__delivery-settings" ref={dialogRef}
        aria-labelledby="mm-delivery-settings-title" aria-describedby="mm-delivery-settings-description"
        onCancel={close} onClose={close} onClick={event => {
            if (event.target !== event.currentTarget) return
            const bounds = event.currentTarget.getBoundingClientRect()
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close()
        }}>
        <div className="mm-admin__settings-heading">
            <h2 id="mm-delivery-settings-title">Delivery settings</h2>
            <button type="button" className="mm-admin__text-button" autoFocus onClick={close}>Close</button>
        </div>
        <p id="mm-delivery-settings-description" className="mm-admin__helper">Your courier connection. Delivery bookings are managed inside each paid delivery order.</p>
        <section className="mm-admin__connection-status" aria-label="Courier connection status" aria-live="polite" aria-busy={checking}>
            <div className="mm-admin__settings-heading"><strong>Bob Go</strong>{connection ? <span className="mm-admin__helper">{connection.environment === "production" ? "Live account" : "Test account"}</span> : null}</div>
            <strong>{checking ? "Checking connection…" : check.status === "connected" ? "Connected" : check.status === "error" ? "Connection needs attention" : ready ? "Configured · not checked yet" : connection ? "Setup needs attention" : "Connection details unavailable"}</strong>
            {check.location ? <p>Drop-off point: {check.location}</p> : null}
            {check.message ? <p className={check.status === "error" ? "mm-admin__error" : undefined} role={check.status === "error" ? "alert" : undefined}>{check.message}</p> : null}
            {connection && !ready ? <p>Courier booking is paused or setup is incomplete. Contact your website administrator.</p> : null}
            {check.checkedAt ? <p className="mm-admin__helper">Last checked: {check.checkedAt}</p> : null}
        </section>
        <p className="mm-admin__helper">For delivery: prepare the parcel, mark the paid order Ready, then review its quote and confirm the booking. Collection orders do not use Bob Go.</p>
        {paymentEnvironment === "sandbox" && connection?.environment === "production" ? <p className="mm-admin__error">Payments are in test mode. Live courier booking is blocked for test-paid orders.</p> : null}
        <details className="mm-admin__technical"><summary>Troubleshooting</summary>
            <p className="mm-admin__helper">This only checks the connection and drop-off point. It does not book a shipment or create a courier charge.</p>
            <button type="button" className="mm-admin__secondary-button" disabled={disabled} onClick={checkConnection}>{checking ? "Checking connection…" : "Check courier connection (no booking)"}</button>
            <p className="mm-admin__helper">If the check fails, contact your website administrator. No API keys need to be entered here.</p>
        </details>
    </dialog>
}

function LoginView({ apiBaseUrl, liveEnabled, backendConfigured }: { apiBaseUrl: string; liveEnabled: boolean; backendConfigured: boolean }) {
    const [email, setEmail] = useState("")
    const [password, setPassword] = useState("")
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState("")
    useEffect(() => {
        if (liveEnabled) window.sessionStorage.removeItem("moving_modesty_admin_token")
    }, [liveEnabled])

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
            const response = await adminFetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
            })
            const data = await response.json()
            if (!response.ok || !data.token) throw new Error(data.error || "Sign-in failed.")
            if (typeof window !== "undefined") {
                window.sessionStorage.setItem("moving_modesty_admin_token", data.token)
                const returnPath = window.sessionStorage.getItem("moving_modesty_admin_return") || "/admin"
                window.sessionStorage.removeItem("moving_modesty_admin_return")
                route(returnPath)
                return
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
                <a className="mm-admin__brand" href="/" aria-label="Back to Moving Modesty website">MM</a>
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
                <a className="mm-admin__website-link" href="/">← Back to the website</a>
            </form>
        </div>
    )
}

function PageHeader({ eyebrow, title, action, onAction }: { eyebrow: string; title: string; action?: string; onAction?: () => void }) {
    return (
        <header className="mm-admin__header">
            <div>
                <p className="mm-admin__eyebrow">{eyebrow}</p>
                <h1 className={`mm-admin__title ${title === "Dashboard" ? "mm-admin__title--dashboard" : ""}`}>{title}</h1>
            </div>
            {action && onAction ? <button className="mm-admin__button" type="button" onClick={onAction}>{action}</button> : null}
        </header>
    )
}

function AdminNav({ current }: { current: "dashboard" | "orders" | "products" }) {
    const [open, setOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement>(null)
    function close() {
        setOpen(false)
        triggerRef.current?.focus()
    }
    return (
        <div className="mm-admin__responsive-nav" data-state={open ? "open" : "closed"} onKeyDown={event => {
            if (event.key === "Escape" && open) { event.preventDefault(); close() }
        }}>
            <button type="button" className="mm-admin__menu-toggle" ref={triggerRef}
                aria-expanded={open} aria-controls="mm-admin-navigation" onClick={() => setOpen(current => !current)}>
                <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
                    {open ? <path d="M4 4l12 12M16 4L4 16" /> : <path d="M3 5h14M3 10h14M3 15h14" />}
                </svg>
                {open ? "Close" : "Menu"}
            </button>
            <nav id="mm-admin-navigation" className="mm-admin__nav" aria-label="Admin navigation" hidden={!open}>
                <a onClick={close} aria-current={current === "dashboard" ? "page" : undefined} className={current === "dashboard" ? "is-active" : ""} href="/admin">Dashboard</a>
                <a onClick={close} aria-current={current === "orders" ? "page" : undefined} className={current === "orders" ? "is-active" : ""} href="/admin/orders">Orders</a>
                <a onClick={close} aria-current={current === "products" ? "page" : undefined} className={current === "products" ? "is-active" : ""} href="/admin/products">Products (CMS)</a>
            </nav>
        </div>
    )
}

function DashboardView({ snapshot }: { snapshot: Snapshot; logout: () => void }) {
    const liveOrders = snapshot.orders.filter((order) => order.payment?.environment === "production")
    const paidRevenue = liveOrders
        .filter((order) => order.paymentStatus === "Paid")
        .reduce((sum, order) => sum + order.total, 0)
    const stats = [
        ["To prepare", liveOrders.filter((order) => ["New", "Confirmed"].includes(order.status) && order.paymentStatus === "Paid").length],
        ["Preparing", liveOrders.filter((order) => order.status === "Preparing" && order.paymentStatus === "Paid").length],
        ["Ready to hand over", liveOrders.filter((order) => order.status === "Ready" && order.paymentStatus === "Paid").length],
        ["Paid order value", money.format(paidRevenue)],
    ]
    return (
        <>
            <PageHeader eyebrow="ADMIN PORTAL" title="Dashboard" />
            <p className="mm-admin__helper">Your store at a glance. Open Orders to see what needs doing next.</p>
            {snapshot.paymentEnvironment === "sandbox" ? <div className="mm-admin__notice">PayFast is currently in test mode. Test payments are excluded from live totals.</div> : null}
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
                <a className="mm-admin__button mm-admin__button-link" href="/admin/orders">Open orders</a>
            </div>
            <div className="mm-admin__order-table">
                {snapshot.orders.length === 0 ? (
                    <div className="mm-admin__empty"><strong>No orders yet</strong><span>New customer orders will appear here.</span></div>
                ) : null}
                {snapshot.orders.slice(0, 5).map((order) => (
                    <button className="mm-admin__order-row" type="button" key={order.id} onClick={() => route(`/admin/orders?order=${encodeURIComponent(order.id)}`)}>
                        <strong>{order.id}</strong>
                        <span>{order.customer}</span>
                        <span>{order.placedAt}</span>
                        <span>{money.format(order.total)}</span>
                        <span className="mm-admin__badges"><em className={badgeClass(order.paymentStatus)}>{order.paymentStatus}</em><em className={badgeClass(order.status)}>{order.status}</em></span>
                    </button>
                ))}
            </div>
            <details className="mm-admin__technical"><summary>About these totals</summary><p className="mm-admin__helper">These figures include payments recorded in live PayFast only. Sandbox payments and payments without a recorded environment are excluded. This is order value, not an accounting or settlement report.</p></details>
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
    search,
    setSearch,
    method,
    setMethod,
    updateOrderStatus,
    requestShipping,
    bobGoConnection,
    retryNotification,
    loading,
}: {
    orders: AdminOrder[]
    selected?: AdminOrder
    selectedOrderId: string
    setSelectedOrderId: (id: string) => void
    filter: string
    setFilter: (filter: string) => void
    search: string
    setSearch: (value: string) => void
    method: string
    setMethod: (value: string) => void
    updateOrderStatus: (order: AdminOrder, status: OrderStatus) => void
    requestShipping: ShippingRequest
    bobGoConnection?: Snapshot["bobGoConnection"]
    retryNotification: (order: AdminOrder, notificationId: string) => void
    loading: boolean
}) {
    const detailRef = useRef<HTMLElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const dialogRef = useRef<HTMLDialogElement>(null)
    const courierRef = useRef<HTMLDivElement>(null)
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
    const [focusDetail, setFocusDetail] = useState(false)
    const failedEmail = Boolean(selected?.notifications?.some(event => event.status === "failed"))
    const [notificationsOpen, setNotificationsOpen] = useState(failedEmail)
    useEffect(() => { if (failedEmail) setNotificationsOpen(true) }, [failedEmail, selected?.id])
    useEffect(() => {
        if (window.matchMedia("(max-width: 1199px)").matches && new URLSearchParams(window.location.search).get("order")) setFocusDetail(true)
    }, [])

    useEffect(() => {
        if (!focusDetail) return
        detailRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" })
        detailRef.current?.focus({ preventScroll: true })
        startTransition(() => setFocusDetail(false))
    }, [selected?.id, focusDetail])

    useEffect(() => {
        if (confirmation) dialogRef.current?.showModal()
        else dialogRef.current?.close()
    }, [confirmation])

    function requestStatus(order: AdminOrder, status: OrderStatus, label: string) {
        if (["Confirmed", "Preparing", "Ready"].includes(status)) { updateOrderStatus(order, status); return }
        const description = status === "Cancelled"
            ? `Cancel ${order.id}? This cannot be undone here. ${order.paymentStatus === "Paid" ? "This does not refund the payment. Handle any refund separately in PayFast. " : ""}The customer will be notified if email is configured.`
            : status === "Collected" ? `Confirm that ${order.customer} has actually received the parcel. This completes the order.`
            : status === "Dispatched" ? "Confirm that you have handed the parcel to the courier or drop-off locker using the booked waybill."
            : status === "Delivered" ? "Confirm that courier tracking shows the parcel was delivered. This completes the order."
            : `Change ${order.id} to ${status.toLowerCase()}? A customer notification will be submitted if email is configured.`
        setConfirmation({ title: label, description, run: () => updateOrderStatus(order, status) })
    }

    return (
        <>
            <PageHeader eyebrow="ADMIN / ORDERS" title="Orders" />
            <p className="mm-admin__helper">Start with Needs attention. Select an order, then follow its next step.</p>
            <section className="mm-admin__order-controls" aria-label="Find and filter orders">
            <div className="mm-admin__filters" role="group" aria-label="Order filters">
                {["Needs attention", "In progress", "All orders"].map((label) => (
                    <button
                        className={`mm-admin__filter ${filter === label ? "is-active" : ""}`}
                        type="button"
                        key={label}
                        aria-pressed={filter === label}
                        onClick={() => setFilter(label)}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <div className="mm-admin__search-row">
                <label className="mm-admin__field">Find an order<input type="search" placeholder="Order number, name or email" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
                <details className="mm-admin__extra-filter" open={method !== "All methods" ? true : undefined}>
                    <summary>{method === "All methods" ? "Filter by delivery or collection" : `Showing: ${method}`}</summary>
                    <label className="mm-admin__field">Receive by<select value={method} onChange={(event) => setMethod(event.target.value)}><option>All methods</option><option>Collection</option><option>Courier</option><option>To be confirmed</option></select></label>
                </details>
            </div>
            <p className="mm-admin__helper" role="status">{orders.length} {orders.length === 1 ? "order" : "orders"} shown</p>
            </section>
            <div className="mm-admin__orders-layout">
                <div className="mm-admin__order-list" ref={listRef} tabIndex={-1}>
                    {!orders.length ? <div className="mm-admin__empty"><strong>No matching orders</strong><span>Try All orders or clear your search and delivery filter.</span></div> : null}
                    {orders.map((order) => (
                        <button
                            className={`mm-admin__order-card ${selectedOrderId === order.id ? "is-selected" : ""}`}
                            type="button"
                            key={order.id}
                            aria-pressed={selectedOrderId === order.id}
                            onClick={() => { setSelectedOrderId(order.id); if (window.matchMedia("(max-width: 1199px)").matches) setFocusDetail(true) }}
                        >
                            <span className="mm-admin__order-card-top">
                                <strong>{order.customer}</strong>
                                <strong className="mm-admin__order-amount">{money.format(order.total)}</strong>
                            </span>
                            <span className="mm-admin__badges"><em className={badgeClass(order.paymentStatus)}>{order.paymentStatus}</em><em className={badgeClass(order.status)}>{order.status}</em><span>{order.deliveryMethod}</span></span>
                            <span className="mm-admin__order-meta">{order.id} · {order.placedAt}</span>
                            {order.actionNeeded?.length ? <span className="mm-admin__order-meta">Action needed</span> : null}
                        </button>
                    ))}
                </div>
                {selected ? (
                    <article className="mm-admin__detail" ref={detailRef} tabIndex={-1} aria-label={`Details for ${selected.id}`}>
                        <button type="button" className="mm-admin__text-button mm-admin__back" onClick={() => { listRef.current?.scrollIntoView({ behavior: "auto", block: "start" }); listRef.current?.focus({ preventScroll: true }) }}>← Back to orders</button>
                        <div className="mm-admin__detail-heading">
                            <p className="mm-admin__eyebrow">ORDER DETAILS</p>
                            <h2>{selected.customer}</h2>
                            <p className="mm-admin__order-meta">{selected.id} · {selected.placedAt}</p>
                        </div>
                        {selected.payment?.environment === "sandbox" ? <p className="mm-admin__notice">Sandbox payment—no real payment was collected. Do not fulfil this as a customer purchase.</p> : null}
                        {selected.actionNeeded?.length ? <section className="mm-admin__notice" aria-label="Action needed"><strong>Action needed</strong>{selected.actionNeeded.map((issue, index) => <p key={issue.reference || index}>{issue.message}{issue.reference ? <small className="mm-admin__error-ref">Reference: {issue.reference}</small> : null}</p>)}</section> : null}
                        <div className="mm-admin__badges"><em className={badgeClass(selected.paymentStatus)}>{selected.paymentStatus}</em><em className={badgeClass(selected.status)}>{selected.status}</em><span>{selected.deliveryMethod}</span></div>
                        <section className="mm-admin__next-step" aria-label="Next step">
                            <p className="mm-admin__eyebrow">{["Collected", "Delivered", "Cancelled"].includes(selected.status) ? "ORDER CLOSED" : "YOUR NEXT STEP"}</p>
                            <p>{selected.workflow?.guidance || "Refresh orders to load the current workflow before making changes."}</p>
                            {selected.workflow?.nextStatus ? <button className="mm-admin__button" type="button" disabled={loading} onClick={() => requestStatus(selected, selected.workflow!.nextStatus!, selected.workflow!.actionLabel)}>{loading ? "Saving…" : selected.workflow.actionLabel}</button> : null}
                            {selected.paymentStatus === "Paid" && selected.status === "Ready" && selected.deliveryMethod === "Courier" && selected.shipping && !["Booking", "Booked", "Cancelled"].includes(selected.shipping.status) ? <button className="mm-admin__button" type="button" disabled={loading} onClick={() => {
                                courierRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" })
                                courierRef.current?.focus({ preventScroll: true })
                            }}>Book waybill</button> : null}
                        </section>
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
                            {selected.deliveryFee !== undefined ? <p>{selected.deliveryMethod === "Collection" ? "Collection: no delivery fee" : `Customer delivery fee: ${selected.deliveryFee === 0 ? "Free" : money.format(selected.deliveryFee)}`}</p> : null}
                            <details className="mm-admin__technical"><summary>Payment details</summary>
                            <p>PayFast environment: {selected.payment?.environment === "production" ? "Live" : selected.payment?.environment === "sandbox" ? "Sandbox" : "Not recorded—check in PayFast if needed"}</p>
                            {selected.payment?.providerStatus ? <p>PayFast check: {selected.payment.providerStatus.replaceAll("_", " ")}</p> : null}
                            {selected.payment?.providerPaymentId ? <p>PayFast reference: {selected.payment.providerPaymentId}</p> : null}
                            {selected.payment?.failureReason ? <p className="mm-admin__payment-error">Reason: {selected.payment.failureReason}</p> : null}
                            </details>
                        </Detail>
                        <Detail title="Fulfilment">
                            <p>{selected.deliveryMethod}</p><p>{selected.deliveryMethod === "Collection" ? selected.status === "Collected" ? "The parcel has been handed to the customer." : "Message the customer privately with the collection address and a suitable time." : selected.address || "Delivery address missing. Contact the customer before booking."}</p>
                        </Detail>
                        {selected.deliveryMethod === "Courier" && selected.shipping &&
                            ((selected.paymentStatus === "Paid" && selected.status === "Ready") || ["Booking", "Booked", "Failed"].includes(selected.shipping.status)) ? (
                            <div ref={courierRef} tabIndex={-1} aria-label="Book this order's waybill"><ShippingPanel key={selected.id} order={selected} loading={loading} connection={bobGoConnection} requestShipping={requestShipping} confirm={setConfirmation} /></div>
                        ) : null}
                        <details key={`notifications-${selected.id}`} className="mm-admin__technical" open={notificationsOpen} onToggle={event => setNotificationsOpen(event.currentTarget.open)}>
                            <summary>Email notifications{selected.notifications?.some(event => event.status === "failed") ? " · Action needed" : ""}</summary>
                            <p className="mm-admin__helper">Submitted means the email provider accepted it, not that it reached the inbox. Preparation steps do not send customer emails.</p>
                            {!selected.notifications?.length ? <p>No recorded notifications yet. Older emails may not be listed.</p> : <ul className="mm-admin__notifications">{selected.notifications.map(event => <li key={event.id}>
                                <div><strong>{event.title}</strong><p>{event.recipient}</p><p role={event.status === "failed" ? "status" : undefined}>{event.deliveryEvent === "email.delivery_delayed" ? "Delivery delayed" : event.deliveryEvent === "email.bounced" ? "Bounced" : event.status === "sent" ? "Submitted" : event.status === "delivered" ? "Delivered to mail server" : event.status === "queued" ? "Awaiting submission" : "Failed"}{event.status === "failed" && !event.retryable && !event.deliveryMessage ? " — no longer appropriate for this order's current stage" : ""}</p>{event.deliveryMessage ? <p>{event.deliveryMessage}</p> : null}</div>
                                {event.status === "failed" && event.retryable ? <button type="button" className="mm-admin__secondary-button" disabled={loading} onClick={() => retryNotification(selected, event.id)}>Retry email<span className="mm-admin__sr-only">: {event.title} to {event.recipient}</span></button> : null}
                            </li>)}</ul>}
                        </details>
                        {selected.workflow?.canCancel ? <details key={selected.id} className="mm-admin__technical"><summary>More order options</summary><div className="mm-admin__actions">
                            {selected.workflow?.canCancel ? <button className="mm-admin__secondary-button" type="button" disabled={loading} onClick={() => requestStatus(selected, "Cancelled", "Cancel order")}>Cancel order</button> : null}
                        </div></details> : null}
                    </article>
                ) : null}
            </div>
            <dialog className="mm-admin__dialog" ref={dialogRef} aria-labelledby="mm-order-confirm-title" aria-describedby="mm-order-confirm-description" onCancel={() => setConfirmation(null)} onClose={() => setConfirmation(null)}>
                <h2 id="mm-order-confirm-title">{confirmation?.title}</h2>
                <p id="mm-order-confirm-description">{confirmation?.description}</p>
                <div className="mm-admin__actions">
                    <button className="mm-admin__secondary-button" type="button" autoFocus onClick={() => setConfirmation(null)}>Go back</button>
                    <button className="mm-admin__button" type="button" disabled={loading} onClick={() => { const action = confirmation; dialogRef.current?.close(); setConfirmation(null); action?.run() }}>Confirm</button>
                </div>
            </dialog>
        </>
    )
}

function ShippingPanel({ order, loading, connection, requestShipping, confirm }: {
    order: AdminOrder; loading: boolean; connection?: Snapshot["bobGoConnection"]; requestShipping: ShippingRequest; confirm: (value: Confirmation) => void
}) {
    const shipping = order.shipping!
    const [parcel, setParcel] = useState({ weightGrams: String(shipping.weightGrams || ""), lengthCm: String(shipping.lengthCm || ""), widthCm: String(shipping.widthCm || ""), heightCm: String(shipping.heightCm || "") })
    const [measured, setMeasured] = useState(false)
    const [cover, setCover] = useState(true)
    const [quote, setQuote] = useState<ShippingResult | null>(null)
    const [quoteIndex, setQuoteIndex] = useState(0)
    const [waybill, setWaybill] = useState("")
    const [error, setError] = useState("")
    const pending = shipping.status === "Booking"
    const booked = shipping.status === "Booked"
    const liveBookingForTest = connection?.environment === "production" && order.payment?.environment === "sandbox"
    const canQuote = !liveBookingForTest && order.paymentStatus === "Paid" && order.status === "Ready" && !pending && !booked && shipping.status !== "Cancelled" && Boolean(connection?.enabled && connection.configured)
    const rate = quote?.rates?.[quoteIndex]
    const fields = [["weightGrams", "Packed weight (g)"], ["lengthCm", "Length (cm)"], ["widthCm", "Width (cm)"], ["heightCm", "Height (cm)"]] as const

    async function run(action: "quote" | "book" | "refresh" | "waybill", payload: Record<string, unknown> = {}) {
        startTransition(() => setError(""))
        try {
            const result = await requestShipping(order, action, payload)
            startTransition(() => {
                if (action === "quote") { setQuote(result); setQuoteIndex(0) }
                if (action === "book") setQuote(null)
                if (action === "waybill" && result.url) setWaybill(result.url)
            })
        } catch (caught) {
            startTransition(() => { setError(caught instanceof Error ? caught.message : "Courier request failed."); if (action === "book") setQuote(null) })
        }
    }
    function book() {
        if (!rate || !quote?.expires || quote.expires <= Date.now()) { setError("This quote expired. Get a new quote."); setQuote(null); return }
        confirm({ title: quote.environment === "production" ? "Confirm LIVE courier booking" : "Confirm sandbox booking",
            description: `${order.id}: ${rate.providerName} · ${rate.serviceName} (${rate.serviceCode}), quoted ${courierMoney.format(rate.amount)}. Parcel ${parcel.lengthCm} × ${parcel.widthCm} × ${parcel.heightCm} cm, ${parcel.weightGrams} g. Drop-off at ${shipping.senderLocationName}, delivery to ${order.address}. ${quote.declaredValue ? `Declared-value cover requested for ${courierMoney.format(quote.declaredValue)}; courier terms apply.` : "No additional declared-value cover requested; only the courier's standard terms apply."} ${quote.environment === "production" ? "This creates a real waybill and may charge Zarina's Bob Go account. Final courier charges can differ from the quote." : "Sandbox test only."} The customer's delivery fee is unchanged.`,
            run: () => { void run("book", { quoteToken: rate.quoteToken }) } })
    }
    return <Detail title="Bob Go delivery">
        {liveBookingForTest ? <p role="alert">This is a test payment. Live courier booking is blocked so it cannot create a real charge.</p> : null}
        <p><strong>{shipping.environment === "production" ? "LIVE" : "SANDBOX"}</strong> · Status: {shipping.status}</p>
        <p>Drop-off: {shipping.senderLocationName} · Deliver to the customer's door.</p>
        <p>Customer delivery fee: <strong>{order.deliveryFee === undefined ? "Not recorded" : order.deliveryFee === 0 ? "Free" : money.format(order.deliveryFee)}</strong>. This is separate from Zarina's courier cost.</p>
        {shipping.trackingNumber ? <p>Waybill / tracking: <strong>{shipping.trackingNumber}</strong></p> : null}
        {shipping.lastError ? <p role="status">{shipping.lastError}</p> : null}
        {pending ? <p>Booking is awaiting confirmation. Check its status; do not book another shipment or create a duplicate in Bob Go.</p> : null}
        {booked ? <p>{order.status === "Dispatched" || order.status === "Delivered" ? "This order has been handed over. Use the tracking number to check its progress; email results are shown below." : "Download the waybill, attach it to the parcel and drop it off. Only then mark the order Dispatched to submit the customer's tracking email."}</p> : null}
        {(pending || booked) ? <div className="mm-admin__actions mm-admin__courier-actions">
            <button type="button" className="mm-admin__secondary-button" disabled={loading} onClick={() => { void run("refresh") }}>Check shipment status</button>
            {booked && !waybill ? <button type="button" className="mm-admin__button" disabled={loading} onClick={() => { void run("waybill") }}>Prepare printable waybill</button> : null}
            {waybill ? <a className="mm-admin__button" href={waybill} target="_blank" rel="noopener noreferrer">Print waybill</a> : null}
            {shipping.trackingUrl ? <a href={shipping.trackingUrl} target="_blank" rel="noopener noreferrer">Open tracker (enter waybill number)</a> : null}
        </div> : null}
        {canQuote ? <>
            <p className="mm-admin__helper">Check the packed box, including packaging. The 412 g / 25 × 20.5 × 3.5 cm measurement applies only to one Hawa + one Amina; measure other combinations.</p>
            <div className="mm-admin__parcel-grid">{fields.map(([field, label]) => <label className="mm-admin__field" key={field}>{label}<input type="number" min={field === "weightGrams" ? 1 : 0.01} max={field === "weightGrams" ? 30000 : 150} step={field === "weightGrams" ? 1 : 0.01} inputMode="decimal" value={parcel[field]} disabled={loading} onChange={event => { setParcel(current => ({ ...current, [field]: event.target.value })); setMeasured(false); setQuote(null) }} /></label>)}</div>
            <label className="mm-admin__courier-check"><input type="checkbox" checked={measured} disabled={loading} onChange={event => { setMeasured(event.target.checked); setQuote(null) }} />I have checked these packed measurements and the customer's address.</label>
            <label className="mm-admin__courier-check"><input type="checkbox" checked={cover} disabled={loading} onChange={event => { setCover(event.target.checked); setQuote(null) }} />Request additional declared-value cover for {courierMoney.format(order.subtotal || 0)}.</label>
            <p className="mm-admin__helper">Availability and cover depend on the courier's terms. If no quote supports it, review those terms before choosing standard cover only.</p>
            {!rate ? <button type="button" className="mm-admin__button" disabled={loading || !measured || Object.values(parcel).some(value => !Number(value))} onClick={() => { setQuote(null); void run("quote", { parcel: Object.fromEntries(Object.entries(parcel).map(([key, value]) => [key, Number(value)])), additionalCover: cover }) }}>{loading ? "Checking Bob Go…" : "Get delivery quote"}</button> : null}
            {rate ? <div className="mm-admin__quote">
                <label className="mm-admin__field">Choose courier service<select value={quoteIndex} disabled={loading} onChange={event => setQuoteIndex(Number(event.target.value))}>{quote?.rates?.map((option, index) => <option value={index} key={`${option.serviceCode}-${index}`}>{option.providerName} · {option.serviceName} · {courierMoney.format(option.amount)}</option>)}</select></label>
                <p><strong>Zarina's courier quote: {courierMoney.format(rate.amount)}</strong></p>
                <p className="mm-admin__helper">This is Zarina's courier cost, not the customer's fixed R99 delivery fee. Quotes expire after 10 minutes; final courier charges can vary.</p>
                <button type="button" className="mm-admin__button" disabled={loading} onClick={book}>Book waybill</button>
            </div> : null}
        </> : null}
        {!canQuote && !booked && !pending ? <p>Booking requires a paid delivery order marked Ready and a configured courier connection.</p> : null}
        {!booked && !pending && shipping.blockers.length ? <details className="mm-admin__technical"><summary>What is still needed?</summary><ul className="mm-admin__blockers">{shipping.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul></details> : null}
        {error ? <p className="mm-admin__error" role="alert">{error}</p> : null}
    </Detail>
}

function Detail({ title, children }: { title: string; children: ReactNode }) {
    return <section className="mm-admin__detail-block"><h3>{title}</h3>{children}</section>
}

function ProductsView() {
    return (
        <>
            <PageHeader eyebrow="ADMIN / PRODUCTS" title="Products" />
            <div className="mm-admin__cms-note">
                <p className="mm-admin__eyebrow">FRAMER CMS</p>
                <h2>Products are managed in the CMS</h2>
                <p>
                    This portal is for orders. To add a product or change its photos, description or price, open Framer CMS using the button below.
                </p>
                <a className="mm-admin__cms-link" href="https://framer.com/projects/HSoQpURWMbVB013b2Lkg" target="_blank" rel="noreferrer">Open Framer CMS ↗</a>
                <ol className="mm-admin__cms-steps"><li>Open CMS and choose the relevant product collection.</li><li>Add or edit the product, including its images, price and available sizes.</li><li>Check the preview on desktop and mobile, then publish in Framer.</li></ol>
                <p className="mm-admin__helper">Changes in Framer CMS are separate from order management here.</p>
            </div>
        </>
    )
}

const styles = `
.mm-admin, .mm-admin * { box-sizing: border-box; }
.mm-admin { min-width: 0; overflow-wrap: anywhere; }
.mm-admin :is(button, a, input, select, summary):focus-visible { outline: 2px solid var(--mm-ink); outline-offset: 3px; }
.mm-admin__utilities { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; font-size: 13px; }
.mm-admin__utility-actions { grid-column: 2; grid-row: 1; display: flex; align-items: center; gap: 24px; }
.mm-admin__responsive-nav { display: none; }
.mm-admin__menu-toggle { grid-column: 1; grid-row: 1; justify-self: start; display: inline-flex; align-items: center; gap: 8px; min-height: 44px; border: 1px solid var(--mm-border); background: transparent; padding: 8px 12px; cursor: pointer; font-weight: 600 !important; }
.mm-admin__menu-toggle:hover, .mm-admin__menu-toggle[aria-expanded="true"] { background: var(--mm-soft); }
.mm-admin__menu-toggle:focus-visible, .mm-admin__nav a:focus-visible { outline: 2px solid var(--mm-sage); outline-offset: 3px; }
.mm-admin__utilities a { color: var(--mm-ink); min-height: 44px; display: inline-flex; align-items: center; }
.mm-admin__account { position: relative; }
.mm-admin__account > summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; font-weight: 600; list-style: none; }
.mm-admin__account > summary::-webkit-details-marker { display: none; }
.mm-admin__account > summary::after { content: ''; width: 6px; height: 6px; border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: rotate(45deg); margin: -3px 0 0 8px; }
.mm-admin__account-menu { position: absolute; right: 0; top: 100%; z-index: 2; min-width: 168px; padding: 8px 16px; background: var(--mm-surface); border: 1px solid var(--mm-border); display: grid; gap: 4px; }
.mm-admin__account-menu a, .mm-admin__account-menu button { text-align: left; }
.mm-admin__badges { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; }
.mm-admin__filter { min-height: 44px; padding: 10px 16px; border: 0; border-bottom: 3px solid transparent; background: transparent; color: var(--mm-muted); cursor: pointer; font-weight: 600; }
.mm-admin__filter:hover { background: var(--mm-soft); color: var(--mm-ink); }
.mm-admin__filter.is-active { background: var(--mm-soft); color: var(--mm-ink); border-bottom-color: var(--mm-sage); }
.mm-admin__order-controls { display: grid; gap: 16px; }
.mm-admin__search-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.mm-admin__extra-filter summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; color: var(--mm-muted); font-size: 13px; }
.mm-admin__extra-filter summary::after { content: ''; width: 6px; height: 6px; border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: rotate(45deg); margin: -3px 0 0 10px; }
.mm-admin__extra-filter summary::-webkit-details-marker { display: none; }
.mm-admin__extra-filter .mm-admin__field { max-width: 320px; padding-bottom: 8px; }
.mm-admin__next-step { display: grid; gap: 12px; border-left: 3px solid var(--mm-sage); background: var(--mm-soft); padding: 18px; }
.mm-admin__next-step p { margin: 0; }
.mm-admin__next-step button { justify-self: start; }
.mm-admin__notifications { list-style: none; padding: 0; margin: 0; }
.mm-admin__notifications li { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; justify-content: space-between; padding: 16px 0; border-top: 1px solid var(--mm-border); }
.mm-admin__notifications li > div { min-width: 0; flex: 1 1 180px; }
.mm-admin__notifications p { margin: 4px 0 0; overflow-wrap: anywhere; }
.mm-admin__sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.mm-admin__technical summary { min-height: 44px; cursor: pointer; padding: 12px 0; font-weight: 600; }
.mm-admin__parcel-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
.mm-admin__parcel-grid .mm-admin__field, .mm-admin__quote .mm-admin__field { min-width: 0; }
.mm-admin__parcel-grid input, .mm-admin__quote select { width: 100% !important; min-width: 0; }
.mm-admin__courier-check { display: flex; align-items: flex-start; gap: 10px; margin: 16px 0; cursor: pointer; }
.mm-admin__courier-check input { flex: 0 0 20px; width: 20px; height: 20px; margin: 1px 0 0; accent-color: var(--mm-sage); }
.mm-admin__quote { display: grid; gap: 12px; margin-top: 18px; padding: 16px; border: 1px solid var(--mm-sage); }
.mm-admin__quote p { margin: 0; }
.mm-admin__courier-actions { flex-wrap: wrap; justify-content: flex-start; }
.mm-admin__courier-actions a { color: var(--mm-ink); }
.mm-admin__dialog { width: min(480px, calc(100% - 32px)); max-height: calc(100dvh - 48px); overflow-y: auto; border: 1px solid var(--mm-border); background: var(--mm-surface); color: var(--mm-ink); padding: 24px; }
.mm-admin__dialog::backdrop { background: rgba(0,0,0,.4); }
.mm-admin__dialog h2 { margin: 0 0 16px; font: 500 24px/1.2 Montserrat, Inter, sans-serif; }
.mm-admin__dialog p { margin: 0 0 24px; }
.mm-admin__delivery-settings { width: min(520px, calc(100% - 32px)); }
.mm-admin__settings-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.mm-admin__settings-heading h2 { margin: 0; }
.mm-admin__delivery-settings > .mm-admin__helper { margin: 12px 0 20px; }
.mm-admin__connection-status { display: grid; gap: 10px; background: var(--mm-soft); border-left: 3px solid var(--mm-sage); padding: 18px; margin: 20px 0; }
.mm-admin__connection-status p, .mm-admin__delivery-settings .mm-admin__technical p { margin: 0; }
.mm-admin__delivery-settings .mm-admin__technical { border-top: 1px solid var(--mm-border); }
.mm-admin__delivery-settings .mm-admin__technical > button { margin: 16px 0; }
.mm-admin__back { display: none; align-self: flex-start; }
.mm-admin__cms-steps { padding-left: 20px; line-height: 1.65; }
.mm-admin__cms-steps li + li { margin-top: 12px; }
@media (width < 768px) { .mm-admin__responsive-nav { display: contents; } }
.mm-admin__blockers { margin: 12px 0 18px; padding-left: 19px; color: var(--mm-muted); }
.mm-admin__blockers li + li { margin-top: 6px; }
.mm-admin__setup-card { border: 1px solid var(--mm-border); background: var(--mm-surface); padding: 18px; display: grid; gap: 8px; }
.mm-admin__setup-card p { margin: 0; color: var(--mm-muted); }
.mm-admin__setup-card pre { margin: 4px 0 0; padding: 12px; max-height: 260px; overflow: auto; background: var(--mm-soft); color: var(--mm-ink); font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.mm-admin__payment-error { color: #8A342C; font-weight: 700; }
.mm-admin { font-family: Inter, Arial, sans-serif; font-size: 15px; line-height: 1.45; }
.mm-admin button, .mm-admin input, .mm-admin select, .mm-admin textarea { font: inherit; }
.mm-admin button { color: inherit; }
.mm-admin__page { display: flex; flex-direction: column; gap: 24px; padding: 28px 32px; width: 100%; }
.mm-admin__notice { border: 1px solid var(--mm-border); background: var(--mm-soft); padding: 12px 16px; }
.mm-admin__error-ref { display: block; overflow-wrap: anywhere; color: var(--mm-muted); margin-top: 6px; }
.mm-admin__header, .mm-admin__section-heading, .mm-admin__product-toolbar, .mm-admin__order-card-top, .mm-admin__actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.mm-admin__eyebrow { margin: 0 0 8px; color: var(--mm-muted); font-size: 12px; font-weight: 700; letter-spacing: .08em; }
.mm-admin__title { margin: 0; color: var(--mm-ink); font-family: Montserrat, Inter, sans-serif; font-size: clamp(32px, 3vw, 42px); font-weight: 500; letter-spacing: -.035em; line-height: 1.15; text-transform: uppercase; }
.mm-admin__title--dashboard { color: var(--mm-ink); }
.mm-admin__button { appearance: none; min-height: 44px; border: 0; border-radius: 0; background: var(--mm-sage); color: #fff !important; cursor: pointer; font-weight: 700; padding: 13px 20px; transition: opacity .18s ease; }
.mm-admin__button:hover { opacity: .82; }
.mm-admin__button-link { display: inline-flex; align-items: center; justify-content: center; text-decoration: none; }
.mm-admin__button:disabled { cursor: not-allowed; opacity: .45; }
.mm-admin__button.is-active { box-shadow: inset 0 0 0 2px var(--mm-ink); }
.mm-admin__nav { grid-column: 1 / -1; grid-row: 2; display: grid; gap: 4px; margin-top: 12px; padding: 8px; background: var(--mm-surface); border: 1px solid var(--mm-border); }
.mm-admin__nav[hidden] { display: none; }
.mm-admin__nav a { min-height: 48px; display: flex; align-items: center; padding: 12px 14px; color: var(--mm-ink); text-decoration: none; }
.mm-admin__nav a:hover, .mm-admin__nav a.is-active { background: var(--mm-soft); }
.mm-admin__nav a.is-active { box-shadow: inset 3px 0 var(--mm-sage); font-weight: 600; }
.mm-admin__secondary-button, .mm-admin__text-button { appearance: none; border: 1px solid var(--mm-border); background: transparent; color: var(--mm-ink); cursor: pointer; font-weight: 700; padding: 12px 18px; }
.mm-admin__text-button { border: 0; min-height: 44px; padding: 8px 0; text-decoration: underline; }
.mm-admin__stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.mm-admin__stat { min-height: 108px; margin: 0; border: 1px solid var(--mm-border); background: var(--mm-surface); padding: 18px; }
.mm-admin__stat p { margin: 0 0 12px; color: var(--mm-muted); font-size: 13px; }
.mm-admin__stat strong { display: block; font-family: Montserrat, Inter, sans-serif; font-size: 30px; font-weight: 500; font-variant-numeric: tabular-nums; }
.mm-admin__section-heading h2 { margin: 0; font-family: Montserrat, Inter, sans-serif; font-size: 26px; font-weight: 500; letter-spacing: -.025em; }
.mm-admin__order-table, .mm-admin__order-list, .mm-admin__product-list { display: flex; flex-direction: column; background: var(--mm-border); gap: 1px; }
.mm-admin__order-row { display: grid; grid-template-columns: .8fr 1.2fr 1fr .8fr .7fr; align-items: center; gap: 16px; width: 100%; border: 0; background: var(--mm-surface); padding: 18px; text-align: left; cursor: pointer; }
.mm-admin__order-row:hover, .mm-admin__order-card:hover, .mm-admin__order-card.is-selected { background: var(--mm-soft); }
.mm-admin__order-row em, .mm-admin__product-row em { justify-self: end; }
.mm-admin__badge { display: inline-block; border: 1px solid var(--mm-border); background: #E3E8DF; color: #536047; font-size: 11px; font-style: normal; font-weight: 700; padding: 3px 8px; white-space: nowrap; }
.mm-admin__badge--pending, .mm-admin__badge--new, .mm-admin__badge--low-stock { background: #F1E7D2; color: #765C35; }
.mm-admin__badge--delivered, .mm-admin__badge--active, .mm-admin__badge--paid { background: #E1E9DD; color: #4E6545; }
.mm-admin__badge--failed, .mm-admin__badge--refunded, .mm-admin__badge--cancelled { background: #F0DDDA; color: #7A352B; }
.mm-admin__quick-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.mm-admin__quick-card { border: 1px solid var(--mm-border); background: var(--mm-surface); padding: 26px; }
.mm-admin__quick-card h3 { margin: 0 0 8px; font-size: 21px; }
.mm-admin__quick-card p { margin: 0 0 18px; color: var(--mm-muted); }
.mm-admin__cms-note { border: 1px solid var(--mm-border); background: var(--mm-surface); padding: clamp(28px, 6vw, 64px); }
.mm-admin__cms-note h2 { max-width: 720px; margin: 0 0 18px; font-family: Montserrat, Inter, sans-serif; font-size: clamp(34px, 5vw, 58px); font-weight: 500; letter-spacing: -.04em; line-height: 1; text-transform: uppercase; }
.mm-admin__cms-note > p { max-width: 680px; color: var(--mm-muted); font-size: 17px; line-height: 1.65; }
.mm-admin__cms-link { display: inline-flex; min-height: 48px; align-items: center; margin-top: 12px; padding: 13px 18px; background: var(--mm-sage); color: #fff; font-weight: 700; text-decoration: none; }
.mm-admin__muted-label { color: var(--mm-muted); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.mm-admin__filters { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--mm-border); }
.mm-admin__orders-layout { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); align-items: start; gap: 24px; }
.mm-admin__orders-layout > * { min-width: 0; scroll-margin-top: 24px; }
.mm-admin__order-card-top { align-items: flex-start; gap: 12px; }
.mm-admin__order-card-top > strong:first-child { min-width: 0; }
.mm-admin__order-amount { white-space: nowrap; font-size: 14px; font-variant-numeric: tabular-nums; }
.mm-admin__order-meta { margin: 0; color: var(--mm-muted); font-size: 12px; line-height: 1.6; }
.mm-admin__order-card { display: flex; flex-direction: column; gap: 12px; width: 100%; border: 0; border-left: 3px solid transparent; background: var(--mm-surface); cursor: pointer; padding: 18px; text-align: left; }
.mm-admin__order-card.is-selected { border-left-color: var(--mm-sage); }
.mm-admin__detail-heading { display: grid; gap: 8px; }
.mm-admin__detail-heading .mm-admin__eyebrow { margin: 0; }
.mm-admin__detail-heading h2 { margin: 0; font: 500 24px/1.3 Montserrat, Inter, sans-serif; letter-spacing: -.025em; }
.mm-admin__detail { display: flex; flex-direction: column; gap: 20px; border: 1px solid var(--mm-border); background: var(--mm-surface); padding: 28px; }
.mm-admin__detail > h2 { margin: -4px 0 4px; font-family: Montserrat, Inter, sans-serif; font-size: clamp(24px, 3vw, 36px); line-height: 1.2; font-weight: 500; }
.mm-admin__detail-block { border-bottom: 1px solid var(--mm-border); padding: 0 0 18px; }
.mm-admin__detail-block h3, .mm-admin__detail-block p { margin: 0; }
.mm-admin__detail-block h3 { margin-bottom: 8px; font-size: 15px; }
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
.mm-admin__brand { display: grid; width: 52px; height: 52px; place-items: center; border: 1px solid var(--mm-border); color: var(--mm-ink); font-family: Montserrat, Inter, sans-serif; font-size: 18px; font-weight: 600; text-decoration: none; }
.mm-admin__website-link { color: var(--mm-ink); text-underline-offset: 3px; }
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
  .mm-admin__editor-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mm-admin__variant-editor { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .mm-admin__product-row { grid-template-columns: 56px 1.4fr repeat(2, .7fr) auto; }
  .mm-admin__product-row > :nth-child(4), .mm-admin__product-row > :nth-child(6) { display: none; }
  .mm-admin__variant-row { padding-left: 16px; }
}
@container (max-width: 700px) {
  .mm-admin__orders-layout { grid-template-columns: 1fr; }
  .mm-admin__back { display: block; }
}
@container (max-width: 620px) {
  .mm-admin__page { gap: 20px; padding: 18px; }
  .mm-admin__filters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; }
  .mm-admin__filters button { padding: 10px 8px; font-size: 13px; white-space: normal; }
  .mm-admin__header, .mm-admin__section-heading, .mm-admin__product-toolbar { align-items: flex-start; flex-direction: column; }
  .mm-admin__title { font-size: 32px; }
  .mm-admin__search-row { grid-template-columns: 1fr; }
  .mm-admin__detail { padding: 18px; }
  .mm-admin__utility-actions { gap: 18px; }
  .mm-admin__stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mm-admin__quick-grid { grid-template-columns: 1fr; }
  .mm-admin__section-heading h2 { font-size: 24px; }
  .mm-admin__order-row { grid-template-columns: 1fr auto; }
  .mm-admin__order-row > :nth-child(3) { display: none; }
  .mm-admin__order-row > :nth-child(5) { grid-column: 1 / -1; }
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
  .mm-admin__variant-editor, .mm-admin__variant-row { grid-template-columns: 1fr; }
  .mm-admin__stat { min-height: 108px; padding: 18px; }
  .mm-admin__stat strong { font-size: 30px; }
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
