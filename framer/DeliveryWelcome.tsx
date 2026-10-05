import { useEffect, useRef, useState, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { addPropertyControls, ControlType, useIsStaticRenderer } from "framer"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"

interface DeliveryWelcomeProps {
    title?: string
    message?: string
    buttonLabel?: string
    destination?: string
    delay?: number
    logo?: { src: string; srcSet?: string; alt?: string }
    background?: string
    textColor?: string
    sage?: string
    buttonColor?: string
    font?: CSSProperties
    style?: CSSProperties
}

const visitKey = "moving-modesty:delivery-welcome:v1"
let shownThisVisit = false

function browsingPage() {
    if (typeof window === "undefined") return false
    return !/^\/(cart|checkout|admin|404)(\/|$)/i.test(window.location.pathname)
}

function alreadyShown() {
    if (shownThisVisit) return true
    try { return window.sessionStorage.getItem(visitKey) === "shown" }
    catch { return false }
}

function rememberShown() {
    shownThisVisit = true
    try { window.sessionStorage.setItem(visitKey, "shown") }
    catch { /* In-memory fallback when browser storage is unavailable. */ }
}

/**
 * @framerIntrinsicWidth 360
 * @framerIntrinsicHeight 264
 * @framerSupportedLayoutWidth any-prefer-fixed
 * @framerSupportedLayoutHeight auto
 */
export default function DeliveryWelcome(props: DeliveryWelcomeProps) {
    const {
        title = "A little extra, on us.",
        message = "Enjoy free delivery on orders R1,500 & over.",
        buttonLabel = "Shop the collection",
        destination = "/#collection",
        delay = 3.5,
        logo = { src: "https://framerusercontent.com/images/ixoYfu8JE3sJpyqachN7D9nmoQ.png", alt: "Moving Modesty" },
        background = "#fff9f5",
        textColor = "#5f5143",
        sage = "#738063",
        buttonColor = "#c7cbc8",
        font,
        style,
    } = props
    const isStatic = useIsStaticRenderer()
    const reducedMotion = useReducedMotion()
    const [open, setOpen] = useState(false)
    const [portalHost, setPortalHost] = useState<HTMLElement | null>(null)
    const cardRef = useRef<HTMLElement>(null)
    const closeRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        if (isStatic || typeof window === "undefined") return
        setPortalHost(document.body)
        if (!browsingPage() || alreadyShown()) return
        const timer = window.setTimeout(() => {
            if (!browsingPage() || alreadyShown()) return
            rememberShown()
            setOpen(true)
        }, Math.max(0, delay) * 1000)
        return () => window.clearTimeout(timer)
    }, [isStatic, delay])

    useEffect(() => {
        if (!open || typeof window === "undefined") return
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = "hidden"
        closeRef.current?.focus({ preventScroll: true })
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false)
            if (event.key !== "Tab") return
            const controls = cardRef.current?.querySelectorAll<HTMLElement>("button, a[href]")
            if (!controls?.length) return
            const first = controls[0]
            const last = controls[controls.length - 1]
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault()
                last.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first.focus()
            }
        }
        const onNavigation = () => setOpen(false)
        window.addEventListener("keydown", onKey)
        window.addEventListener("popstate", onNavigation)
        window.addEventListener("hashchange", onNavigation)
        return () => {
            window.removeEventListener("keydown", onKey)
            window.removeEventListener("popstate", onNavigation)
            window.removeEventListener("hashchange", onNavigation)
            document.body.style.overflow = previousOverflow
            if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
        }
    }, [open])

    const cardStyle: CSSProperties = {
        boxSizing: "border-box",
        width: "100%",
        padding: "24px",
        background,
        color: textColor,
        border: "1px solid rgba(95,81,67,.18)",
        borderTop: `4px solid ${sage}`,
        borderRadius: "4px",
        boxShadow: "0 8px 32px rgba(40,34,28,.14)",
        fontFamily: "Jost, sans-serif",
        fontSize: "16px",
        lineHeight: "1.5",
        ...font,
        position: "relative",
        pointerEvents: "auto",
    }
    const content = (
        <aside ref={cardRef} className="mm-delivery-card" role="dialog" aria-modal="true" aria-label="Free delivery offer" style={cardStyle}>
            <style>{`
                .mm-delivery-close:hover { background: rgba(115,128,99,.1); }
                .mm-delivery-card a:hover { filter: brightness(.96); }
                .mm-delivery-card a:focus-visible, .mm-delivery-close:focus-visible {
                    outline: 2px solid ${textColor}; outline-offset: 3px;
                }
                .mm-delivery-position { position: fixed; inset: 0; box-sizing: border-box;
                    display: grid; grid-template-columns: minmax(0, 1fr);
                    grid-template-rows: minmax(0, 1fr); place-items: center; padding: 24px; z-index: 10;
                    background: rgba(40,34,28,.18); }
                .mm-delivery-panel { width: 360px; min-width: 0; min-height: 0; max-width: 100%; max-height: 100%;
                    overflow: auto; border-radius: 4px; }
                @media (max-width: 767px) {
                    .mm-delivery-position { padding: max(16px, env(safe-area-inset-top))
                        max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom))
                        max(16px, env(safe-area-inset-left)); }
                    .mm-delivery-card { padding: 20px !important; }
                }
            `}</style>
            <button ref={closeRef} type="button" className="mm-delivery-close" aria-label="Close free delivery offer"
                onClick={() => setOpen(false)}
                style={{ position: "absolute", top: 8, right: 8, width: 44, height: 44,
                    border: 0, borderRadius: 4, padding: 0, background: "transparent",
                    color: textColor, cursor: "pointer", fontFamily: "Jost, sans-serif", fontSize: 12 }}>
                Close
            </button>
            <div style={{ display: "flex", gap: 12, alignItems: "center", paddingRight: 36, marginBottom: 20 }}>
                <img src={logo.src} srcSet={logo.srcSet} alt={logo.alt || "Moving Modesty"}
                    width={32} height={32} style={{ objectFit: "contain", filter: "invert(100%)", flexShrink: 0 }} />
                <span style={{ fontFamily: "Montserrat, sans-serif", fontSize: 10, fontWeight: 500,
                    letterSpacing: ".1em", lineHeight: 1.4 }}>MOVING MODESTY</span>
            </div>
            <h2 style={{ margin: "0 0 10px", fontFamily: "Montserrat, sans-serif", fontWeight: 400,
                fontSize: 23, lineHeight: 1.25, letterSpacing: "-.02em" }}>{title}</h2>
            <p aria-live="polite" style={{ margin: "0 0 20px", fontWeight: 400 }}>{message}</p>
            <a href={destination} onClick={() => setOpen(false)}
                style={{ display: "flex", alignItems: "center", justifyContent: "center",
                    minHeight: 44, padding: "10px 16px", boxSizing: "border-box",
                    background: buttonColor, color: textColor, textDecoration: "none", fontWeight: 500 }}>
                {buttonLabel}
            </a>
        </aside>
    )

    if (isStatic) return <div style={{ ...style, position: "relative", width: "100%" }}>{content}</div>
    return <div style={{ position: "relative", pointerEvents: "none", width: 0, height: 0 }}>
        {portalHost && createPortal(
            <AnimatePresence>
                {open && <motion.div className="mm-delivery-position"
                    onClick={(event) => { if (event.target === event.currentTarget) setOpen(false) }}
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    transition={{ duration: reducedMotion ? 0 : .2 }}>
                    <motion.div className="mm-delivery-panel"
                    initial={{ opacity: 0, y: reducedMotion ? 0 : 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: reducedMotion ? 0 : 8 }}
                    transition={{ duration: reducedMotion ? 0 : .28, ease: [0.22, 1, 0.36, 1] }}>
                    {content}
                    </motion.div>
                </motion.div>}
            </AnimatePresence>, portalHost)}
    </div>
}

addPropertyControls(DeliveryWelcome, {
    title: { type: ControlType.String, title: "Heading", defaultValue: "A little extra, on us." },
    message: { type: ControlType.String, title: "Message", defaultValue: "Enjoy free delivery on orders R1,500 & over.", displayTextArea: true },
    buttonLabel: { type: ControlType.String, title: "Button", defaultValue: "Shop the collection" },
    destination: { type: ControlType.Link, title: "Destination", defaultValue: "/#collection" },
    delay: { type: ControlType.Number, title: "Delay", defaultValue: 3.5, min: 1, max: 10, step: .5, unit: "s" },
    logo: { type: ControlType.ResponsiveImage, title: "Logo" },
    background: { type: ControlType.Color, title: "Background", defaultValue: "#fff9f5" },
    textColor: { type: ControlType.Color, title: "Text", defaultValue: "#5f5143" },
    sage: { type: ControlType.Color, title: "Sage accent", defaultValue: "#738063" },
    buttonColor: { type: ControlType.Color, title: "Button fill", defaultValue: "#c7cbc8" },
    font: { type: ControlType.Font, title: "Body font", controls: "extended", defaultFontType: "sans-serif",
        defaultValue: { fontSize: "16px", lineHeight: "1.5em", variant: "Regular" } },
})
