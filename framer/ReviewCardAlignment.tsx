import { forwardRef, useEffect, useRef, type ComponentType } from "react"
import { useIsStaticRenderer } from "framer"

// Keep the native CMS list and its responsive layout. Only measure cards owned
// by this list; never query or change another section on the page.
export function withEqualReviewCards(Component: ComponentType<any>): ComponentType<any> {
    return forwardRef<HTMLElement, any>(function EqualReviewCards(props, forwardedRef) {
        const root = useRef<HTMLElement | null>(null)
        const isStatic = useIsStaticRenderer()
        useEffect(() => {
            const container = root.current
            if (!container || isStatic) return
            let disposed = false
            let frame = 0
            const original = new Map<HTMLElement, { height: string; margin: string }>()
            function align() {
                if (disposed || !container) return
                const cards = Array.from(container.querySelectorAll<HTMLElement>("article"))
                    .filter(card => card.getBoundingClientRect().width > 0)
                if (!cards.length) return
                for (const card of cards) {
                    const client = card.lastElementChild as HTMLElement | null
                    if (!original.has(card)) original.set(card, { height: card.style.height, margin: client?.style.marginTop || "" })
                    card.style.height = "auto"
                }
                const height = Math.ceil(Math.max(...cards.map(card => card.getBoundingClientRect().height)))
                for (const card of cards) {
                    card.style.height = `${height}px`
                    const client = card.lastElementChild as HTMLElement | null
                    if (client) client.style.marginTop = "auto"
                }
            }
            function schedule() {
                cancelAnimationFrame(frame)
                frame = requestAnimationFrame(align)
            }
            schedule()
            void document.fonts.ready.then(() => { if (!disposed) schedule() })
            window.addEventListener("resize", schedule)
            return () => {
                disposed = true
                cancelAnimationFrame(frame)
                window.removeEventListener("resize", schedule)
                for (const [card, value] of original) {
                    card.style.height = value.height
                    const client = card.lastElementChild as HTMLElement | null
                    if (client) client.style.marginTop = value.margin
                }
            }
        }, [isStatic, props.children])
        return <Component {...props} ref={(element: HTMLElement | null) => {
            root.current = element
            if (typeof forwardedRef === "function") forwardedRef(element)
            else if (forwardedRef) forwardedRef.current = element
        }} />
    })
}
