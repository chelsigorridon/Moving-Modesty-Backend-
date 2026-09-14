import { addPropertyControls, ControlType, useIsStaticRenderer } from "framer"
import { startTransition, useEffect, useMemo, useState, type CSSProperties } from "react"

interface CartItem {
    id: string
    name: string
    colour: string
    size: string
    price: number
    priceLabel: string
    image: string
    quantity: number
}

interface Props {
    surfaceColor: string
    textColor: string
    accentColor: string
    buttonTextColor: string
    borderColor: string
    style?: CSSProperties
}

type FulfilmentMethod = "delivery" | "collection"

const CART_KEY = "moving-modesty-cart-v1"
const FULFILMENT_KEY = "moving-modesty-fulfilment-v1"
const FULFILMENT_EVENT = "moving-modesty-fulfilment-updated"
const previewItems: CartItem[] = [{
    id: "checkout-preview",
    name: "Hawa Tri-Instant Scarf — Black",
    colour: "Black",
    size: "Small",
    price: 450,
    priceLabel: "R 450.00",
    image: "",
    quantity: 1,
}]

function readCart(): CartItem[] {
    if (typeof window === "undefined") return []
    try {
        const value = window.localStorage.getItem(CART_KEY)
        if (!value) return []
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === "string") : []
    } catch {
        return []
    }
}

function readFulfilmentMethod(): FulfilmentMethod {
    if (typeof window === "undefined") return "delivery"
    try {
        return window.localStorage.getItem(FULFILMENT_KEY) === "collection"
            ? "collection"
            : "delivery"
    } catch {
        return "delivery"
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
        accentColor = "#738063",
        buttonTextColor = "#EAE6E3",
        borderColor = "rgba(51, 43, 37, 0.18)",
        style,
    } = props
    const isStatic = useIsStaticRenderer()
    const [items, setItems] = useState<CartItem[]>([])
    const [fulfilmentMethod, setFulfilmentMethod] = useState<FulfilmentMethod>("delivery")
    const [compact, setCompact] = useState(false)
    const [open, setOpen] = useState(true)

    useEffect(() => {
        if (isStatic || typeof window === "undefined") return
        const refreshCart = () => setItems(readCart())
        const refreshFulfilment = () => setFulfilmentMethod(readFulfilmentMethod())
        const handleFulfilmentChange = (event: Event) => {
            const method = (event as CustomEvent<FulfilmentMethod>).detail
            setFulfilmentMethod(method === "collection" ? "collection" : "delivery")
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
    const css = [
        ".mm-checkout-order-item{display:grid;grid-template-columns:84px minmax(0,1fr);gap:16px;padding:20px 0;border-bottom:1px solid var(--checkout-border)}",
        ".mm-checkout-order-image{width:84px;height:104px}",
        ".mm-checkout-summary-toggle{width:100%;min-height:48px;align-items:center;justify-content:space-between;padding:0 0 18px;border:0;border-bottom:1px solid var(--checkout-border);background:transparent;color:inherit;font:500 15px/1.2 Jost,Arial,sans-serif;cursor:pointer}",
        ".mm-checkout-summary-toggle:focus-visible{outline:2px solid currentColor;outline-offset:3px}",
        ".mm-checkout-summary-content[data-hidden=true]{display:none}",
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
                    <strong style={{ fontSize: 17, fontWeight: 500 }}>{formatMoney(subtotal)}</strong>
                </button>
            ) : null}

            <div className="mm-checkout-summary-content" data-hidden={compact && !open ? "true" : "false"}>
                <h2 style={{ margin: compact ? "22px 0 0" : 0, fontSize: 25, lineHeight: 1.15, fontWeight: 400, letterSpacing: ".055em", textTransform: "uppercase" }}>
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
                                <h3 style={{ margin: 0, fontSize: 17, lineHeight: 1.25, fontWeight: 500, letterSpacing: ".025em", textTransform: "uppercase" }}>
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

            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 24, fontSize: 15 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 20 }}>
                    <span>Subtotal</span>
                    <span>{formatMoney(subtotal)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 20 }}>
                    <span>{isCollection ? "Collection" : "Delivery"}</span>
                    <span style={{ textAlign: "right" }}>{isCollection ? "No delivery fee" : "Calculated at checkout"}</span>
                </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 20, marginTop: 23, paddingTop: 20, borderTop: "1px solid " + borderColor, fontSize: 21, letterSpacing: ".035em", textTransform: "uppercase" }}>
                <span>Total</span>
                <strong style={{ fontWeight: 500 }}>{formatMoney(subtotal)}</strong>
            </div>
            <div style={{ display: "flex", minHeight: 53, boxSizing: "border-box", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 24, padding: "17px 24px", background: accentColor, color: buttonTextColor, fontSize: 19, fontWeight: 400, lineHeight: 1, letterSpacing: "0em" }}>
                <LockIcon /> Secure checkout
            </div>
            </div>
        </aside>
    )
}

addPropertyControls(CheckoutOrderSummary, {
    surfaceColor: { type: ControlType.Color, title: "Surface", defaultValue: "#FFFFFF" },
    textColor: { type: ControlType.Color, title: "Text", defaultValue: "#332B25" },
    accentColor: { type: ControlType.Color, title: "Accent", defaultValue: "#738063" },
    buttonTextColor: { type: ControlType.Color, title: "Button text", defaultValue: "#EAE6E3" },
    borderColor: { type: ControlType.Color, title: "Border", defaultValue: "rgba(51, 43, 37, 0.18)" },
})
