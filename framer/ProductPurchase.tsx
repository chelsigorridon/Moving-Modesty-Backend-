import { addPropertyControls, ControlType, useIsStaticRenderer } from "framer"
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"

interface ResponsiveImage {
    src?: string
    srcSet?: string
    alt?: string
}

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
    productName: string
    price: string
    image?: ResponsiveImage | string
    sizeMode: "hawa" | "oneSize"
    sizeOptions?: string
    buttonLabel: string
    surfaceColor: string
    textColor: string
    buttonColor: string
    buttonTextColor: string
    borderColor: string
    style?: CSSProperties
}

const CART_KEY = "moving-modesty-cart-v1"

function parsePrice(value: string): number {
    const cleaned = String(value || "").replace(/[^0-9.,]/g, "").replace(/,/g, "")
    const parsed = Number.parseFloat(cleaned)
    return Number.isFinite(parsed) ? parsed : 0
}

function deriveColour(name: string): string {
    const emDashParts = String(name || "").split(/[—–]/)
    if (emDashParts.length > 1) return emDashParts[emDashParts.length - 1].trim()
    const hyphenParts = String(name || "").split(" - ")
    if (hyphenParts.length > 1) return hyphenParts[hyphenParts.length - 1].trim()
    return ""
}

function getImageSource(image?: ResponsiveImage | string): string {
    if (typeof image === "string") return image
    return image?.src || ""
}

function readCart(): CartItem[] {
    if (typeof window === "undefined") return []
    try {
        const saved = window.localStorage.getItem(CART_KEY)
        if (!saved) return []
        const parsed = JSON.parse(saved)
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

function parseSizeOptions(value: string | undefined, mode: Props["sizeMode"]): string[] {
    const configured = String(value || "")
        .split(/\s*(?:\/|,|\||\n)\s*/)
        .map((option) => option.trim())
        .filter(Boolean)
    const unique = Array.from(new Set(configured))
    if (unique.length > 0) return unique
    return mode === "oneSize" ? ["One size fits all"] : ["Small", "Large"]
}

/**
 * @framerSupportedLayoutWidth any-prefer-fixed
 * @framerSupportedLayoutHeight auto
 */
export default function ProductPurchase(props: Props) {
    const {
        productName = "Scarf",
        price = "R 0.00",
        image,
        sizeMode = "hawa",
        sizeOptions = "",
        buttonLabel = "Add to cart",
        surfaceColor = "#EAE6E3",
        textColor = "#332B25",
        buttonColor = "#738063",
        buttonTextColor = "#EAE6E3",
        borderColor = "rgba(51, 43, 37, 0.24)",
        style,
    } = props

    const isStatic = useIsStaticRenderer()
    const availableSizes = useMemo(
        () => parseSizeOptions(sizeOptions, sizeMode),
        [sizeMode, sizeOptions]
    )
    const oneSize = availableSizes.length === 1
    const sizesKey = availableSizes.join("|")
    const [selectedSize, setSelectedSize] = useState(oneSize ? availableSizes[0] : "")
    const [message, setMessage] = useState("")
    const resetTimer = useRef<number | undefined>(undefined)

    useEffect(() => {
        setSelectedSize(oneSize ? availableSizes[0] : "")
        setMessage("")
    }, [oneSize, productName, sizesKey])

    useEffect(() => {
        return () => {
            if (typeof window !== "undefined" && resetTimer.current !== undefined) {
                window.clearTimeout(resetTimer.current)
            }
        }
    }, [])

    function handleAdd() {
        if (!selectedSize) {
            setMessage("Please choose a size")
            return
        }
        if (isStatic || typeof window === "undefined") {
            setMessage("Added to bag")
            return
        }

        const numericPrice = parsePrice(price)
        const colour = deriveColour(productName)
        const id = [productName, selectedSize].join("::").toLowerCase()
        const current = readCart()
        const existingIndex = current.findIndex((item) => item.id === id)
        let next: CartItem[]

        if (existingIndex >= 0) {
            next = current.map((item, index) =>
                index === existingIndex ? { ...item, quantity: item.quantity + 1 } : item
            )
        } else {
            next = [
                ...current,
                {
                    id,
                    name: productName,
                    colour,
                    size: selectedSize,
                    price: numericPrice,
                    priceLabel: price,
                    image: getImageSource(image),
                    quantity: 1,
                },
            ]
        }

        window.localStorage.setItem(CART_KEY, JSON.stringify(next))
        window.dispatchEvent(new CustomEvent("moving-modesty-cart-updated", { detail: next }))
        setMessage("Added to bag")
        if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current)
        resetTimer.current = window.setTimeout(() => setMessage(""), 2200)
    }

    const css = [
        ".mm-product-button{transition:opacity .24s cubic-bezier(.22,1,.36,1),transform .24s cubic-bezier(.22,1,.36,1)}",
        ".mm-product-button:hover{opacity:.92;transform:translateY(-1px)}",
        ".mm-product-button:active{opacity:1;transform:translateY(0) scale(.98);transition-duration:.16s}",
        ".mm-product-button:focus-visible{outline:2px solid currentColor;outline-offset:3px}",
    ].join("")

    return (
        <div
            style={{
                ...style,
                position: "relative",
                width: "100%",
                display: "flex",
                flexDirection: "column",
                gap: 14,
                background: surfaceColor,
                color: textColor,
                fontFamily: "Jost, Arial, sans-serif",
            }}
        >
            <style>{css}</style>
            <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span
                    style={{
                        fontSize: 12,
                        lineHeight: 1.2,
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                    }}
                >
                    Size
                </span>
                <select
                    aria-label={oneSize ? "Scarf size" : "Choose scarf size"}
                    value={selectedSize}
                    onChange={(event) => {
                        setSelectedSize(event.target.value)
                        setMessage("")
                    }}
                    style={{
                        width: "100%",
                        height: 48,
                        boxSizing: "border-box",
                        padding: "0 14px",
                        border: "1px solid " + borderColor,
                        borderRadius: 10,
                        background: "rgba(255,255,255,0.45)",
                        color: textColor,
                        fontFamily: "inherit",
                        fontSize: 15,
                        cursor: "pointer",
                        outlineColor: buttonColor,
                    }}
                >
                    {!oneSize ? <option value="">Select size</option> : null}
                    {availableSizes.map((option) => (
                        <option key={option} value={option}>{option}</option>
                    ))}
                </select>
            </label>

            <button
                className="mm-product-button"
                type="button"
                onClick={handleAdd}
                aria-label={buttonLabel + " — " + productName}
                style={{
                    width: "100%",
                    minHeight: 53,
                    padding: "17px 24px",
                    border: "none",
                    borderRadius: 0,
                    background: buttonColor,
                    color: buttonTextColor,
                    fontFamily: "inherit",
                    fontSize: 19,
                    fontWeight: 400,
                    lineHeight: 1,
                    cursor: "pointer",
                }}
            >
                {message === "Added to bag" ? "Added to bag" : buttonLabel}
            </button>

            <div
                aria-live="polite"
                style={{
                    minHeight: 18,
                    marginTop: -7,
                    fontSize: 13,
                    lineHeight: "18px",
                    color: message === "Please choose a size" ? "#8B3E2F" : textColor,
                }}
            >
                {message && message !== "Added to bag" ? message : ""}
            </div>
        </div>
    )
}

addPropertyControls(ProductPurchase, {
    productName: { type: ControlType.String, title: "Product", defaultValue: "Scarf" },
    price: { type: ControlType.String, title: "Price", defaultValue: "R 0.00" },
    image: { type: ControlType.ResponsiveImage, title: "Image" },
    sizeMode: {
        type: ControlType.Enum,
        title: "Sizes",
        options: ["hawa", "oneSize"],
        optionTitles: ["Small / Large", "One size"],
        defaultValue: "hawa",
        displaySegmentedControl: true,
    },
    sizeOptions: {
        type: ControlType.String,
        title: "Size Options",
        defaultValue: "",
        placeholder: "Small / Large",
    },
    buttonLabel: { type: ControlType.String, title: "Button", defaultValue: "Add to cart" },
    surfaceColor: { type: ControlType.Color, title: "Surface", defaultValue: "#EAE6E3" },
    textColor: { type: ControlType.Color, title: "Text", defaultValue: "#332B25" },
    buttonColor: { type: ControlType.Color, title: "Button fill", defaultValue: "#738063" },
    buttonTextColor: { type: ControlType.Color, title: "Button text", defaultValue: "#EAE6E3" },
    borderColor: { type: ControlType.Color, title: "Border", defaultValue: "rgba(51, 43, 37, 0.24)" },
})
