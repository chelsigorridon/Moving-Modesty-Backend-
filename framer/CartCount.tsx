import { forwardRef, useEffect, useState, type ComponentType } from "react"

const CART_KEY = "moving-modesty-cart-v1"
const CART_EVENT = "moving-modesty-cart-updated"

function readQuantity(): number {
    if (typeof window === "undefined") return 0
    try {
        const cart = JSON.parse(window.localStorage.getItem(CART_KEY) || "[]")
        if (!Array.isArray(cart)) return 0
        return cart.reduce((total, item) => {
            const quantity = Number(item?.quantity)
            return item && typeof item.id === "string" && Number.isSafeInteger(quantity) && quantity > 0
                ? total + quantity : total
        }, 0)
    } catch {
        return 0
    }
}

// Wrap the existing canvas count label; keep its styling and the original bag icon.
export function withCartCount(Component: ComponentType<any>): ComponentType<any> {
    return forwardRef(function CartCount(props: any, ref) {
        const [quantity, setQuantity] = useState(0)
        useEffect(() => {
            const refresh = () => setQuantity(readQuantity())
            const onStorage = (event: StorageEvent) => {
                if (event.key === CART_KEY || event.key === null) refresh()
            }
            refresh()
            window.addEventListener(CART_EVENT, refresh)
            window.addEventListener("storage", onStorage)
            window.addEventListener("pageshow", refresh)
            window.addEventListener("focus", refresh)
            return () => {
                window.removeEventListener(CART_EVENT, refresh)
                window.removeEventListener("storage", onStorage)
                window.removeEventListener("pageshow", refresh)
                window.removeEventListener("focus", refresh)
            }
        }, [])
        return <Component {...props} ref={ref} text={String(quantity)}
            aria-label={`${quantity} ${quantity === 1 ? "item" : "items"} in cart`}
            aria-live="polite" aria-atomic="true"
            style={{ ...props.style, ...(quantity === 0 ? { display: "none" } : {}) }} />
    })
}
