import {
    startTransition,
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type FormEvent,
    type ReactNode,
} from "react"
import { addPropertyControls, ControlType, useIsStaticRenderer } from "framer"

type View = "login" | "dashboard" | "orders" | "products" | "discounts"
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
    id?: string
    returnableQuantity?: number
    restockableQuantity?: number
    name: string
    variant: string
    quantity: number
    price: number
}

interface AdminOrder {
    detailsLoaded?: boolean
    listNeedsAttention?: boolean
    listInProgress?: boolean
    id: string
    customer: string
    email: string
    phone: string
    placedAt: string
    subtotal?: number
    discountAmount?: number
    discountCode?: string
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
    deliveryDetails?: DeliveryEditorDetails
    bobGoSync?: { status: string; message?: string; remoteOrderId?: string }
    items: OrderItem[]
    aftersales?: {
        canStartReturn: boolean
        canRecordRefund: boolean
        refundedTotal: number
        remainingRefundable: number
        returns: Array<{ id: string; status: string; reason: string; waybillReference?: string; receivedAt?: string; items: Array<{ itemId: string; quantity: number; restocked: number }> }>
        refunds: Array<{ id: string; amount: number; reference: string; reason: string; refundedAt: string; recordedBy: string }>
    }
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
        courierName?: string
        serviceName?: string
        courierStatus?: string
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

interface OrderTrace {
    order: { orderNumber: string; createdAt: string; updatedAt: string }
    payment: { status: string; providerStatus?: string; merchantPaymentId?: string; providerPaymentId?: string; verifiedAt?: string; updatedAt: string } | null
    shipment: { status: string; providerShipmentId?: string; waybillReference?: string; trackingNumber?: string; bookedAt?: string; updatedAt: string } | null
    notifications: Array<{ template: string; status: string; providerEmailId?: string; deliveryEvent?: string; deliveryEventAt?: string; createdAt: string }>
    incidents: Array<{ reference: string; source: string; operation: string; summary: string; lastSeenAt: string; resolvedAt?: string }>
    history: Array<{ from?: string; to: string; at: string }>
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
    collectionDropOff?: PickupPoint | null
    expires?: number
    declaredValue?: number
    environment?: "sandbox" | "production"
    url?: string
    message?: string
    points?: DeliveryPointResult[]
    packages?: SavedParcelPackage[]
    limited?: boolean
}
type ShippingRequest = (order: AdminOrder, action: "quote" | "book" | "refresh" | "waybill" | "save_delivery" | "pickup_points" | "packages" | "cancel_waybill" | "check_cancellation" | "prepare_replacement", payload?: Record<string, unknown>) => Promise<ShippingResult>
type AftersalesRequest = (order: AdminOrder, payload: Record<string, unknown>) => Promise<void>
type Confirmation = { title: string; description: string; confirmLabel?: string; run: () => void }
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
        if (!init?.signal?.aborted && error instanceof Error && ["TypeError", "TimeoutError", "AbortError"].includes(error.name)) {
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
    const [technicalAlertsOpen, setTechnicalAlertsOpen] = useState(false)
    const [courierCheck, setCourierCheck] = useState<CourierConnectionCheck>({ status: "unchecked" })
    const accountRef = useRef<HTMLDetailsElement>(null)
    const accountSummaryRef = useRef<HTMLElement>(null)
    const alertsBannerRef = useRef<HTMLButtonElement>(null)
    const alertsReturnFocus = useRef<HTMLElement | null>(null)
    const mutationPending = useRef(false)
    const initialOrderLinkConsumed = useRef(false)

    const backendConfigured = Boolean(normalizeBaseUrl(apiBaseUrl))
    const liveEnabled = backendConfigured && !isStatic

    useEffect(() => {
        if (!technicalAlertsOpen && alertsReturnFocus.current) {
            alertsReturnFocus.current.focus()
            alertsReturnFocus.current = null
        }
    }, [technicalAlertsOpen])

    const loadTechnicalAlerts = useCallback(async (status: "open" | "resolved", page: number): Promise<TechnicalAlertsData> => {
        if (!liveEnabled) throw new Error("Open the live admin portal to review technical alerts.")
        const response = await adminFetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/diagnostics?status=${status}&page=${page}`, {
            headers: { Authorization: `Bearer ${token()}` },
        })
        const data = await response.json().catch(() => null)
        if (response.status === 401) { rememberAdminReturnPath(); route("/admin/login") }
        if (!response.ok || !Array.isArray(data?.incidents) || !data?.counts || !data?.pagination) throw new Error(apiErrorMessage(data, "Technical alerts could not be loaded."))
        return data
    }, [apiBaseUrl, liveEnabled])

    const resolveTechnicalAlert = useCallback(async (incident: TechnicalIncident) => {
        if (!liveEnabled || mutationPending.current) throw new Error("Wait for the current action to finish, then review the alert again.")
        mutationPending.current = true
        try {
            const response = await adminFetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/diagnostics`, {
                method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
                body: JSON.stringify({ id: incident.id, expectedOccurrences: incident.occurrences, confirmed: true }),
            })
            const data = await response.json().catch(() => null)
            if (response.status === 401) { rememberAdminReturnPath(); route("/admin/login") }
            if (!response.ok || data?.resolved !== true) throw new Error(apiErrorMessage(data, "Resolution could not be confirmed. Refresh and check the alert."))
            // Re-read the banner; never hide other unresolved issues optimistically.
            setRefresh(value => value + 1)
        } finally { mutationPending.current = false }
    }, [apiBaseUrl, liveEnabled])

    function openTechnicalAlerts(fromBanner = false) {
        if (accountRef.current) accountRef.current.open = false
        alertsReturnFocus.current = fromBanner ? alertsBannerRef.current : accountSummaryRef.current
        setTechnicalAlertsOpen(true)
    }

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
        adminFetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/data?view=${encodeURIComponent(view)}`, {
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
                    const requested = initialOrderLinkConsumed.current ? null : new URLSearchParams(window.location.search).get("order")
                    initialOrderLinkConsumed.current = true
                    setSelectedOrderId((current) => {
                        const id = current || requested || ""
                        return data.orders.some(order => order.id === id) ? id : ""
                    })
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
                (orderFilter === "Needs attention" && (order.listNeedsAttention ?? (Boolean(order.actionNeeded?.length) ||
                    Boolean(order.aftersales?.returns.some(record => record.status !== "received") || order.aftersales?.canRecordRefund) ||
                    order.paymentStatus === "Paid" &&
                    (order.status === "New" || order.status === "Confirmed" ||
                     (order.status === "Ready" && order.shipping?.status !== "Booking" && order.shipping?.status !== "Booked") ||
                     (!['Collected', 'Delivered', 'Cancelled'].includes(order.status) && order.shipping?.status === "Failed"))))) ||
                (orderFilter === "In progress" && (order.listInProgress ?? (order.paymentStatus === "Paid" &&
                    (order.status === "Preparing" || order.status === "Dispatched" ||
                     (order.status === "Ready" && ['Booking', 'Booked'].includes(order.shipping?.status || ""))))))
            return matchesStatus && (method === "All methods" || method === order.deliveryMethod) &&
                (!query || [order.id, order.customer, order.email].some((value) => value.toLowerCase().includes(query)))
        })
    }, [orderFilter, snapshot.orders, search, method])

    const selectedOrder = filteredOrders.find((order) => order.id === selectedOrderId)
    const [detailError, setDetailError] = useState("")
    const [detailRetry, setDetailRetry] = useState(0)
    const needsDetails = selectedOrder?.detailsLoaded === false
    useEffect(() => {
        if (!liveEnabled || view !== "orders" || loadState !== "ready" || !selectedOrderId || !needsDetails) return
        const controller = new AbortController()
        startTransition(() => setDetailError(""))
        adminFetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/data?order=${encodeURIComponent(selectedOrderId)}`, {
            headers: { Authorization: `Bearer ${token()}` },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
        }).then(async response => {
            if (response.status === 401) { rememberAdminReturnPath(); route("/admin/login"); throw new Error("Please sign in again.") }
            const data = await response.json().catch(() => null)
            if (!response.ok || !data?.orders?.some((order: AdminOrder) => order.id === selectedOrderId)) throw new Error(apiErrorMessage(data, "Order details could not be loaded."))
            if (controller.signal.aborted) return
            const fullOrder = data.orders.find((order: AdminOrder) => order.id === selectedOrderId)
            startTransition(() => setSnapshot(current => ({ ...current, orders: current.orders.map(order => order.id === selectedOrderId ? { ...fullOrder, detailsLoaded: true } : order) })))
        }).catch(error => {
            if (!controller.signal.aborted) startTransition(() => setDetailError(error instanceof Error ? error.message : "Order details could not be loaded."))
        })
        return () => controller.abort()
    }, [apiBaseUrl, liveEnabled, view, loadState, refresh, selectedOrderId, needsDetails, detailRetry])

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

    async function requestShipping(order: AdminOrder, action: Parameters<ShippingRequest>[1], payload: Record<string, unknown> = {}): Promise<ShippingResult> {
        if (mutationPending.current || !liveEnabled) throw new Error("Wait for the current action to finish, then try again.")
        mutationPending.current = true
        startTransition(() => { setLoading(true); setNotice("") })
        try {
            const changingWaybill = ["cancel_waybill", "check_cancellation", "prepare_replacement"].includes(action)
            const endpoint = action === "book" ? "book-shipment" : action === "save_delivery" ? "delivery" : changingWaybill ? "shipment-change" : "shipment"
            const lookup = action === "pickup_points" || action === "packages"
            const url = action === "packages" ? `${normalizeBaseUrl(apiBaseUrl)}/api/admin/bobgo/packages`
                : action === "pickup_points" ? `${normalizeBaseUrl(apiBaseUrl)}/api/admin/bobgo/pickup-points?q=${encodeURIComponent(String(payload.query || ""))}`
                : `${normalizeBaseUrl(apiBaseUrl)}/api/admin/orders/${encodeURIComponent(order.id)}/${endpoint}`
            const response = await adminFetch(url, {
                method: lookup ? "GET" : action === "save_delivery" ? "PATCH" : "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
                ...(lookup ? {} : { body: JSON.stringify(action === "book" ? { ...payload, confirm: true } : action === "save_delivery" ? payload : { ...payload, action }) }),
            })
            const data = await response.json().catch(() => null)
            if (!response.ok) {
                if (response.status === 401) route("/admin/login")
                throw new Error(apiErrorMessage(data, "Bob Go could not complete this request."))
            }
            startTransition(() => {
                if (data.order) setSnapshot((current) => ({ ...current, orders: current.orders.map(item => item.id === order.id ? data.order : item) }))
                if (data.message || data.warning) setNotice(data.warning || data.message)
                if ((action === "save_delivery" || changingWaybill) && !data.order) setRefresh(current => current + 1)
            })
            return data as ShippingResult
        } catch (error) {
            if (action === "book" || ["cancel_waybill", "check_cancellation", "prepare_replacement"].includes(action)) setRefresh(current => current + 1)
            const failure = error instanceof Error ? error : new Error("Bob Go request failed.")
            startTransition(() => setNotice(failure.message))
            throw failure
        } finally {
            mutationPending.current = false
            startTransition(() => setLoading(false))
        }
    }

    async function requestAftersales(order: AdminOrder, payload: Record<string, unknown>) {
        if (mutationPending.current || !liveEnabled) throw new Error("Wait for the current action to finish, then try again.")
        mutationPending.current = true
        startTransition(() => { setLoading(true); setNotice("") })
        try {
            const response = await adminFetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/orders/${encodeURIComponent(order.id)}/aftersales`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
                body: JSON.stringify(payload),
            })
            const data = await response.json().catch(() => null)
            if (!response.ok) {
                if (response.status === 401) route("/admin/login")
                throw new Error(apiErrorMessage(data, "The return or refund could not be saved."))
            }
            startTransition(() => {
                if (data.order) setSnapshot(current => ({ ...current, orders: current.orders.map(item => item.id === order.id ? data.order : item) }))
                else setRefresh(current => current + 1)
                setNotice(data.warning || data.message || "Saved.")
            })
        } catch (error) {
            setRefresh(current => current + 1)
            const failure = error instanceof Error ? error : new Error("The return or refund could not be saved.")
            startTransition(() => setNotice(failure.message))
            throw failure
        } finally {
            mutationPending.current = false
            startTransition(() => setLoading(false))
        }
    }

    async function requestTrace(order: AdminOrder): Promise<OrderTrace> {
        const response = await adminFetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/orders/${encodeURIComponent(order.id)}/trace`, {
            headers: { Authorization: `Bearer ${token()}` },
        })
        const data = await response.json().catch(() => null)
        if (!response.ok) {
            if (response.status === 401) route("/admin/login")
            throw new Error(apiErrorMessage(data, "Support details could not be loaded."))
        }
        return data as OrderTrace
    }

    async function checkCourierConnection() {
        if (mutationPending.current || !liveEnabled) return
        mutationPending.current = true
        startTransition(() => { setLoading(true); setCourierCheck({ status: "checking" }) })
        try {
            const response = await adminFetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/bobgo/locations`, { headers: { Authorization: `Bearer ${token()}` } })
            const data = await response.json().catch(() => null)
            if (!response.ok || !data?.connected) throw new Error(data?.error || "The Bob Go account connection could not be verified.")
            startTransition(() => setCourierCheck({ status: "connected", location: data.target,
                message: data.bookingEnabled ? "Account access verified. Manual booking is enabled; each order still needs valid delivery details and a courier quote." : "Account access verified. Courier booking is currently paused.",
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

    async function requestShippingWeights(changes?: Array<{ id: string; expectedGrams: number | null; grams: number | null }>): Promise<ShippingWeightRow[]> {
        if (mutationPending.current || !liveEnabled) throw new Error("Wait for the current action to finish, then try again.")
        mutationPending.current = true
        startTransition(() => setLoading(true))
        try {
            const response = await adminFetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/bobgo/weights`, {
                method: changes ? "PATCH" : "GET", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
                ...(changes ? { body: JSON.stringify({ changes, confirmed: true }) } : {}),
            })
            const data = await response.json().catch(() => null)
            if (!response.ok || !Array.isArray(data?.weights)) {
                if (response.status === 401) route("/admin/login")
                throw new Error(apiErrorMessage(data, "Product weights could not be loaded or saved."))
            }
            return data.weights
        } finally { mutationPending.current = false; startTransition(() => setLoading(false)) }
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

    async function logout() {
        if (mutationPending.current) return
        mutationPending.current = true
        startTransition(() => setLoading(true))
        try {
            if (liveEnabled && token()) {
                const response = await adminFetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/logout`, {
                    method: "POST", headers: { Authorization: `Bearer ${token()}` },
                })
                const data = await response.json().catch(() => null)
                if (!response.ok || data?.revoked !== true) throw new Error(apiErrorMessage(data, "Sign-out could not be confirmed. Please try again."))
            }
            if (typeof window !== "undefined") window.sessionStorage.removeItem("moving_modesty_admin_token")
            route("/admin/login")
        } catch (error) {
            startTransition(() => setNotice(error instanceof Error ? error.message : "Sign-out could not be confirmed. Please try again."))
        } finally {
            mutationPending.current = false
            startTransition(() => setLoading(false))
        }
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
            {/* Static repository CSS: raw-text output keeps Framer's React 18 SSR and hydration identical. */}
            <style dangerouslySetInnerHTML={{ __html: styles + technicalAlertsCss }} />
            {view === "login" ? (
                <LoginView apiBaseUrl={apiBaseUrl} liveEnabled={liveEnabled} backendConfigured={backendConfigured} />
            ) : (
                <div className="mm-admin__page">
                    <div className="mm-admin__utilities">
                        <AdminNav current={view} />
                        <div className="mm-admin__utility-actions">
                            {view === "dashboard" || view === "orders" ? <button type="button" className="mm-admin__text-button" disabled={loading} onClick={() => setRefresh((current) => current + 1)}>{loading ? "Updating…" : "Refresh orders"}</button> : null}
                            <details className="mm-admin__account" ref={accountRef}>
                                <summary ref={accountSummaryRef}>Account</summary>
                                <div className="mm-admin__account-menu">
                                    <button type="button" className="mm-admin__text-button" aria-haspopup="dialog" onClick={openDeliverySettings}>Delivery settings</button>
                                    <button type="button" className="mm-admin__text-button" aria-haspopup="dialog" onClick={() => openTechnicalAlerts()}>Technical alerts</button>
                                    <a href="/" target="_blank" rel="noopener noreferrer">View website</a>
                                    <button type="button" className="mm-admin__text-button" disabled={loading} onClick={logout}>Log out</button>
                                </div>
                            </details>
                        </div>
                    </div>
                    {notice ? <div className="mm-admin__notice" role="status">{notice}</div> : null}
                    {snapshot.operationalNotice ? <div className="mm-admin__notice" role="status"><p style={{ margin: 0 }}>{snapshot.operationalNotice}</p><button type="button" className="mm-admin__text-button" ref={alertsBannerRef} aria-haspopup="dialog" onClick={() => openTechnicalAlerts(true)}>Review technical alerts</button></div> : null}
                    {view === "discounts" ? (
                        <DiscountManager apiBaseUrl={apiBaseUrl} enabled={liveEnabled} />
                    ) : view === "products" ? (
                        <ProductsView apiBaseUrl={apiBaseUrl} liveEnabled={liveEnabled} />
                    ) : liveEnabled && loadState !== "ready" ? (
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
                            setFilter={value => { setOrderFilter(value); setSelectedOrderId("") }}
                            search={search}
                            setSearch={value => { setSearch(value); setSelectedOrderId("") }}
                            method={method}
                            setMethod={value => { setMethod(value); setSelectedOrderId("") }}
                            updateOrderStatus={updateOrderStatus}
                            requestShipping={requestShipping}
                            requestAftersales={requestAftersales}
                            bobGoConnection={snapshot.bobGoConnection}
                            retryNotification={retryNotification}
                            requestTrace={liveEnabled ? requestTrace : undefined}
                            loading={loading}
                            detailError={detailError}
                            retryDetails={() => setDetailRetry(value => value + 1)}
                        />
                    ) : (
                <ProductsView apiBaseUrl={apiBaseUrl} liveEnabled={liveEnabled} />
                    )}
                    <DeliverySettings open={deliverySettingsOpen} close={closeDeliverySettings} connection={snapshot.bobGoConnection}
                        check={courierCheck} checking={courierCheck.status === "checking"} disabled={loading || !liveEnabled || loadState !== "ready"}
                        checkConnection={checkCourierConnection} paymentEnvironment={snapshot.paymentEnvironment} requestWeights={liveEnabled ? requestShippingWeights : undefined} />
                    {technicalAlertsOpen ? <EmbeddedTechnicalAlerts load={loadTechnicalAlerts} resolve={resolveTechnicalAlert} close={() => setTechnicalAlertsOpen(false)} /> : null}
                </div>
            )}
        </section>
    )
}

function DeliverySettings({ open, close, connection, check, checking, disabled, checkConnection, paymentEnvironment, requestWeights }: {
    open: boolean
    close: () => void
    connection?: Snapshot["bobGoConnection"]
    check: CourierConnectionCheck
    checking: boolean
    disabled: boolean
    checkConnection: () => void
    paymentEnvironment?: Snapshot["paymentEnvironment"]
    requestWeights?: ShippingWeightSettingsProps["request"]
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
            {check.location ? <p>Delivery setup: {check.location}</p> : null}
            {check.message ? <p className={check.status === "error" ? "mm-admin__error" : undefined} role={check.status === "error" ? "alert" : undefined}>{check.message}</p> : null}
            {connection && !ready ? <p>Courier booking is paused or setup is incomplete. Contact your website administrator.</p> : null}
            {check.checkedAt ? <p className="mm-admin__helper">Last checked: {check.checkedAt}</p> : null}
        </section>
        <p className="mm-admin__helper">For delivery: prepare the parcel, mark the paid order Ready, then review its quote and confirm the booking. Collection orders do not use Bob Go.</p>
        {paymentEnvironment === "sandbox" && connection?.environment === "production" ? <p className="mm-admin__error">Payments are in test mode. Live courier booking is blocked for test-paid orders.</p> : null}
        <EmbeddedDeliveryAdvancedSettings needsAttention={check.status === "error"}>
        <details className="mm-admin__technical"><summary>Troubleshooting</summary>
            <p className="mm-admin__helper">This checks read-only Bob Go account access, not locker availability, courier quotes or order synchronisation. It does not book a shipment or create a courier charge.</p>
            <button type="button" className="mm-admin__secondary-button" disabled={disabled} onClick={checkConnection}>{checking ? "Checking connection…" : "Check courier connection (no booking)"}</button>
            <p className="mm-admin__helper">If the check fails, contact your website administrator. No API keys need to be entered here.</p>
        </details>
        {open && requestWeights ? <EmbeddedShippingWeightSettings request={requestWeights} /> : null}
        </EmbeddedDeliveryAdvancedSettings>
    </dialog>
}

function LoginView({ apiBaseUrl, liveEnabled, backendConfigured }: { apiBaseUrl: string; liveEnabled: boolean; backendConfigured: boolean }) {
    const [email, setEmail] = useState("")
    const [password, setPassword] = useState("")
    const [showPassword, setShowPassword] = useState(false)
    const passwordInputId = useId()
    const passwordInput = useRef<HTMLInputElement>(null)
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
            setShowPassword(false)
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
                <div className="mm-admin__field">
                    <label htmlFor={passwordInputId}>Password</label>
                    <div className="mm-admin__password-field">
                        <input
                            id={passwordInputId}
                            ref={passwordInput}
                            type={showPassword ? "text" : "password"}
                            autoComplete="current-password"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            placeholder="Password"
                            required
                        />
                        <button
                            className="mm-admin__password-toggle"
                            type="button"
                            aria-label={showPassword ? "Hide password" : "Show password"}
                            aria-controls={passwordInputId}
                            aria-pressed={showPassword}
                            title={showPassword ? "Hide password" : "Show password"}
                            onClick={() => {
                                // Preserve browser-filled text before changing the input type.
                                if (passwordInput.current) setPassword(passwordInput.current.value)
                                setShowPassword(current => !current)
                            }}
                        >
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                                <circle cx="12" cy="12" r="3" />
                                {showPassword ? <path d="m3 3 18 18" /> : null}
                            </svg>
                        </button>
                    </div>
                </div>
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

function AdminNav({ current }: { current: "dashboard" | "orders" | "products" | "discounts" }) {
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
            <a onClick={close} aria-current={current === "products" ? "page" : undefined} className={current === "products" ? "is-active" : ""} href="/admin/products">Products</a>
                <a onClick={close} aria-current={current === "discounts" ? "page" : undefined} className={current === "discounts" ? "is-active" : ""} href="/admin/discounts">Discounts</a>
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
    requestAftersales,
    bobGoConnection,
    retryNotification,
    requestTrace,
    loading,
    detailError,
    retryDetails,
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
    requestAftersales: AftersalesRequest
    bobGoConnection?: Snapshot["bobGoConnection"]
    retryNotification: (order: AdminOrder, notificationId: string) => void
    requestTrace?: (order: AdminOrder) => Promise<OrderTrace>
    loading: boolean
    detailError?: string
    retryDetails?: () => void
}) {
    const detailRef = useRef<HTMLElement>(null)
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
            ? `Cancel ${order.id}? This cannot be undone here. ${order.paymentStatus === "Paid" ? "This does not refund the payment. Complete any refund in PayFast, then record it under Returns & refunds. " : ""}The customer will be notified if email is configured.`
            : status === "Collected" ? `Confirm that ${order.customer} has actually received the parcel. This completes the order.`
            : status === "Dispatched" ? "Confirm that you have handed the parcel to the courier or drop-off locker using the booked waybill."
            : status === "Delivered" ? "Confirm that courier tracking shows the parcel was delivered. This completes the order."
            : `Change ${order.id} to ${status.toLowerCase()}? A customer notification will be submitted if email is configured.`
        setConfirmation({ title: label, description, run: () => updateOrderStatus(order, status) })
    }

    const deliveryNext = selected ? deliveryNextStep(selected) : null
    return (
        <>
            <PageHeader eyebrow="ADMIN / ORDERS" title="Orders" />
            <p className="mm-admin__helper">Select an order to open its details. Select it again to close.</p>
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
                <EmbeddedOrderCards orders={orders} selectedId={selectedOrderId} onSelect={setSelectedOrderId}
                    empty={<div className="mm-admin__empty"><strong>No matching orders</strong><span>Try All orders or clear your search and delivery filter.</span></div>}
                    renderSummary={(order, expanded) => <>
                            <span className="mm-admin__order-card-top">
                                <strong>{order.customer}</strong>
                                <strong className="mm-admin__order-amount">{money.format(order.total)}</strong>
                            </span>
                            <span className="mm-admin__badges"><em className={badgeClass(order.paymentStatus)}>{order.paymentStatus}</em><em className={badgeClass(order.status)}>{order.status}</em><span>{order.deliveryMethod}</span></span>
                            <span className="mm-admin__order-summary-footer"><span className="mm-admin__order-meta">{order.id} · {order.placedAt}</span><span className="mm-admin__order-toggle-label">{expanded ? "Close details" : "View details"}</span></span>
                            {order.actionNeeded?.length ? <span className="mm-admin__order-meta">Action needed</span> : null}
                    </>}
                    renderDetails={close => selected?.detailsLoaded === false ? (
                        <section className="mm-admin__detail" aria-label={`Details for ${selected.id}`} aria-busy={!detailError}>
                            <button type="button" className="mm-admin__text-button mm-admin__close-details" onClick={close}>Close details</button>
                            <p role="status">{detailError || "Loading order details…"}</p>
                            {detailError ? <button type="button" className="mm-admin__secondary-button" onClick={retryDetails}>Try again</button> : null}
                        </section>
                    ) : selected ? (
                    <article className="mm-admin__detail" ref={detailRef} tabIndex={-1} aria-label={`Details for ${selected.id}`}>
                        <button type="button" className="mm-admin__text-button mm-admin__close-details" onClick={close}>Close details</button>
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
                            <p>{deliveryNext?.guidance || selected.workflow?.guidance || "Refresh orders to load the current workflow before making changes."}</p>
                            {deliveryNext ? <button className="mm-admin__button mm-delivery__primary-action" type="button" disabled={loading} onClick={() => {
                                courierRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" })
                                courierRef.current?.focus({ preventScroll: true })
                            }}>{deliveryNext.label}</button> : null}
                            {selected.workflow?.nextStatus ? <button className={deliveryNext ? "mm-admin__secondary-button" : "mm-admin__button"} type="button" disabled={loading} onClick={() => requestStatus(selected, selected.workflow!.nextStatus!, selected.workflow!.actionLabel)}>{loading ? "Saving…" : selected.workflow.actionLabel}</button> : null}
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
                            {selected.subtotal !== undefined ? <p>Product subtotal: {money.format(selected.subtotal)}</p> : null}
                            {(selected.discountAmount || 0) > 0 ? <p>Discount{selected.discountCode ? ` (${selected.discountCode})` : ""}: −{money.format(selected.discountAmount || 0)}</p> : null}
                            {selected.deliveryFee !== undefined ? <p>{selected.deliveryMethod === "Collection" ? "Collection: no delivery fee" : `Delivery included in the customer's order total: ${selected.deliveryFee === 0 ? "Free" : money.format(selected.deliveryFee)}`}</p> : null}
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
                        {selected.aftersales && (selected.aftersales.canStartReturn || selected.aftersales.canRecordRefund || selected.aftersales.returns.length > 0 || selected.aftersales.refunds.length > 0) ? <AftersalesPanel key={selected.id} order={selected} loading={loading} request={requestAftersales} confirm={setConfirmation} /> : null}
                        {selected.workflow?.canCancel ? <details key={selected.id} className="mm-admin__technical"><summary>More order options</summary><div className="mm-admin__actions">
                            {selected.workflow?.canCancel ? <button className="mm-admin__secondary-button" type="button" disabled={loading} onClick={() => requestStatus(selected, "Cancelled", "Cancel order")}>Cancel order</button> : null}
                        </div></details> : null}
                        {requestTrace ? <OrderSupportTrace key={`trace-${selected.id}`} order={selected} request={requestTrace} /> : null}
                        <button type="button" className="mm-admin__text-button mm-admin__close-details" onClick={close}>Close details</button>
                    </article>
                ) : null} />
            </div>
            <dialog className="mm-admin__dialog" ref={dialogRef} aria-labelledby="mm-order-confirm-title" aria-describedby="mm-order-confirm-description" onCancel={() => setConfirmation(null)} onClose={() => setConfirmation(null)}>
                <h2 id="mm-order-confirm-title">{confirmation?.title}</h2>
                <p id="mm-order-confirm-description">{confirmation?.description}</p>
                <div className="mm-admin__actions">
                    <button className="mm-admin__secondary-button" type="button" autoFocus onClick={() => setConfirmation(null)}>Go back</button>
                    <button className="mm-admin__button" type="button" disabled={loading} onClick={() => { const action = confirmation; dialogRef.current?.close(); setConfirmation(null); action?.run() }}>{confirmation?.confirmLabel || "Confirm"}</button>
                </div>
            </dialog>
        </>
    )
}

function OrderSupportTrace({ order, request }: { order: AdminOrder; request: (order: AdminOrder) => Promise<OrderTrace> }) {
    const [trace, setTrace] = useState<OrderTrace | null>(null)
    const [error, setError] = useState("")
    const [busy, setBusy] = useState(false)
    const sequence = useRef(0)
    useEffect(() => () => { sequence.current++ }, [])
    const timestamp = (value?: string) => {
        if (!value) return "Not recorded"
        const date = new Date(value)
        return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })
    }
    async function load(open: boolean) {
        if (!open) { sequence.current++; return }
        const current = ++sequence.current
        startTransition(() => { setBusy(true); setError(""); setTrace(null) })
        try {
            const result = await request(order)
            if (current === sequence.current) startTransition(() => setTrace(result))
        } catch (failure) {
            if (current === sequence.current) startTransition(() => setError(failure instanceof Error ? failure.message : "Support details could not be loaded."))
        } finally {
            if (current === sequence.current) startTransition(() => setBusy(false))
        }
    }
    return <details className="mm-admin__technical mm-admin__support-trace" onToggle={event => void load(event.currentTarget.open)}>
        <summary>Support details</summary>
        <p className="mm-admin__helper">For troubleshooting only. Opening this section does not send emails, change the order or book delivery. Close and reopen to refresh.</p>
        {busy ? <p role="status">Loading support details…</p> : error ? <p role="status">{error} Close and reopen to try again.</p> : trace ? <>
            <p>Order reference: {trace.order.orderNumber}<br />Created: {timestamp(trace.order.createdAt)}<br />Last updated: {timestamp(trace.order.updatedAt)}</p>
            <strong>Payment</strong>
            {trace.payment ? <p>Status: {trace.payment.status} · {trace.payment.providerStatus || "No provider status recorded"}<br />Merchant reference: {trace.payment.merchantPaymentId || "Not recorded"}<br />PayFast reference: {trace.payment.providerPaymentId || "Not recorded"}<br />Verified: {timestamp(trace.payment.verifiedAt)}<br />Last check: {timestamp(trace.payment.updatedAt)}</p> : <p>No payment recorded.</p>}
            <strong>Courier</strong>
            {trace.shipment ? <p>Status: {trace.shipment.status}<br />Bob Go reference: {trace.shipment.providerShipmentId || "Not recorded"}<br />Waybill: {trace.shipment.waybillReference || "Not recorded"}<br />Tracking: {trace.shipment.trackingNumber || "Not recorded"}<br />Booked: {timestamp(trace.shipment.bookedAt)}<br />Last check: {timestamp(trace.shipment.updatedAt)}</p> : <p>No courier shipment recorded.</p>}
            <strong>Email events</strong>
            {!trace.notifications.length ? <p>No email events recorded.</p> : <ul>{trace.notifications.map((event, index) => <li key={index}>{event.template}: {event.status}<br />Provider reference: {event.providerEmailId || "Not recorded"}<br />{event.deliveryEvent || "Submission"}: {timestamp(event.deliveryEventAt || event.createdAt)}</li>)}</ul>}
            <strong>Errors</strong>
            {!trace.incidents.length ? <p>No linked errors recorded. This does not prove that every provider screen succeeded.</p> : <ul>{trace.incidents.map(event => <li key={event.reference}>{event.resolvedAt ? "Resolved" : "Needs attention"}: {event.summary}<br />{event.source} / {event.operation}<br />Reference: {event.reference}<br />Last seen: {timestamp(event.lastSeenAt)}</li>)}</ul>}
            <strong>Recent order changes</strong>
            {!trace.history.length ? <p>No status changes recorded.</p> : <ul>{trace.history.slice(0, 10).map((event, index) => <li key={index}>{event.from || "Created"} → {event.to} · {timestamp(event.at)}</li>)}</ul>}
            <p className="mm-admin__helper">These are the latest recorded provider states. A missing PayFast callback does not confirm payment. Refresh courier tracking from the waybill panel.</p>
        </> : null}
    </details>
}

function aftersalesDate(value: string) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", day: "2-digit", month: "short", year: "numeric" }).format(date)
}

function AftersalesPanel({ order, loading, request, confirm }: {
    order: AdminOrder; loading: boolean; request: AftersalesRequest; confirm: (value: Confirmation) => void
}) {
    const sales = order.aftersales!
    const active = sales.returns.find(record => record.status !== "received")
    const [reason, setReason] = useState("")
    const [quantities, setQuantities] = useState<Record<string, number>>({})
    const [restock, setRestock] = useState<Record<string, number>>({})
    const [waybill, setWaybill] = useState("")
    const [inspected, setInspected] = useState(false)
    const [refundAmount, setRefundAmount] = useState(sales.remainingRefundable.toFixed(2))
    const [refundReference, setRefundReference] = useState("")
    const [refundReason, setRefundReason] = useState("")
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
    const [refundDate, setRefundDate] = useState(today)
    const [completed, setCompleted] = useState(false)
    const [error, setError] = useState("")
    const requestIds = useRef<{ approval?: string; refund?: string }>({})

    async function save(payload: Record<string, unknown>, reset?: "approval" | "receipt" | "refund") {
        setError("")
        try {
            await request(order, payload)
            if (reset === "approval") { requestIds.current.approval = undefined; setReason(""); setQuantities({}) }
            if (reset === "receipt") { setInspected(false); setRestock({}); setWaybill("") }
            if (reset === "refund") { requestIds.current.refund = undefined; setRefundReference(""); setRefundReason(""); setCompleted(false); setRefundAmount("") }
        } catch (failure) { setError(failure instanceof Error ? failure.message : "Not saved. Please try again.") }
    }

    function approve(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        const items = order.items.filter(item => item.id && quantities[item.id] > 0).map(item => ({ itemId: item.id!, quantity: quantities[item.id!] }))
        if (!items.length) { setError("Choose at least one item to return."); return }
        requestIds.current.approval ||= crypto.randomUUID()
        void save({ action: "approve_return", requestId: requestIds.current.approval, reason, items }, "approval")
    }

    function refund(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        if (!completed) { setError("First complete the refund in PayFast."); return }
        requestIds.current.refund ||= crypto.randomUUID()
        const payload = { action: "record_refund", requestId: requestIds.current.refund, completedInPayFast: true, amount: Number(refundAmount).toFixed(2), reference: refundReference, reason: refundReason, refundedAt: refundDate }
        confirm({ title: "Record completed refund?", description: `Record ${courierMoney.format(Number(refundAmount))} for ${order.id}, reference ${refundReference}? This records your confirmation and submits a customer email. It does not transfer money or refund again.`, run: () => { void save(payload, "refund") } })
    }

    return <details className="mm-admin__technical mm-admin__aftersales" open={active || sales.canRecordRefund ? true : undefined}>
        <summary>Returns &amp; refunds{active ? " · Return in progress" : sales.refundedTotal > 0 ? ` · ${courierMoney.format(sales.refundedTotal)} refunded` : ""}</summary>
        <p className="mm-admin__helper">Manage an approved return or record a refund here. Booking a waybill and refunding the payment are separate actions.</p>
        {order.payment?.environment === "sandbox" ? <p className="mm-admin__notice">Sandbox payment: use sandbox PayFast and Bob Go only. No real money was collected.</p> : null}
        {error ? <p className="mm-admin__notice" role="alert">{error}</p> : null}
        {sales.canStartReturn ? <form className="mm-admin__aftersales-form" onSubmit={approve}>
            <h3>Approve a return</h3>
            <p className="mm-admin__helper">Agree the return with the customer first, then select the items. Stock and payment are unchanged at this step.</p>
            <label className="mm-admin__field">Reason for return<textarea required minLength={3} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>
            {order.items.filter(item => item.id && (item.returnableQuantity || 0) > 0).map(item => <label className="mm-admin__field" key={item.id}>{item.name} · {item.variant} — quantity to return<input type="number" min={0} max={item.returnableQuantity} step={1} value={quantities[item.id!] || 0} onChange={event => setQuantities(current => ({ ...current, [item.id!]: Number(event.target.value) }))} /></label>)}
            <button className="mm-admin__secondary-button" type="submit" disabled={loading}>Approve return</button>
        </form> : null}
        {active ? <section className="mm-admin__aftersales-section" aria-label="Current return">
            <h3>{active.status === "approved" ? "Arrange the return" : "Waiting for returned items"}</h3>
            <p>{active.reason}</p>
            {active.status === "approved" ? <>
                <p className="mm-admin__helper">Book the return in Bob Go using the customer’s pickup address and Zarina’s private return address. Check the parcel and courier charge there. This portal does not book or pay for a return waybill.</p>
                <a className="mm-admin__secondary-button" href={order.payment?.environment === "sandbox" ? "https://sandbox.bobgo.co.za/" : "https://app.bobgo.co.za/"} target="_blank" rel="noopener noreferrer">Open Bob Go to book return</a>
                <form className="mm-admin__aftersales-form" onSubmit={event => { event.preventDefault(); void save({ action: "return_waybill", returnId: active.id, reference: waybill }) }}>
                    <label className="mm-admin__field">Booked return waybill reference<input required minLength={3} maxLength={100} value={waybill} onChange={event => setWaybill(event.target.value)} /></label>
                    <button className="mm-admin__secondary-button" type="submit" disabled={loading}>Save return waybill</button>
                </form>
            </> : <p>Return waybill: <strong>{active.waybillReference}</strong>. Save receipt only when the parcel actually arrives.</p>}
            <form className="mm-admin__aftersales-form" onSubmit={event => { event.preventDefault(); if (!inspected) return; void save({ action: "receive_return", returnId: active.id, inspected: true, restock: active.items.map(item => ({ itemId: item.itemId, quantity: restock[item.itemId] || 0 })) }, "receipt") }}>
                <h3>Receive &amp; inspect</h3>
                <p className="mm-admin__helper">Only add items in resaleable condition back to stock. Leave damaged or worn items at zero.</p>
                {active.items.map(returned => {
                    const item = order.items.find(row => row.id === returned.itemId)
                    const max = Math.min(returned.quantity, item?.restockableQuantity || 0)
                    return <label className="mm-admin__field" key={returned.itemId}>{item?.name || "Returned item"} · {item?.variant} — {returned.quantity} expected<input type="number" aria-label={`Restock quantity for ${item?.name || "item"} ${item?.variant || ""}`} min={0} max={max} step={1} disabled={max === 0} value={restock[returned.itemId] || 0} onChange={event => setRestock(current => ({ ...current, [returned.itemId]: Number(event.target.value) }))} /><span className="mm-admin__helper">{max > 0 ? "Quantity inspected and suitable for resale" : "No recorded stock deduction to reverse. Record receipt, then review stock in Products."}</span></label>
                })}
                <label className="mm-admin__checkbox"><input type="checkbox" required checked={inspected} onChange={event => setInspected(event.target.checked)} />I have received all agreed items and checked their condition.</label>
                <button className="mm-admin__button" type="submit" disabled={loading || !inspected}>Save received items</button>
            </form>
        </section> : null}
        {sales.returns.filter(record => record.status === "received").map(record => <section className="mm-admin__aftersales-section" key={record.id}><strong>Return received{record.receivedAt ? ` · ${aftersalesDate(record.receivedAt)}` : ""}</strong><p>{record.reason}</p><p>{record.items.reduce((sum, item) => sum + item.restocked, 0)} item(s) restored to stock.{record.waybillReference ? ` Return waybill: ${record.waybillReference}.` : ""}</p></section>)}
        {sales.canRecordRefund ? <form className="mm-admin__aftersales-form" onSubmit={refund}>
            <h3>Record a completed refund</h3>
            <p>Remaining refundable amount: <strong>{courierMoney.format(sales.remainingRefundable)}</strong></p>
            <p className="mm-admin__helper">Refund the customer in PayFast first. Only record it here once PayFast confirms completion. A partial refund does not mark the entire payment as refunded.</p>
            <a className="mm-admin__secondary-button" href={order.payment?.environment === "sandbox" ? "https://sandbox.payfast.co.za/" : "https://my.payfast.io/"} target="_blank" rel="noopener noreferrer">Open PayFast</a>
            <label className="mm-admin__field">Completed refund amount (R)<input required type="number" inputMode="decimal" min={0.01} max={sales.remainingRefundable} step={0.01} value={refundAmount} onChange={event => setRefundAmount(event.target.value)} /></label>
            <label className="mm-admin__field">PayFast refund reference<input required minLength={3} maxLength={100} value={refundReference} onChange={event => setRefundReference(event.target.value)} /></label>
            <label className="mm-admin__field">Refund completed on<input required type="date" max={today} value={refundDate} onChange={event => setRefundDate(event.target.value)} /></label>
            <label className="mm-admin__field">Reason for refund<textarea required minLength={3} maxLength={1000} value={refundReason} onChange={event => setRefundReason(event.target.value)} /></label>
            <label className="mm-admin__checkbox"><input type="checkbox" required checked={completed} onChange={event => setCompleted(event.target.checked)} />PayFast confirms this refund is completed, not only requested.</label>
            <button className="mm-admin__button" type="submit" disabled={loading || !completed}>Record completed refund</button>
        </form> : null}
        {sales.refunds.length > 0 ? <section className="mm-admin__aftersales-section"><h3>Refund history</h3><p>Total recorded: {courierMoney.format(sales.refundedTotal)} · Remaining: {courierMoney.format(sales.remainingRefundable)}</p>{sales.refunds.map(record => <div key={record.id}><strong>{courierMoney.format(record.amount)} · {aftersalesDate(record.refundedAt)}</strong><p>PayFast reference: {record.reference}</p><p>{record.reason}</p></div>)}<p className="mm-admin__helper">These are the refunds Zarina has confirmed, not an automatic PayFast refund-status check. Customer email status appears in Email notifications above.</p></section> : null}
    </details>
}

function deliveryNextStep(order: AdminOrder) {
    if (order.deliveryMethod !== "Courier" || order.paymentStatus !== "Paid" || order.status !== "Ready" || !order.shipping) return null
    const action = order.deliveryDetails?.waybillChange?.action
    if (action === "check_cancellation") return { label: "Check cancellation", guidance: "Check the cancellation below. Delivery stays locked until Bob Go confirms it. Do not book another courier yet." }
    if (action === "prepare_replacement") return { label: "Prepare replacement", guidance: "The old waybill is cancelled. Prepare a replacement below, then check the details and compare fresh courier quotes." }
    if (order.shipping.status === "Cancelled") return { label: "Review cancelled waybill", guidance: "This waybill is cancelled and cannot be reused. Review the delivery options below before changing or rebooking it." }
    if (order.shipping.status === "Booking") return { label: "Check booking status", guidance: "Bob Go has not confirmed the booking yet. Check its status below; do not make another booking." }
    if (order.shipping.status === "Booked") return order.workflow?.nextStatus === null
        ? { label: "Check shipment status", guidance: order.workflow.guidance || "Check the shipment below before dispatching. Bob Go has not confirmed all booking details yet." }
        : { label: "Print & track waybill", guidance: "Print the waybill and attach it to the parcel. Mark dispatched only after courier collection or drop-off." }
    if (order.deliveryDetails?.plan?.collection.kind === "door" && collectionScheduleProblem(order.deliveryDetails.plan.collectionSchedule, true)) return { label: "Choose collection date / time", guidance: "Choose this parcel’s requested collection date and available hours in the delivery section, then compare fresh courier quotes." }
    return { label: order.deliveryDetails?.plan ? "Continue delivery setup" : "Set up delivery", guidance: "Check the addresses, choose your box and weigh the sealed parcel. Compare couriers, then choose a service and review its cost before booking." }
}

function ShippingPanel({ order, loading, connection, requestShipping, confirm }: {
    order: AdminOrder; loading: boolean; connection?: Snapshot["bobGoConnection"]; requestShipping: ShippingRequest; confirm: (value: Confirmation) => void
}) {
    const shipping = order.shipping!
    const [parcel, setParcel] = useState({ weightGrams: String(shipping.weightGrams || ""), lengthCm: String(shipping.lengthCm || (shipping.status === "Booked" || shipping.status === "Booking" ? "" : movingModestyBoxPreset.lengthCm)), widthCm: String(shipping.widthCm || (shipping.status === "Booked" || shipping.status === "Booking" ? "" : movingModestyBoxPreset.widthCm)), heightCm: String(shipping.heightCm || (shipping.status === "Booked" || shipping.status === "Booking" ? "" : movingModestyBoxPreset.heightCm)) })
    const [measured, setMeasured] = useState(false)
    const [quote, setQuote] = useState<(ShippingResult & { deliveryRevision?: number }) | null>(null)
    const [quoteIndex, setQuoteIndex] = useState(0)
    const [waybill, setWaybill] = useState("")
    const [editingDelivery, setEditingDelivery] = useState(false)
    const [reviewDetails, setReviewDetails] = useState(false)
    const [error, setError] = useState("")
    const [changingCollection, setChangingCollection] = useState(false)
    const homeCollection = useRef(order.deliveryDetails?.plan?.collection.kind === "door" ? {
        endpoint: order.deliveryDetails.plan.collection, schedule: order.deliveryDetails.plan.collectionSchedule,
    } : null)
    const pending = shipping.status === "Booking"
    const booked = shipping.status === "Booked"
    const cancellationPending = order.deliveryDetails?.waybillChange?.action === "check_cancellation"
    const liveBookingForTest = connection?.environment === "production" && order.payment?.environment === "sandbox"
    const scheduleProblem = order.deliveryDetails?.plan?.collection.kind === "door" ? collectionScheduleProblem(order.deliveryDetails.plan.collectionSchedule, true) : ""
    const canQuote = !editingDelivery && !liveBookingForTest && order.paymentStatus === "Paid" && order.status === "Ready" && !pending && !booked && shipping.status !== "Cancelled" && Boolean(connection?.enabled && (connection.configured || order.deliveryDetails?.plan))
    const currentQuote = quote?.deliveryRevision === order.deliveryDetails?.revision ? quote : null
    const rate = currentQuote?.rates?.[quoteIndex]
    const cancelled = shipping.status === "Cancelled" || order.deliveryDetails?.waybillChange?.action === "prepare_replacement"
    const progressStep = cancelled || cancellationPending || editingDelivery || reviewDetails || !booked && !pending && Boolean(scheduleProblem) ? 1 : booked ? 4 : pending || changingCollection ? 3 : order.deliveryDetails && !order.deliveryDetails.plan ? 1 : rate ? 3 : 2
    const quoteHintId = useId()
    const collectionChoiceStyle = (selected: boolean): CSSProperties => ({ minHeight: 48, whiteSpace: "normal", textAlign: "left", lineHeight: 1.4,
        ...(selected ? { background: "var(--mm-soft)", boxShadow: "inset 3px 0 var(--mm-sage)", borderColor: "var(--mm-sage)" } : {}) })
    const missingMeasurements = Object.entries(parcel).some(([key, value]) => {
        const amount = Number(value)
        return !Number.isFinite(amount) || amount < (key === "weightGrams" ? 1 : 0.01) || amount > (key === "weightGrams" ? 30000 : 150) || key === "weightGrams" && !Number.isInteger(amount)
    })

    async function run(action: "quote" | "book" | "refresh" | "waybill", payload: Record<string, unknown> = {}, sourceOrder = order) {
        startTransition(() => setError(""))
        try {
            const result = await requestShipping(sourceOrder, action, payload)
            if (action === "quote" && !result.rates?.length) throw new Error("No courier services found. Check the address, pickup point and parcel, then try again.")
            startTransition(() => {
                if (action === "quote") { setQuote({ ...result, deliveryRevision: sourceOrder.deliveryDetails?.revision }); setQuoteIndex(0) }
                if (action === "book") setQuote(null)
                if (action === "waybill" && result.url) setWaybill(result.url)
            })
        } catch (caught) {
            startTransition(() => { setError(caught instanceof Error ? caught.message : "Courier request failed."); if (action === "book") setQuote(null) })
        }
    }
    async function compareCollection(endpoint: CourierEndpoint, schedule?: CollectionSchedule) {
        const details = order.deliveryDetails
        if (!details?.plan || !details.canEdit || loading || changingCollection || booked || pending || cancelled) return
        if (details.plan.delivery.kind !== "door") { setError("Confirm the customer’s home delivery address before comparing couriers."); return }
        if (!currentQuote?.expires || currentQuote.expires <= Date.now()) { setError("These prices expired. Compare couriers again."); setQuote(null); return }
        if (details.plan.collection.kind === "door") homeCollection.current = { endpoint: details.plan.collection, schedule: details.plan.collectionSchedule }
        setChangingCollection(true); setQuote(null); setError("")
        try {
            const saved = await requestShipping(order, "save_delivery", { action: "delivery", expectedRevision: details.revision,
                plan: { ...details.plan, collection: endpoint, collectionSchedule: endpoint.kind === "door" ? schedule : undefined,
                    delivery: details.plan.delivery, customerApprovedPickup: false }, confirmed: true, rememberCollection: false })
            if (!saved.order || saved.order.deliveryDetails?.revision === details.revision) throw new Error("Collection details saved. Refresh the order and compare couriers again.")
            await run("quote", { parcel: Object.fromEntries(Object.entries(parcel).map(([key, value]) => [key, Number(value)])), additionalCover: false }, saved.order)
        } catch (caught) { setError(caught instanceof Error ? caught.message : "Collection could not be changed. Refresh and compare again.") }
        finally { setChangingCollection(false) }
    }
    function book() {
        if (!rate || !quote?.expires || quote.expires <= Date.now()) { setError("This quote expired. Get a new quote."); setQuote(null); return }
        const plan = order.deliveryDetails?.plan
        const endpointLabel = (endpoint: CourierEndpoint) => endpoint.kind === "pickup_point" ? endpoint.point.name
            : [endpoint.address.line1, endpoint.address.line2, endpoint.address.suburb, endpoint.address.city, endpoint.address.province, endpoint.address.postalCode].filter(Boolean).join(", ")
        const routeDescription = plan ? `${plan.collection.kind === "door" ? "Courier collection from" : "Drop-off at"} ${endpointLabel(plan.collection)}. ${plan.delivery.kind === "door" ? "Delivery to" : "Customer collection at"} ${endpointLabel(plan.delivery)}.${plan.collection.kind === "door" && plan.collectionSchedule ? ` Requested collection: ${collectionScheduleLabel(plan.collectionSchedule)}. This is not a guaranteed appointment.` : ""}`
            : `Drop-off at ${shipping.senderLocationName}, delivery to ${order.address}.`
        confirm({ title: quote.environment === "production" ? "Confirm LIVE courier booking" : "Confirm sandbox booking",
            confirmLabel: `Book waybill · ${courierMoney.format(rate.amount)}`,
            description: `${order.id}: ${rate.providerName} · ${rate.serviceName} (${rate.serviceCode}), quoted ${courierMoney.format(rate.amount)}. Parcel ${parcel.lengthCm} × ${parcel.widthCm} × ${parcel.heightCm} cm, ${parcel.weightGrams} g. ${routeDescription} ${quote.declaredValue ? `Declared-value cover requested for ${courierMoney.format(quote.declaredValue)}; courier terms apply.` : "No additional declared-value cover requested; only the courier's standard terms apply."} ${quote.environment === "production" ? "This creates a real waybill and may charge Zarina's Bob Go account. Final courier charges can differ from the quote." : "Sandbox test only."} Booking the courier does not charge the customer again.`,
            run: () => { void run("book", { quoteToken: rate.quoteToken }) } })
    }
    const deliveryEditor = order.deliveryDetails ? <EmbeddedDeliveryEditor key={order.deliveryDetails.revision} guided details={order.deliveryDetails} disabled={loading || changingCollection}
        onContinue={() => setReviewDetails(false)}
        onEditingChange={editing => { setEditingDelivery(editing); setReviewDetails(editing); setQuote(null); setMeasured(false) }}
        changeWaybill={async payload => { setQuote(null); setMeasured(false); setWaybill(""); await requestShipping(order, payload.action as Parameters<ShippingRequest>[1], payload) }}
        save={async payload => { await requestShipping(order, "save_delivery", payload) }}
        searchPoints={async query => { const result = await requestShipping(order, "pickup_points", { query }); return { points: result.points || [], limited: result.limited } }} /> : null
    return <Detail title="Arrange delivery">
        {liveBookingForTest ? <p role="alert">This is a test payment. Live courier booking is blocked so it cannot create a real charge.</p> : null}
        <p><strong>{shipping.environment === "production" ? "LIVE" : "SANDBOX"}</strong> · Status: {shipping.status}</p>
        <EmbeddedDeliveryProgress current={progressStep} paused={cancelled || cancellationPending} />
        {!order.deliveryDetails ? <p>Drop-off: {shipping.senderLocationName} · Deliver to the customer's door.</p> : null}
        <EmbeddedDeliveryStepFlow current={progressStep} locked={booked || pending || cancelled || cancellationPending || loading || changingCollection} onReview={step => { setReviewDetails(step === 1); setQuote(null); setMeasured(false) }}>
        {deliveryEditor}
        {canQuote && (!order.deliveryDetails || order.deliveryDetails.plan) ? <div>
            <EmbeddedParcelEditor value={parcel} disabled={loading} change={value => { setParcel(value); setMeasured(false); setQuote(null) }}
                loadPackages={async () => { const result = await requestShipping(order, "packages"); return result.packages || [] }} />
            <label className="mm-admin__courier-check"><input type="checkbox" checked={measured} disabled={loading} onChange={event => { setMeasured(event.target.checked); setQuote(null) }} />Dimensions and packed weight checked.</label>
            <p id={quoteHintId} className="mm-admin__helper mm-delivery__action-hint">{loading ? "Please wait." : scheduleProblem || (missingMeasurements ? "Enter valid box dimensions and a packed weight (1–30,000 g)." : !measured ? "Tick to confirm the parcel." : "Comparing prices does not book a courier.")}</p>
            <div className="mm-delivery__step-actions"><button type="button" className="mm-admin__button mm-delivery__primary-action" aria-describedby={quoteHintId} disabled={loading || !measured || missingMeasurements || Boolean(scheduleProblem)} onClick={() => { setQuote(null); void run("quote", { parcel: Object.fromEntries(Object.entries(parcel).map(([key, value]) => [key, Number(value)])), additionalCover: false }) }}>{loading ? "Comparing…" : "Compare couriers"}</button></div>
        </div> : null}
        <div>{pending ? <><p>Waiting for Bob Go to confirm the booking. Don’t book again.</p><button type="button" className="mm-admin__button mm-delivery__primary-action" disabled={loading} onClick={() => { void run("refresh") }}>Check shipment status</button></> : changingCollection ? <p role="status">Comparing prices for the new collection method… No waybill is being booked.</p> : rate ? <div className="mm-admin__quote">
            <h4>3. Choose a courier</h4>
            {currentQuote?.collectionDropOff && order.deliveryDetails?.plan ? <div className="mm-delivery__method-choices" role="group" aria-label="How Zarina sends the parcel" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 8, marginBottom: 4, minWidth: 0 }}>
                <button type="button" className="mm-admin__secondary-button" style={collectionChoiceStyle(order.deliveryDetails.plan.collection.kind === "door")} aria-pressed={order.deliveryDetails.plan.collection.kind === "door"} disabled={loading || !order.deliveryDetails.canEdit}
                    onClick={() => { if (order.deliveryDetails?.plan?.collection.kind === "door") return; const saved = homeCollection.current; if (saved) void compareCollection(saved.endpoint, saved.schedule); else { setQuote(null); setReviewDetails(true) } }}>Courier collects from Zarina</button>
                <button type="button" className="mm-admin__secondary-button" style={collectionChoiceStyle(order.deliveryDetails.plan.collection.kind === "pickup_point")} aria-pressed={order.deliveryDetails.plan.collection.kind === "pickup_point"} disabled={loading || !order.deliveryDetails.canEdit}
                    onClick={() => { if (order.deliveryDetails?.plan?.collection.kind === "pickup_point") return; const contact = order.deliveryDetails?.plan?.collection.contact, point = currentQuote.collectionDropOff; if (contact && point) void compareCollection({ kind: "pickup_point", contact, point }) }}>Locker drop-off · {currentQuote.collectionDropOff.name}</button>
            </div> : null}
            <p className="mm-admin__helper">{order.deliveryDetails?.plan?.collection.kind === "pickup_point" ? "Zarina takes the parcel to the locker." : "The courier collects from Zarina’s address."} Both options deliver to the customer’s home.</p>
            <label className="mm-admin__field">Courier and service<select value={quoteIndex} disabled={loading} onChange={event => setQuoteIndex(Number(event.target.value))}>{quote?.rates?.map((option, index) => <option value={index} key={`${option.providerName}-${option.serviceCode}-${index}`}>{option.providerName} · {option.serviceName} · {courierMoney.format(option.amount)}</option>)}</select></label>
            <p><strong>Courier cost: {courierMoney.format(rate.amount)}</strong></p>
            <p className="mm-admin__helper">Paid by Zarina to Bob Go. Customer paid {order.deliveryFee === undefined ? "delivery at checkout" : order.deliveryFee === 0 ? "no delivery fee" : money.format(order.deliveryFee) + " delivery"}.</p>
            <details className="mm-admin__technical"><summary>Quote details</summary><p className="mm-admin__helper">All available services returned by Bob Go are shown. Locker choices may limit couriers. Quotes expire after 10 minutes; final courier charges can vary. Standard courier liability only; no additional cover is requested.</p></details>
            <button type="button" className="mm-admin__button mm-delivery__primary-action" disabled={loading} onClick={book}>Review booking · {courierMoney.format(rate.amount)}</button>
        </div> : null}</div>
        <div><h4>4. Print & track</h4>
            {shipping.trackingNumber ? <p>Waybill: <strong>{shipping.trackingNumber}</strong></p> : null}
            <p>{shipping.courierName || "Courier details awaiting confirmation"}{shipping.serviceName || shipping.serviceLevelCode ? ` · ${shipping.serviceName || shipping.serviceLevelCode}` : ""}</p>
            <div className="mm-admin__actions mm-admin__courier-actions">
                {!waybill ? <button type="button" className="mm-admin__button mm-delivery__primary-action" disabled={loading} onClick={() => { void run("waybill") }}>Prepare printable waybill</button> : <a className="mm-admin__button mm-admin__button-link mm-delivery__primary-action" href={waybill} target="_blank" rel="noopener noreferrer">Print waybill PDF</a>}
                <button type="button" className="mm-admin__secondary-button" disabled={loading} onClick={() => { void run("refresh") }}>Check shipment status</button>
                {shipping.trackingUrl ? <a href={shipping.trackingUrl} target="_blank" rel="noopener noreferrer">Track parcel</a> : null}
            </div>
            {shipping.courierStatus ? <p>Courier status: <strong>{shipping.courierStatus.replaceAll("-", " ")}</strong></p> : null}
            <p className="mm-admin__helper">{order.status === "Dispatched" || order.status === "Delivered" ? "Handed to the courier. Track progress above." : "Attach the waybill. Mark Dispatched after collection or drop-off to send customer tracking."}</p>
            {deliveryEditor ? <details className="mm-admin__technical"><summary>Delivery details & changes</summary>{deliveryEditor}</details> : null}
        </div>
        </EmbeddedDeliveryStepFlow>
        {shipping.lastError ? <p role="status">{shipping.lastError}</p> : null}
        {editingDelivery ? <p>Save or cancel delivery editing before getting a fresh courier quote.</p> : shipping.status === "Cancelled" ? !order.deliveryDetails?.waybillChange ? <p>This cancelled waybill cannot be reused. Check its delivery options above before getting new quotes.</p> : null : !canQuote && !booked && !pending ? <p>Booking requires a paid delivery order marked Ready and a configured courier connection.</p> : null}
        {!booked && !pending && shipping.blockers.length ? <details className="mm-admin__technical"><summary>What is still needed?</summary><ul className="mm-admin__blockers">{shipping.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul></details> : null}
        {order.bobGoSync ? <EmbeddedDeliveryAdvancedSettings needsAttention={order.bobGoSync.status === "Needs attention"}><EmbeddedOrderSyncStatus value={order.bobGoSync} /></EmbeddedDeliveryAdvancedSettings> : null}
        {error ? <p className="mm-admin__error" role="alert">{error}</p> : null}
    </Detail>
}

function Detail({ title, children }: { title: string; children: ReactNode }) {
    return <section className="mm-admin__detail-block"><h3>{title}</h3>{children}</section>
}

function ProductsView({ apiBaseUrl, liveEnabled }: { apiBaseUrl: string; liveEnabled: boolean }) {
    if (liveEnabled) return <LiveCatalogueEditor apiBaseUrl={apiBaseUrl} live />
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
.mm-admin__aftersales-form, .mm-admin__aftersales-section { display: grid; gap: 12px; margin: 20px 0; min-width: 0; }
.mm-admin__aftersales h3, .mm-admin__aftersales p { margin: 0; }
.mm-admin__aftersales-form .mm-admin__field input, .mm-admin__aftersales-form .mm-admin__field textarea { width: 100%; min-width: 0; box-sizing: border-box; }
.mm-admin__aftersales button, .mm-admin__aftersales a { justify-self: start; max-width: 100%; white-space: normal; }
.mm-admin__aftersales .mm-admin__checkbox { display: flex; align-items: flex-start; gap: 10px; line-height: 1.5; }
.mm-admin__aftersales .mm-admin__checkbox input { width: 18px; height: 18px; flex: 0 0 18px; margin: 3px 0 0; }
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
.mm-admin__button { appearance: none; min-height: 44px; border: 0; border-radius: 0; background: #536047; color: #fff !important; cursor: pointer; font-weight: 700; padding: 13px 20px; transition: opacity .18s ease; }
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
.mm-admin__cms-link { display: inline-flex; min-height: 48px; align-items: center; margin-top: 12px; padding: 13px 18px; background: #536047; color: #fff; font-weight: 700; text-decoration: none; }
.mm-admin__muted-label { color: var(--mm-muted); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.mm-admin__filters { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--mm-border); }
.mm-admin__orders-layout { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: 24px; }
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
.mm-admin__password-field { position: relative; width: 100%; }
.mm-admin__password-field input { padding-right: 60px; }
.mm-admin__password-toggle { position: absolute; top: 2px; right: 4px; display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--mm-ink); cursor: pointer; }
.mm-admin__password-toggle:hover { background: color-mix(in srgb, var(--mm-ink) 6%, transparent); }
.mm-admin__password-toggle:focus-visible { outline: 2px solid var(--mm-sage); outline-offset: -2px; }
.mm-admin__password-field input::-ms-reveal, .mm-admin__password-field input::-ms-clear { display: none; }
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
        options: ["login", "dashboard", "orders", "products", "discounts"],
        optionTitles: ["Login", "Dashboard", "Orders", "Products", "Discounts"],
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

// BEGIN GENERATED PRODUCT EDITOR
type CatalogueDocument = {
  name: string; slug: string; description: string; tagline?: string; productDetails?: string;
  fabricMaterials?: string; benefits?: string; fabricWeight?: string; dimensions?: string; careInstructions?: string; deliveryReturns?: string; category: string;
  homepageImage: { url: string; alt: string }; showOnHomepage: boolean; homepageOrder: number;
  colours: Array<{ id: string; name: string; available: boolean; photos: Array<{ url: string; alt: string }>;
    variants: Array<{ id: string; size: string; price: number; stock: number; stockVerified?: boolean; available: boolean }> }>;
};
type CatalogueEditorErrors = Record<string, string>;
type CatalogueColour = CatalogueDocument["colours"][number];
function productAddress(name: string, used: string[] = []) {
  let base = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 140).replace(/-$/, "") || "product";
  if (base.length === 1) base += "-product";
  let address = base;
  for (let suffix = 2; used.includes(address); suffix++) address = `${base}-${suffix}`;
  return address;
}

function productSizes(document: CatalogueDocument) {
  return [...new Set(document.colours.flatMap(colour => colour.variants.map(entry => entry.size)))];
}
function usualProductPrice(document: CatalogueDocument) {
  const counts = new Map<number, number>();
  for (const colour of document.colours) for (const entry of colour.variants) counts.set(entry.price, (counts.get(entry.price) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}
// Shared edits preserve identifiers, stock and any deliberately different price.
function changeUsualPrice(document: CatalogueDocument, previous: number, price: number): CatalogueDocument {
  return { ...document, colours: document.colours.map(colour => ({ ...colour,
    variants: colour.variants.map(entry => entry.price === previous ? { ...entry, price } : entry) })) };
}
function addProductSize(document: CatalogueDocument, size: string, price: number): CatalogueDocument {
  return { ...document, colours: document.colours.map(colour => ({ ...colour,
    variants: [...colour.variants, { id: crypto.randomUUID(), size, price, stock: 0, stockVerified: true, available: true }] })) };
}
function renameProductSize(document: CatalogueDocument, previous: string, size: string, position?: number): CatalogueDocument {
  return { ...document, colours: document.colours.map(colour => ({ ...colour,
    variants: colour.variants.map((entry, index) => entry.size === previous && (position === undefined || position === index) ? { ...entry, size } : entry) })) };
}
function newProductColour(sizes: string[], price: number): CatalogueColour {
  return { id: crypto.randomUUID(), name: "", available: true, photos: [],
    variants: sizes.map(size => ({ id: crypto.randomUUID(), size, price, stock: 0, stockVerified: true, available: true })) };
}
function withProductColours(document: CatalogueDocument, colours: CatalogueColour[]): CatalogueDocument {
  const photos = colours.flatMap(colour => colour.photos);
  const wasColourPhoto = document.colours.some(colour => colour.photos.some(photo => photo.url === document.homepageImage.url));
  const removed = wasColourPhoto && !photos.some(photo => photo.url === document.homepageImage.url);
  return { ...document, colours, homepageImage: !document.homepageImage.url || removed ? (photos[0] || { url: "", alt: "" }) : document.homepageImage };
}
function catalogueEditorErrors(document: CatalogueDocument, demo = false): CatalogueEditorErrors {
  void demo;
  const errors: CatalogueEditorErrors = {};
  if (document.name.trim().length < 2) errors.name = "Enter a product name.";
  document.colours.forEach((colour, i) => {
    if (!colour.name.trim()) errors[`colours.${i}.name`] = "Enter a colour name.";
    colour.variants.forEach((variant, j) => {
      const path = `colours.${i}.variants.${j}`;
      if (!variant.size.trim()) errors[`${path}.size`] = "Enter a size name.";
      if (!Number.isFinite(variant.price) || variant.price <= 0) errors[`${path}.price`] = "Enter a price greater than zero.";
      if (!Number.isInteger(variant.stock) || variant.stock < 0) errors[`${path}.stock`] = "Enter a whole stock quantity.";
    });
  });
  return errors;
}
function variantAvailable(entry: CatalogueColour["variants"][number]) {
  return entry.available && (entry.stock > 0 || entry.stockVerified === false);
}
function productAvailability(document: CatalogueDocument) {
  if (!document.colours.some(colour => colour.available && colour.variants.some(entry => entry.available))) return "Unavailable";
  return document.colours.some(colour => colour.available && colour.variants.some(variantAvailable)) ? "Available" : "Out of stock";
}
type CatalogueDraft = { id?: string; revision: number; cmsVersion?: string; stockVersion?: string; publishedRevision?: number; publicationState?: string; publicationError?: string; pageUrl?: string; document: CatalogueDocument };
type CatalogueEditorProps = { demo?: boolean; initialProducts?: CatalogueDraft[]; apiBaseUrl?: string; framerTrial?: boolean; live?: boolean };

const catalogueMoney = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" });
const catalogueStages = ["Product details", "Colours & photos", "Preview"];

function newDocument(): CatalogueDocument {
  return { name: "", slug: "product", description: "", category: "Active hijabs", homepageImage: { url: "", alt: "" },
    showOnHomepage: true, homepageOrder: 0, colours: [newProductColour(["One size fits all"], 0)] };
}
function fieldAttributes(path: string, errors: CatalogueEditorErrors) {
  const describedBy = [path === "usualPrice" ? "hint-usualPrice" : "", errors[path] ? `error-${path.replaceAll(".", "-")}` : ""].filter(Boolean).join(" ");
  return { id: `product-${path.replaceAll(".", "-")}`, "aria-invalid": !!errors[path],
    "aria-describedby": describedBy || undefined };
}
function CatalogueField({ label, path, errors, hint, children }: { label: string; path: string; errors: CatalogueEditorErrors; hint?: string; children: ReactNode }) {
  return <div className="mm-products__field">
    <label htmlFor={`product-${path.replaceAll(".", "-")}`}>{label}</label>{children}{hint && <small id={`hint-${path.replaceAll(".", "-")}`}>{hint}</small>}
    {errors[path] && <small className="mm-products__field-error" id={`error-${path.replaceAll(".", "-")}`}>{errors[path]}</small>}
  </div>;
}

function LiveCatalogueEditor({ demo = false, initialProducts = [], apiBaseUrl = "", framerTrial = false, live = false }: CatalogueEditorProps) {
  const [products, setProducts] = useState<CatalogueDraft[]>(initialProducts);
  const [current, setCurrent] = useState<CatalogueDraft | null>(null);
  const [step, setStep] = useState(0);
  const [preview, setPreview] = useState(false);
  const [usualPrice, setUsualPrice] = useState("");
  const [errors, setErrors] = useState<CatalogueEditorErrors>({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!demo);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const saving = useRef(false);
  const focusErrors = useRef(false);
  const inputFile = useRef<HTMLInputElement>(null);
  const pendingColour = useRef<string | null>(null);
  const objectUrls = useRef<string[]>([]);
  const editor = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const base = apiBaseUrl.replace(/\/$/, "");
  const endpoint = live ? "/api/admin/product-catalogue" : framerTrial ? "/api/product-trial/framer" : "/api/admin/catalogue";
  const isNew = current !== null && !current.id;
  const document = current?.document;

  const headers = useCallback((): Record<string, string> => {
    if (framerTrial) return { "Content-Type": "application/json" };
    return { "Content-Type": "application/json", Authorization: `Bearer ${window.sessionStorage.getItem("moving_modesty_admin_token") || ""}` };
  }, [framerTrial]);
  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    fetch(`${base}${endpoint}`, { headers: headers(), signal: controller.signal, cache: "no-store" })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Products could not be loaded."); return data; })
      .then(data => { setProducts(data.products); setNeedsSetup(data.needsSetup === true); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, demo, endpoint, headers]);
  useEffect(() => () => objectUrls.current.forEach(url => URL.revokeObjectURL(url)), []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => { heading.current?.focus(); heading.current?.scrollIntoView({ block: "start" }); }, [step, current?.id, isNew, preview]);
  useEffect(() => {
    if (!focusErrors.current) return;
    focusErrors.current = false;
    const field = editor.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (field) {
      for (let parent = field.parentElement; parent; parent = parent.parentElement) if (parent.tagName === "DETAILS") (parent as HTMLDetailsElement).open = true;
      field.focus();
    }
  }, [errors]);

  function select(product: CatalogueDraft | null) {
    if (dirty && !window.confirm("Leave without saving your changes?")) return;
    setCurrent(product ? structuredClone(product) : { revision: 0, document: newDocument() });
    const price = product ? usualProductPrice(product.document) : 0;
    setUsualPrice(price ? String(price) : ""); setStep(0); setPreview(false); setDirty(false);
    setErrors({}); setNotice(""); setError("");
  }
  function replace(document: CatalogueDocument) {
    setCurrent(previous => previous && { ...previous, document }); setDirty(true); setNotice("");
    const remaining = catalogueEditorErrors(document, demo);
    setErrors(previous => Object.fromEntries(Object.entries(previous).filter(([path]) =>
      path === "usualPrice" || (path === "description" && !document.description.trim()) || remaining[path])));
  }
  function patch(values: Partial<CatalogueDocument>) { if (document) replace({ ...document, ...values }); }
  function changeColour(id: string, change: (colour: CatalogueColour) => CatalogueColour) {
    if (document) replace(withProductColours(document, document.colours.map(colour => colour.id === id ? change(colour) : colour)));
  }
  function rename(name: string) { patch({ name, ...(isNew ? { slug: productAddress(name, products.map(product => product.document.slug)) } : {}) }); }
  function changePrice(value: string) {
    if (document) replace(changeUsualPrice(document, Number(usualPrice), Number(value)));
    setUsualPrice(value);
    const price = Number(value);
    if (value && Number.isFinite(price) && price > 0 && price <= 100000 && Math.abs(price * 100 - Math.round(price * 100)) < 0.00001) {
      setErrors(previous => Object.fromEntries(Object.entries(previous).filter(([path]) => path !== "usualPrice")));
    }
  }
  function next() {
    if (!document) return;
    let found = catalogueEditorErrors(document, demo);
    if (step === 0) {
      found = Object.fromEntries(Object.entries(found).filter(([path]) => ["name", "slug", "description"].includes(path) || path.endsWith(".size")));
      const price = Number(usualPrice);
      if (!usualPrice || !Number.isFinite(price) || price <= 0 || price > 100000 || Math.abs(price * 100 - Math.round(price * 100)) > 0.00001) found.usualPrice = "Enter a price between R0.01 and R100,000, with no more than two decimal places.";
      if (!document.description.trim()) found.description = "Add a short description of your product.";
    }
    focusErrors.current = true; setErrors(found); setError("");
    if (Object.keys(found).length) return;
    setStep(previous => Math.min(previous + 1, 2));
  }
  async function save(publish = false) {
    if (!current || saving.current) return;
    const found = catalogueEditorErrors(current.document, demo);
    const price = Number(usualPrice);
    if (!usualPrice || !Number.isFinite(price) || price <= 0 || price > 100000 || Math.abs(price * 100 - Math.round(price * 100)) > 0.00001) found.usualPrice = "Enter a price between R0.01 and R100,000, with no more than two decimal places.";
    focusErrors.current = true; setErrors(found); setError(""); setNotice("");
    if (Object.keys(found).length) {
      setPreview(false);
      if (isNew) setStep(Object.keys(found).some(path => ["name", "slug", "description", "usualPrice"].includes(path)) ? 0 : 1);
      return;
    }
    saving.current = true; setBusy(true);
    try {
      let saved: CatalogueDraft;
      if (demo) {
        if (products.some(product => product.document.slug === current.document.slug && product.id !== current.id)) throw new Error("A product with this name already exists. Please use a different name.");
        saved = { ...current, id: current.id || crypto.randomUUID(), revision: current.revision + 1 };
      } else {
        const checked = current.document;
        const response = await fetch(`${base}${endpoint}`, { method: "POST", headers: headers(), body: JSON.stringify({ id: current.id, expectedRevision: current.revision, stockVersion: current.stockVersion, ...(framerTrial ? { expectedCmsVersion: current.cmsVersion } : {}), document: checked }), signal: AbortSignal.timeout(60000) });
        const data = await response.json();
        if (!response.ok) throw new Error(`${data.error || "Your changes could not be saved."}${data.errorRef ? ` Reference: ${data.errorRef}` : ""}`);
        if (framerTrial && (data.cmsSynced !== true || data.published !== false || !data.product?.cmsVersion)) throw new Error("Framer has not confirmed this TEST draft save. Your changes remain here; reload to check CMS before retrying.");
        saved = data.product;
      }
      // Keep the confirmed draft even if publication fails or times out.
      setCurrent(saved); setDirty(false);
      setProducts(previous => previous.some(product => product.id === saved.id) ? previous.map(product => product.id === saved.id ? saved : product) : [...previous, saved]);
      if (publish && live) {
        const response = await fetch(`${base}${endpoint}`, { method: "POST", headers: headers(), body: JSON.stringify({ action: "publish", id: saved.id, expectedRevision: saved.revision }), signal: AbortSignal.timeout(60000) });
        const data = await response.json();
        if (!response.ok || data.published !== true || data.cmsSynced !== true) throw new Error(`${data.error || "Publication could not be verified. Your saved draft is retained."}${data.errorRef ? ` Reference: ${data.errorRef}` : ""}`);
        saved = data.product;
        setProducts(previous => previous.map(product => product.id === saved.id ? saved : product));
      }
      setCurrent(null); setDirty(false); setPreview(false); setStep(0);
      setNotice(publish && live ? `${saved.document.name} published. Its page, collection card and checkout are connected.` : demo ? `${saved.document.name} saved for this demo. Refreshing will reset your changes.` : framerTrial ? "TEST draft saved and verified in Framer. The live website has not changed." : "Draft saved. The live website has not changed.");
    } catch (error) { setError(error instanceof Error ? error.message : "Your changes could not be saved. They are still in the editor."); }
    finally { saving.current = false; setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); if (isNew && step < 2) next(); else void save(live); }
  function leave() {
    if (dirty && !window.confirm("Leave without saving your changes?")) return;
    setCurrent(null); setDirty(false); setPreview(false); setErrors({}); setError(""); setNotice("");
  }
  function addPhotos(colourId: string | null) { pendingColour.current = colourId; inputFile.current?.click(); }
  async function acceptPhotos(files: FileList | null) {
    if (!files || !document) return;
    const selected = Array.from(files);
    if (selected.some(file => !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 4 * 1024 * 1024)) { setError("Choose JPG, PNG or WebP photos under 4 MB each."); return; }
    const colour = document.colours.find(colour => colour.id === pendingColour.current);
    if (colour && colour.photos.length + selected.length > 12) { setError("Each colour can have up to 12 photos. Remove a photo before adding more."); return; }
    const target = pendingColour.current;
    setBusy(true);
    try {
      const photos: Array<{ url: string; alt: string }> = [];
      for (const file of selected) {
        if (!live) { const url = URL.createObjectURL(file); objectUrls.current.push(url); photos.push({ url, alt: file.name }); }
        else {
          const body = new FormData(); body.set("photo", file);
          const response = await fetch(`${base}${endpoint}/photos`, { method: "POST", headers: { Authorization: headers().Authorization }, body, signal: AbortSignal.timeout(60000) });
          const data = await response.json();
          if (!response.ok || !data.photo?.url) throw new Error(data.error || "Photo upload failed.");
          photos.push(data.photo);
        }
      }
      if (target) changeColour(target, colour => ({ ...colour, photos: [...colour.photos, ...photos] }));
      else if (photos[0]) patch({ homepageImage: photos[0] });
      setError("");
    } catch (error) { setError(error instanceof Error ? error.message : "Photo upload failed."); }
    finally { setBusy(false); }
  }
  async function initialize() {
    setBusy(true); setError("");
    try { const response = await fetch(`${base}${endpoint}`, { method: "POST", headers: headers(), body: JSON.stringify({ action: "initialize" }), signal: AbortSignal.timeout(60000) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Existing products could not be connected.");
      setProducts(data.products); setNeedsSetup(false);
    } catch (error) { setError(error instanceof Error ? error.message : "Connection failed."); } finally { setBusy(false); }
  }
  const detailsProps = document && { document, usualPrice, errors, patch, rename, changePrice, replace };
  const colourProps = document && { document, demo: demo || live, errors, changeColour, addPhotos,
    removeColour: (id: string) => { if (document.colours.length > 1) replace(withProductColours(document, document.colours.filter(colour => colour.id !== id))); },
    addColour: () => { if (document.colours.length < 30) replace(withProductColours(document, [...document.colours, newProductColour(productSizes(document), Number(usualPrice))])); } };
  const stockProps = document && { document, demo, errors, changeColour };

  if (framerTrial) return <section className="mm-products" ref={editor}>
    <style dangerouslySetInnerHTML={{ __html: catalogueEditorStyles }} />
    <header className="mm-products__header"><div><p className="mm-products__eyebrow">MOVING MODESTY · UNPUBLISHED TEST</p><h1>Products</h1></div></header>
    <p className="mm-products__notice">Connected TEST draft. Save the name, description and tagline directly to Framer. Nothing is published or saved to live stock.</p>
    {notice && <p className="mm-products__success" role="status">{notice}</p>}
    {error && <p className="mm-products__error" role="alert">{error}</p>}
    {loading ? <p role="status">Loading TEST draft from Framer…</p> : !current ? <div className="mm-products__list">{products.map(product => <article className="mm-products__row" key={product.id}>
      <img src={product.document.homepageImage.url} alt="" />
      <div><h2>{product.document.name}</h2><p>{product.document.colours.length} colours · not for sale</p><span className="mm-products__badge">Framer draft</span></div>
      <button onClick={() => select(product)}>Edit product</button>
    </article>)}</div> : document && <>
      <button className="mm-products__back" disabled={busy} onClick={leave}>← Products</button>
      <div className="mm-products__title"><h2 ref={heading} tabIndex={-1}>Edit TEST product</h2><span>{dirty ? "Unsaved changes" : "Framer draft"}</span></div>
      <form onSubmit={submit} noValidate><fieldset disabled={busy} className="mm-products__form"><div className="mm-products__section">
        <CatalogueField label="Product name" path="name" errors={errors} hint="Keep TEST at the start of the name."><input {...fieldAttributes("name", errors)} value={document.name} onChange={event => rename(event.target.value)} maxLength={200} /></CatalogueField>
        <CatalogueField label="Description" path="description" errors={errors}><textarea {...fieldAttributes("description", errors)} rows={4} value={document.description} onChange={event => patch({ description: event.target.value })} maxLength={10000} /></CatalogueField>
        <CatalogueField label="Collection tagline" path="tagline" errors={errors} hint="Keep UNPUBLISHED TEST in the tagline."><input {...fieldAttributes("tagline", errors)} value={document.tagline ?? ""} onChange={event => patch({ tagline: event.target.value })} maxLength={300} /></CatalogueField>
        <p>Read-only for this first test: {document.colours.map(colour => colour.name).join(" & ")} · {productSizes(document).join(" / ")} · {catalogueMoney.format(usualProductPrice(document))}. Photos, prices, colours and stock are not editable yet.</p>
      </div><footer className="mm-products__footer"><span>Unpublished draft only</span><button className="mm-products__primary" type="submit">{busy ? "Saving…" : "Save draft"}</button></footer></fieldset></form>
    </>}
  </section>;

  return <section className="mm-products" ref={editor}>
    <style dangerouslySetInnerHTML={{ __html: catalogueEditorStyles }} />
    <header className="mm-products__header"><div><p className="mm-products__eyebrow">MOVING MODESTY</p><h1>Products</h1></div>
      {!current && <button className="mm-products__primary" disabled={loading || busy || needsSetup} onClick={() => select(null)}>Add product</button>}</header>
    <p className="mm-products__notice">{live ? "Save a draft while you prepare. Publish when you’re ready for customers to see the changes." : demo ? "Demo only. Changes stay in this window and don’t affect your website." : "Draft trial. Changes are saved as drafts, not published to your website."}</p>
    {notice && <p className="mm-products__success" role="status">{notice}</p>}
    {error && <p className="mm-products__error" role="alert">{error}</p>}
    <input ref={inputFile} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={event => { void acceptPhotos(event.target.files); event.target.value = ""; }} />
    {needsSetup && <div className="mm-products__section"><p>Connect the existing Amina and Hawa products once. Their live pages and stock won’t be changed.</p><button disabled={busy} onClick={() => void initialize()}>{busy ? "Connecting…" : "Connect existing products"}</button></div>}
    {loading ? <p role="status">Loading products…</p> : !current ? <div className="mm-products__list">
      {products.length === 0 && <p>No products yet. Choose Add product to get started.</p>}
      {products.map(product => <article className="mm-products__row" key={product.id}>
        {product.document.homepageImage.url ? <img src={product.document.homepageImage.url} alt="" /> : <span className="mm-products__placeholder">M</span>}
        <div><h2>{product.document.name}</h2><p>{product.document.colours.length} colours</p><span className="mm-products__badge">{live ? product.publicationState !== "idle" ? "Publication needs checking" : product.publishedRevision === product.revision ? "Published" : "Draft changes" : productAvailability(product.document) + (demo ? " · demo" : " · draft")}</span>{product.publicationError && <p role="alert">{product.publicationError}</p>}{live && product.publishedRevision ? <p><a href={product.pageUrl} target="_blank" rel="noreferrer">View product page ↗</a></p> : null}</div>
        <button onClick={() => select(product)}>Edit product</button>
      </article>)}
    </div> : document && <>
      <button className="mm-products__back" disabled={busy} onClick={leave}>← Products</button>
      {isNew && <ol className="mm-products__steps" aria-label="Add product steps">{catalogueStages.map((stage, index) => <li key={stage} aria-current={step === index ? "step" : undefined}><span>{index + 1}</span>{stage}</li>)}</ol>}
      <div className="mm-products__title"><h2 ref={heading} tabIndex={-1}>{isNew ? catalogueStages[step] : preview ? `Preview ${document.name}` : document.name}</h2><span>{dirty ? "Unsaved changes" : demo ? "Demo copy" : "Draft"}</span></div>
      <form onSubmit={submit} noValidate>
        <fieldset disabled={busy} className="mm-products__form">
          {isNew ? step === 0 ? <DetailsFields {...detailsProps!} /> : step === 1 ? <>
            <ColourFields {...colourProps!} />
            <details className="mm-products__accordion" open><summary>Stock & availability</summary><StockFields {...stockProps!} /></details>
          </> : <Preview document={document} demo={demo || live} patch={patch} addPhotos={addPhotos} /> : preview ? <Preview document={document} demo={demo || live} patch={patch} addPhotos={addPhotos} /> : <>
            <p className="mm-products__intro">Choose what you want to change.</p>
            <details className="mm-products__accordion"><summary>Product details <small>Name, description, price & sizes</small></summary><DetailsFields {...detailsProps!} /></details>
            <details className="mm-products__accordion"><summary>Colours & photos <small>Colour names and their images</small></summary><ColourFields {...colourProps!} /></details>
            <details className="mm-products__accordion"><summary>Stock & availability <small>Quantities and what customers can buy</small></summary><StockFields {...stockProps!} /></details>
          </>}
          <footer className="mm-products__footer">
            <div>{isNew && step > 0 ? <button type="button" onClick={() => { setStep(previous => previous - 1); setErrors({}); }}>Back</button> : !isNew && <button type="button" onClick={() => setPreview(!preview)}>{preview ? "Back to editing" : "Preview"}</button>}</div>
            {live && (!isNew || step === 2) && <button type="button" onClick={() => void save(false)}>Save draft</button>}
            <button className="mm-products__primary" type="submit">{busy ? "Working…" : isNew && step < 2 ? "Continue" : live ? "Publish" : demo ? isNew ? "Save demo product" : "Save demo changes" : "Save draft"}</button>
          </footer>
        </fieldset>
      </form>
    </>}
  </section>;
}

type DetailsProps = {
  document: CatalogueDocument; usualPrice: string; errors: CatalogueEditorErrors;
  patch: (values: Partial<CatalogueDocument>) => void; rename: (value: string) => void;
  changePrice: (value: string) => void; replace: (document: CatalogueDocument) => void;
};
function DetailsFields({ document, usualPrice, errors, patch, rename, changePrice, replace }: DetailsProps) {
  // Keep duplicate rows visible during typing so validation can explain and fix them.
  const sizes = document.colours[0].variants.map(entry => entry.size);
  return <div className="mm-products__section">
    <CatalogueField label="Product name" path="name" errors={errors}><input {...fieldAttributes("name", errors)} value={document.name} onChange={event => rename(event.target.value)} placeholder="e.g. Noor Active Hijab" maxLength={200} /></CatalogueField>
    <CatalogueField label="Description" path="description" errors={errors}><textarea {...fieldAttributes("description", errors)} rows={3} value={document.description} onChange={event => patch({ description: event.target.value })} placeholder="What should customers know about this product?" maxLength={10000} /></CatalogueField>
    <CatalogueField label="Usual price (R)" path="usualPrice" errors={errors} hint="Used for new colours and sizes. Any different prices you set are kept."><input {...fieldAttributes("usualPrice", errors)} type="number" min="0.01" max={100000} step="0.01" inputMode="decimal" value={usualPrice} onChange={event => changePrice(event.target.value)} placeholder="e.g. 420" /></CatalogueField>
    <div className="mm-products__sizes"><h3>Sizes</h3><p>Leave one size, or add the sizes this product comes in.</p>
      {document.colours[0].variants.map((entry, index) => {
        const path = `colours.0.variants.${index}.size`;
        return <div className="mm-products__size" key={entry.id}><CatalogueField label={`Size ${index + 1}`} path={path} errors={errors}><input {...fieldAttributes(path, errors)} value={entry.size} maxLength={80} onChange={event => replace(renameProductSize(document, entry.size, event.target.value, index))} /></CatalogueField>
          {sizes.length > 1 && <button type="button" disabled={document.colours.some(colour => colour.variants.length === 1)} aria-label={`Remove size ${entry.size || index + 1}`} onClick={() => replace({ ...document, colours: document.colours.map(colour => ({ ...colour, variants: colour.variants.filter((variant, position) => position !== index || variant.size !== entry.size) })) })}>Remove</button>}</div>;
      })}
      <button type="button" disabled={document.colours.some(colour => colour.variants.length >= 30)} onClick={() => {
        let name = "New size";
        for (let suffix = 2; sizes.some(size => size.toLowerCase() === name.toLowerCase()); suffix++) name = `New size ${suffix}`;
        replace(addProductSize(document, name, Number(usualPrice)));
      }}>Add size</button>
    </div>
    <details className="mm-products__optional"><summary>More product information <small>Optional</small></summary>
      {([
        ["tagline", "Collection tagline"], ["productDetails", "Product details"], ["fabricMaterials", "Fabric & materials"],
        ["benefits", "Benefits"], ["fabricWeight", "Fabric weight"], ["dimensions", "Dimensions"],
        ["careInstructions", "Care instructions"], ["deliveryReturns", "Delivery & returns information"],
      ] as const).map(([key, label]) => <CatalogueField key={key} label={label} path={key} errors={errors}><textarea {...fieldAttributes(key, errors)} rows={2} maxLength={key === "tagline" ? 300 : 10000} value={document[key] || ""} onChange={event => patch({ [key]: event.target.value })} /></CatalogueField>)}
    </details>
  </div>;
}

type ColourProps = { document: CatalogueDocument; demo: boolean; errors: CatalogueEditorErrors; changeColour: (id: string, change: (colour: CatalogueColour) => CatalogueColour) => void; addPhotos: (id: string | null) => void; addColour: () => void; removeColour: (id: string) => void };
function ColourFields({ document, demo, errors, changeColour, addPhotos, addColour, removeColour }: ColourProps) {
  return <div className="mm-products__section"><p className="mm-products__intro">Add each colour and its photos. Your sizes and usual price are already carried across.</p>
    {document.colours.map((colour, index) => <section className="mm-products__colour" key={colour.id}>
      <CatalogueField label={`Colour ${index + 1}`} path={`colours.${index}.name`} errors={errors}><input {...fieldAttributes(`colours.${index}.name`, errors)} value={colour.name} maxLength={120} placeholder="e.g. Black" onChange={event => changeColour(colour.id, value => ({ ...value, name: event.target.value }))} /></CatalogueField>
      {document.colours.length > 1 && <button type="button" className="mm-products__text-button" aria-label={`Remove colour ${colour.name || index + 1}`} onClick={() => removeColour(colour.id)}>Remove colour</button>}
      <div className="mm-products__photos">{colour.photos.map((photo, photoIndex) => <div key={`${photo.url}-${photoIndex}`}><img src={photo.url} alt={photo.alt || colour.name} /><button type="button" aria-label={`Remove photo ${photoIndex + 1} from ${colour.name || `colour ${index + 1}`}`} onClick={() => changeColour(colour.id, value => ({ ...value, photos: value.photos.filter((_, position) => position !== photoIndex) }))}>Remove</button></div>)}</div>
      {demo ? <button type="button" disabled={colour.photos.length >= 12} onClick={() => addPhotos(colour.id)}>{colour.photos.length ? "Add more photos" : "Upload photos"}</button> : <p>Photo uploads will be available once the website connection is complete.</p>}
      <details className="mm-products__optional"><summary>Different prices for this colour <small>Optional</small></summary>
        {colour.variants.map((entry, variantIndex) => {
          const path = `colours.${index}.variants.${variantIndex}.price`;
          return <CatalogueField key={entry.id} label={`${entry.size} price (R)`} path={path} errors={errors}><input {...fieldAttributes(path, errors)} type="number" min="0.01" max={100000} step="0.01" inputMode="decimal" value={entry.price || ""} onChange={event => changeColour(colour.id, value => ({ ...value, variants: value.variants.map(variant => variant.id === entry.id ? { ...variant, price: Number(event.target.value) } : variant) }))} /></CatalogueField>;
        })}
      </details>
    </section>)}
    {errors.colours && <p className="mm-products__field-error">{errors.colours}</p>}
    <button type="button" disabled={document.colours.length >= 30} onClick={addColour}>Add colour</button>
  </div>;
}

type StockProps = { document: CatalogueDocument; demo: boolean; errors: CatalogueEditorErrors; changeColour: ColourProps["changeColour"] };
function StockFields({ document, demo, errors, changeColour }: StockProps) {
  return <div className="mm-products__section"><p className="mm-products__intro">{demo ? "Sample quantities only. " : ""}Enter the quantity you have. Once confirmed, zero stock means sold out. Uncheck availability to pause a colour or size.</p>
    {document.colours.map((colour, index) => <section className="mm-products__stock" key={colour.id}><header><h3>{colour.name || `Colour ${index + 1}`}</h3><label className="mm-products__check"><input type="checkbox" checked={colour.available && (colour.variants.length > 1 || colour.variants[0].available)} onChange={event => changeColour(colour.id, value => ({ ...value, available: event.target.checked, variants: value.variants.length === 1 ? value.variants.map(entry => ({ ...entry, available: event.target.checked })) : value.variants }))} />{colour.name || `Colour ${index + 1}`} available for sale</label></header>
      {colour.variants.map((entry, variantIndex) => {
        const path = `colours.${index}.variants.${variantIndex}.stock`;
        return <div className="mm-products__stock-row" key={entry.id}><CatalogueField label={`${entry.size || "Size"} stock${entry.stockVerified === false ? " — not counted yet" : ""}`} path={path} errors={errors}><input {...fieldAttributes(path, errors)} type="number" min={0} max={100000} step={1} inputMode="numeric" value={entry.stock} onChange={event => changeColour(colour.id, value => ({ ...value, variants: value.variants.map(variant => variant.id === entry.id ? { ...variant, stock: Number(event.target.value), stockVerified: true } : variant) }))} /></CatalogueField>
          {colour.variants.length > 1 && <label className="mm-products__check"><input type="checkbox" checked={entry.available} onChange={event => changeColour(colour.id, value => ({ ...value, variants: value.variants.map(variant => variant.id === entry.id ? { ...variant, available: event.target.checked } : variant) }))} />{entry.size || "Size"} available</label>}</div>;
      })}
    </section>)}
  </div>;
}

function Preview({ document, demo, patch, addPhotos }: { document: CatalogueDocument; demo: boolean; patch: DetailsProps["patch"]; addPhotos: ColourProps["addPhotos"] }) {
  const photos = document.colours.flatMap(colour => colour.photos);
  return <div className="mm-products__preview"><p className="mm-products__intro">This is how your product cards could look. Preview buttons don’t place orders.</p><h3>{document.name}</h3><p>{document.description}</p>
    <div className="mm-products__cards">{document.colours.map(colour => <ColourCard key={colour.id} name={document.name} colour={colour} />)}</div>
    <section className="mm-products__homepage"><h3>Homepage collection</h3><label className="mm-products__check"><input type="checkbox" checked={document.showOnHomepage} onChange={event => patch({ showOnHomepage: event.target.checked })} />Show this product on the homepage</label>
      {document.showOnHomepage ? <>
        <article className="mm-products__collection"><CataloguePhoto url={document.homepageImage.url} alt={document.homepageImage.alt || document.name} /><h3>{document.name}</h3>{document.tagline && <p>{document.tagline}</p>}<span className="mm-products__mock-button">View product</span></article>
        <details className="mm-products__optional"><summary>Choose a different collection photo</summary><div className="mm-products__photo-choices">{photos.map((photo, index) => <button key={`${photo.url}-${index}`} type="button" aria-label={`Use collection photo ${index + 1}`} aria-pressed={document.homepageImage.url === photo.url} onClick={() => patch({ homepageImage: photo })}><img src={photo.url} alt={photo.alt || `Photo ${index + 1}`} /></button>)}</div>{demo && <button type="button" onClick={() => addPhotos(null)}>Upload another photo</button>}</details>
      </> : <p>This product won’t appear in Our Collection.</p>}
    </section>
  </div>;
}
function CataloguePhoto({ url, alt }: { url: string; alt: string }) { return url ? <img src={url} alt={alt} /> : <div className="mm-products__empty-photo">Photo not added yet</div>; }
function ColourCard({ name, colour }: { name: string; colour: CatalogueColour }) {
  const [selectedId, setSelectedId] = useState("");
  const selected = colour.variants.find(entry => entry.id === selectedId);
  const prices = colour.variants.map(entry => entry.price);
  const available = colour.available && (selected ? variantAvailable(selected) : colour.variants.some(variantAvailable));
  return <article><CataloguePhoto url={colour.photos[0]?.url || ""} alt={colour.photos[0]?.alt || `${name} ${colour.name}`} /><h3>{name} — {colour.name}</h3><p>{!selected && new Set(prices).size > 1 ? "From " : ""}{catalogueMoney.format(selected?.price ?? Math.min(...prices))}</p>
    <label className="mm-products__field">Size<select value={selectedId} onChange={event => setSelectedId(event.target.value)}><option value="">Select size</option>{colour.variants.map(entry => <option key={entry.id} value={entry.id} disabled={!colour.available || !variantAvailable(entry)}>{entry.size}{!colour.available || !variantAvailable(entry) ? " — Out of stock" : ""}</option>)}</select></label>
    <span className="mm-products__mock-button">{available ? "Add to cart" : "Out of stock"}</span></article>;
}

const catalogueEditorStyles = `
.mm-products{font-family:Jost,Inter,Arial,sans-serif;color:#302a24;max-width:1000px;margin:0 auto;padding:32px;background:#f5f3f0;box-sizing:border-box}.mm-products *{box-sizing:border-box}.mm-products h1,.mm-products h2,.mm-products h3{font-family:Montserrat,Jost,Inter,Arial,sans-serif;letter-spacing:0;line-height:1.3;font-weight:500}.mm-products h1{font-size:30px;margin:4px 0 12px}.mm-products h2{font-size:22px;margin:0 0 8px}.mm-products h3{font-size:18px;margin:12px 0 8px}.mm-products p{line-height:1.5;margin:6px 0 16px}.mm-products button{font:inherit;padding:11px 17px;min-height:44px;border:1px solid #a69e95;background:transparent;color:inherit;cursor:pointer;transition:background .15s}.mm-products button:hover:not(:disabled){background:#e1e4dc}.mm-products button:disabled{opacity:.55;cursor:not-allowed}.mm-products .mm-products__primary{background:#758166;color:white;border-color:#758166}.mm-products .mm-products__primary:hover:not(:disabled){background:#5d684f}.mm-products :is(button,input,textarea,select,summary):focus-visible{outline:3px solid #758166;outline-offset:3px}.mm-products__header,.mm-products__footer,.mm-products__title{display:flex;align-items:center;justify-content:space-between;gap:16px}.mm-products__eyebrow{font-size:11px;letter-spacing:.12em;color:#746d65}.mm-products__notice{font-size:13px;color:#746d65;border-bottom:1px solid #d5cfc8;padding:0 0 18px}.mm-products__success,.mm-products__error{padding:14px 18px;background:#e9ede2;border-left:3px solid #758166;margin:16px 0;font-size:14px}.mm-products__error{background:#f4e6e1;border-color:#8b3e2f}.mm-products__list{display:grid;gap:1px;background:#d5cfc8;border:1px solid #d5cfc8}.mm-products__row{display:flex;align-items:center;gap:18px;background:#fffaf5;padding:20px}.mm-products__row>div{flex:1;min-width:0}.mm-products__row p{font-size:14px;margin:0 0 4px;color:#746d65}.mm-products__row img,.mm-products__placeholder{width:72px;height:72px;object-fit:cover;flex-shrink:0}.mm-products__placeholder{display:grid;place-items:center;background:#e9e5e0;font-size:28px}.mm-products__badge{font-size:12px;color:#746d65}.mm-products .mm-products__back{border:0;padding-left:0;margin-bottom:16px}.mm-products__steps{list-style:none;display:flex;gap:16px;padding:0;margin:8px 0 28px;border-bottom:1px solid #d5cfc8}.mm-products__steps li{flex:1;font-size:14px;color:#746d65;padding:0 0 14px;border-bottom:3px solid transparent}.mm-products__steps li[aria-current=step]{color:#302a24;border-color:#758166}.mm-products__steps li>span{display:inline-grid;place-items:center;width:25px;height:25px;background:#e4e7df;border-radius:50%;margin-right:8px}.mm-products__title{margin-bottom:20px}.mm-products__title>span{font-size:12px;color:#746d65}.mm-products__form{border:0;padding:0;margin:0;min-width:0}.mm-products__section{padding:24px;background:#fffaf5;min-width:0}.mm-products__field{display:flex;flex-direction:column;gap:7px;font-size:14px;margin:0 0 20px}.mm-products input:not([type=checkbox]),.mm-products textarea,.mm-products select{width:100%;border:1px solid #bbb3aa;background:#fffaf5;color:inherit;padding:12px;font:inherit;border-radius:4px;min-width:0}.mm-products input[aria-invalid=true],.mm-products textarea[aria-invalid=true]{border-color:#8b3e2f}.mm-products textarea{resize:vertical}.mm-products small{color:#746d65;line-height:1.5}.mm-products .mm-products__field-error{color:#8b3e2f}.mm-products__sizes>p,.mm-products__intro{font-size:14px;color:#746d65}.mm-products__size{display:flex;align-items:flex-start;gap:12px}.mm-products__size .mm-products__field{flex:1}.mm-products__size>button{margin-top:24px}.mm-products__check{display:flex;align-items:center;gap:10px;font-size:14px;line-height:1.4;min-height:44px}.mm-products input[type=checkbox]{width:18px;height:18px;accent-color:#758166;flex-shrink:0}.mm-products__optional{margin:18px 0 0;padding-top:18px;border-top:1px solid #d5cfc8}.mm-products summary{cursor:pointer;min-height:44px;padding:8px 0}.mm-products summary small{font-size:12px;margin-left:8px}.mm-products__optional[open]>summary{margin-bottom:14px}.mm-products__accordion{border:1px solid #d5cfc8;background:#fffaf5;margin:12px 0}.mm-products__accordion>summary{font-size:18px;padding:20px}.mm-products__accordion>summary small{display:block;margin:5px 0 0 20px;font-size:13px}.mm-products__colour{padding:20px;background:#f5f3f0;border:1px solid #d5cfc8;margin:0 0 20px}.mm-products__photos,.mm-products__photo-choices{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}.mm-products__photos>div{display:flex;flex-direction:column;gap:6px}.mm-products__photos img,.mm-products__photo-choices img{width:96px;height:96px;object-fit:cover}.mm-products__photos button{font-size:12px;padding:6px}.mm-products__photo-choices button{padding:3px;border:2px solid transparent}.mm-products__photo-choices button[aria-pressed=true]{border-color:#758166}.mm-products__stock{border-bottom:1px solid #d5cfc8;margin-bottom:20px;padding-bottom:12px}.mm-products__stock:last-child{border:0;margin:0}.mm-products__stock header{margin-bottom:14px}.mm-products__stock-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;align-items:center}.mm-products__footer{padding:20px 0;margin-top:16px;border-top:1px solid #d5cfc8}.mm-products__preview{padding:24px;background:#eeeae6}.mm-products__cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));max-width:760px;gap:32px;margin:24px auto 40px}.mm-products__cards article{padding:14px;border:1px solid #a69e95;min-width:0}.mm-products__cards img,.mm-products__empty-photo{width:100%;aspect-ratio:1;object-fit:cover}.mm-products__empty-photo{display:grid;place-items:center;background:#d8d4cf;color:#746d65;font-size:14px}.mm-products__mock-button{display:block;background:#758166;color:white;padding:13px;text-align:center;font-size:14px}.mm-products__collection{max-width:300px;margin-top:18px}.mm-products__collection img{width:100%;aspect-ratio:1;object-fit:cover}.mm-products__homepage{border-top:1px solid #cfc8c0;padding-top:20px}
.mm-products .mm-products__primary,.mm-products__mock-button{background:#536047;border-color:#536047}.mm-products .mm-products__primary:hover:not(:disabled){background:#424d39}.mm-products__row h2,.mm-products__row p{overflow-wrap:anywhere}
@media(max-width:760px){.mm-products{padding:20px}.mm-products__section,.mm-products__colour,.mm-products__preview{padding:16px}.mm-products__cards{gap:20px}.mm-products__steps{gap:10px}.mm-products__steps li>span{display:grid;margin:0 0 8px}.mm-products__title{align-items:flex-start}.mm-products__row{display:grid;grid-template-columns:72px minmax(0,1fr);align-items:start}.mm-products__row>button{grid-column:1/-1;justify-self:start;margin:0}.mm-products__row h2{margin-top:0}}
@media(max-width:480px){.mm-products__cards{grid-template-columns:1fr}.mm-products__stock-row{grid-template-columns:1fr;gap:0}.mm-products__stock-row>.mm-products__check{margin:-12px 0 18px}.mm-products__steps li{font-size:12px}.mm-products__header{flex-wrap:wrap}.mm-products__row{grid-template-columns:54px minmax(0,1fr);gap:12px}.mm-products__row img,.mm-products__placeholder{width:54px;height:54px}.mm-products__row h2{font-size:18px}.mm-products__footer{align-items:stretch}.mm-products__footer>button{max-width:70%}}
`;

// END GENERATED PRODUCT EDITOR

// BEGIN GENERATED DISCOUNT MANAGER
type DiscountRecord = { id: string; revision: number; code: string; type: "percentage" | "amount"; value: number; active: boolean;
  productIds: string[]; minimumSpend: number; startsAt: string | null; endsAt: string | null };
type DiscountProduct = { id: string; name: string };
type DiscountDraft = Omit<DiscountRecord, "id" | "revision" | "value" | "minimumSpend"> & { id?: string; expectedRevision: number; value: string; minimumSpend: string };
type DiscountManagerProps = { demo?: boolean; apiBaseUrl?: string; enabled?: boolean; products?: DiscountProduct[]; onReviewChange?: (records: DiscountRecord[]) => void };
const discountMoney = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", minimumFractionDigits: 2 });
function blankDiscount(): DiscountDraft { return { expectedRevision: 0, code: "", type: "percentage", value: "", active: false,
  productIds: [], minimumSpend: "", startsAt: null, endsAt: null }; }
function localDiscountDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function discountStatus(discount: DiscountRecord) {
  if (!discount.active) return "Off";
  if (discount.endsAt && new Date(discount.endsAt).getTime() <= Date.now()) return "Expired";
  if (discount.startsAt && new Date(discount.startsAt).getTime() > Date.now()) return "Scheduled";
  return "On";
}

function DiscountManager({ demo = false, apiBaseUrl = "", enabled = true, products: initialProducts = [], onReviewChange }: DiscountManagerProps) {
  const [records, setRecords] = useState<DiscountRecord[]>([]);
  const [products, setProducts] = useState(initialProducts);
  const [draft, setDraft] = useState<DiscountDraft | null>(null);
  const [loading, setLoading] = useState(!demo && enabled);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(demo || !enabled);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [scope, setScope] = useState("all");
  const pending = useRef(false);
  const codeField = useRef<HTMLInputElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const base = apiBaseUrl.trim().replace(/\/$/, "");
  async function requestDiscounts(payload?: unknown, signal?: AbortSignal) {
    let session = "";
    try { session = window.sessionStorage.getItem("moving_modesty_admin_token") || ""; } catch { /* Cookie auth is available in the backend portal. */ }
    // Framer uses the explicit bearer session, not cross-site cookies. The native
    // backend portal still sends its cookie on same-origin requests.
    const response = await fetch(`${base}/api/admin/discounts`, { method: payload ? "POST" : "GET", credentials: "same-origin",
      headers: { ...(payload ? { "Content-Type": "application/json" } : {}), ...(session ? { Authorization: `Bearer ${session}` } : {}) },
      body: payload ? JSON.stringify(payload) : undefined, signal: signal || AbortSignal.timeout(20000) });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${result?.error || "Discounts could not be loaded."}${result?.errorRef ? ` Reference: ${result.errorRef}` : ""}`);
    return result;
  }
  useEffect(() => {
    if (demo || !enabled) return;
    const controller = new AbortController();
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A changed external API target or explicit reload resets confirmed backend state.
    setLoading(true); setError(""); setReady(false);
    requestDiscounts(undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]))
      .then(result => { if (active) { setRecords(result.discounts); setProducts(result.products); setReady(true); } })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Discounts could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Reload is explicit; draft edits must never trigger a fetch.
  }, [base, demo, enabled, refresh]);
  const editorOpen = Boolean(draft);
  const editorId = draft?.id;
  useEffect(() => { if (editorOpen) codeField.current?.focus(); }, [editorId, editorOpen]);
  useEffect(() => { if (demo) onReviewChange?.(records); }, [demo, records, onReviewChange]);
  function editDiscount(record?: DiscountRecord) {
    setError(""); setMessage("");
    setScope(record?.productIds.length ? "selected" : "all");
    setDraft(record ? { ...record, expectedRevision: record.revision, value: String(record.value), minimumSpend: record.minimumSpend ? String(record.minimumSpend) : "" } : blankDiscount());
  }
  function closeEditor() {
    if (busy) return;
    setDraft(null); setError(""); createButton.current?.focus();
  }
  async function persistDiscount(current: DiscountDraft) {
    if (pending.current) return;
    const code = current.code.trim().toUpperCase();
    const value = Number(current.value);
    if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(code)) { setError("Enter a code using 2–40 letters, numbers, hyphens or underscores, without spaces."); codeField.current?.focus(); return; }
    if (!current.value.trim() || !Number.isFinite(value) || value <= 0 || (current.type === "percentage" && value >= 100)) { setError("Enter a discount greater than zero. Percentage discounts must be below 100%."); return; }
    if (value > 100000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) { setError("Use an amount no greater than R100,000, with no more than two decimal places."); return; }
    if (current.startsAt && current.endsAt && new Date(current.endsAt) <= new Date(current.startsAt)) { setError("The end date must be after the start date."); return; }
    if (demo && records.some(record => record.id !== current.id && record.code === code)) { setError("That code already exists. Edit its existing discount or choose a different code."); return; }
    const minimumSpend = Number(current.minimumSpend || 0);
    if (!Number.isFinite(minimumSpend) || minimumSpend < 0 || minimumSpend > 100000 || Math.abs(minimumSpend * 100 - Math.round(minimumSpend * 100)) > 0.000001) { setError("Enter a valid minimum spend, with no more than two decimal places."); return; }
    pending.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const payload = { ...current, code, value, minimumSpend };
      const saved: DiscountRecord = demo ? { ...payload, id: current.id || crypto.randomUUID(), revision: current.expectedRevision + 1 }
        : (await requestDiscounts(payload)).discount;
      setRecords(previous => [...previous.filter(record => record.id !== saved.id), saved].sort((a, b) => a.code.localeCompare(b.code)));
      setDraft(null); setMessage(demo ? "Saved in this review only. Nothing on the live website changed." : `Saved. ${saved.code} is ${discountStatus(saved).toLowerCase()}.`);
      createButton.current?.focus();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The save could not be confirmed. Reload Discounts before trying again."); }
    finally { pending.current = false; setBusy(false); }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft && scope === "selected" && !draft.productIds.length) { setError("Select at least one product, or choose All products."); return; }
    if (draft) void persistDiscount(draft);
  }
  function update<K extends keyof DiscountDraft>(key: K, value: DiscountDraft[K]) { setDraft(previous => previous ? { ...previous, [key]: value } : previous); }

  return <section className="mm-discounts" aria-label="Discount management" aria-busy={busy || loading}>
    <style dangerouslySetInnerHTML={{ __html: discountStyles }} />
    <header className="mm-discounts__header"><div><p className="mm-discounts__eyebrow">MOVING MODESTY · DISCOUNTS</p><h1>{draft ? draft.id ? "Edit discount" : "Create discount" : "Discounts"}</h1>
      <p>{draft ? "One shared code that customers enter at checkout." : "Create and control your specials without changing product prices."}</p></div>
      {!draft ? <button ref={createButton} type="button" className="mm-discounts__primary" disabled={busy || loading || !ready || !enabled} onClick={() => editDiscount()}>Create discount</button> : null}
    </header>
    {demo ? <p className="mm-discounts__review">Unpublished review · Changes stay in this browser tab. No live codes, orders or payments are created.</p> : null}
    {error ? <div className="mm-discounts__error" role="alert">{error}{!draft && !ready ? <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Reload discounts</button> : null}</div> : null}
    {message ? <p className="mm-discounts__notice" role="status">{message}</p> : null}
    {draft ? <form className="mm-discounts__form" onSubmit={save}>
      <label>Discount code<input ref={codeField} value={draft.code} required maxLength={40} autoComplete="off" autoCapitalize="characters" spellCheck={false} onChange={event => update("code", event.target.value)} disabled={busy} /><span>Choose your own code. Everyone uses this same code.</span></label>
      <div className="mm-discounts__fields"><label>Discount type<select value={draft.type} disabled={busy} onChange={event => update("type", event.target.value as DiscountDraft["type"])}><option value="percentage">Percentage off (%)</option><option value="amount">Rand amount off (R)</option></select></label>
        <label>{draft.type === "percentage" ? "Percentage off" : "Rand amount off"}<input type="number" value={draft.value} required min="0.01" max={draft.type === "percentage" ? "99.99" : "100000"} step="0.01" inputMode="decimal" disabled={busy} onChange={event => update("value", event.target.value)} /></label></div>
      <label>Applies to<select disabled={busy} value={scope} onChange={event => {
        setScope(event.target.value); if (event.target.value === "all") update("productIds", []);
      }}><option value="all">All products</option><option value="selected" disabled={!products.length}>Selected products</option></select></label>
      {scope === "selected" ? <fieldset className="mm-discounts__products"><legend>Select products</legend>{products.map(product => <label key={product.id}><input type="checkbox" checked={draft.productIds.includes(product.id)} disabled={busy} onChange={event => update("productIds", event.target.checked ? [...draft.productIds, product.id] : draft.productIds.filter(id => id !== product.id))} />{product.name}</label>)}</fieldset> : null}
      <div className="mm-discounts__active"><div><strong>Discount active</strong><p>{draft.active ? "Customers can use it while its dates are valid." : "Off. Customers cannot use this code yet."}</p></div>
        <button className="mm-discounts__switch" type="button" role="switch" aria-label="Discount active" aria-checked={draft.active} disabled={busy} onClick={() => update("active", !draft.active)}><span aria-hidden="true" />{draft.active ? "ON" : "OFF"}</button></div>
      <details className="mm-discounts__options"><summary>More options</summary><div className="mm-discounts__fields"><label>Start date and time<input type="datetime-local" value={localDiscountDate(draft.startsAt)} disabled={busy} onChange={event => update("startsAt", event.target.value ? new Date(event.target.value).toISOString() : null)} /></label>
        <label>End date and time<input type="datetime-local" value={localDiscountDate(draft.endsAt)} disabled={busy} onChange={event => update("endsAt", event.target.value ? new Date(event.target.value).toISOString() : null)} /></label></div><p>Times use this device’s local time zone. Leave dates blank to control it manually.</p>
        <label>Minimum product spend (R)<input type="number" min="0" max="100000" step="0.01" inputMode="decimal" value={draft.minimumSpend} disabled={busy} onChange={event => update("minimumSpend", event.target.value)} /></label></details>
      <p className="mm-discounts__helper">One code per order. Discounts apply to products, not the delivery fee. Free delivery still qualifies at R1,200 before discounts. Already-started payments and paid orders keep their saved discount.</p>
      <footer><button type="submit" className="mm-discounts__primary" disabled={busy}>{busy ? "Saving…" : "Save discount"}</button><button type="button" className="mm-discounts__secondary" disabled={busy} onClick={closeEditor}>Cancel</button></footer>
    </form> : loading ? <p role="status">Loading discounts…</p> : ready && !records.length ? <div className="mm-discounts__empty"><h2>No discounts yet</h2><p>When you’re ready to run a special, choose Create discount.</p><span>No codes or specials are active.</span></div>
      : <div className="mm-discounts__list">{records.map(record => <article key={record.id} className="mm-discounts__row"><div><h2>{record.code}</h2><p>{record.type === "percentage" ? `${record.value}% off` : `${discountMoney.format(record.value)} off`} · {record.productIds.length ? "Selected products" : "All products"}</p>
        {discountStatus(record) === "Scheduled" || discountStatus(record) === "Expired" ? <span>{discountStatus(record)}{record.endsAt ? ` · Ends ${new Date(record.endsAt).toLocaleString("en-ZA")}` : ""}</span> : null}</div><div className="mm-discounts__actions">
        <button type="button" className="mm-discounts__secondary" disabled={busy} onClick={() => editDiscount(record)}>Edit<span className="mm-discounts__sr"> {record.code}</span></button>
        <button type="button" className="mm-discounts__switch" role="switch" aria-label={`${record.code} active`} aria-checked={record.active} disabled={busy} onClick={() => void persistDiscount({ ...record, expectedRevision: record.revision, value: String(record.value), minimumSpend: String(record.minimumSpend), active: !record.active })}><span aria-hidden="true" />{record.active ? "ON" : "OFF"}</button>
      </div></article>)}</div>}
  </section>;
}

const discountStyles = `
.mm-discounts h2{font-family:Jost,Arial,sans-serif}.mm-discounts .mm-discounts__primary{background:#536047}.mm-discounts .mm-discounts__primary:hover{background:#405339}
.mm-discounts{position:relative;box-sizing:border-box;color:var(--mm-ink,#302a24);font:16px/1.5 Jost,Arial,sans-serif;width:100%;container-type:inline-size}
.mm-discounts *{box-sizing:border-box}.mm-discounts button,.mm-discounts input,.mm-discounts select{font:inherit;color:inherit}
.mm-discounts button{cursor:pointer;transition:background .15s,opacity .15s}.mm-discounts button:disabled{cursor:not-allowed;opacity:.55}
.mm-discounts button:focus-visible,.mm-discounts input:focus-visible,.mm-discounts select:focus-visible,.mm-discounts summary:focus-visible{outline:2px solid var(--mm-ink,#302a24);outline-offset:3px}
.mm-discounts__header{display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:28px}.mm-discounts__eyebrow{font-size:11px;letter-spacing:.15em;margin:0 0 12px;color:var(--mm-muted,#746d65)}
.mm-discounts h1{font:400 38px/1.15 Montserrat,Arial,sans-serif;margin:0 0 12px}.mm-discounts h2{font-size:22px;font-weight:500;margin:0 0 8px}.mm-discounts p{margin:0;color:var(--mm-muted,#746d65)}
.mm-discounts__primary,.mm-discounts__secondary{min-height:46px;padding:10px 20px;border:1px solid var(--mm-border,#a69e95);border-radius:3px;white-space:nowrap}.mm-discounts__primary{background:var(--mm-sage,#738063);color:#fff!important;border-color:transparent}.mm-discounts__primary:hover{background:#536047}.mm-discounts__secondary{background:transparent}.mm-discounts__secondary:hover{background:var(--mm-surface,#eeeae6)}
.mm-discounts__review,.mm-discounts__notice,.mm-discounts__error{margin:0 0 24px!important;padding:12px 16px;border:1px solid var(--mm-border,#a69e95);font-size:14px}.mm-discounts__error{color:#7a352b;background:#f5e6e1}.mm-discounts__error button{margin-left:16px}.mm-discounts__notice{color:#405339}
.mm-discounts__empty{padding:56px 28px;text-align:center;border:1px solid var(--mm-border,#a69e95);border-radius:4px;background:var(--mm-surface,#eeeae6)}.mm-discounts__empty span{display:block;margin-top:16px;color:var(--mm-muted,#746d65);font-size:14px}
.mm-discounts__form{max-width:760px;border:1px solid var(--mm-border,#a69e95);padding:28px;background:var(--mm-surface,#eeeae6);border-radius:4px;display:grid;gap:24px}.mm-discounts__form label{display:grid;gap:8px;font-size:15px;font-weight:500}.mm-discounts__form label>span,.mm-discounts__helper{font-size:13px;font-weight:400;color:var(--mm-muted,#746d65)}
.mm-discounts__form input:not([type=checkbox]),.mm-discounts__form select{width:100%;min-width:0;min-height:46px;padding:10px 12px;border:1px solid var(--mm-border,#a69e95);border-radius:3px;background:#faf8f5}.mm-discounts__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.mm-discounts__active{display:flex;justify-content:space-between;align-items:center;gap:20px}.mm-discounts__active p{font-size:14px}.mm-discounts__switch{display:inline-flex;align-items:center;justify-content:center;gap:9px;min-width:92px;min-height:44px;padding:8px 12px;border:1px solid var(--mm-border,#a69e95);border-radius:30px;background:#e2ded9;font-size:13px!important;font-weight:600!important;flex-shrink:0}.mm-discounts__switch[aria-checked=true]{background:#536047;border-color:#536047;color:#fff}.mm-discounts__switch>span{width:15px;height:15px;background:currentColor;border-radius:50%;opacity:.85}
.mm-discounts__options{border-top:1px solid var(--mm-border,#a69e95);padding-top:18px}.mm-discounts__options summary{cursor:pointer}.mm-discounts__options[open] .mm-discounts__fields{margin-top:18px}.mm-discounts__options p{font-size:13px;margin:12px 0 18px}.mm-discounts__form footer{display:flex;gap:12px;flex-wrap:wrap}.mm-discounts__products{padding:16px;border:1px solid var(--mm-border,#a69e95)}.mm-discounts__products label{display:flex;align-items:center;margin:8px 0}.mm-discounts__products input{width:18px;height:18px;accent-color:#536047}
.mm-discounts__list{display:grid;gap:16px}.mm-discounts__row{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:24px;border:1px solid var(--mm-border,#a69e95);border-radius:4px;background:var(--mm-surface,#eeeae6)}.mm-discounts__row h2{overflow-wrap:anywhere}.mm-discounts__row span{font-size:13px;color:var(--mm-muted,#746d65)}.mm-discounts__actions{display:flex;gap:12px;flex-shrink:0}.mm-discounts__sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
@container(max-width:600px){.mm-discounts__header{align-items:flex-start;flex-direction:column;gap:16px}.mm-discounts h1{font-size:30px}.mm-discounts__form{padding:20px}.mm-discounts__fields{grid-template-columns:1fr;gap:20px}.mm-discounts__row{align-items:flex-start;flex-direction:column;padding:20px;gap:18px}.mm-discounts__actions{width:100%;justify-content:space-between}.mm-discounts__empty{padding:36px 20px}}
`;

// END GENERATED DISCOUNT MANAGER

// BEGIN_MM_PACKING_REFERENCE
// Supplied by Zarina, 22 October 2026. Product weights exclude packaging.
// Packed weights are references only: confirm the actual sealed parcel before booking.
const zarinaProductMeasurements = [
  { product: "Hawa Tri-Instant", size: "Small", productGrams: 126, singlePackedGrams: 183 },
  { product: "Hawa Tri-Instant", size: "Large", productGrams: 145, singlePackedGrams: 200 },
  { product: "Amina Tie-Back", size: "One size fits all", productGrams: 212, singlePackedGrams: 267 },
] as const;

const movingModestyBoxPreset = {
  id: "moving-modesty-scarf-box", name: "Moving Modesty scarf box", lengthCm: 25, widthCm: 20, heightCm: 3,
} as const;

const zarinaPackedReferences = [
  { label: "1 Hawa Small", grams: 183, approximate: false },
  { label: "1 Hawa Large", grams: 200, approximate: false },
  { label: "1 Amina", grams: 267, approximate: false },
  { label: "2 Hawa Small", grams: 305, approximate: true },
  { label: "1 Hawa Small + 1 Hawa Large", grams: 335, approximate: false },
  { label: "1 Hawa + 1 Amina", grams: 393, approximate: false },
] as const;

function zarinaProductMeasurement(product: string, size: string) {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const name = normalize(product).replace(/ scarf$/, ""), variant = normalize(size);
  if (["hawa", "hawa tri instant"].includes(name)) {
    if (["small", "s"].includes(variant)) return zarinaProductMeasurements[0];
    if (["large", "l"].includes(variant)) return zarinaProductMeasurements[1];
  }
  if (["amina", "amina tie back"].includes(name) && ["one size fits all", "one size", "onesize", "os"].includes(variant)) return zarinaProductMeasurements[2];
  return undefined;
}
// END_MM_PACKING_REFERENCE

// BEGIN_MM_COLLECTION_SCHEDULE
type CollectionSchedule = { date: string; after: string; before: string };

function southAfricaToday(now = Date.now()) {
  return new Date(now + 2 * 60 * 60_000).toISOString().slice(0, 10);
}

function collectionScheduleProblem(schedule: CollectionSchedule | undefined, current = false, now = Date.now()): string {
  if (!schedule || typeof schedule.date !== "string" || typeof schedule.after !== "string" || typeof schedule.before !== "string") return "Choose a collection date and an available time window before comparing couriers.";
  const date = schedule.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00Z`))
    || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) return "Choose a valid collection date.";
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!time.test(schedule.after) || !time.test(schedule.before) || schedule.after < "08:00" || schedule.before > "17:00" || schedule.after >= schedule.before) return "Choose a start and end time between 08:00 and 17:00, with the end after the start.";
  if (current && (date < southAfricaToday(now) || Date.parse(`${date}T${schedule.before}:00+02:00`) <= now)) return "The collection date or time window has passed. Choose a new schedule and compare couriers again.";
  return "";
}

function collectionScheduleLabel(schedule: CollectionSchedule) {
  return `${schedule.date} · ${schedule.after}–${schedule.before} SAST`;
}

function collectionRateSchedule(schedule?: CollectionSchedule) {
  if (!schedule) return {};
  const problem = collectionScheduleProblem(schedule);
  if (problem) throw new Error(problem);
  return { requested_collection_date: `${schedule.date}T${schedule.after}:00+02:00` };
}

function collectionShipmentSchedule(schedule?: CollectionSchedule) {
  if (!schedule) return {};
  const date = collectionRateSchedule(schedule).requested_collection_date;
  return { collection_min_date: date, collection_after: `${schedule.after}:00`, collection_before: `${schedule.before}:00` };
}
// END_MM_COLLECTION_SCHEDULE

// BEGIN_MM_DELIVERY_EDITOR
type CourierAddress = { company: string; line1: string; line2: string; suburb: string; city: string; province: string; postalCode: string };
type CourierContact = { name: string; email: string; phone: string };
type PickupPoint = { id: string; providerSlug: string; name: string };
type CourierEndpoint = { kind: "door"; contact: CourierContact; address: CourierAddress }
  | { kind: "pickup_point"; contact: CourierContact; point: PickupPoint };
type CourierPlan = { version: 1; collection: CourierEndpoint; delivery: CourierEndpoint;
  collectionInstructions: string; deliveryInstructions: string; customerApprovedPickup: boolean; collectionSchedule?: CollectionSchedule };

type DeliveryPointResult = PickupPoint & { description: string; type: string };
type DeliveryEditorDetails = { revision: number; plan: CourierPlan | null; draftPlan: CourierPlan; privateNote: string; canEdit: boolean; blockedReason?: string;
  collectionTimeMode?: "preferred_instructions";
  waybillChange?: { action: "cancel_waybill" | "check_cancellation" | "prepare_replacement"; trackingNumber: string };
  previousWaybills?: Array<{ trackingNumber: string; courierName: string; status: string; replacedAt: string }> };
interface DeliveryEditorProps {
  details: DeliveryEditorDetails;
  disabled?: boolean;
  save: (payload: Record<string, unknown>) => Promise<void>;
  searchPoints: (query: string) => Promise<{ points: DeliveryPointResult[]; limited?: boolean }>;
  onEditingChange?: (editing: boolean) => void;
  changeWaybill?: (payload: Record<string, unknown>) => Promise<void>;
  guided?: boolean;
  onContinue?: () => void;
}
const emptyCourierAddress: CourierAddress = { company: "", line1: "", line2: "", suburb: "", city: "", province: "Western Cape", postalCode: "" };
const deliveryProvinces = ["Eastern Cape", "Free State", "Gauteng", "KwaZulu-Natal", "Limpopo", "Mpumalanga", "North West", "Northern Cape", "Western Cape"];

function EmbeddedDeliveryEditor({ details, disabled = false, save, searchPoints, onEditingChange, changeWaybill, guided = false, onContinue }: DeliveryEditorProps) {
  const [editing, setEditing] = useState(false);
  const [scheduleOnly, setScheduleOnly] = useState(false);
  const [editSide, setEditSide] = useState<"collection" | "delivery">("delivery");
  const [saving, setSaving] = useState(false);
  const [plan, setPlan] = useState<CourierPlan>(() => structuredClone(details.draftPlan));
  const [confirmed, setConfirmed] = useState(false);
  const [remember, setRemember] = useState(false);
  const [note, setNote] = useState(details.privateNote);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [waybillConfirmation, setWaybillConfirmation] = useState("");
  const [changeError, setChangeError] = useState("");
  const hintId = useId();
  const waybillScope = `${details.revision}:${details.waybillChange?.trackingNumber}:${details.waybillChange?.action}`;
  async function submitWaybillChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!details.waybillChange || !changeWaybill || saving || disabled) return;
    if (details.waybillChange.action !== "check_cancellation" && waybillConfirmation !== waybillScope) return;
    setSaving(true); setChangeError(""); setMessage("");
    try {
      await changeWaybill({ action: details.waybillChange.action, expectedRevision: details.revision,
        expectedWaybill: details.waybillChange.trackingNumber, confirm: true });
      setWaybillConfirmation(""); onEditingChange?.(false);
    } catch (caught) { setChangeError(caught instanceof Error ? caught.message : "The waybill change could not be confirmed. Refresh the order before continuing."); }
    finally { setSaving(false); }
  }
  const doorAddresses = useRef({ collection: details.draftPlan.collection.kind === "door" ? details.draftPlan.collection.address : emptyCourierAddress,
    delivery: details.draftPlan.delivery.kind === "door" ? details.draftPlan.delivery.address : emptyCourierAddress });
  function changeEndpoint(side: "collection" | "delivery", endpoint: CourierEndpoint) {
    setPlan(current => ({ ...current, [side]: endpoint, ...(side === "collection" && endpoint.kind === "pickup_point" ? { collectionSchedule: undefined } : {}) })); setConfirmed(false);
    if (endpoint.kind === "door") doorAddresses.current[side] = endpoint.address;
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
      collectionSchedule: plan.collection.kind === "door" ? {
        date: text("collectionSchedule.date", plan.collectionSchedule?.date), after: text("collectionSchedule.after", plan.collectionSchedule?.after), before: text("collectionSchedule.before", plan.collectionSchedule?.before),
      } : undefined,
      collectionInstructions: text("collectionInstructions", plan.collectionInstructions), deliveryInstructions: text("deliveryInstructions", plan.deliveryInstructions),
      customerApprovedPickup: plan.delivery.kind === "pickup_point" ? form.has("approvedPickup") : false };
  }
  async function saveDelivery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setMessage("");
    // Read this component's own form at submit time, including silent autofill.
    const form = new FormData(event.currentTarget), next = readDeliveryForm(form);
    if (next.delivery.kind !== "door") { setError("Enter the customer’s home delivery address. Locker drop-off is for Zarina’s collection location only."); return; }
    if ([next.collection, next.delivery].some(value => value.kind === "pickup_point" && !value.point.id)) { setError("Choose each pickup point from the Bob Go search results."); return; }
    if (next.collection.kind === "door") { const problem = collectionScheduleProblem(next.collectionSchedule, true); if (problem) { setError(problem); return; } }
    setSaving(true);
    try {
      await save({ action: "delivery", expectedRevision: details.revision, plan: next, confirmed: form.has("confirmed"), rememberCollection: form.has("remember") });
      setEditing(false); onEditingChange?.(false); setConfirmed(false); setMessage("Delivery details saved.");
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
  function edit(side: "collection" | "delivery", kind?: "door" | "pickup_point", onlySchedule = false) {
    if (!details.canEdit || disabled || saving) return;
    const next = structuredClone(details.draftPlan), endpoint = next[side];
    if (kind && endpoint.kind !== kind) next[side] = kind === "door"
      ? { kind, contact: endpoint.contact, address: structuredClone(doorAddresses.current[side]) }
      : { kind, contact: endpoint.contact, point: { id: "", providerSlug: "", name: "" } };
    if (next.collection.kind === "pickup_point") next.collectionSchedule = undefined;
    setScheduleOnly(onlySchedule);
    setPlan(next); setEditSide(side); setRemember(false);
    setError(""); setMessage(""); setConfirmed(false); setEditing(true); onEditingChange?.(true);
  }
  const action = details.waybillChange?.action;
  const changeForm = details.waybillChange && changeWaybill ? <form className="mm-delivery__waybill-change" onSubmit={submitWaybillChange} aria-busy={saving}>
    <strong>{action === "prepare_replacement" ? "Waybill cancelled — set up a replacement" : action === "check_cancellation" ? "Waiting for cancellation confirmation" : "Cancel this waybill to change delivery"}</strong>
    <p className="mm-admin__helper">Waybill: <strong>{details.waybillChange.trackingNumber}</strong></p>
    <p>{action === "cancel_waybill" ? "Cancel before changing the address or courier. A replacement may cost again. The customer’s payment stays unchanged."
      : action === "check_cancellation" ? "Wait for Bob Go to confirm cancellation before rebooking."
      : "Edit the delivery details, then get new quotes. You’ll confirm any new booking cost."}</p>
    {action !== "check_cancellation" ? <label className="mm-delivery__check"><input type="checkbox" required
      checked={waybillConfirmation === waybillScope} disabled={disabled || saving}
      onChange={event => setWaybillConfirmation(event.target.checked ? waybillScope : "")} />This parcel has not been handed to a courier or dropped off.</label> : null}
    <p id={`${hintId}-waybill`} className="mm-admin__helper mm-delivery__action-hint" role="status">{saving ? "Checking Bob Go. Please wait."
      : disabled ? "Wait for the current action to finish."
      : action !== "check_cancellation" && waybillConfirmation !== waybillScope ? "Tick the confirmation above to continue."
      : action === "cancel_waybill" ? "This requests cancellation of this waybill only."
      : action === "check_cancellation" ? "You can safely check again; no new booking will be made." : "Ready to unlock replacement setup. You will approve any new courier cost separately."}</p>
    <button type="submit" className={action === "cancel_waybill" ? "mm-admin__secondary-button mm-delivery__danger-button" : "mm-admin__button mm-delivery__primary-action"}
      aria-describedby={`${hintId}-waybill`} disabled={disabled || saving || action !== "check_cancellation" && waybillConfirmation !== waybillScope}>
      {saving ? "Checking Bob Go…" : action === "cancel_waybill" ? "Cancel this waybill" : action === "check_cancellation" ? "Check cancellation" : "Prepare replacement"}
    </button>
    {changeError ? <p role="alert" className="mm-admin__error">{changeError}</p> : null}
  </form> : null;
  return <section className="mm-admin__delivery-editor" aria-label="Delivery setup and notes">
    <style dangerouslySetInnerHTML={{ __html: deliveryEditorCss }} />
    <div className="mm-delivery__heading"><strong>{details.canEdit ? "1. Check delivery details" : "Delivery details"}</strong>{!guided || !details.canEdit ? <span className="mm-admin__helper">{!details.canEdit ? action === "prepare_replacement" ? "Cancelled · setup locked" : action === "check_cancellation" ? "Cancellation pending" : "Booking locked" : details.plan ? "Confirmed" : "Check before continuing"}</span> : null}</div>
    {!details.canEdit && action !== "cancel_waybill" ? changeForm : null}
    {!guided || !editing ? <div className="mm-delivery__grid mm-delivery__summary">{(["collection", "delivery"] as const).map(side => <div className="mm-delivery__address-card" key={side}>
      <strong>{side === "collection" ? "From Zarina" : "To the customer"}</strong><p>{summaryEndpoint(shownPlan[side], side)}</p>
      {side === "collection" && shownPlan.collection.kind === "door" && (!guided || details.plan) ? <div className="mm-delivery__schedule-summary"><p><strong>Requested collection:</strong> {shownPlan.collectionSchedule ? collectionScheduleLabel(shownPlan.collectionSchedule) : "Choose a date and time."}</p>
        {details.collectionTimeMode === "preferred_instructions" ? <p className="mm-admin__helper">Hours are sent as a preferred driver note, not a booked time slot.</p> : null}
        {details.canEdit && !editing ? <button type="button" className="mm-admin__text-button" disabled={disabled || saving} onClick={() => edit("collection", undefined, true)}>{shownPlan.collectionSchedule ? "Change collection date / time" : "Choose collection date / time"}</button> : null}
        {!guided ? <p className="mm-admin__helper">Requested window, not a guaranteed appointment. Courier cut-offs and business days apply.</p> : null}</div> : null}
      {details.canEdit && !editing && !guided && side === "collection" ? <>
        <div className="mm-delivery__method-choices" role="group" aria-label={side === "collection" ? "How Zarina sends the parcel" : "How the customer receives the parcel"}>
          {(["door", "pickup_point"] as const).map(kind => <button key={kind} type="button" disabled={disabled || saving}
            className={shownPlan[side].kind === kind ? "mm-admin__button" : "mm-admin__secondary-button"} aria-pressed={shownPlan[side].kind === kind}
            onClick={() => edit(side, kind)}>{side === "collection" ? kind === "door" ? "Courier collects from Zarina" : "Zarina drops off at a locker / counter"
              : kind === "door" ? "Deliver to customer’s address" : "Customer collects at a locker / counter"}</button>)}
        </div>
        <p className="mm-admin__helper">{side === "collection" ? "Choose a method to check its address or select a drop-off point." : "Only switch to a pickup point if the customer agrees."}</p>
      </> : null}
      <details className="mm-delivery__contact"><summary>Contact details</summary><p className="mm-admin__helper">{shownPlan[side].contact.name}<br />{shownPlan[side].contact.phone}<br />{shownPlan[side].contact.email}</p></details>
      {details.canEdit && !editing ? <button type="button" className={side === "delivery" ? "mm-admin__secondary-button" : "mm-admin__text-button"} disabled={disabled || saving} onClick={() => edit(side)}>{side === "collection" ? "Change collection" : "Edit delivery address"}</button> : null}
    </div>)}</div> : null}
    {details.canEdit && !editing && !guided ? <p className="mm-admin__helper">Courier names, services and prices appear after you confirm the details and compare quotes. Locker or counter choices can limit the eligible couriers.</p> : null}
    {!editing && (shownPlan.collectionInstructions || shownPlan.deliveryInstructions) ? <details><summary>Courier instructions</summary><p>{shownPlan.collectionInstructions}</p><p>{shownPlan.deliveryInstructions}</p></details> : null}
    {!editing && details.canEdit && details.plan ? <button type="button" className="mm-admin__text-button" disabled={disabled} onClick={() => edit("delivery")}>Edit courier instructions</button> : null}
    {!details.canEdit && action === "cancel_waybill" && changeForm ? <details className="mm-delivery__change-options"><summary>Change address or courier</summary>{changeForm}</details> : null}
    {!details.canEdit && !changeForm ? <div className="mm-admin__notice"><p>{details.blockedReason}</p>
      {details.blockedReason?.includes("waybill") ? <details><summary>Change an already-booked delivery</summary>
        <p>Address or courier changes must be confirmed by Bob Go or the courier. Their documented API does not provide booked-waybill editing. A courier change may require cancellation and a new paid booking.</p>
        <p>Do not create a second shipment while the first is active. Editing a private note below does not change the waybill.</p>
        <a href="https://my.bobgo.co.za/" target="_blank" rel="noopener noreferrer">Open Bob Go to arrange the change</a>
      </details> : null}</div> : null}
    {details.previousWaybills?.length ? <details className="mm-delivery__history"><summary>Previous waybills ({details.previousWaybills.length})</summary>
      <p className="mm-admin__helper">Cancelled bookings kept for reference. Do not use these labels for the replacement parcel.</p>
      <ul>{details.previousWaybills.map(old => <li key={`${old.trackingNumber}:${old.replacedAt}`}><strong>{old.trackingNumber}</strong> · {old.courierName} · {old.status}</li>)}</ul>
    </details> : null}
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
      {editing ? <><p className="mm-admin__helper">{scheduleOnly ? "Update collection for this parcel." : "The other address stays unchanged."}</p>
      {!scheduleOnly ? <DeliveryEndpointFields key={editSide} side={editSide} value={plan[editSide]}
        allowCollectionMethodChoice={!guided || details.draftPlan.collection.kind === "pickup_point"}
        changeKind={kind => changeKind(editSide, kind)} change={value => changeEndpoint(editSide, value)} searchPoints={searchPoints} /> : null}
      <details><summary>Courier instructions (optional)</summary><div className="mm-delivery__grid">
        <label className="mm-admin__field">Collection instructions<textarea name="collectionInstructions" maxLength={1000} rows={3} value={plan.collectionInstructions}
          onChange={event => setPlan(current => ({ ...current, collectionInstructions: event.target.value }))} placeholder="For the collecting courier" /></label>
        <label className="mm-admin__field">Delivery instructions<textarea name="deliveryInstructions" maxLength={1000} rows={3} value={plan.deliveryInstructions}
          onChange={event => setPlan(current => ({ ...current, deliveryInstructions: event.target.value }))} placeholder="Gate, access or delivery instructions" /></label>
      </div></details></> : null}
      {plan.collection.kind === "door" ? <section className="mm-delivery__schedule" aria-label="Requested collection schedule">
        <h4>When can the courier collect?</h4>
        <p className="mm-admin__helper">{details.collectionTimeMode === "preferred_instructions" ? "Choose preferred hours between 08:00 and 17:00 (SAST). These are sent as a driver note, not a booked time slot." : "Choose a window between 08:00 and 17:00 (SAST). Collection time is requested, not guaranteed."}</p>
        <div className="mm-delivery__grid">
          <label className="mm-admin__field">Requested collection date<input name="collectionSchedule.date" type="date" required min={southAfricaToday()} value={plan.collectionSchedule?.date || ""} autoComplete="off"
            onChange={event => setPlan(current => ({ ...current, collectionSchedule: { date: event.target.value, after: current.collectionSchedule?.after || "", before: current.collectionSchedule?.before || "" } }))} /></label>
          <label className="mm-admin__field">{details.collectionTimeMode === "preferred_instructions" ? "Preferred from" : "Available from"}<input name="collectionSchedule.after" type="time" required min="08:00" max="17:00" step={60} value={plan.collectionSchedule?.after || ""} autoComplete="off"
            onChange={event => setPlan(current => ({ ...current, collectionSchedule: { date: current.collectionSchedule?.date || "", after: event.target.value, before: current.collectionSchedule?.before || "" } }))} /></label>
          <label className="mm-admin__field">{details.collectionTimeMode === "preferred_instructions" ? "Preferred until" : "Available until"}<input name="collectionSchedule.before" type="time" required min="08:00" max="17:00" step={60} value={plan.collectionSchedule?.before || ""} autoComplete="off"
            onChange={event => setPlan(current => ({ ...current, collectionSchedule: { date: current.collectionSchedule?.date || "", after: current.collectionSchedule?.after || "", before: event.target.value } }))} /></label>
        </div><details><summary>Collection timing</summary><p className="mm-admin__helper">Courier cut-offs and business days apply. Bob Go may move collection to the next available business day.</p></details>
      </section> : null}
      {editing && editSide === "collection" && !scheduleOnly ? <label className="mm-delivery__check"><input type="checkbox" name="remember" checked={remember} onChange={event => setRemember(event.target.checked)} />Use these sender collection details for future orders. The date and time are for this order only.</label> : null}
      <label className="mm-delivery__check"><input type="checkbox" name="confirmed" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I have checked both addresses and contact details.</label>
      <p id={`${hintId}-details`} className="mm-admin__helper mm-delivery__action-hint">{disabled || saving ? "Please wait." : !confirmed ? "Tick to confirm the details." : "No courier is booked yet."}</p>
      <div className="mm-delivery__actions"><button type="submit" className="mm-admin__button mm-delivery__primary-action" aria-describedby={`${hintId}-details`} disabled={disabled || saving || !confirmed}>{saving ? "Saving…" : editing ? "Save delivery details" : "Confirm delivery details"}</button>
        {editing ? <button type="button" className="mm-admin__text-button" onClick={() => { setEditing(false); setPlan(structuredClone(details.draftPlan)); onEditingChange?.(false); setError(""); setConfirmed(false); }}>Cancel editing</button> : null}</div>
    </fieldset></form> : null}
    {guided && !editing && details.canEdit && details.plan && onContinue ? <div className="mm-delivery__step-actions"><button type="button" className="mm-admin__button mm-delivery__primary-action" disabled={disabled || Boolean(shownPlan.collection.kind === "door" && collectionScheduleProblem(shownPlan.collectionSchedule, true))} onClick={onContinue}>Continue to parcel</button></div> : null}
    <details className="mm-delivery__private"><summary>Private order note</summary><p className="mm-admin__helper">For Zarina’s records only. Editable after booking; never sent to the courier or customer.</p>
      <form onSubmit={savePrivateNote}><label className="mm-admin__field">Private note<textarea name="privateNote" rows={3} maxLength={3000} value={note} onChange={event => setNote(event.target.value)} disabled={disabled} /></label>
        <button type="submit" className="mm-admin__secondary-button" disabled={disabled || note === details.privateNote}>Save private note</button></form>
    </details>
    {error ? <p className="mm-admin__error" role="alert">{error}</p> : null}
    {message ? <p className="mm-admin__helper" role="status">{message}</p> : null}
  </section>;
}

function DeliveryEndpointFields({ side, value, change, changeKind, searchPoints, allowCollectionMethodChoice = true }: { side: "collection" | "delivery"; value: CourierEndpoint; allowCollectionMethodChoice?: boolean;
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
  const title = side === "collection" ? "Collection details" : "Customer delivery";
  return <section className="mm-delivery__endpoint" aria-label={side === "collection" ? "Sender collection details" : "Customer delivery details"}>
    <h4>{title}</h4>{side === "collection" && allowCollectionMethodChoice ? <label className="mm-admin__field">Collection method
      <select name={`${side}.kind`} value={value.kind} onChange={event => changeKind(event.target.value as "door" | "pickup_point")}>
        <option value="door">Courier collects from an address</option>
        <option value="pickup_point">Zarina drops off at a locker or counter</option>
      </select></label> : side === "delivery" ? <p className="mm-admin__helper">The parcel is delivered to the customer’s home address.</p> : null}
    {value.kind === "pickup_point" && side === "delivery" ? <button type="button" className="mm-admin__secondary-button" onClick={() => changeKind("door")}>Enter customer’s home address</button> : null}
    {value.kind === "pickup_point" && side === "collection" ? <div className="mm-delivery__point-search">
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
      <p className="mm-admin__helper">Available couriers depend on the selected point.</p>
      {error ? <p role="alert" className="mm-admin__error">{error}</p> : null}
    </div> : value.kind === "door" ? <div className="mm-delivery__grid">{([
      ["company", "Company (optional)", false], ["line1", "Street address", true], ["line2", "Unit / building (optional)", false],
      ["suburb", "Suburb", true], ["city", "City", true], ["postalCode", "Postal code", true],
    ] as const).map(([key, label, required]) => <label className="mm-admin__field" key={key}>{label}<input name={`${side}.${key}`} required={required}
      maxLength={key === "postalCode" ? 4 : key === "company" ? 150 : key === "city" || key === "suburb" ? 100 : 180} inputMode={key === "postalCode" ? "numeric" : "text"}
      value={value.address[key]} autoComplete={`section-${side} ${key === "postalCode" ? "postal-code" : key === "city" ? "address-level2" : key === "line1" ? "address-line1" : key === "line2" ? "address-line2" : key === "company" ? "organization" : "address-level3"}`}
      onChange={event => change({ ...value, address: { ...value.address, [key]: event.target.value } })} /></label>)}
      <label className="mm-admin__field">Province<select name={`${side}.province`} value={value.address.province} autoComplete={`section-${side} address-level1`}
        onChange={event => change({ ...value, address: { ...value.address, province: event.target.value as CourierAddress["province"] } })}>{deliveryProvinces.map(province => <option key={province}>{province}</option>)}</select></label>
    </div> : null}
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
.mm-delivery__waybill-change{display:grid;gap:14px;margin-top:16px;padding-top:16px;border-top:1px solid var(--mm-border,#a69e95)}.mm-delivery__waybill-change p{margin:0}.mm-delivery__waybill-change button{min-height:44px;white-space:normal;text-align:left;justify-self:start;max-width:100%}.mm-delivery__history{margin:18px 0}.mm-delivery__history li{margin:10px 0}
.mm-delivery__contact summary,.mm-delivery__change-options>summary{min-height:44px;padding:12px 0;cursor:pointer;text-decoration:underline;font-size:13px}.mm-delivery__contact p{overflow-wrap:anywhere}.mm-delivery__change-options{border-top:1px solid var(--mm-border,#a69e95);margin-top:12px}
.mm-delivery__method-choices{display:grid;gap:8px;margin:12px 0;min-width:0}.mm-delivery__method-choices>button{width:100%;min-height:48px;white-space:normal;text-align:left;line-height:1.4}
.mm-delivery__schedule{margin:12px 0;padding:14px 0;border-top:1px solid var(--mm-border,#a69e95)}.mm-delivery__schedule h4{margin:0}.mm-delivery__schedule-summary{overflow-wrap:anywhere}.mm-delivery__schedule input{min-height:44px}
.mm-admin .mm-delivery__danger-button{border-color:#7a352b;color:#7a352b;background:transparent;min-height:48px}.mm-admin .mm-delivery__danger-button:disabled{opacity:.6;cursor:not-allowed}
.mm-admin__delivery-editor .mm-delivery__primary-action:disabled{background:var(--mm-soft,#e3e6de);color:var(--mm-muted,#62594f)!important;border:1px solid var(--mm-border,#a69e95);opacity:1;cursor:not-allowed}
.mm-delivery__action-hint{margin:0;font-size:13px;line-height:1.5}
@media(max-width:600px){.mm-admin__delivery-editor{padding:14px}.mm-delivery__grid{grid-template-columns:1fr}.mm-delivery__actions>button,.mm-delivery__waybill-change>button{width:100%;text-align:center}}
`;
// END_MM_DELIVERY_EDITOR

// BEGIN_MM_DELIVERY_PROGRESS
interface DeliveryProgressProps { current: 1 | 2 | 3 | 4; paused?: boolean }

function EmbeddedDeliveryProgress({ current, paused = false }: DeliveryProgressProps) {
  return <div className="mm-delivery__progress">
    <style dangerouslySetInnerHTML={{ __html: deliveryProgressCss }} />
    <ol aria-label="Delivery steps">{["Check details", "Box & weight", "Choose & book", "Print & track"].map((label, index) => <li key={label}
      aria-current={current === index + 1 ? "step" : undefined} aria-label={current === index + 1 ? `Step ${current} of 4: ${label}` : undefined} data-complete={!paused && index + 1 < current ? "true" : undefined}>
      <span className="mm-delivery__step-number" aria-hidden="true">{index + 1}</span><span>{label}</span>
    </li>)}</ol>
  </div>;
}

const deliveryProgressCss = `
.mm-delivery__progress{margin:16px 0;min-width:0}.mm-delivery__progress ol{display:grid;grid-template-columns:1fr;gap:8px;list-style:none;padding:0;margin:0}
.mm-delivery__progress li:not([aria-current=step]){display:none}.mm-delivery__progress li[aria-current=step] .mm-delivery__step-number::after{content:" / 4"}
.mm-delivery__progress li{display:flex;align-items:center;gap:7px;padding:10px 8px;border:1px solid var(--mm-border,#a69e95);font-size:12px;line-height:1.4;min-width:0;overflow-wrap:normal}
.mm-delivery__progress li[aria-current=step]{border-color:var(--mm-sage,#7d896d);background:var(--mm-soft,#e3e6de);font-weight:700;box-shadow:inset 0 -2px var(--mm-sage,#7d896d)}
.mm-delivery__step-number{flex:none;font-weight:700}.mm-delivery__progress li[data-complete=true] .mm-delivery__step-number{color:var(--mm-ink,#302a24)}
.mm-admin .mm-delivery__primary-action{min-height:48px;max-width:100%;white-space:normal;text-align:center;justify-self:start}
.mm-admin .mm-delivery__primary-action:disabled{opacity:1;background:var(--mm-soft,#e3e6de);border:1px solid var(--mm-border,#a69e95);color:var(--mm-muted,#62594f)!important;cursor:not-allowed}
@media(max-width:600px){.mm-admin .mm-delivery__primary-action{width:100%}}
`;
// END_MM_DELIVERY_PROGRESS

// BEGIN_MM_DELIVERY_STEP_FLOW
type DeliveryStep = 1 | 2 | 3 | 4;
interface DeliveryStepFlowProps {
  current: DeliveryStep;
  onReview: (step: 1 | 2) => void;
  children: [ReactNode, ReactNode, ReactNode, ReactNode];
  locked?: boolean;
}
const deliveryStepTitles = ["Delivery details", "Parcel", "Courier", "Waybill & tracking"];

function EmbeddedDeliveryStepFlow({ current, onReview, children, locked = false }: DeliveryStepFlowProps) {
  const active = useRef<HTMLDivElement>(null), previous = useRef(current);
  useEffect(() => {
    if (previous.current !== current) active.current?.focus({ preventScroll: true });
    previous.current = current;
  }, [current]);
  return <div className="mm-delivery__flow">
    <style dangerouslySetInnerHTML={{ __html: deliveryStepFlowCss }} />
    {!locked && (current === 2 || current === 3) ? <button type="button" className="mm-admin__secondary-button mm-delivery__back" onClick={() => onReview(current === 2 ? 1 : 2)}>{current === 2 ? "Edit delivery details" : "Back to parcel"}</button> : null}
    <div key={current} ref={active} tabIndex={-1} className="mm-delivery__active-step" data-delivery-step={current} role="region" aria-label={`Step ${current}: ${deliveryStepTitles[current - 1]}`}>
      {children[current - 1]}
    </div>
  </div>;
}

const deliveryStepFlowCss = `
.mm-delivery__flow{display:grid;gap:14px;min-width:0;overflow:clip}.mm-delivery__back{justify-self:start;min-height:44px}
.mm-delivery__active-step{min-width:0;outline:none;animation:mm-delivery-slide-in 180ms ease-out both}.mm-delivery__active-step:focus-visible{outline:2px solid var(--mm-sage,#7d896d);outline-offset:-2px}
.mm-delivery__active-step .mm-admin__delivery-editor{margin:0}.mm-delivery__active-step h4{margin:0 0 16px}.mm-delivery__step-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:18px}
.mm-delivery__flow .mm-delivery__check{display:flex;align-items:flex-start;gap:10px;min-height:44px;font-size:14px;line-height:1.5}.mm-delivery__flow .mm-delivery__check input{flex:none;width:20px;height:20px;margin:1px 0;padding:0}
@keyframes mm-delivery-slide-in{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
@media(prefers-reduced-motion:reduce){.mm-delivery__active-step{animation:none}}
@media(max-width:600px){.mm-delivery__step-actions>.mm-delivery__primary-action{width:100%}}
`;
// END_MM_DELIVERY_STEP_FLOW

// BEGIN_MM_DELIVERY_ADVANCED_SETTINGS
interface DeliveryAdvancedSettingsProps { children: ReactNode; needsAttention?: boolean }

function EmbeddedDeliveryAdvancedSettings({ children, needsAttention = false }: DeliveryAdvancedSettingsProps) {
  return <details className="mm-admin__technical mm-delivery__advanced" open={needsAttention ? true : undefined}>
    <style dangerouslySetInnerHTML={{ __html: `.mm-delivery__advanced{margin-top:18px;padding-top:14px;border-top:1px solid var(--mm-border,#a69e95);min-width:0;overflow-wrap:anywhere}.mm-delivery__advanced>summary{min-height:44px;align-content:center;cursor:pointer}.mm-delivery__advanced>summary:focus-visible{outline:3px solid var(--mm-sage,#7d896d);outline-offset:3px}` }} />
    <summary>Advanced settings{needsAttention ? " · needs attention" : ""}</summary>
    {children}
  </details>;
}
// END_MM_DELIVERY_ADVANCED_SETTINGS

// BEGIN_MM_ORDER_SYNC_STATUS
interface OrderSyncStatusProps {
  value: { status: string; message?: string; remoteOrderId?: string };
}

function EmbeddedOrderSyncStatus({ value }: OrderSyncStatusProps) {
  return <details aria-label="Bob Go order synchronisation" open={value.status === "Needs attention" ? true : undefined} style={{ margin: "16px 0", padding: "10px 0", overflowWrap: "anywhere", fontSize: 13 }}>
    <summary style={{ minHeight: 44, cursor: "pointer", alignContent: "center" }}>Sales-channel sync: <strong>{value.status}</strong></summary>
    {value.message ? <p className="mm-admin__helper" style={{ margin: "8px 0 0" }}>{value.message}</p> : null}
    {value.remoteOrderId ? <p className="mm-admin__helper" style={{ margin: "8px 0 0" }}>Bob Go order reference: {value.remoteOrderId}</p> : null}
  </details>;
}
// END_MM_ORDER_SYNC_STATUS

// BEGIN_MM_PARCEL_EDITOR
type ParcelValues = { weightGrams: string; lengthCm: string; widthCm: string; heightCm: string };
type SavedParcelPackage = { id: string; name: string; lengthCm: number; widthCm: number; heightCm: number };
interface ParcelEditorProps {
  value: ParcelValues; change: (value: ParcelValues) => void; disabled?: boolean;
  loadPackages: () => Promise<SavedParcelPackage[]>;
}

function EmbeddedParcelEditor({ value, change, disabled = false, loadPackages }: ParcelEditorProps) {
  const packedWeight = zarinaPackedReferences.find(item => String(item.grams) === value.weightGrams);
  const [manualWeight, setManualWeight] = useState(() => Boolean(value.weightGrams && !packedWeight));
  const weightChoice = manualWeight || value.weightGrams && !packedWeight ? "manual" : packedWeight ? String(packedWeight.grams) : "";
  const [packages, setPackages] = useState<SavedParcelPackage[]>([]), [selected, setSelected] = useState(() =>
    Number(value.lengthCm) === movingModestyBoxPreset.lengthCm && Number(value.widthCm) === movingModestyBoxPreset.widthCm && Number(value.heightCm) === movingModestyBoxPreset.heightCm ? movingModestyBoxPreset.id : "");
  const availablePackages: SavedParcelPackage[] = [movingModestyBoxPreset, ...packages];
  const [loading, setLoading] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState("");
  async function load() {
    setLoading(true); setError("");
    try { setPackages((await loadPackages()).map(item => ({ ...item, id: `bobgo:${item.id}` }))); setLoaded(true); }
    catch { setError("Saved boxes could not be loaded. You can still choose the Moving Modesty box or enter dimensions yourself."); }
    finally { setLoading(false); }
  }
  function choose(id: string) {
    setSelected(id); const item = availablePackages.find(entry => entry.id === id);
    if (item) change({ ...value, lengthCm: String(item.lengthCm), widthCm: String(item.widthCm), heightCm: String(item.heightCm) });
  }
  function chooseWeight(choice: string) {
    const preset = zarinaPackedReferences.find(item => String(item.grams) === choice);
    setManualWeight(choice === "manual");
    change({ ...value, weightGrams: preset ? String(preset.grams) : "" });
  }
  return <section className="mm-admin__parcel-editor" aria-label="Packed parcel">
    <h4>2. Check the parcel</h4>
    <style dangerouslySetInnerHTML={{ __html: `.mm-admin__packing-reference{margin:14px 0;font-size:13px}.mm-admin__packing-reference summary{min-height:44px;padding:12px 0;cursor:pointer}.mm-admin__packing-reference dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 14px}.mm-admin__packing-reference dt,.mm-admin__packing-reference dd{margin:0}.mm-admin__packing-reference dd{white-space:nowrap}.mm-admin__parcel-editor>button{max-width:100%;white-space:normal}` }} />
    <label className="mm-admin__field">Choose a box<select value={selected} disabled={disabled || loading} onChange={event => choose(event.target.value)}>
      <option value="">Enter dimensions myself</option><option value={movingModestyBoxPreset.id}>{movingModestyBoxPreset.name} · {movingModestyBoxPreset.lengthCm} × {movingModestyBoxPreset.widthCm} × {movingModestyBoxPreset.heightCm} cm</option>
      {packages.length ? <optgroup label="Saved in Bob Go">{packages.map(item => <option key={item.id} value={item.id}>{item.name} · {item.lengthCm} × {item.widthCm} × {item.heightCm} cm</option>)}</optgroup> : null}
    </select></label>
    <p className="mm-admin__helper">Up to 2 scarves per box.</p>
    {selected ? <button type="button" className="mm-admin__text-button" disabled={disabled} onClick={() => setSelected("")}>Change dimensions</button> :
      <div className="mm-admin__parcel-grid">{([["lengthCm", "Length (cm)"], ["widthCm", "Width (cm)"], ["heightCm", "Height (cm)"]] as const).map(([key, label]) =>
        <label className="mm-admin__field" key={key}>{label}<input type="number" required min={0.01} max={150} step={0.01} inputMode="decimal" value={value[key]} disabled={disabled} onChange={event => change({ ...value, [key]: event.target.value })} /></label>)}</div>}
    <label className="mm-admin__field">Choose a packed weight<select name="packedWeightPreset" value={weightChoice} required disabled={disabled} onChange={event => chooseWeight(event.target.value)}>
      <option value="" disabled>Choose a weight</option>
      {zarinaPackedReferences.map(item => <option key={item.label} value={String(item.grams)}>{item.label} · {item.approximate ? "≈ " : ""}{item.grams} g</option>)}
      <option value="manual">Enter weight manually</option>
    </select></label>
    {weightChoice === "manual" ? <label className="mm-admin__field">Weight of sealed parcel (g)<input type="number" required min={1} max={30000} step={1} inputMode="numeric" disabled={disabled} value={value.weightGrams} onChange={event => change({ ...value, weightGrams: event.target.value })} /></label> : null}
    <p className="mm-admin__helper">Includes the box and packaging. Check your sealed parcel.</p>
    {weightChoice !== "manual" && packedWeight?.approximate ? <p className="mm-admin__helper" role="status">305 g is approximate. Enter the actual weight manually if it differs.</p> : null}
    <p className="mm-admin__helper">This form quotes one parcel; extra boxes must also be included in the courier booking.</p>
    <details className="mm-admin__packing-reference"><summary>Other saved boxes (optional)</summary>
      {!loaded || error ? <button type="button" className="mm-admin__secondary-button" disabled={disabled || loading} onClick={() => { void load(); }}>{loading ? "Loading boxes…" : error ? "Retry saved boxes" : "Load saved Bob Go boxes"}</button> : null}
      {loaded ? <p className="mm-admin__helper">{packages.length ? "Saved boxes are now available in Choose a box above." : "No other saved boxes were found. You can still use the Moving Modesty box or enter dimensions yourself."}</p> : null}
      {error ? <p role="status" className="mm-admin__helper">{error}</p> : null}
    </details>
  </section>;
}
// END_MM_PARCEL_EDITOR

// BEGIN_MM_SHIPPING_WEIGHT_SETTINGS
type ShippingWeightRow = { id: string; product: string; colour: string; size: string; grams: number | null };
interface ShippingWeightSettingsProps {
  request: (changes?: Array<{ id: string; expectedGrams: number | null; grams: number | null }>) => Promise<ShippingWeightRow[]>;
}
function EmbeddedShippingWeightSettings({ request }: ShippingWeightSettingsProps) {
  const [rows, setRows] = useState<ShippingWeightRow[] | null>(null), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState(""), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  async function load() {
    setBusy(true); setError("");
    try { const saved = await request(); setRows(saved); setDrafts(Object.fromEntries(saved.map(row => [row.id, row.grams === null ? "" : String(row.grams)]))); setRevision(value => value + 1); setConfirmed(false); setMessage(""); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Weights could not be loaded."); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setError(""); setMessage("");
    const changes = (rows || []).map(row => { const raw = String(form.get(row.id) || "").trim(); return { id: row.id, expectedGrams: row.grams, grams: raw ? Number(raw) : null }; }).filter(row => row.grams !== row.expectedGrams);
    if (changes.some(row => row.grams !== null && (!Number.isInteger(row.grams) || row.grams < 1 || row.grams > 30000))) { setError("Enter measured whole grams between 1 and 30000."); return; }
    if (!form.has("confirmed")) return;
    if (!changes.length) { setMessage("No weights changed."); return; }
    setBusy(true);
    try { const saved = await request(changes); setRows(saved); setDrafts(Object.fromEntries(saved.map(row => [row.id, row.grams === null ? "" : String(row.grams)]))); setRevision(value => value + 1); setConfirmed(false); setMessage("Measured weights saved."); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Weights could not be saved."); }
    finally { setBusy(false); }
  }
  function fillMeasuredWeights() {
    setDrafts(current => Object.fromEntries((rows || []).map(row => {
      const measured = zarinaProductMeasurement(row.product, row.size);
      return [row.id, measured ? String(measured.productGrams) : current[row.id] ?? ""];
    })));
    setConfirmed(false); setError(""); setMessage("Zarina’s product-only weights filled in. Review the values, confirm them, then save. Nothing has been saved yet.");
  }
  return <details className="mm-delivery__private mm-admin__weight-settings"><summary>Product weights (without packaging)</summary>
    <style dangerouslySetInnerHTML={{ __html: `.mm-admin__weight-settings{margin-top:18px;padding-top:14px;border-top:1px solid var(--mm-border,#a69e95)}.mm-admin__weight-settings summary{cursor:pointer}.mm-admin__weight-settings .mm-admin__field{display:grid;gap:6px;min-width:0}.mm-admin__weight-settings .mm-admin__field input{width:100%;box-sizing:border-box}.mm-admin__weight-settings .mm-delivery__check{display:flex;align-items:flex-start;gap:10px}.mm-admin__weight-settings .mm-delivery__check input{flex:none;width:20px;height:20px}.mm-admin__weight-settings .mm-delivery__actions{display:flex;flex-wrap:wrap;gap:12px}` }} />
    <p className="mm-admin__helper">Product weights for sales-channel orders, not the packed parcel. Save each scarf’s weight without its box. Leave unknown weights blank.</p>
    <p className="mm-admin__helper">Zarina’s measured product weights: {zarinaProductMeasurements.map(row => `${row.product} ${row.size}: ${row.productGrams}g`).join(" · ")}. These exclude the box.</p>
    {!rows ? <button type="button" className="mm-admin__secondary-button" disabled={busy} onClick={() => { void load(); }}>{busy ? "Loading…" : "Load product weights"}</button> : <form key={revision} onSubmit={save}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}>
        <button type="button" className="mm-admin__secondary-button" disabled={!rows.some(row => zarinaProductMeasurement(row.product, row.size))} onClick={fillMeasuredWeights}>Fill Zarina’s measured weights</button>
        {rows.map(row => <label className="mm-admin__field" key={row.id}>{row.product} · {row.colour} · {row.size} (g)<input name={row.id} type="number" min={1} max={30000} step={1} inputMode="numeric" value={drafts[row.id] ?? ""} onChange={event => { setDrafts(current => ({ ...current, [row.id]: event.target.value })); setConfirmed(false); }} /></label>)}
        <label className="mm-delivery__check"><input type="checkbox" name="confirmed" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />These are measured individual product weights.</label>
        <div className="mm-delivery__actions"><button type="submit" className="mm-admin__secondary-button" disabled={busy || !confirmed}>{busy ? "Saving…" : "Save product weights"}</button><button type="button" className="mm-admin__text-button" disabled={busy} onClick={() => { void load(); }}>Reload saved weights</button></div>
      </fieldset></form>}
    {error ? <p role="alert" className="mm-admin__error">{error}</p> : null}{message ? <p role="status" className="mm-admin__helper">{message}</p> : null}
  </details>;
}
// END_MM_SHIPPING_WEIGHT_SETTINGS

// BEGIN_MM_TECHNICAL_ALERTS
interface TechnicalIncident {
  id: string;
  reference: string;
  orderNumber: string | null;
  source: string;
  operation: string;
  code: string;
  summary: string;
  severity: string;
  environment: string;
  httpStatus: number | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}
interface TechnicalAlertsData {
  incidents: TechnicalIncident[];
  counts: { open: number; resolved: number };
  pagination: { page: number; pageSize: number; hasMore: boolean };
}
interface TechnicalAlertsProps {
  load: (status: "open" | "resolved", page: number) => Promise<TechnicalAlertsData>;
  resolve: (incident: TechnicalIncident) => Promise<void>;
  close: () => void;
}

function technicalAlertTitle(incident: TechnicalIncident) {
  const names: Record<string, string> = {
    admin_login: "Admin sign-in", admin_auth: "Admin access", admin_logout: "Admin sign-out",
    admin_load: "Loading the admin portal", admin_update: "Saving admin changes", admin_product: "Product update",
    checkout_save: "Saving checkout", checkout_recover: "Recovering checkout",
    payment_start: "Starting payment", payment_notify: "Payment verification", payment_return: "Payment return",
    courier_quote: "Courier quote", courier_book: "Waybill booking", courier_cancel: "Waybill cancellation",
    courier_connection: "Bob Go connection", courier_sync: "Sales-channel sync", courier_tracking: "Courier tracking",
    courier_refresh: "Shipment status check", courier_waybill: "Waybill PDF", courier_webhook: "Tracking update",
    email_send: "Sending email", email_webhook: "Email delivery update", contact_send: "Contact form",
    server_request: "Website service", browser_admin: "Admin connection", browser_checkout: "Checkout connection", browser_contact: "Contact form connection",
  };
  return names[incident.operation] || ({ admin: "Admin portal", courier: "Bob Go delivery", payment: "Payment", email: "Email", checkout: "Checkout", browser: "Browser connection", contact: "Contact form" }[incident.source]) || "Website service";
}
function technicalAlertDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : new Intl.DateTimeFormat("en-ZA", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Johannesburg",
  }).format(date) + " SAST";
}

function EmbeddedTechnicalAlerts({ load, resolve, close }: TechnicalAlertsProps) {
  const titleId = useId(), descriptionId = useId(), confirmationId = useId();
  const dialog = useRef<HTMLDialogElement>(null), detailHeading = useRef<HTMLHeadingElement>(null), confirmationHeading = useRef<HTMLHeadingElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null), listHeading = useRef<HTMLDivElement>(null);
  const mounted = useRef(true), pending = useRef(false), wasConfirming = useRef(false);
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [page, setPage] = useState(0), [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<TechnicalAlertsData | null>(null), [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<TechnicalIncident | null>(null);
  const [reviewed, setReviewed] = useState(false), [confirming, setConfirming] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");

  useEffect(() => {
    mounted.current = true;
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => { mounted.current = false; if (node?.open) node.close(); };
  }, []);
  useEffect(() => {
    let active = true;
    // Keep late responses from a closed dialog or previous filter out of view.
    Promise.resolve().then(async () => {
      if (!active) return;
      setLoading(true); setError(""); setSelected(null); setReviewed(false); setConfirming(false);
      const result = await load(status, page);
      if (active) setData(result);
    }).catch(() => {
      if (active) { setData(null); setError("Alerts could not be loaded. Refresh to try again."); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load, status, page, refresh]);
  useEffect(() => { if (selected) detailHeading.current?.focus(); }, [selected]);
  useEffect(() => {
    if (confirming) confirmationHeading.current?.focus();
    else if (wasConfirming.current) reviewButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  function showList() {
    setSelected(null); setReviewed(false); setConfirming(false); setError("");
    listHeading.current?.focus();
  }
  async function confirmResolution() {
    if (!selected || selected.resolvedAt || !reviewed || !confirming || pending.current || loading) return;
    pending.current = true; setSaving(true); setError("");
    try {
      await resolve(selected);
      if (!mounted.current) return;
      setNotice("Alert marked as resolved. Its history is kept under Resolved.");
      setSelected(null); setReviewed(false); setConfirming(false); setPage(0); setRefresh(value => value + 1);
      listHeading.current?.focus();
    } catch (reason) {
      if (!mounted.current) return;
      setError(reason instanceof Error ? reason.message : "Resolution could not be confirmed. Refresh and check the alert before trying again.");
      setReviewed(false); setConfirming(false);
    } finally { pending.current = false; if (mounted.current) setSaving(false); }
  }
  const disabled = loading || saving;
  return <dialog className="mm-admin__dialog mm-admin__alerts" ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { if (pending.current) event.preventDefault(); else close(); }}
    onClick={event => {
      if (event.target !== event.currentTarget || pending.current) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
    <div className="mm-admin__settings-heading">
      <h2 id={titleId}>Technical alerts</h2>
      <button type="button" className="mm-admin__text-button" autoFocus disabled={saving} onClick={close}>Close</button>
    </div>
    <p id={descriptionId} className="mm-admin__helper">Review recorded website issues. Resolving an alert keeps its history; it does not repair the problem.</p>
    <div className="mm-admin__alerts-toolbar" ref={listHeading} tabIndex={-1} aria-label="Alert filters">
      <div className="mm-admin__alerts-filters" role="group" aria-label="Alert status">
        {(["open", "resolved"] as const).map(value => <button key={value} type="button" className={status === value ? "mm-admin__button" : "mm-admin__secondary-button"}
          aria-pressed={status === value} disabled={saving} onClick={() => { setStatus(value); setPage(0); showList(); setNotice(""); }}>
          {value === "open" ? "Open" : "Resolved"}{data ? ` (${data.counts[value]})` : ""}
        </button>)}
      </div>
      <button type="button" className="mm-admin__text-button" disabled={disabled} onClick={() => { setRefresh(value => value + 1); setNotice(""); }}>{loading ? "Loading…" : "Refresh alerts"}</button>
    </div>
    {notice ? <p role="status" className="mm-admin__notice">{notice}</p> : null}
    {error ? <div role="alert" className="mm-admin__alerts-error"><p className="mm-admin__error">{error}</p>
      <button type="button" className="mm-admin__secondary-button" disabled={disabled} onClick={() => setRefresh(value => value + 1)}>Refresh and review</button></div> : null}
    <div aria-busy={disabled}>
    {loading ? <p role="status">Loading alerts…</p> : selected ? <section className="mm-admin__alert-detail">
      <button type="button" className="mm-admin__text-button" disabled={saving} onClick={showList}>Back to alerts</button>
      <div className="mm-admin__alerts-heading"><h3 tabIndex={-1} ref={detailHeading}>{technicalAlertTitle(selected)}</h3><span className="mm-admin__alert-status">{selected.resolvedAt ? "Resolved" : "Open"}</span></div>
      <p>{selected.summary}</p>
      <dl className="mm-admin__alert-facts">
        <div><dt>Last recorded</dt><dd>{technicalAlertDate(selected.lastSeenAt)}</dd></div>
        <div><dt>First recorded</dt><dd>{technicalAlertDate(selected.firstSeenAt)}</dd></div>
        <div><dt>Occurrences</dt><dd>{selected.occurrences}</dd></div>
        <div><dt>Environment</dt><dd>{selected.environment === "production" ? "Live website" : selected.environment}</dd></div>
        <div><dt>Level</dt><dd>{selected.severity}</dd></div>
        <div><dt>Related order</dt><dd>{selected.orderNumber || "General website alert"}</dd></div>
        {selected.resolvedAt ? <div><dt>Resolved</dt><dd>{technicalAlertDate(selected.resolvedAt)}</dd></div> : null}
      </dl>
      <details className="mm-admin__technical"><summary>Support reference & technical details</summary>
        <dl className="mm-admin__alert-facts">
          <div><dt>Reference</dt><dd>{selected.reference}</dd></div><div><dt>Operation</dt><dd>{selected.operation}</dd></div>
          <div><dt>Error code</dt><dd>{selected.code}</dd></div>
          {selected.httpStatus ? <div><dt>HTTP status</dt><dd>{selected.httpStatus}</dd></div> : null}
        </dl>
      </details>
      {!selected.resolvedAt ? <div className="mm-admin__alert-resolution">
        <p className="mm-admin__helper">Check that this issue is no longer happening before resolving it. If it happens again, it will reopen.</p>
        <label className="mm-admin__courier-check"><input type="checkbox" checked={reviewed} disabled={saving || confirming || Boolean(error)} onChange={event => setReviewed(event.target.checked)} />I have checked this issue.</label>
        {confirming ? <section className="mm-admin__alert-confirmation" aria-labelledby={confirmationId}>
          <h4 tabIndex={-1} ref={confirmationHeading} id={confirmationId}>Mark this alert as resolved?</h4>
          <p>This only updates the alert. It does not change orders, payments or waybills.</p>
          <div className="mm-admin__alerts-actions">
            <button type="button" className="mm-admin__secondary-button" disabled={saving} onClick={() => { setConfirming(false); reviewButton.current?.focus(); }}>Keep open</button>
            <button type="button" className="mm-admin__button" disabled={saving} onClick={confirmResolution}>{saving ? "Resolving…" : "Confirm resolution"}</button>
          </div>
        </section> : <button type="button" ref={reviewButton} className="mm-admin__button" disabled={!reviewed || disabled || Boolean(error)} onClick={() => setConfirming(true)}>Mark as resolved</button>}
      </div> : null}
    </section> : data && !error ? <>
      {data.incidents.length ? <ul className="mm-admin__alerts-list">{data.incidents.map(incident => <li key={incident.id}>
        <div className="mm-admin__alerts-heading"><h3>{technicalAlertTitle(incident)}</h3><span className="mm-admin__alert-status">{incident.resolvedAt ? "Resolved" : "Open"} · {incident.severity}</span></div>
        <p>{incident.summary}</p><p className="mm-admin__helper">{technicalAlertDate(incident.lastSeenAt)} · {incident.occurrences} {incident.occurrences === 1 ? "occurrence" : "occurrences"}</p>
        <button type="button" className="mm-admin__secondary-button" onClick={() => { setSelected(incident); setReviewed(false); setConfirming(false); setNotice(""); }}>Review alert</button>
      </li>)}</ul> : <p className="mm-admin__notice">{status === "open" ? "No open alerts." : "No resolved alerts yet."}</p>}
      {page > 0 || data.pagination.hasMore ? <nav className="mm-admin__alerts-actions" aria-label="Alert pages">
        <button type="button" className="mm-admin__secondary-button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</button>
        <span>Page {page + 1}</span><button type="button" className="mm-admin__secondary-button" disabled={!data.pagination.hasMore} onClick={() => setPage(value => value + 1)}>Next</button>
      </nav> : null}
    </> : null}
    </div>
  </dialog>;
}

const technicalAlertsCss = `
.mm-admin__alerts { width:min(680px,calc(100% - 32px)); box-sizing:border-box; font:inherit; line-height:1.5; }
.mm-admin__alerts *, .mm-admin__alerts *::before, .mm-admin__alerts *::after { box-sizing:border-box; }
.mm-admin__alerts > .mm-admin__helper { margin:12px 0 20px; }
.mm-admin__alerts-toolbar,.mm-admin__alerts-filters,.mm-admin__alerts-actions,.mm-admin__alerts-heading { display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
.mm-admin__alerts-toolbar,.mm-admin__alerts-heading { justify-content:space-between; }
.mm-admin__alerts-toolbar { margin-bottom:20px; }
.mm-admin__alerts-list { list-style:none; padding:0; margin:0; display:grid; gap:16px; }
.mm-admin__alerts-list li,.mm-admin__alert-confirmation { min-width:0; border:1px solid var(--mm-border); padding:18px; }
.mm-admin__alerts h3 { font:500 18px/1.35 Montserrat,Inter,sans-serif; margin:0; }
.mm-admin__alerts h4 { font:600 16px/1.4 Montserrat,Inter,sans-serif; margin:0 0 12px; }
.mm-admin__alerts .mm-admin__helper { color:var(--mm-ink); }
.mm-admin__alerts-list p,.mm-admin__alert-detail > p,.mm-admin__alert-resolution p { margin:12px 0; }
.mm-admin__alerts p,.mm-admin__alerts dd,.mm-admin__alerts h3 { overflow-wrap:anywhere; }
.mm-admin__alert-status { font-size:13px; font-weight:600; }
.mm-admin__alert-facts { display:grid; gap:12px; margin:20px 0; }
.mm-admin__alert-facts > div { display:grid; grid-template-columns:minmax(110px,1fr) minmax(0,2fr); gap:12px; }
.mm-admin__alert-facts dt { font-weight:600; }
.mm-admin__alert-facts dd { margin:0; }
.mm-admin__alert-resolution { border-top:1px solid var(--mm-border); margin-top:20px; padding-top:8px; }
.mm-admin__alert-confirmation { background:var(--mm-soft); margin-top:16px; }
.mm-admin__alerts-actions { margin-top:16px; }
.mm-admin__alerts button { min-height:44px; font:inherit; cursor:pointer; max-width:100%; white-space:normal; }
.mm-admin__alerts button:disabled { cursor:not-allowed; opacity:.5; }
.mm-admin__alerts :is(button,input,summary):focus-visible { outline:2px solid var(--mm-sage); outline-offset:3px; }
.mm-admin__alerts-error { margin:16px 0; }
@media(max-width:420px) { .mm-admin__alerts { padding:18px; } .mm-admin__alert-facts > div { grid-template-columns:1fr; gap:2px; } }
`;
// END_MM_TECHNICAL_ALERTS

// BEGIN_MM_ORDER_CARDS
interface OrderCardsProps<T extends { id: string }> {
  orders: T[];
  selectedId: string;
  onSelect: (id: string) => void;
  renderSummary: (order: T, expanded: boolean) => ReactNode;
  renderDetails: (close: () => void) => ReactNode;
  empty?: ReactNode;
}

// Display state only: no transport, order updates or courier actions.
function EmbeddedOrderCards<T extends { id: string }>({ orders, selectedId, onSelect, renderSummary, renderDetails, empty }: OrderCardsProps<T>) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusId = useRef("");
  useEffect(() => {
    if (selectedId || !returnFocusId.current) return;
    const trigger = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(".mm-admin__order-card") || [])
      .find(button => button.id === returnFocusId.current);
    returnFocusId.current = "";
    trigger?.focus({ preventScroll: true });
    trigger?.scrollIntoView?.({ behavior: "auto", block: "nearest" });
  }, [selectedId]);

  function close(id: string) {
    returnFocusId.current = `${baseId}-order-${encodeURIComponent(id)}`;
    onSelect("");
  }
  return <div className="mm-admin__order-list mm-admin__disclosure-list" ref={listRef}>
    <style dangerouslySetInnerHTML={{ __html: orderCardsCss }} />
    {!orders.length ? empty : null}
    {/* eslint-disable-next-line react-hooks/refs -- Render callbacks only attach close to buttons; refs are read in the effect, never while rendering. */}
    {orders.map(order => {
      const expanded = selectedId === order.id;
      const triggerId = `${baseId}-order-${encodeURIComponent(order.id)}`;
      const panelId = `${triggerId}-details`;
      return <div className="mm-admin__order-disclosure" key={order.id}>
        <button className={`mm-admin__order-card${expanded ? " is-selected" : ""}`} type="button" id={triggerId}
          aria-expanded={expanded} aria-controls={panelId} onClick={() => expanded ? close(order.id) : onSelect(order.id)}>
          {renderSummary(order, expanded)}
        </button>
        <div id={panelId} role="region" aria-labelledby={triggerId} hidden={!expanded}>
          {expanded ? renderDetails(() => close(order.id)) : null}
        </div>
      </div>;
    })}
  </div>;
}

const orderCardsCss = `
.mm-admin__disclosure-list { display:grid; gap:14px; background:transparent; }
.mm-admin__order-disclosure { min-width:0; border:1px solid var(--mm-border); background:var(--mm-surface); }
.mm-admin__order-disclosure > [hidden] { display:none; }
.mm-admin__order-disclosure .mm-admin__detail { border:0; border-top:1px solid var(--mm-border); }
.mm-admin__order-disclosure .mm-admin__order-card { min-height:44px; user-select:none; }
.mm-admin__order-summary-footer { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 14px; width:100%; min-width:0; }
.mm-admin__order-summary-footer .mm-admin__order-meta { overflow-wrap:anywhere; }
.mm-admin__order-toggle-label { color:var(--mm-ink); font-size:13px; font-weight:600; text-decoration:underline; text-underline-offset:3px; white-space:nowrap; }
.mm-admin__order-disclosure .mm-admin__close-details { display:block; align-self:flex-start; }
.mm-admin__order-disclosure :is(.mm-admin__order-card,.mm-admin__close-details):focus-visible { outline:2px solid var(--mm-sage); outline-offset:3px; }
`;
// END_MM_ORDER_CARDS
