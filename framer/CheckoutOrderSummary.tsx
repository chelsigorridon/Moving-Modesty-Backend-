import { addPropertyControls, ControlType, useIsStaticRenderer } from "framer"
import { startTransition, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react"

interface CartItem {
    id: string
    sku?: string
    productSlug?: string
    name: string
    colour: string
    size: string
    price: number
    priceLabel: string
    image: string
    quantity: number
}

interface Props {
    discountsEnabled?: boolean
    apiBaseUrl?: string
    surfaceColor: string
    textColor: string
    accentColor: string
    buttonTextColor: string
    borderColor: string
    style?: CSSProperties
}

type FulfilmentMethod = "delivery" | "collection" | "to_be_confirmed"

const CART_KEY = "moving-modesty-cart-v1"
const FULFILMENT_KEY = "moving-modesty-fulfilment-v2"
const FULFILMENT_EVENT = "moving-modesty-fulfilment-updated"
const DISCOUNT_CODE_KEY = "moving-modesty-discount-code-v1"
const DISCOUNT_EVENT = "moving-modesty-discount-updated"
const PAYMENT_ACTION_EVENT = "moving-modesty-checkout-pay"
const PAYMENT_STATE_EVENT = "moving-modesty-checkout-payment-state"
const PAYMENT_STATE_REQUEST_EVENT = "moving-modesty-checkout-payment-state-request"
interface PaymentActionState {
    connected: boolean
    atPayment: boolean
    disabled: boolean
    label: string
}
type DiscountQuote = { subtotal: number; deliveryFee: number; total: number; discountAmount: number; discountSnapshot?: { code: string } | null; fingerprint: string }
function summarySku(item: CartItem) {
    if (item.sku) return item.sku
    const identity = `${item.productSlug || ""} ${item.name}`.toLowerCase()
    const colour = String(item.colour || "").toLowerCase()
    const base = identity.includes("amina") ? (colour.includes("lavender") ? "AMINA-LAV" : colour.includes("lilac") ? "AMINA-LIL" : "AMINA-BLK")
        : identity.includes("hawa") ? (colour.includes("pink") ? "HAWA-PNK" : colour.includes("sage") ? "HAWA-SGE" : colour.includes("grey") || colour.includes("gray") ? "HAWA-GRY" : "HAWA-BLK") : ""
    const size = String(item.size || "").trim().toLowerCase()
    const suffix = size === "small" ? "S" : size === "large" ? "L" : size.includes("one size") ? "OS" : size.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase()
    return base && suffix ? `${base}-${suffix}` : ""
}
function discountFingerprint(cart: CartItem[], method: FulfilmentMethod) {
    return JSON.stringify({ method, items: cart.map(item => [summarySku(item), item.quantity, item.price]).sort() })
}
function storedDiscountCode() {
    try { return window.sessionStorage.getItem(DISCOUNT_CODE_KEY) || "" } catch { return "" }
}
function storeDiscountCode(code: string) {
    try { if (code) window.sessionStorage.setItem(DISCOUNT_CODE_KEY, code); else window.sessionStorage.removeItem(DISCOUNT_CODE_KEY) } catch { /* The order save remains server validated. */ }
    window.dispatchEvent(new CustomEvent(DISCOUNT_EVENT))
}
const STANDARD_DELIVERY_FEE = 99
const FREE_DELIVERY_THRESHOLD = 1200
const previewItems: CartItem[] = [{
    id: "checkout-preview",
    name: "Hawa Tri-Instant Scarf — Black",
    colour: "Black",
    size: "Small",
    price: 450,
    priceLabel: "R 450.00",
    image: "https://framerusercontent.com/images/i6owtTY1yDSiItsUFxWH0UF63zg.jpg",
    quantity: 1,
}]

function normalizeImage(value: unknown): string {
    if (!value) return ""
    if (typeof value === "string") return value
    if (typeof value !== "object") return ""

    const image = value as {
        src?: unknown
        url?: unknown
        value?: unknown
        fieldData?: Record<string, unknown>
    }
    if (typeof image.src === "string") return image.src
    if (typeof image.url === "string") return image.url
    if (image.value) {
        const nested = normalizeImage(image.value)
        if (nested) return nested
    }
    if (image.fieldData) {
        for (const nestedValue of Object.values(image.fieldData)) {
            const nested = normalizeImage(nestedValue)
            if (nested) return nested
        }
    }
    return ""
}

function readCart(): CartItem[] {
    if (typeof window === "undefined") return []
    try {
        const value = window.localStorage.getItem(CART_KEY)
        if (!value) return []
        const parsed = JSON.parse(value)
        return Array.isArray(parsed)
            ? normalizeStorefrontCart(parsed
                  .filter((item) => item && typeof item.id === "string")
                  .map((item) => ({ ...item, image: normalizeImage(item.image) })))
            : []
    } catch {
        return []
    }
}

function readFulfilmentMethod(): FulfilmentMethod {
    if (typeof window === "undefined") return "to_be_confirmed"
    try {
        const method = window.localStorage.getItem(FULFILMENT_KEY)
        return method === "collection" || method === "delivery" ? method : "to_be_confirmed"
    } catch {
        return "to_be_confirmed"
    }
}

function formatMoney(value: number): string {
    return "R" + value.toFixed(2)
}

function baseName(name: string): string {
    const value = String(name || "Scarf")
    const parts = value.split(/[—–]/)
    if (parts.length > 1) return parts[0].trim()
    return value.split(" - ")[0].trim()
}

function LockIcon() {
    return (
        <svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true">
            <rect x="3.5" y="8" width="11" height="7.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M6 8V5.8a3 3 0 0 1 6 0V8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
    )
}

function Placeholder() {
    return (
        <svg viewBox="0 0 60 72" width="36" height="44" aria-hidden="true">
            <path d="M12 56c9-15 13-31 10-45 15 6 25 18 28 36-12-2-24 1-38 9Z" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M20 18c9 8 14 18 18 30" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
    )
}

/**
 * @framerSupportedLayoutWidth any-prefer-fixed
 * @framerSupportedLayoutHeight auto
 */
export default function CheckoutOrderSummary(props: Props) {
    const {
        surfaceColor = "#FFFFFF",
        textColor = "#332B25",
        accentColor = "#536047",
        buttonTextColor = "#EAE6E3",
        borderColor = "rgba(51, 43, 37, 0.18)",
        discountsEnabled = false,
        apiBaseUrl = "https://movingmodesty.vercel.app",
        style,
    } = props
    const isStatic = useIsStaticRenderer()
    const [items, setItems] = useState<CartItem[]>([])
    const [fulfilmentMethod, setFulfilmentMethod] = useState<FulfilmentMethod>("to_be_confirmed")
    const [compact, setCompact] = useState(false)
    const [open, setOpen] = useState(true)
    const [code, setCode] = useState("")
    const [appliedCode, setAppliedCode] = useState("")
    const [discountQuote, setDiscountQuote] = useState<DiscountQuote | null>(null)
    const [discountError, setDiscountError] = useState("")
    const [checkingCode, setCheckingCode] = useState(false)
    const [paymentAction, setPaymentAction] = useState<PaymentActionState>({ connected: false, atPayment: false, disabled: true, label: "Pay securely" })
    const discountInputId = useId()
    const paymentHelpId = useId()
    const paymentButton = useRef<HTMLButtonElement | null>(null)
    const paymentEntryFocused = useRef(false)
    const discountRequest = useRef<AbortController | null>(null)
    const recoveredOrder = useRef(false)
    const currentFingerprint = useRef("")
    const fingerprint = discountFingerprint(items, fulfilmentMethod)
    currentFingerprint.current = fingerprint

    useEffect(() => {
        if (isStatic || typeof window === "undefined") return
        const receivePaymentState = (event: Event) => {
            const state = (event as CustomEvent<PaymentActionState>).detail
            if (!state || typeof state.label !== "string") return
            setPaymentAction({ connected: state.connected === true, atPayment: state.atPayment === true,
                disabled: state.disabled !== false, label: state.label })
        }
        window.addEventListener(PAYMENT_STATE_EVENT, receivePaymentState)
        // Either component may mount first; request the controller's current state.
        window.dispatchEvent(new CustomEvent(PAYMENT_STATE_REQUEST_EVENT))
        return () => window.removeEventListener(PAYMENT_STATE_EVENT, receivePaymentState)
    }, [isStatic])

    useEffect(() => {
        if (!paymentAction.atPayment) { paymentEntryFocused.current = false; return }
        if (isStatic || paymentAction.disabled || !paymentAction.connected || paymentEntryFocused.current) return
        const button = paymentButton.current
        if (!button) return
        paymentEntryFocused.current = true
        const rect = button.getBoundingClientRect()
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
            button.scrollIntoView({ behavior: "auto", block: "center" })
        }
        button.focus({ preventScroll: true })
    }, [isStatic, paymentAction])

    useEffect(() => {
        if (isStatic || typeof window === "undefined") return
        const refreshCode = () => { const saved = storedDiscountCode(); setAppliedCode(saved); setCode(saved) }
        const savedOrder = (event: Event) => {
            const order = (event as CustomEvent).detail
            if (!order || !Number.isFinite(Number(order.total))) return
            const method = order.fulfilmentMethod || order.method
            if (method && method !== readFulfilmentMethod()) return
            recoveredOrder.current = true
            const cart = readCart()
            const currentLines = cart.map(item => `${summarySku(item).toUpperCase()}:${item.quantity}`).sort()
            const savedLines = Array.isArray(order.items) ? order.items.map((item: { sku: string; quantity: number }) => `${item.sku.toUpperCase()}:${item.quantity}`).sort() : null
            if (!savedLines || JSON.stringify(currentLines) !== JSON.stringify(savedLines)) {
                discountRequest.current?.abort(); setDiscountQuote(null); setAppliedCode(""); storeDiscountCode(""); setCheckingCode(false)
                if (order.discountSnapshot?.code) setDiscountError("Your cart changed. Apply your discount again for this cart.")
                return
            }
            discountRequest.current?.abort()
            const savedCode = order.discountSnapshot?.code || ""
            setAppliedCode(savedCode); setCode(savedCode); setCheckingCode(false); setDiscountError("")
            setDiscountQuote({ subtotal: Number(order.subtotal), deliveryFee: Number(order.deliveryFee), total: Number(order.total),
                discountAmount: Number(order.discountAmount || 0), discountSnapshot: order.discountSnapshot,
                fingerprint: discountFingerprint(cart, readFulfilmentMethod()) })
        }
        refreshCode()
        window.addEventListener(DISCOUNT_EVENT, refreshCode)
        window.addEventListener("moving-modesty-order-updated", savedOrder)
        return () => { discountRequest.current?.abort(); window.removeEventListener(DISCOUNT_EVENT, refreshCode); window.removeEventListener("moving-modesty-order-updated", savedOrder) }
    }, [isStatic])

    async function checkDiscount(candidate: string, cart: CartItem[], method: FulfilmentMethod) {
        discountRequest.current?.abort()
        const controller = new AbortController()
        discountRequest.current = controller
        const requestedFingerprint = discountFingerprint(cart, method)
        const normalized = candidate.trim().toUpperCase()
        setCheckingCode(true); setDiscountError("")
        try {
            if (!normalized || !cart.length || cart.some(item => !summarySku(item))) throw new Error("Please check your code and cart.")
            const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/checkout/discount`, { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: normalized, fulfilmentMethod: method, items: cart.map(item => ({ sku: summarySku(item), quantity: item.quantity })) }),
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) })
            const result = await response.json().catch(() => null)
            if (!response.ok || !result?.quote) throw new Error(`${result?.error || "The code could not be checked. Try again."}${result?.errorRef ? ` Reference: ${result.errorRef}` : ""}`)
            if (controller.signal.aborted || currentFingerprint.current !== requestedFingerprint) return
            setDiscountQuote({ ...result.quote, fingerprint: requestedFingerprint }); setAppliedCode(normalized); setCode(normalized)
            storeDiscountCode(normalized)
        } catch (reason) {
            if (controller.signal.aborted || currentFingerprint.current !== requestedFingerprint) return
            setDiscountQuote(null); setAppliedCode(""); storeDiscountCode("")
            setDiscountError(reason instanceof Error ? reason.message : "The code could not be checked. Please try again.")
        } finally { if (discountRequest.current === controller) setCheckingCode(false) }
    }
    useEffect(() => {
        if (isStatic || !discountsEnabled || !appliedCode || !items.length) return
        if (discountQuote?.fingerprint === fingerprint && discountQuote.discountSnapshot?.code === appliedCode) return
        // The return handler restores the saved payment amount before a retry.
        // Do not reject a frozen discount simply because today's code is off.
        if (new URLSearchParams(window.location.search).has("payment") && !recoveredOrder.current) return
        void checkDiscount(appliedCode, items, fulfilmentMethod)
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Cart/code changes are the quote invalidation boundary.
    }, [fingerprint, appliedCode, discountsEnabled, isStatic, apiBaseUrl])

    useEffect(() => {
        if (isStatic || typeof window === "undefined") return
        const refreshCart = () => setItems(readCart())
        const refreshFulfilment = () => setFulfilmentMethod(readFulfilmentMethod())
        const handleFulfilmentChange = (event: Event) => {
            const method = (event as CustomEvent<FulfilmentMethod>).detail
            setFulfilmentMethod(method === "collection" || method === "delivery" ? method : "to_be_confirmed")
        }
        const handleStorage = (event: StorageEvent) => {
            if (!event.key || event.key === CART_KEY) refreshCart()
            if (!event.key || event.key === FULFILMENT_KEY) refreshFulfilment()
        }

        refreshCart()
        refreshFulfilment()
        window.addEventListener("storage", handleStorage)
        window.addEventListener("moving-modesty-cart-updated", refreshCart as EventListener)
        window.addEventListener(FULFILMENT_EVENT, handleFulfilmentChange)
        return () => {
            window.removeEventListener("storage", handleStorage)
            window.removeEventListener("moving-modesty-cart-updated", refreshCart as EventListener)
            window.removeEventListener(FULFILMENT_EVENT, handleFulfilmentChange)
        }
    }, [isStatic])

    useEffect(() => {
        if (isStatic || typeof window === "undefined") return
        const query = window.matchMedia("(max-width: 899px)")
        const update = () => {
            startTransition(() => {
                setCompact(query.matches)
                setOpen(!query.matches)
            })
        }
        update()
        query.addEventListener("change", update)
        return () => query.removeEventListener("change", update)
    }, [isStatic])

    const displayedItems = isStatic ? previewItems : items
    const subtotal = useMemo(
        () => displayedItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0),
        [displayedItems]
    )

    const isCollection = fulfilmentMethod === "collection"
    const isDelivery = fulfilmentMethod === "delivery"
    const qualifiesForFreeDelivery = subtotal >= FREE_DELIVERY_THRESHOLD
    const deliveryFee = !isDelivery || subtotal <= 0 || qualifiesForFreeDelivery ? 0 : STANDARD_DELIVERY_FEE
    const validatedQuote = discountQuote?.fingerprint === fingerprint && discountQuote.discountSnapshot?.code === appliedCode ? discountQuote : null
    const discountAmount = validatedQuote?.discountAmount || 0
    const total = validatedQuote?.total ?? subtotal + deliveryFee
    const css = [
        ".mm-checkout-order-item{display:grid;grid-template-columns:84px minmax(0,1fr);gap:16px;padding:20px 0;border-bottom:1px solid var(--checkout-border)}",
        ".mm-checkout-order-image{width:84px;height:104px}",
        ".mm-checkout-summary-toggle{width:100%;min-height:48px;align-items:center;justify-content:space-between;padding:0 0 18px;border:0;border-bottom:1px solid var(--checkout-border);background:transparent;color:inherit;font:500 15px/1.2 Jost,Arial,sans-serif;cursor:pointer}",
        ".mm-checkout-summary-toggle:focus-visible{outline:2px solid currentColor;outline-offset:3px}",
        ".mm-checkout-summary-content[data-hidden=true]{display:none}",
        ".mm-checkout-pay{display:flex;width:100%;min-height:53px;box-sizing:border-box;align-items:center;justify-content:center;padding:17px 20px;border:0;border-radius:0;font:700 19px/1.2 Jost,Arial,sans-serif;cursor:pointer;transition:filter .18s ease,transform .18s ease}",
        ".mm-checkout-pay:hover:not(:disabled){filter:brightness(.94)}.mm-checkout-pay:active:not(:disabled){transform:translateY(1px)}.mm-checkout-pay:focus-visible{outline:2px solid currentColor;outline-offset:3px}.mm-checkout-pay:disabled:not([data-preview=true]){opacity:.6;cursor:not-allowed}",
        ".mm-checkout-payment-help,.mm-checkout-security-note{margin:10px 0 0;font-size:13px;line-height:1.45;text-align:center}.mm-checkout-security-note{display:flex;align-items:center;justify-content:center;gap:6px}",
        "@media(prefers-reduced-motion:reduce){.mm-checkout-pay{transition:none}}",
        ".mm-checkout-discount{margin-top:24px;font-size:14px}.mm-checkout-discount label{display:block;margin-bottom:8px}.mm-checkout-discount-controls{display:flex;gap:8px}.mm-checkout-discount input{min-width:0;width:100%;padding:10px;border:1px solid var(--checkout-border);font:inherit;color:inherit;background:transparent}.mm-checkout-discount button{min-height:44px;padding:8px 14px;border:1px solid var(--checkout-border);font:inherit;color:inherit;background:transparent;cursor:pointer}.mm-checkout-discount button:disabled{opacity:.55;cursor:not-allowed}.mm-checkout-discount input:focus-visible,.mm-checkout-discount button:focus-visible{outline:2px solid currentColor;outline-offset:2px}",
        "@container (max-width:420px){.mm-checkout-order-item{grid-template-columns:72px minmax(0,1fr);gap:13px}.mm-checkout-order-image{width:72px;height:88px}}",
    ].join("")

    return (
        <aside
            style={{
                ...style,
                position: "relative",
                width: "100%",
                containerType: "inline-size",
                padding: 30,
                boxSizing: "border-box",
                border: "1px solid " + borderColor,
                background: surfaceColor,
                color: textColor,
                fontFamily: "Jost, Arial, sans-serif",
                "--checkout-border": borderColor,
            } as CSSProperties}
            aria-label="Your order"
        >
            <style>{css}</style>
            {compact ? (
                <button
                    className="mm-checkout-summary-toggle"
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpen((current) => !current)}
                    style={{ display: "flex" }}
                >
                    <span>{open ? "Hide" : "Show"} order summary</span>
                    <strong style={{ fontSize: 17, fontWeight: 500 }}>{formatMoney(total)}</strong>
                </button>
            ) : null}

            <div className="mm-checkout-summary-content" data-hidden={compact && !open ? "true" : "false"}>
                <h2 style={{ margin: compact ? "22px 0 0" : 0, fontFamily: "Montserrat, Arial, sans-serif", fontSize: 25, lineHeight: 1.15, fontWeight: 400, letterSpacing: ".055em", textTransform: "uppercase" }}>
                    Your order
                </h2>

            {displayedItems.length === 0 ? (
                <p style={{ margin: "22px 0", fontSize: 15, lineHeight: 1.55 }}>Your cart is currently empty.</p>
            ) : (
                <div style={{ marginTop: 8 }}>
                    {displayedItems.map((item) => (
                        <div className="mm-checkout-order-item" key={item.id}>
                            <div
                                className="mm-checkout-order-image"
                                role={item.image ? undefined : "img"}
                                aria-label={item.image ? undefined : item.name + " image unavailable"}
                                style={{ display: "grid", placeItems: "center", overflow: "hidden", background: "#E4E0DC", color: "rgba(51,43,37,.38)" }}
                            >
                                {item.image ? (
                                    <img src={item.image} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "contain", objectPosition: "center" }} />
                                ) : (
                                    <Placeholder />
                                )}
                            </div>
                            <div style={{ minWidth: 0 }}>
                                <h3 style={{ margin: 0, fontFamily: "Montserrat, Arial, sans-serif", fontSize: 17, lineHeight: 1.25, fontWeight: 500, letterSpacing: ".025em", textTransform: "uppercase" }}>
                                    {baseName(item.name)}
                                </h3>
                                <p style={{ margin: "7px 0 0", fontSize: 14, lineHeight: 1.4 }}>
                                    {[item.colour, item.size].filter(Boolean).join(" · ")}
                                </p>
                                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 12, fontSize: 14 }}>
                                    <span>Qty {item.quantity}</span>
                                    <strong style={{ fontWeight: 500 }}>{formatMoney(item.price * item.quantity)}</strong>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {discountsEnabled ? <div className="mm-checkout-discount" role="group" aria-label="Discount code">
                <label htmlFor={discountInputId}>Discount code</label><div className="mm-checkout-discount-controls"><input id={discountInputId} value={code} maxLength={40} autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={checkingCode || isStatic || !items.length}
                    onChange={event => setCode(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (!checkingCode && !isStatic && items.length) void checkDiscount(code, items, fulfilmentMethod) } }} /><button type="button" onClick={() => void checkDiscount(code, items, fulfilmentMethod)} disabled={checkingCode || isStatic || !code.trim() || !items.length}>{checkingCode ? "Checking…" : "Apply"}</button></div>
                {discountError ? <p role="alert" style={{ color: "#8B352B" }}>{discountError}</p> : null}
                {appliedCode ? <p role="status">{validatedQuote ? `${appliedCode} applied.` : "Checking your discount…"} <button type="button" disabled={checkingCode} onClick={() => { discountRequest.current?.abort(); setDiscountQuote(null); setAppliedCode(""); setCode(""); setDiscountError(""); storeDiscountCode("") }}>Remove</button></p> : null}
            </div> : null}
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 24, fontSize: 15 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 20 }}>
                    <span>Subtotal</span>
                    <span>{formatMoney(validatedQuote?.subtotal ?? subtotal)}</span>
                </div>
                {discountAmount > 0 ? <div style={{ display: "flex", justifyContent: "space-between", gap: 20 }}><span>Discount ({appliedCode})</span><span>−{formatMoney(discountAmount)}</span></div> : null}
                <div style={{ display: "flex", justifyContent: "space-between", gap: 20 }}>
                    <span>{isCollection ? "Collection" : "Delivery"}</span>
                    <span style={{ textAlign: "right" }}>
                        {fulfilmentMethod === "to_be_confirmed" ? "Choose delivery or collection" : isCollection ? "No delivery fee" : subtotal <= 0 ? "—" : (validatedQuote?.deliveryFee ?? deliveryFee) === 0 ? "Free" : formatMoney(validatedQuote?.deliveryFee ?? deliveryFee)}
                    </span>
                </div>
                {isDelivery && !qualifiesForFreeDelivery && subtotal > 0 ? (
                    <p style={{ margin: 0, color: "rgba(51,43,37,.7)", fontSize: 13, lineHeight: 1.45 }}>
                        Add {formatMoney(FREE_DELIVERY_THRESHOLD - subtotal)} more for free delivery.
                    </p>
                ) : null}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 20, marginTop: 23, paddingTop: 20, borderTop: "1px solid " + borderColor, fontSize: 21, letterSpacing: ".035em", textTransform: "uppercase" }}>
                <span>Total</span>
                <strong style={{ fontWeight: 500 }}>{formatMoney(total)}</strong>
            </div>
            </div>
            {/* Keep the only payment action outside the collapsible mobile summary. */}
            <div className="mm-checkout-payment-action" style={{ marginTop: 24 }}>
                <button ref={paymentButton} className="mm-checkout-pay" type="button" data-preview={isStatic ? "true" : undefined}
                    style={{ background: accentColor, color: buttonTextColor }}
                    disabled={isStatic || paymentAction.disabled || !paymentAction.connected || checkingCode}
                    aria-label={paymentAction.label === "Pay securely" ? "Pay securely with PayFast" : paymentAction.label}
                    aria-describedby={!isStatic && !paymentAction.atPayment ? paymentHelpId : undefined}
                    aria-busy={paymentAction.label === "Opening PayFast…" || paymentAction.label === "Checking payment…" || checkingCode}
                    onClick={() => { if (!isStatic && !paymentAction.disabled && paymentAction.connected && !checkingCode) window.dispatchEvent(new CustomEvent(PAYMENT_ACTION_EVENT)) }}>
                    {isStatic ? "Pay securely" : paymentAction.label}
                </button>
                {!isStatic && !paymentAction.atPayment ? <p className="mm-checkout-payment-help" id={paymentHelpId}>
                    {paymentAction.connected ? "Complete your checkout details to unlock payment." : "Preparing secure checkout…"}
                </p> : null}
                <p className="mm-checkout-security-note"><LockIcon /> Secure checkout with PayFast</p>
            </div>
        </aside>
    )
}

addPropertyControls(CheckoutOrderSummary, {
    discountsEnabled: { type: ControlType.Boolean, title: "Discounts", defaultValue: false },
    apiBaseUrl: { type: ControlType.String, title: "Vercel API", defaultValue: "https://movingmodesty.vercel.app", hidden: props => !props.discountsEnabled },
    surfaceColor: { type: ControlType.Color, title: "Surface", defaultValue: "#FFFFFF" },
    textColor: { type: ControlType.Color, title: "Text", defaultValue: "#332B25" },
    accentColor: { type: ControlType.Color, title: "Accent", defaultValue: "#536047" },
    buttonTextColor: { type: ControlType.Color, title: "Button text", defaultValue: "#EAE6E3" },
    borderColor: { type: ControlType.Color, title: "Border", defaultValue: "rgba(51, 43, 37, 0.18)" },
})

// BEGIN GENERATED CART IDENTITY
// Bundled into Framer's single-file components by build-framer-cart.mjs.
type StorefrontCartLine = {
  id: string; sku?: string; productSlug?: string; name: string; colour: string;
  size: string; quantity: number;
};

function canonicalCartSku(item: StorefrontCartLine): string {
  if (item.sku?.trim()) return item.sku.trim().toUpperCase();
  const identity = `${item.productSlug || ""} ${item.name || ""}`.toLowerCase();
  const colour = String(item.colour || "").trim().toLowerCase();
  const bases: Record<string, string> = identity.includes("amina")
    ? { lavender: "AMINA-LAV", lilac: "AMINA-LIL", black: "AMINA-BLK" }
    : identity.includes("hawa")
      ? { black: "HAWA-BLK", pink: "HAWA-PNK", "soft pink": "HAWA-PNK", sage: "HAWA-SGE", grey: "HAWA-GRY", gray: "HAWA-GRY" }
      : {};
  const size = String(item.size || "").trim().toLowerCase();
  const suffix = size === "small" ? "S" : size === "large" ? "L" : size.includes("one size") ? "OS" : "";
  return bases[colour] && suffix ? `${bases[colour]}-${suffix}` : "";
}

function normalizeStorefrontCart<T extends StorefrontCartLine>(items: T[]): T[] {
  const result: T[] = [];
  const positions = new Map<string, number>();
  for (const item of items) {
    const sku = canonicalCartSku(item);
    // Leave unidentifiable or invalid lines visible for the existing validation
    // flow. Never guess an unknown variant or silently discard its quantity.
    if (!sku || !Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      result.push({ ...item });
      continue;
    }
    const position = positions.get(sku);
    if (position !== undefined) {
      const total = result[position].quantity + item.quantity;
      if (Number.isSafeInteger(total)) result[position] = { ...result[position], quantity: total };
      else result.push({ ...item });
    } else {
      positions.set(sku, result.length);
      result.push({ ...item, id: sku, sku });
    }
  }
  return result;
}

// END GENERATED CART IDENTITY
