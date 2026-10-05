import * as React from "react"
import { addPropertyControls, ControlType } from "framer"

interface MailchimpSignupProps {
    buttonLabel: string
    successLabel: string
    privacyUrl: string
    style?: React.CSSProperties
}

const MAILCHIMP_ACTION =
    "https://gmail.us4.list-manage.com/subscribe/post?u=d4b7fe9994d26a5a202b69a38&id=fa50c9edf6&f_id=00da7beaf0"

// Mailchimp's official embed script uses this JSONP response endpoint too.
// No private API key is exposed, and elapsed time is never treated as success.
export function submitMailchimpSignup(fields: FormData, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new Error("Signup cancelled.")); return }
        const callback = `mmMailchimp_${window.crypto.randomUUID().replaceAll("-", "")}`
        const callbacks = window as unknown as Record<string, unknown>
        const script = document.createElement("script")
        const url = new URL(MAILCHIMP_ACTION.replace("/post?", "/post-json?"))
        for (const name of ["FNAME", "EMAIL", "tags", "b_d4b7fe9994d26a5a202b69a38_fa50c9edf6"]) {
            url.searchParams.set(name, String(fields.get(name) || ""))
        }
        url.searchParams.set("c", callback)
        const cleanup = () => { window.clearTimeout(timer); script.remove(); delete callbacks[callback]; signal.removeEventListener("abort", abort) }
        const fail = () => { cleanup(); reject(new Error("We couldn't confirm your signup. Please try again.")) }
        const abort = () => { cleanup(); reject(new Error("Signup cancelled.")) }
        const timer = window.setTimeout(fail, 15_000)
        callbacks[callback] = (result: { result?: string; msg?: string }) => {
            cleanup()
            if (result?.result === "success") resolve()
            else {
                // Never insert the provider's HTML into the page.
                const text = String(result?.msg || "").replace(/<[^>]*>/g, " ")
                reject(new Error(/already subscribed/i.test(text) ? "This email is already subscribed." : "Signup wasn't accepted. Check your email or try again."))
            }
        }
        script.onerror = fail
        script.src = url.toString()
        script.async = true
        signal.addEventListener("abort", abort, { once: true })
        document.head.appendChild(script)
    })
}

const inputStyle: React.CSSProperties = {
    width: "100%",
    height: 48,
    boxSizing: "border-box",
    border: "1px solid rgba(234, 230, 227, 0.42)",
    borderRadius: 2,
    background: "rgba(234, 230, 227, 0.06)",
    color: "#EAE6E3",
    padding: "14px",
    fontFamily: "Jost, sans-serif",
    fontSize: 15,
    fontWeight: 400,
    lineHeight: 1.2,
    outline: "none",
}

const labelStyle: React.CSSProperties = {
    color: "#EAE6E3",
    fontFamily: "Montserrat, sans-serif",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.14em",
    lineHeight: 1.4,
}

/**
 * Mailchimp-connected community signup form for Moving Modesty.
 *
 * @framerIntrinsicWidth 460
 * @framerIntrinsicHeight 311
 * @framerSupportedLayoutWidth any-prefer-fixed
 * @framerSupportedLayoutHeight fixed
 */
export default function MailchimpSignup(props: MailchimpSignupProps) {
    const {
        buttonLabel = "JOIN THE COMMUNITY",
        successLabel = "CHECK YOUR EMAIL TO CONFIRM",
        privacyUrl = "/privacy-policy",
        style,
    } = props
    const [status, setStatus] = React.useState<"idle" | "pending" | "success" | "error">(
        "idle"
    )
    const formRef = React.useRef<HTMLFormElement>(null)
    const [message, setMessage] = React.useState("")
    const pending = React.useRef<AbortController | null>(null)
    React.useEffect(() => () => pending.current?.abort(), [])

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault()
        if (pending.current || status === "success") return
        const fields = new FormData(event.currentTarget)
        const controller = new AbortController()
        pending.current = controller
        setStatus("pending")
        setMessage("")
        try {
            await submitMailchimpSignup(fields, controller.signal)
            if (controller.signal.aborted) return
            setStatus("success")
            setMessage("Check your inbox and spam folder for confirmation.")
            formRef.current?.reset()
        } catch (error) {
            if (controller.signal.aborted) return
            setStatus("error")
            setMessage(error instanceof Error ? error.message : "We couldn't confirm your signup. Please try again.")
        } finally { pending.current = null }
    }

    return (
        <form
            ref={formRef}
            action={MAILCHIMP_ACTION}
            method="post"
            onSubmit={handleSubmit}
            style={{
                ...style,
                position: "relative",
                width: "100%",
                height: "100%",
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                gap: 18,
                overflow: "hidden",
                padding: 28,
                border: "1px solid rgba(234, 230, 227, 0.34)",
                borderRadius: 2,
                background: "rgba(234, 230, 227, 0.06)",
            }}
        >
            <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={labelStyle}>YOUR NAME</span>
                <input
                    name="FNAME"
                    type="text"
                    required
                    autoComplete="given-name"
                    placeholder="Amina"
                    style={inputStyle}
                    onFocus={(event) => {
                        event.currentTarget.style.borderColor = "#7D896D"
                    }}
                    onBlur={(event) => {
                        event.currentTarget.style.borderColor =
                            "rgba(234, 230, 227, 0.42)"
                    }}
                />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={labelStyle}>YOUR EMAIL ADDRESS</span>
                <input
                    name="EMAIL"
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="you@example.com"
                    style={inputStyle}
                    onFocus={(event) => {
                        event.currentTarget.style.borderColor = "#7D896D"
                    }}
                    onBlur={(event) => {
                        event.currentTarget.style.borderColor =
                            "rgba(234, 230, 227, 0.42)"
                    }}
                />
            </label>

            <input type="hidden" name="tags" value="8032927" />
            <div aria-hidden="true" style={{ position: "absolute", left: -5000 }}>
                <input
                    type="text"
                    name="b_d4b7fe9994d26a5a202b69a38_fa50c9edf6"
                    tabIndex={-1}
                    defaultValue=""
                />
            </div>

            <div
                style={{
                    color: "rgba(234, 230, 227, 0.72)",
                    fontFamily: "Jost, sans-serif",
                    fontSize: 12,
                    fontWeight: 400,
                    lineHeight: 1.4,
                    textAlign: "center",
                }}
                role="status"
                aria-live="polite"
            >
                {message ? message : <>
                By joining, you agree to emails. Unsubscribe anytime. {" "}
                <a
                    href={privacyUrl}
                    style={{ color: "inherit", textDecoration: "underline" }}
                >
                    Privacy Policy
                </a>
                .
                </>}
            </div>

            <button
                type="submit"
                disabled={status === "pending" || status === "success"}
                style={{
                    width: "100%",
                    minHeight: 42,
                    border: 0,
                    borderRadius: 0,
                    background: "#7D896D",
                    color: "#EAE6E3",
                    cursor: status === "pending" || status === "success" ? "default" : "pointer",
                    fontFamily: "Montserrat, sans-serif",
                    fontSize: 12,
                    fontWeight: 600,
                    letterSpacing: "0.02em",
                    opacity: status === "pending" ? 0.72 : 1,
                    transition: "background-color 180ms ease, opacity 180ms ease",
                }}
            >
                {status === "pending"
                    ? "JOINING..."
                    : status === "success"
                      ? successLabel
                      : status === "error" ? "TRY AGAIN" : buttonLabel}
            </button>

            <span aria-live="polite" style={{ position: "absolute", left: -5000 }}>
                {status === "success" ? successLabel : ""}
            </span>
        </form>
    )
}

addPropertyControls(MailchimpSignup, {
    buttonLabel: {
        type: ControlType.String,
        title: "Button",
        defaultValue: "JOIN THE COMMUNITY",
    },
    successLabel: {
        type: ControlType.String,
        title: "Success",
        defaultValue: "CHECK YOUR EMAIL TO CONFIRM",
    },
    privacyUrl: {
        type: ControlType.Link,
        title: "Privacy",
        defaultValue: "/privacy-policy",
    },
})
