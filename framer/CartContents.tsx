
import { addPropertyControls, ControlType, useIsStaticRenderer } from "framer"
import { useEffect, useMemo, useState, type CSSProperties } from "react"

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
    checkoutPath: string
    continuePath: string
    surfaceColor: string
    textColor: string
    accentColor: string
    buttonTextColor: string
    borderColor: string
    style?: CSSProperties
}

const CART_KEY = "moving-modesty-cart-v1"

const previewItem: CartItem = {
    id: "hawa-preview::small",
    name: "Hawa Tri-Instant Scarf — Black",
    colour: "Black",
    size: "Small",
    price: 450,
    priceLabel: "R 450.00",
    image: "https://framerusercontent.com/images/i6owtTY1yDSiItsUFxWH0UF63zg.jpg",
    quantity: 1,
}

function readCart(): CartItem[] {
    if (typeof window === "undefined") return []
    try {
        const saved = window.localStorage.getItem(CART_KEY)
        if (!saved) return []
        const parsed = JSON.parse(saved)
        if (!Array.isArray(parsed)) return []
        return parsed.filter((item) => item && typeof item.id === "string")
    } catch {
        return []
    }
}

function formatMoney(value: number): string {
    return "R" + value.toFixed(2)
}

function getBaseProductName(name: string): string {
    const value = String(name || "Scarf")
    const dashParts = value.split(/[—–]/)
    if (dashParts.length > 1) return dashParts[0].trim()
    const hyphenParts = value.split(" - ")
    return hyphenParts[0].trim()
}

function MinusIcon() {
    return (
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    )
}

function PlusIcon() {
    return (
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M3 8h10M8 3v10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    )
}

function ArrowIcon() {
    return (
        <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
            <path d="M3 9h11M10 5l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function LockIcon() {
    return (
        <svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true">
            <rect x="3.5" y="8" width="11" height="7.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M6 8V5.8a3 3 0 0 1 6 0V8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
    )
}

function ImagePlaceholder() {
    return (
        <svg viewBox="0 0 96 120" width="62" height="78" aria-hidden="true">
            <path d="M19 89c14-25 19-48 15-69 23 9 38 27 43 54-18-3-37 2-58 15Z" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M31 30c13 12 22 27 27 46M24 96h50" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
    )
}

/**
 * @framerSupportedLayoutWidth any-prefer-fixed
 * @framerSupportedLayoutHeight auto
 */
export default function CartContents(props: Props) {
    const {
        checkoutPath = "/checkout",
        continuePath = "/amina",
        surfaceColor = "#FFFFFF",
        textColor = "#332B25",
        accentColor = "#738063",
        buttonTextColor = "#EAE6E3",
        borderColor = "rgba(51, 43, 37, 0.20)",
        style,
    } = props

    const isStatic = useIsStaticRenderer()
    const [items, setItems] = useState<CartItem[]>([])
    const displayedItems = isStatic ? [previewItem] : items

    useEffect(() => {
        if (isStatic || typeof window === "undefined") return
        const refresh = () => setItems(readCart())
        refresh()
        window.addEventListener("storage", refresh)
        window.addEventListener("moving-modesty-cart-updated", refresh as EventListener)
        return () => {
            window.removeEventListener("storage", refresh)
            window.removeEventListener("moving-modesty-cart-updated", refresh as EventListener)
        }
    }, [isStatic])

    const subtotal = useMemo(
        () => displayedItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0),
        [displayedItems]
    )
    const itemCount = useMemo(
        () => displayedItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        [displayedItems]
    )

    function save(next: CartItem[]) {
        setItems(next)
        if (isStatic || typeof window === "undefined") return
        window.localStorage.setItem(CART_KEY, JSON.stringify(next))
        window.dispatchEvent(new CustomEvent("moving-modesty-cart-updated", { detail: next }))
    }

    function changeQuantity(id: string, delta: number) {
        const next = items.map((item) =>
            item.id === id ? { ...item, quantity: Math.max(1, item.quantity + delta) } : item
        )
        save(next)
    }

    function removeItem(id: string) {
        save(items.filter((item) => item.id !== id))
    }

    const css = [
        ".mm-cart-header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin:0 0 48px;padding-bottom:22px;border-bottom:1px solid var(--mm-border)}",
        ".mm-cart-heading{margin:0;font-family:Montserrat,Arial,sans-serif;font-size:44px;font-weight:500;line-height:1.15;letter-spacing:-.02em;text-transform:uppercase}",
        ".mm-cart-title,.mm-reassurance h2{font-family:Montserrat,Arial,sans-serif}",
        ".mm-cart-count{margin:0;font-size:13px;line-height:1.3;letter-spacing:.16em;text-transform:uppercase;white-space:nowrap}",
        ".mm-cart-grid{display:grid;grid-template-columns:minmax(0,1.72fr) minmax(320px,.92fr);gap:52px;align-items:start}",
        ".mm-cart-items{border-top:1px solid var(--mm-border)}",
        ".mm-cart-row{display:grid;grid-template-columns:190px minmax(0,1fr) auto auto;grid-template-areas:'image info qty price';gap:26px;align-items:center;padding:28px 0;border-bottom:1px solid var(--mm-border)}",
        ".mm-cart-image{grid-area:image;width:190px;height:238px}",
        ".mm-cart-info{grid-area:info;min-width:0}",
        ".mm-cart-price{grid-area:price;align-self:center}",
        ".mm-cart-actions{grid-area:qty;justify-self:end}",
        ".mm-cart-summary{position:sticky;top:24px}",
        ".mm-cart-button,.mm-shop-button{transition:opacity .24s cubic-bezier(.22,1,.36,1),transform .24s cubic-bezier(.22,1,.36,1)}",
        ".mm-cart-button:hover,.mm-shop-button:hover{opacity:.92;transform:translateY(-1px)}",
        ".mm-cart-button:active,.mm-shop-button:active{opacity:1;transform:translateY(0) scale(.98);transition-duration:.16s}",
        ".mm-cart-button:focus-visible,.mm-shop-button:focus-visible,.mm-quantity-button:focus-visible,.mm-remove:focus-visible,.mm-text-link:focus-visible{outline:2px solid currentColor;outline-offset:3px}",
        ".mm-quantity-button:hover{background:rgba(51,43,37,.06)!important}",
        ".mm-remove:hover,.mm-text-link:hover{opacity:.68}",
        ".mm-reassurance{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:72px;border-top:1px solid var(--mm-border);border-bottom:1px solid var(--mm-border)}",
        ".mm-reassurance-item{padding:28px 32px;text-align:center}",
        ".mm-reassurance-item+.mm-reassurance-item{border-left:1px solid var(--mm-border)}",
        "@container (max-width:900px){.mm-cart-heading{font-size:36px}.mm-cart-grid{grid-template-columns:1fr;gap:34px}.mm-cart-summary{position:relative;top:auto}.mm-cart-header{margin-bottom:34px}.mm-reassurance{margin-top:52px}}",
        "@container (max-width:600px){.mm-cart-header{align-items:flex-start;flex-direction:column;gap:10px;margin-bottom:24px;padding-bottom:18px}.mm-cart-heading{font-size:30px}.mm-cart-row{grid-template-columns:1fr;grid-template-areas:'image' 'info' 'price' 'qty';gap:0;padding:24px 0 28px}.mm-cart-image{width:100px;height:100px;aspect-ratio:auto;margin-bottom:18px}.mm-cart-image img{object-fit:contain!important;object-position:center!important}.mm-cart-title{font-size:22px!important}.mm-cart-price{justify-self:start;margin-top:15px;font-size:19px!important}.mm-cart-actions{justify-self:start;margin-top:18px}.mm-remove{margin-left:0!important}.mm-cart-summary{padding:24px!important}.mm-reassurance{grid-template-columns:1fr;margin-top:44px}.mm-reassurance-item{padding:24px 18px}.mm-reassurance-item+.mm-reassurance-item{border-left:0;border-top:1px solid var(--mm-border)}}",
    ].join("")

    return (
        <div
            style={{
                ...style,
                position: "relative",
                width: "100%",
                containerType: "inline-size",
                color: textColor,
                fontFamily: "Jost, Arial, sans-serif",
                "--mm-border": borderColor,
            } as CSSProperties}
        >
            <style>{css}</style>

            <header className="mm-cart-header">
                <h1 className="mm-cart-heading">Your cart</h1>
                <p className="mm-cart-count">
                    {itemCount} {itemCount === 1 ? "item" : "items"}
                </p>
            </header>

            {displayedItems.length === 0 ? (
                <div
                    style={{
                        minHeight: 170,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        justifyContent: "center",
                        gap: 20,
                        padding: "40px 0 54px",
                        borderBottom: "1px solid " + borderColor,
                    }}
                >
                    <h2 style={{ margin: 0, fontSize: 26, lineHeight: 1.2, fontWeight: 400 }}>
                        Your cart is currently empty.
                    </h2>
                    <a
                        className="mm-shop-button"
                        href={continuePath}
                        style={{
                            display: "inline-flex",
                            minHeight: 53,
                            alignItems: "center",
                            justifyContent: "center",
                            gap: 12,
                            padding: "17px 24px",
                            background: accentColor,
                            color: buttonTextColor,
                            textDecoration: "none",
                            fontSize: 19,
                            fontWeight: 400,
                            lineHeight: 1,
                            letterSpacing: "0em",
                        }}
                    >
                        Shop the collection <ArrowIcon />
                    </a>
                </div>
            ) : (
                <div className="mm-cart-grid">
                    <section className="mm-cart-items" aria-label="Cart items">
                        {displayedItems.map((item) => (
                            <article className="mm-cart-row" key={item.id}>
                                <div
                                    className="mm-cart-image"
                                    role={item.image ? undefined : "img"}
                                    aria-label={item.image ? undefined : item.name + " image unavailable"}
                                    style={{
                                        overflow: "hidden",
                                        background: "#E4E0DC",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        color: "rgba(51,43,37,0.42)",
                                    }}
                                >
                                    {item.image ? (
                                        <img
                                            src={item.image}
                                            alt={item.name}
                                            style={{
                                                width: "100%",
                                                height: "100%",
                                                objectFit: "cover",
                                                objectPosition: "center top",
                                            }}
                                        />
                                    ) : (
                                        <ImagePlaceholder />
                                    )}
                                </div>

                                <div className="mm-cart-info">
                                    <h2
                                        className="mm-cart-title"
                                        style={{
                                            margin: 0,
                                            fontSize: 24,
                                            lineHeight: 1.2,
                                            fontWeight: 400,
                                            letterSpacing: ".035em",
                                            textTransform: "uppercase",
                                        }}
                                    >
                                        {getBaseProductName(item.name)}
                                    </h2>
                                    <p style={{ margin: "13px 0 0", fontSize: 16, lineHeight: 1.45 }}>
                                        {[item.colour, item.size].filter(Boolean).join(" · ")}
                                    </p>
                                </div>

                                <strong
                                    className="mm-cart-price"
                                    style={{ fontSize: 18, lineHeight: 1.2, fontWeight: 500, whiteSpace: "nowrap" }}
                                >
                                    {formatMoney(item.price * item.quantity)}
                                </strong>

                                <div className="mm-cart-actions">
                                    <div
                                        aria-label={"Quantity for " + item.name}
                                        style={{
                                            display: "inline-flex",
                                            alignItems: "center",
                                            border: "1px solid " + borderColor,
                                            background: surfaceColor,
                                        }}
                                    >
                                        <button
                                            className="mm-quantity-button"
                                            type="button"
                                            aria-label="Decrease quantity"
                                            onClick={() => changeQuantity(item.id, -1)}
                                            style={{
                                                width: 46,
                                                height: 46,
                                                display: "grid",
                                                placeItems: "center",
                                                border: 0,
                                                background: "transparent",
                                                color: textColor,
                                                cursor: "pointer",
                                            }}
                                        >
                                            <MinusIcon />
                                        </button>
                                        <span style={{ minWidth: 36, textAlign: "center", fontSize: 16 }}>
                                            {item.quantity}
                                        </span>
                                        <button
                                            className="mm-quantity-button"
                                            type="button"
                                            aria-label="Increase quantity"
                                            onClick={() => changeQuantity(item.id, 1)}
                                            style={{
                                                width: 46,
                                                height: 46,
                                                display: "grid",
                                                placeItems: "center",
                                                border: 0,
                                                background: "transparent",
                                                color: textColor,
                                                cursor: "pointer",
                                            }}
                                        >
                                            <PlusIcon />
                                        </button>
                                    </div>
                                    <button
                                        className="mm-remove"
                                        type="button"
                                        onClick={() => removeItem(item.id)}
                                        style={{
                                            display: "block",
                                            marginTop: 13,
                                            marginLeft: "auto",
                                            padding: "4px 0",
                                            border: 0,
                                            borderBottom: "1px solid currentColor",
                                            background: "transparent",
                                            color: textColor,
                                            fontFamily: "inherit",
                                            fontSize: 13,
                                            cursor: "pointer",
                                        }}
                                    >
                                        Remove
                                    </button>
                                </div>
                            </article>
                        ))}
                    </section>

                    <aside
                        className="mm-cart-summary"
                        aria-label="Cart total"
                        style={{
                            padding: 32,
                            border: "1px solid " + borderColor,
                            background: surfaceColor,
                        }}
                    >
                        <div
                            style={{
                                display: "flex",
                                justifyContent: "space-between",
                                gap: 20,
                                margin: "0 0 26px",
                                fontSize: 21,
                                letterSpacing: ".04em",
                                textTransform: "uppercase",
                            }}
                        >
                            <span>Total</span>
                            <strong style={{ fontWeight: 500 }}>{formatMoney(subtotal)}</strong>
                        </div>
                        <a
                            className="mm-cart-button"
                            href={checkoutPath}
                            style={{
                                display: "flex",
                                minHeight: 53,
                                alignItems: "center",
                                justifyContent: "center",
                                gap: 12,
                                padding: "17px 24px",
                                background: accentColor,
                                color: buttonTextColor,
                                textDecoration: "none",
                                fontSize: 19,
                                fontWeight: 400,
                                lineHeight: 1,
                                letterSpacing: "0em",
                            }}
                        >
                            Proceed to checkout <ArrowIcon />
                        </a>
                    </aside>
                </div>
            )}

            <section className="mm-reassurance" aria-label="Shopping reassurance">
                <div className="mm-reassurance-item">
                    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8 }}>
                        <LockIcon />
                        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 500, letterSpacing: ".12em", textTransform: "uppercase" }}>
                            Secure checkout
                        </h2>
                    </div>
                    <p style={{ margin: "9px 0 0", fontSize: 14, lineHeight: 1.45 }}>Secure online payment processing</p>
                </div>
                <div className="mm-reassurance-item">
                    <h2 style={{ margin: 0, fontSize: 13, fontWeight: 500, letterSpacing: ".12em", textTransform: "uppercase" }}>
                        Delivery
                    </h2>
                    <p style={{ margin: "9px 0 0", fontSize: 14, lineHeight: 1.45 }}>Delivery options available at checkout</p>
                </div>
                <div className="mm-reassurance-item">
                    <h2 style={{ margin: 0, fontSize: 13, fontWeight: 500, letterSpacing: ".12em", textTransform: "uppercase" }}>
                        Returns
                    </h2>
                    <a
                        className="mm-text-link"
                        href="/refund-cancellation-policy"
                        style={{ display: "inline-block", marginTop: 9, color: textColor, fontSize: 14, lineHeight: 1.45, textUnderlineOffset: 3 }}
                    >
                        View returns &amp; refund terms
                    </a>
                </div>
            </section>
        </div>
    )
}

addPropertyControls(CartContents, {
    checkoutPath: { type: ControlType.String, title: "Checkout", defaultValue: "/checkout" },
    continuePath: { type: ControlType.String, title: "Continue", defaultValue: "/amina" },
    surfaceColor: { type: ControlType.Color, title: "Surface", defaultValue: "#FFFFFF" },
    textColor: { type: ControlType.Color, title: "Text", defaultValue: "#332B25" },
    accentColor: { type: ControlType.Color, title: "Accent", defaultValue: "#738063" },
    buttonTextColor: { type: ControlType.Color, title: "Button text", defaultValue: "#EAE6E3" },
    borderColor: { type: ControlType.Color, title: "Border", defaultValue: "rgba(51, 43, 37, 0.20)" },
})
