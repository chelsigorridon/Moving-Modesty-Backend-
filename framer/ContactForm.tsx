import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from "react"
import { addPropertyControls, ControlType, useIsStaticRenderer } from "framer"

interface ContactFormProps {
    endpoint: string
    textColor: string
    borderColor: string
    accentColor: string
    buttonTextColor: string
    style?: CSSProperties
}

/**
 * @framerIntrinsicWidth 480
 * @framerIntrinsicHeight 424
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export default function ContactForm({
    endpoint = "https://movingmodesty.vercel.app/api/contact",
    textColor = "#332B25", borderColor = "#B6AEA7", accentColor = "#738063",
    buttonTextColor = "#EAE6E3", style,
}: ContactFormProps) {
    const isStatic = useIsStaticRenderer()
    const id = useId()
    const pending = useRef(false)
    const request = useRef<AbortController | null>(null)
    const submission = useRef<{ fingerprint: string; id: string } | null>(null)
    const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle")
    const [message, setMessage] = useState("")
    useEffect(() => () => request.current?.abort(), [])

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        if (isStatic || pending.current) return
        const form = event.currentTarget
        if (!form.reportValidity()) return
        const fields = new FormData(form)
        const data = { name: String(fields.get("name") || "").trim(), email: String(fields.get("email") || "").trim(), message: String(fields.get("message") || "").trim(), website: String(fields.get("website") || "") }
        const fingerprint = JSON.stringify(data)
        if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, id: crypto.randomUUID() }
        pending.current = true
        setState("sending")
        setMessage("")
        const controller = new AbortController()
        request.current = controller
        const timeout = window.setTimeout(() => controller.abort(), 20000)
        try {
            const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...data, submissionId: submission.current!.id }), signal: controller.signal })
            const result = await response.json()
            if (!response.ok || result.accepted !== true) throw new Error(result.error || "We couldn’t send your message. Please try again or contact us on WhatsApp.")
            setState("sent")
            setMessage("Thank you—your message has been sent to Moving Modesty. We’ll be in touch soon.")
            form.reset()
            submission.current = null
        } catch (error) {
            setState("error")
            setMessage(error instanceof Error && error.name !== "AbortError" ? error.message : "We couldn’t confirm your message was sent. Please retry, or contact us on WhatsApp.")
        } finally {
            window.clearTimeout(timeout)
            pending.current = false
            request.current = null
        }
    }

    const fieldStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, minWidth: 0, fontSize: 13, fontWeight: 500, lineHeight: 1.3 }
    const inputStyle: CSSProperties = { width: "100%", minWidth: 0, height: 50, boxSizing: "border-box", padding: "15px 16px", border: "1px solid " + borderColor, borderRadius: 0, background: "transparent", color: textColor, font: "400 16px/1.4 Jost, Arial, sans-serif" }
    return <form className="mm-contact-form" aria-label="Contact Moving Modesty" onSubmit={submit} style={{ ...style, position: "relative", width: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 20, fontFamily: "Jost, Arial, sans-serif", color: textColor }}>
        <style>{`.mm-contact-form :is(input,textarea,button,a):focus-visible{outline:2px solid ${accentColor};outline-offset:3px}.mm-contact-form input::placeholder,.mm-contact-form textarea::placeholder{color:${borderColor};opacity:1}`}</style>
        <label htmlFor={id + "-name"} style={fieldStyle}>Name<input id={id + "-name"} name="name" autoComplete="name" required minLength={2} maxLength={100} placeholder="Your name" style={inputStyle} disabled={state === "sending"} /></label>
        <label htmlFor={id + "-email"} style={fieldStyle}>Email<input id={id + "-email"} name="email" type="email" autoComplete="email" required maxLength={254} placeholder="you@example.com" style={inputStyle} disabled={state === "sending"} /></label>
        <label htmlFor={id + "-message"} style={fieldStyle}>Message<textarea id={id + "-message"} name="message" required minLength={10} maxLength={4000} placeholder="How can we help?" style={{ ...inputStyle, height: 120, resize: "vertical" }} disabled={state === "sending"} /></label>
        <div aria-hidden="true" style={{ display: "none" }}><label>Leave empty<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
        <button type="submit" disabled={isStatic || state === "sending"} style={{ border: 0, borderRadius: 0, width: "100%", minHeight: 53, padding: "17px 24px", background: accentColor, color: buttonTextColor, font: "400 19px/1 Jost, Arial, sans-serif", cursor: state === "sending" ? "wait" : "pointer", opacity: state === "sending" ? 0.7 : 1 }}>{state === "sending" ? "SENDING…" : "SEND MESSAGE"}</button>
        {message ? <p role={state === "error" ? "alert" : "status"} aria-live="polite" style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>{message}{state === "error" ? <> <a href="https://wa.me/27766514548" style={{ color: accentColor }}>Contact us on WhatsApp</a></> : null}</p> : null}
    </form>
}

addPropertyControls(ContactForm, {
    endpoint: { type: ControlType.String, title: "Endpoint", defaultValue: "https://movingmodesty.vercel.app/api/contact" },
    textColor: { type: ControlType.Color, title: "Text", defaultValue: "#332B25" },
    borderColor: { type: ControlType.Color, title: "Border", defaultValue: "#B6AEA7" },
    accentColor: { type: ControlType.Color, title: "Accent", defaultValue: "#738063" },
    buttonTextColor: { type: ControlType.Color, title: "Button text", defaultValue: "#EAE6E3" },
})
