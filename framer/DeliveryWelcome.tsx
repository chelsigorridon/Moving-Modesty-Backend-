import { useEffect, useRef, useState, type CSSProperties } from "react"
import { addPropertyControls, ControlType, useIsStaticRenderer } from "framer"
import { motion, useReducedMotion } from "framer-motion"

interface DeliveryWelcomeProps {
    enabled?: boolean
    canvasPreview?: boolean
    title?: string
    message?: string
    buttonLabel?: string
    destination?: string
    delay?: number
    scrollAfter?: number
    logo?: { src: string; srcSet?: string; alt?: string }
    background?: string
    textColor?: string
    sage?: string
    buttonColor?: string
    font?: CSSProperties
    style?: CSSProperties
}

const visitKey = "moving-modesty:delivery-popup:v3"
let shownThisVisit = false

function browsingPage() {
    if (typeof window === "undefined") return false
    const { pathname, hostname } = window.location
    return pathname.replace(/\/+$/, "") === "" ||
        (hostname.endsWith(".framercanvas.com") && pathname.endsWith("/preview-module.html"))
}

function alreadyShown() {
    if (shownThisVisit) return true
    try { return window.sessionStorage.getItem(visitKey) === "shown" }
    catch { return false }
}

function rememberShown() {
    shownThisVisit = true
    try { window.sessionStorage.setItem(visitKey, "shown") }
    catch { /* Once-per-visit fallback when browser storage is unavailable. */ }
}

/**
 * @framerIntrinsicWidth 360
 * @framerIntrinsicHeight 264
 * @framerSupportedLayoutWidth any-prefer-fixed
 * @framerSupportedLayoutHeight auto
 */
export default function DeliveryWelcome(props: DeliveryWelcomeProps) {
    const {
        enabled = true,
        canvasPreview = false,
        title = "A little extra, on us.",
        message = "Enjoy free delivery on orders R1,500 & over.",
        buttonLabel = "Shop the collection",
        destination = "/#collection",
        delay = 10,
        scrollAfter = 900,
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
    const [delayElapsed, setDelayElapsed] = useState(false)
    const [beyondIntro, setBeyondIntro] = useState(false)
    const [open, setOpen] = useState(false)
    const [dismissed, setDismissed] = useState(false)
    const dialogRef = useRef<HTMLDialogElement>(null)

    useEffect(() => {
        if (isStatic || typeof window === "undefined") return
        if (!enabled) {
            setOpen(false)
            setDelayElapsed(false)
            setBeyondIntro(false)
            return
        }
        if (!browsingPage() || alreadyShown()) {
            setDismissed(true)
            return
        }
        setDismissed(false)
        setDelayElapsed(false)
        const timer = window.setTimeout(() => setDelayElapsed(true), Math.max(1, Number.isFinite(delay) ? delay : 10) * 1000)
        return () => window.clearTimeout(timer)
    }, [isStatic, enabled, delay])

    useEffect(() => {
        if (isStatic || !enabled || dismissed || open || typeof window === "undefined") return
        // Use browser scroll position, without inspecting other page components.
        // One full viewport and the minimum scroll distance keep the hero CTA above the popup.
        const checkScroll = () => setBeyondIntro(window.scrollY >= Math.max(window.innerHeight, Number.isFinite(scrollAfter) ? scrollAfter : 900))
        checkScroll()
        window.addEventListener("scroll", checkScroll, { passive: true })
        window.addEventListener("resize", checkScroll)
        return () => {
            window.removeEventListener("scroll", checkScroll)
            window.removeEventListener("resize", checkScroll)
        }
    }, [isStatic, enabled, dismissed, open, scrollAfter])

    useEffect(() => {
        if (isStatic || !enabled || dismissed || open || !delayElapsed || !beyondIntro) return
        if (!browsingPage() || alreadyShown()) return
        setOpen(true)
    }, [isStatic, enabled, dismissed, open, delayElapsed, beyondIntro])

    useEffect(() => {
        const dialog = dialogRef.current
        if (!enabled || !open || !dialog || typeof window === "undefined") return
        // A native modal handles keyboard focus containment, Escape, background inertness
        // and focus restoration without querying the surrounding page.
        if (!dialog.open) dialog.showModal()
        rememberShown()
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = "hidden"
        const onNavigation = () => { setDismissed(true); setOpen(false) }
        window.addEventListener("popstate", onNavigation)
        window.addEventListener("hashchange", onNavigation)
        return () => {
            window.removeEventListener("popstate", onNavigation)
            window.removeEventListener("hashchange", onNavigation)
            dialog.close()
            document.body.style.overflow = previousOverflow
        }
    }, [enabled, open])

    const dismiss = () => { setDismissed(true); setOpen(false) }
    const card = (
        <aside className="mm-delivery-popup-card" aria-label="Free delivery offer"
            style={{ boxSizing: "border-box", width: "100%", padding: 24, background,
                color: textColor, border: "1px solid rgba(95,81,67,.18)", borderTop: `4px solid ${sage}`,
                borderRadius: 4, boxShadow: "0 8px 32px rgba(40,34,28,.14)",
                fontFamily: "Jost, sans-serif", fontSize: 16, lineHeight: "1.5", ...font,
                position: "relative", pointerEvents: "auto" }}>
            <style>{`
                .mm-delivery-popup-dialog::backdrop { background: rgba(40,34,28,.12); }
                .mm-delivery-popup-close:hover { background: rgba(115,128,99,.1); }
                .mm-delivery-popup-card a:hover { filter: brightness(.96); }
                .mm-delivery-popup-card a:focus-visible, .mm-delivery-popup-close:focus-visible {
                    outline: 2px solid ${textColor}; outline-offset: 3px;
                }
                @media (max-width: 767px) {
                    .mm-delivery-popup-card { padding: 20px !important; }
                }
            `}</style>
            <button type="button" className="mm-delivery-popup-close" aria-label="Close free delivery offer"
                onClick={isStatic ? undefined : dismiss}
                style={{ position: "absolute", top: 8, right: 8, width: 44, height: 44,
                    border: 0, borderRadius: 4, padding: 0, background: "transparent", color: textColor,
                    cursor: "pointer", fontFamily: "Jost, sans-serif", fontSize: 12 }}>Close</button>
            <div style={{ display: "flex", gap: 12, alignItems: "center", paddingRight: 36, marginBottom: 20 }}>
                <img src={logo.src} srcSet={logo.srcSet} alt={logo.alt || "Moving Modesty"}
                    width={32} height={32} style={{ objectFit: "contain", filter: "invert(100%)", flexShrink: 0 }} />
                <span style={{ fontFamily: "Montserrat, sans-serif", fontSize: 10, fontWeight: 500,
                    letterSpacing: ".1em", lineHeight: 1.4 }}>MOVING MODESTY</span>
            </div>
            <h2 style={{ margin: "0 0 10px", fontFamily: "Montserrat, sans-serif", fontWeight: 400,
                fontSize: 23, lineHeight: 1.25, letterSpacing: "-.02em" }}>{title}</h2>
            <p style={{ margin: "0 0 20px", fontWeight: 400 }}>{message}</p>
            <a href={destination} onClick={isStatic ? undefined : dismiss}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 44,
                    padding: "10px 16px", boxSizing: "border-box", background: buttonColor, color: textColor,
                    textDecoration: "none", fontWeight: 500 }}>{buttonLabel}</a>
        </aside>
    )

    if (isStatic) return <div style={{ ...style, position: "relative", width: "100%",
        height: canvasPreview && enabled ? "auto" : 0 }}>
        {canvasPreview && enabled ? card : null}
    </div>
    // No card or empty promotional space is added to the page's content flow.
    return <div data-mm-delivery-popup={!enabled ? "disabled" : dismissed ? "dismissed" : open ? "open" : "waiting"}
        style={{ position: "relative", width: 0, height: 0, pointerEvents: "none" }}>
        <dialog ref={dialogRef} className="mm-delivery-popup-dialog" aria-label="Free delivery offer"
                onCancel={(event) => { event.preventDefault(); dismiss() }}
                onClick={(event) => { if (event.target === event.currentTarget) dismiss() }}
                style={{ position: "fixed", inset: 0, margin: "auto", padding: 0, width: 360,
                    maxWidth: "calc(100% - 32px)", height: "fit-content", maxHeight: "calc(100dvh - 32px)",
                    overflow: "auto", border: 0, borderRadius: 4, background: "transparent", pointerEvents: "auto" }}>
                <motion.div initial={false} animate={{ opacity: open ? 1 : 0, y: open || reducedMotion ? 0 : 12 }}
                    transition={{ duration: reducedMotion ? 0 : .28, ease: [0.22, 1, 0.36, 1] }}>{card}</motion.div>
        </dialog>
    </div>
}

addPropertyControls(DeliveryWelcome, {
    enabled: { type: ControlType.Boolean, title: "Enable popup", defaultValue: true },
    canvasPreview: { type: ControlType.Boolean, title: "Canvas preview", defaultValue: false,
        description: "Show the popup for editing only. Use Preview to test its scroll trigger." },
    title: { type: ControlType.String, title: "Heading", defaultValue: "A little extra, on us." },
    message: { type: ControlType.String, title: "Message", defaultValue: "Enjoy free delivery on orders R1,500 & over.", displayTextArea: true },
    buttonLabel: { type: ControlType.String, title: "Button", defaultValue: "Shop the collection" },
    destination: { type: ControlType.Link, title: "Destination", defaultValue: "/#collection" },
    delay: { type: ControlType.Number, title: "Delay", defaultValue: 10, min: 1, max: 30, step: .5, unit: "s" },
    scrollAfter: { type: ControlType.Number, title: "Scroll after", defaultValue: 900, min: 400, max: 2000, step: 50, unit: "px" },
    logo: { type: ControlType.ResponsiveImage, title: "Logo" },
    background: { type: ControlType.Color, title: "Background", defaultValue: "#fff9f5" },
    textColor: { type: ControlType.Color, title: "Text", defaultValue: "#5f5143" },
    sage: { type: ControlType.Color, title: "Sage accent", defaultValue: "#738063" },
    buttonColor: { type: ControlType.Color, title: "Button fill", defaultValue: "#c7cbc8" },
    font: { type: ControlType.Font, title: "Body font", controls: "extended", defaultFontType: "sans-serif",
        defaultValue: { fontSize: "16px", lineHeight: "1.5em", variant: "Regular" } },
})
