import {
    forwardRef,
    useEffect,
    useRef,
    type ComponentType,
} from "react"

const STYLE_ID = "moving-modesty-checkout-slider-styles"
const ROOT_SELECTOR = '[data-mm-checkout-slider="true"]'
const CART_KEY = "moving-modesty-cart-v1"
const FULFILMENT_KEY = "moving-modesty-fulfilment-v2"
const FULFILMENT_EVENT = "moving-modesty-fulfilment-updated"
const CHECKOUT_TOKEN_KEY = "moving-modesty-checkout-token-v1"
const CHECKOUT_DRAFT_KEY = "moving-modesty-checkout-draft-v1"
const ORDER_API_BASE = "https://movingmodesty.vercel.app"
async function checkoutFetch(url: string, init?: RequestInit) {
    try { return await fetch(url, { ...init, signal: init?.signal || AbortSignal.timeout(20000) }) }
    catch (error) {
        if (error instanceof Error && (error.name === "TypeError" || error.name === "TimeoutError")) {
            // Never report checkout tokens, customer details, addresses or URLs.
            void fetch(`${ORDER_API_BASE}/api/diagnostics/browser`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ surface: "checkout", code: error.name === "TimeoutError" ? "browser_timeout" : "browser_network" }), signal: AbortSignal.timeout(5000) }).catch(() => undefined)
        }
        throw error
    }
}
function checkoutErrorMessage(data: { error?: string; errorRef?: string } | null, fallback: string) {
    return `${data?.error || fallback}${data?.errorRef ? ` Reference: ${data.errorRef}` : ""}`
}
const STEP_NAMES = [
    "1. Contact details",
    "2. Fulfilment method",
    "3. Delivery address",
    "4. Payment",
]

type Cleanup = () => void
type FulfilmentMethod = "delivery" | "collection" | "to_be_confirmed"
type CheckoutStage = "started" | "fulfilment" | "address" | "complete"

interface StoredCartItem {
    id?: string
    sku?: string
    productSlug?: string
    name?: string
    colour?: string
    size?: string
    quantity?: number
}

interface PayFastPayment {
    action: string
    fields: Record<string, string>
}

function paymentReturnState() {
    const params = new URLSearchParams(window.location.search)
    const payment = params.get("payment")
    return {
        payment: payment === "processing" || payment === "cancelled" ? payment : "",
        orderNumber: params.get("order")?.trim() || "",
    }
}

function submitPayFastForm(payment: PayFastPayment) {
    const destination = new URL(payment.action)
    if (!["www.payfast.co.za", "sandbox.payfast.co.za"].includes(destination.hostname)) {
        throw new Error("The payment destination is invalid.")
    }

    const form = document.createElement("form")
    form.method = "POST"
    form.action = destination.toString()
    form.style.display = "none"
    Object.entries(payment.fields).forEach(([name, value]) => {
        const input = document.createElement("input")
        input.type = "hidden"
        input.name = name
        input.value = value
        form.appendChild(input)
    })
    document.body.appendChild(form)
    form.submit()
}

function fieldValue(root: HTMLElement, ...names: string[]): string {
    for (const name of names) {
        const field = root.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            `[name="${name}"]`
        )
        const value = field?.value.trim()
        if (value) return value
    }
    return ""
}

function sizeCode(size: string): string {
    const normalized = size.trim().toLowerCase()
    if (normalized === "small") return "S"
    if (normalized === "large") return "L"
    if (normalized.includes("one size")) return "OS"
    return normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase()
}

function legacySku(item: StoredCartItem): string {
    const identity = `${item.productSlug || ""} ${item.name || ""}`.toLowerCase()
    const colour = String(item.colour || "").toLowerCase()
    let base = ""
    if (identity.includes("amina")) {
        base = colour.includes("lavender") ? "AMINA-LAV" : colour.includes("lilac") ? "AMINA-LIL" : "AMINA-BLK"
    } else if (identity.includes("hawa")) {
        base = colour.includes("pink") ? "HAWA-PNK" : colour.includes("sage") ? "HAWA-SGE" : colour.includes("grey") || colour.includes("gray") ? "HAWA-GRY" : "HAWA-BLK"
    }
    const suffix = sizeCode(String(item.size || ""))
    return base && suffix ? `${base}-${suffix}` : ""
}

function readCartItems(): Array<{ sku: string; quantity: number }> {
    let cart: StoredCartItem[] = []
    try {
        const parsed = JSON.parse(window.localStorage.getItem(CART_KEY) || "[]")
        if (Array.isArray(parsed)) cart = parsed
    } catch {
        cart = []
    }
    return cart.map((item) => ({
        sku: String(item.sku || legacySku(item)).trim().toUpperCase(),
        quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
    }))
}

function getCheckoutToken(): string {
    const existing = window.localStorage.getItem(CHECKOUT_TOKEN_KEY)
    if (existing) return existing
    const created = typeof window.crypto?.randomUUID === "function"
        ? window.crypto.randomUUID()
        : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (character) =>
            (Number(character) ^ window.crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(character) / 4).toString(16)
        )
    window.localStorage.setItem(CHECKOUT_TOKEN_KEY, created)
    return created
}

const CHECKOUT_FIELDS: Record<string, string> = {
    checkoutFullName: "given-name", firstName: "given-name", lastName: "family-name",
    checkoutEmail: "email", checkoutPhone: "tel", checkoutStreet: "address-line1",
    checkoutStreet2: "address-line2", addressLine2: "address-line2", suburb: "address-level3",
    checkoutCity: "address-level2", checkoutProvince: "address-level1", checkoutPostal: "postal-code",
}
const PROVINCES = ["Eastern Cape", "Free State", "Gauteng", "KwaZulu-Natal", "Limpopo", "Mpumalanga", "North West", "Northern Cape", "Western Cape"]
function cartFingerprint(items: Array<{ sku: string; quantity: number }>) {
    const totals = new Map<string, number>()
    items.forEach(item => totals.set(item.sku.toUpperCase(), (totals.get(item.sku.toUpperCase()) || 0) + item.quantity))
    return JSON.stringify([...totals].sort(([a], [b]) => a.localeCompare(b)))
}
function restoreField(root: HTMLElement, name: string, value: string) {
    const field = root.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${name}"]`)
    if (!field) return
    const prototype = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value)
    field.dispatchEvent(new Event("input", { bubbles: true }))
    field.dispatchEvent(new Event("change", { bubbles: true }))
}

function addStyles() {
    if (document.getElementById(STYLE_ID)) return

    const style = document.createElement("style")
    style.id = STYLE_ID
    style.textContent = `
${ROOT_SELECTOR} {
  gap: 0 !important;
  overflow-x: clip !important;
  scroll-margin-top: 104px !important;
}
${ROOT_SELECTOR} > [data-mm-checkout-step] {
  display: none !important;
  width: 100% !important;
  box-sizing: border-box !important;
}
${ROOT_SELECTOR} > [data-mm-checkout-step][data-mm-active="true"] {
  display: flex !important;
  padding: 28px !important;
  border: 1px solid rgba(51, 43, 37, .16) !important;
  background: #fff !important;
  box-shadow: 0 14px 34px rgba(51, 43, 37, .055) !important;
}
${ROOT_SELECTOR} > [data-mm-checkout-submit] {
  display: none !important;
}
.mm-checkout-progress {
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 18px;
}
.mm-checkout-progress-copy {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 10px;
  color: #332b25;
  font: 500 12px/1.2 Jost, sans-serif;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.mm-checkout-progress-name {
  color: #738063;
  letter-spacing: .06em;
  text-align: right;
}
.mm-checkout-progress-track {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 7px;
}
.mm-checkout-progress-segment {
  height: 3px;
  background: rgba(51, 43, 37, .12);
  transition: background .24s ease;
}
.mm-checkout-progress-segment[data-complete="true"] {
  background: #738063;
}
.mm-checkout-feedback {
  display: none;
  width: 100%;
  margin: 0 0 14px;
  padding: 12px 14px;
  border: 1px solid rgba(139, 62, 47, .35);
  background: rgba(139, 62, 47, .07);
  color: #7a352b;
  font: 500 13px/1.45 Jost, sans-serif;
  box-sizing: border-box;
}
.mm-checkout-feedback[data-visible="true"] { display: block; }
.mm-checkout-feedback[data-tone="success"] {
  border-color: rgba(115, 128, 99, .45);
  background: rgba(115, 128, 99, .10);
  color: #536047;
}
.mm-checkout-nav {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 8px;
  box-sizing: border-box;
}
.mm-checkout-nav[data-first="false"] {
  justify-content: space-between;
}
.mm-checkout-nav button {
  min-height: 50px;
  padding: 13px 22px;
  border-radius: 0;
  font: 500 14px/1 Jost, sans-serif;
  letter-spacing: .04em;
  cursor: pointer;
  transition: transform .18s ease, opacity .18s ease, background .18s ease;
}
.mm-checkout-nav button:hover {
  transform: translateY(-1px);
}
.mm-checkout-nav button:active {
  transform: translateY(0);
}
.mm-checkout-nav button:focus-visible {
  outline: 2px solid #738063;
  outline-offset: 3px;
}
.mm-checkout-nav button:disabled {
  cursor: wait;
  opacity: .6;
}
.mm-checkout-back {
  color: #332b25;
  background: transparent;
  border: 1px solid rgba(51, 43, 37, .25);
}
.mm-checkout-next {
  min-width: 148px;
  color: #fff;
  background: #738063;
  border: 1px solid #738063;
}
.mm-checkout-next:hover {
  background: #657257;
}
${ROOT_SELECTOR} [data-mm-fulfilment-option] {
  cursor: pointer !important;
  background: #fff !important;
  border: 1px solid rgba(51, 43, 37, .20) !important;
  box-shadow: none !important;
  transition: background .2s ease, border-color .2s ease, box-shadow .2s ease, transform .18s ease !important;
}
${ROOT_SELECTOR} [data-mm-fulfilment-option]:hover {
  border-color: rgba(115, 128, 99, .72) !important;
  transform: translateY(-1px);
}
${ROOT_SELECTOR} [data-mm-fulfilment-option]:focus-visible {
  outline: 2px solid #738063;
  outline-offset: 3px;
}
${ROOT_SELECTOR} [data-mm-fulfilment-option][data-mm-selected="true"] {
  background: rgb(205, 227, 179) !important;
  border-color: #738063 !important;
  box-shadow: inset 0 0 0 1px rgba(115, 128, 99, .25) !important;
}
@media (max-width: 767px) {
  ${ROOT_SELECTOR} > [data-mm-checkout-step][data-mm-active="true"] {
    padding: 20px 16px !important;
  }
  .mm-checkout-progress {
    margin-bottom: 14px;
  }
  .mm-checkout-progress-copy {
    gap: 10px;
    font-size: 12px;
  }
  .mm-checkout-progress-name {
    max-width: 58%;
  }
  .mm-checkout-nav {
    align-items: stretch;
  }
  .mm-checkout-nav[data-first="false"] button {
    flex: 1;
  }
  .mm-checkout-nav button {
    min-height: 48px;
    padding: 12px 14px;
  }
  .mm-checkout-next {
    min-width: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .mm-checkout-progress-segment,
  .mm-checkout-nav button,
  ${ROOT_SELECTOR} [data-mm-fulfilment-option] {
    transition: none;
  }
}
`
    document.head.appendChild(style)
}

function setupSlider(root: HTMLElement): Cleanup | null {
    if (root.dataset.mmCheckoutReady === "true") return null

    const directChildren = Array.from(root.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement
    )
    const steps = STEP_NAMES.map((name) =>
        directChildren.find((child) => child.dataset.framerName === name)
    ).filter((step): step is HTMLElement => Boolean(step))

    if (steps.length !== STEP_NAMES.length) return null

    const returnState = paymentReturnState()
    if (
        readCartItems().length === 0 &&
        !returnState.payment &&
        window.location.pathname.replace(/\/$/, "") === "/checkout"
    ) {
        window.location.replace("/cart")
        return null
    }

    const submit = directChildren.find((child) => !steps.includes(child))
    const cleanups: Cleanup[] = []
    const injectedNodes: HTMLElement[] = []
    let activeIndex = returnState.payment ? 3 : 0
    let animating = false
    let fulfilmentMethod: FulfilmentMethod = "to_be_confirmed"
    let orderReference = returnState.orderNumber
    let requestInFlight = false
    let disposed = false
    let paymentLocked = Boolean(returnState.payment)
    let recoveryInFlight = Boolean(returnState.payment)
    const recoveryController = new AbortController()
    const checkoutFields = Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea"))
    function validateFields() {
        checkoutFields.forEach(field => {
            field.setCustomValidity("")
            if (field.disabled) return
            if (field.name === "checkoutProvince" && field.value && !PROVINCES.includes(field.value.trim())) field.setCustomValidity("Please choose a South African province.")
            if (field.name === "checkoutPhone" && field.value) {
                const phone = field.value.trim().replace(/[\s().-]/g, "").replace(/^0027/, "+27")
                if (!/^(?:0\d{9}|\+?27\d{9})$/.test(phone)) field.setCustomValidity("Please enter a valid South African phone number.")
            }
        })
    }
    checkoutFields.forEach(field => {
        const autocomplete = CHECKOUT_FIELDS[field.name]
        if (!autocomplete) return
        const original = { autocomplete: field.getAttribute("autocomplete"), type: field.getAttribute("type"),
            inputmode: field.getAttribute("inputmode"), pattern: field.getAttribute("pattern"), required: field.required }
        field.setAttribute("autocomplete", autocomplete)
        if (field instanceof HTMLInputElement) {
            if (autocomplete === "email") field.type = "email"
            if (autocomplete === "tel") { field.type = "tel"; field.inputMode = "tel" }
            if (autocomplete === "postal-code") { field.type = "text"; field.inputMode = "numeric"; field.pattern = "[0-9]{4}" }
        }
        if (autocomplete !== "address-line2") field.required = true
        cleanups.push(() => {
            for (const attr of ["autocomplete", "type", "inputmode", "pattern"] as const) {
                const value = original[attr]
                if (value === null) field.removeAttribute(attr)
                else field.setAttribute(attr, value)
            }
            field.required = original.required
            field.setCustomValidity("")
        })
    })
    function saveDraft() {
        if (recoveryInFlight || disposed || (paymentLocked && returnState.payment)) return
        try {
            const fields = Object.fromEntries(checkoutFields.filter(field => field.name in CHECKOUT_FIELDS).map(field => [field.name, field.value]))
            window.sessionStorage.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify({ token: getCheckoutToken(), orderReference,
                fields, fulfilmentMethod, savedAt: Date.now(), cart: JSON.parse(window.localStorage.getItem(CART_KEY) || "[]") }))
        } catch { /* Server recovery remains available if storage is restricted. */ }
    }
    const onFieldChange = () => { validateFields(); saveDraft() }
    root.addEventListener("input", onFieldChange)
    root.addEventListener("change", onFieldChange)
    cleanups.push(() => { disposed = true; recoveryController.abort(); root.removeEventListener("input", onFieldChange); root.removeEventListener("change", onFieldChange) })

    root.dataset.mmCheckoutReady = "true"
    root.dataset.mmActiveStep = String(activeIndex + 1)
    if (submit) submit.dataset.mmCheckoutSubmit = "true"

    const blockNativeSubmit = (event: Event) => {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
    }

    root.addEventListener("submit", blockNativeSubmit, true)
    cleanups.push(() => root.removeEventListener("submit", blockNativeSubmit, true))

    if (submit) {
        submit.addEventListener("click", blockNativeSubmit, true)
        cleanups.push(() => submit.removeEventListener("click", blockNativeSubmit, true))
    }

    const deliveryOption = steps[1].querySelector<HTMLElement>(
        '[data-framer-name="Delivery"]'
    )
    const collectionOption = steps[1].querySelector<HTMLElement>(
        '[data-framer-name="Collection"]'
    )
    const fulfilmentOptions = [deliveryOption, collectionOption].filter(
        (option): option is HTMLElement => Boolean(option)
    )
    const fulfilmentGroup = deliveryOption?.parentElement ?? null
    const addressFields = Array.from(
        steps[2].querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            "input, select, textarea"
        )
    )
    const originalDisabledStates = new Map(
        addressFields.map((field) => [field, field.disabled])
    )

    const fulfilmentInput = document.createElement("input")
    fulfilmentInput.type = "hidden"
    fulfilmentInput.name = "checkoutFulfilmentMethod"
    fulfilmentInput.value = fulfilmentMethod
    root.appendChild(fulfilmentInput)
    injectedNodes.push(fulfilmentInput)

    function setFulfilmentMethod(method: FulfilmentMethod, moveFocus = false) {
        fulfilmentMethod = method
        fulfilmentInput.value = method

        fulfilmentOptions.forEach((option) => {
            const optionMethod = option === deliveryOption ? "delivery" : "collection"
            const selected = optionMethod === method
            option.dataset.mmSelected = String(selected)
            option.setAttribute("aria-checked", String(selected))
            option.tabIndex = selected || (method === "to_be_confirmed" && option === deliveryOption) ? 0 : -1
        })

        const isCollection = method === "collection"
        addressFields.forEach((field) => {
            field.disabled = isCollection ? true : (originalDisabledStates.get(field) ?? false)
        })

        try {
            window.localStorage.setItem(FULFILMENT_KEY, method)
        } catch {
            // The custom event still keeps components on this page in sync.
        }
        window.dispatchEvent(
            new CustomEvent<FulfilmentMethod>(FULFILMENT_EVENT, {
                detail: method,
            })
        )

        if (moveFocus) {
            const selectedOption = method === "delivery" ? deliveryOption : collectionOption
            selectedOption?.focus({ preventScroll: true })
        }
        saveDraft()
    }

    if (fulfilmentGroup) {
        fulfilmentGroup.setAttribute("role", "radiogroup")
        fulfilmentGroup.setAttribute("aria-label", "Fulfilment method")
    }

    fulfilmentOptions.forEach((option) => {
        const method: FulfilmentMethod = option === deliveryOption ? "delivery" : "collection"
        option.dataset.mmFulfilmentOption = method
        option.setAttribute("role", "radio")

        const onClick = (event: Event) => {
            event.preventDefault()
            setFulfilmentMethod(method)
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                setFulfilmentMethod(method)
                return
            }
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return
            event.preventDefault()
            const useDelivery = event.key === "ArrowLeft" || event.key === "ArrowUp"
            setFulfilmentMethod(useDelivery ? "delivery" : "collection", true)
        }

        option.addEventListener("click", onClick)
        option.addEventListener("keydown", onKeyDown)
        cleanups.push(() => {
            option.removeEventListener("click", onClick)
            option.removeEventListener("keydown", onKeyDown)
        })
    })

    const savedFulfilment = (() => {
        // A new checkout must not inherit a previous customer's choice or the
        // old implicit Delivery default. Only restore when returning from PayFast.
        if (!returnState.payment) return "to_be_confirmed"
        try {
            const method = window.localStorage.getItem(FULFILMENT_KEY)
            return method === "collection" || method === "delivery" ? method : "to_be_confirmed"
        } catch {
            return "to_be_confirmed"
        }
    })()
    setFulfilmentMethod(savedFulfilment)

    const progress = document.createElement("div")
    progress.className = "mm-checkout-progress"
    progress.setAttribute("aria-label", "Checkout progress")

    const progressCopy = document.createElement("div")
    progressCopy.className = "mm-checkout-progress-copy"

    const count = document.createElement("span")
    const stepName = document.createElement("span")
    stepName.className = "mm-checkout-progress-name"
    progressCopy.append(count, stepName)

    const track = document.createElement("div")
    track.className = "mm-checkout-progress-track"
    const segments = STEP_NAMES.map(() => {
        const segment = document.createElement("span")
        segment.className = "mm-checkout-progress-segment"
        track.appendChild(segment)
        return segment
    })

    progress.append(progressCopy, track)
    root.insertBefore(progress, steps[0])
    injectedNodes.push(progress)

    const feedback = document.createElement("div")
    feedback.className = "mm-checkout-feedback"
    feedback.setAttribute("role", "status")
    feedback.setAttribute("aria-live", "polite")
    root.insertBefore(feedback, steps[0])
    injectedNodes.push(feedback)

    function showFeedback(message: string, tone: "error" | "success" = "error") {
        feedback.textContent = message
        feedback.dataset.visible = String(Boolean(message))
        feedback.dataset.tone = tone
    }

    // The return URL isn't proof of payment. Only a verified server status
    // below may show success and clear this checkout's cart.

    function checkoutPayload(stage: CheckoutStage) {
        const firstName = fieldValue(root, "checkoutFullName", "firstName")
        const lastName = fieldValue(root, "lastName")
        const email = fieldValue(root, "checkoutEmail")
        const phone = fieldValue(root, "checkoutPhone")
        if (!firstName || !lastName || !email || !phone) {
            throw new Error("Please complete your name, email address, and phone number.")
        }

        const items = readCartItems()
        if (items.length === 0) throw new Error("Your cart is empty.")
        if (items.some((item) => !item.sku)) {
            throw new Error("One of the cart items needs to be added again before checkout.")
        }

        const effectiveMethod = stage === "started" ? "to_be_confirmed" : fulfilmentMethod
        if (stage !== "started" && effectiveMethod === "to_be_confirmed") {
            throw new Error("Please choose delivery or collection before continuing.")
        }
        const needsAddress = effectiveMethod === "delivery" && (stage === "address" || stage === "complete")
        const address = needsAddress ? {
            line1: fieldValue(root, "checkoutStreet"),
            line2: fieldValue(root, "checkoutStreet2", "addressLine2"),
            suburb: fieldValue(root, "suburb"),
            city: fieldValue(root, "checkoutCity"),
            province: fieldValue(root, "checkoutProvince"),
            postalCode: fieldValue(root, "checkoutPostal"),
        } : undefined

        if (needsAddress) {
            if (!address?.line1 || !address.suburb || !address.city || !address.province || !address.postalCode) {
                throw new Error("Please complete the delivery address.")
            }
        }

        return {
            checkoutToken: getCheckoutToken(),
            stage,
            customer: { firstName, lastName, email, phone },
            fulfilmentMethod: effectiveMethod,
            address,
            items,
        }
    }

    async function syncOrder(stage: CheckoutStage): Promise<boolean> {
        if (requestInFlight) return false
        requestInFlight = true
        showFeedback("")
        root.querySelectorAll<HTMLButtonElement>(".mm-checkout-nav button").forEach((button) => {
            button.disabled = true
        })
        try {
            let payload = checkoutPayload(stage)
            let response = await checkoutFetch(`${ORDER_API_BASE}/api/checkout/orders`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(15_000),
            })
            let data = await response.json().catch(() => null)
            if (response.status === 409 && data?.code === "CHECKOUT_CHANGED") {
                // Changed details need a fresh order, not an edited payment.
                window.localStorage.removeItem(CHECKOUT_TOKEN_KEY)
                payload = { ...payload, checkoutToken: getCheckoutToken() }
                orderReference = ""
                response = await checkoutFetch(`${ORDER_API_BASE}/api/checkout/orders`, {
                    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(15_000),
                })
                data = await response.json().catch(() => null)
            }
            if (!response.ok || !data?.order?.orderNumber) {
                throw new Error(checkoutErrorMessage(data, "Your order could not be saved. Please try again."))
            }
            orderReference = data.order.orderNumber
            saveDraft()
            window.dispatchEvent(new CustomEvent("moving-modesty-order-updated", { detail: data.order }))
            return true
        } catch (error) {
            showFeedback(error instanceof Error ? error.message : "Your order could not be saved.")
            return false
        } finally {
            requestInFlight = false
            root.querySelectorAll<HTMLButtonElement>(".mm-checkout-nav button").forEach((button) => {
                button.disabled = false
            })
        }
    }

    async function beginPayFastPayment(): Promise<boolean> {
        validateFields()
        for (const index of [0, ...(fulfilmentMethod === "delivery" ? [2] : [])]) {
            const invalid = getInvalidField(steps[index])
            if (invalid) {
                await goTo(index)
                invalid.reportValidity()
                invalid.focus()
                showFeedback("Please check the highlighted information before paying.")
                return false
            }
        }
        // Always persist the final checkout state before opening PayFast. This
        // keeps Neon authoritative even when the customer changed an earlier
        // field after the order was first created.
        const synced = await syncOrder("complete")
        if (!synced) return false

        requestInFlight = true
        showFeedback("")
        root.querySelectorAll<HTMLButtonElement>(".mm-checkout-nav button").forEach((button) => {
            button.disabled = true
        })
        try {
            const response = await checkoutFetch(`${ORDER_API_BASE}/api/payments/payfast/checkout`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    orderNumber: orderReference,
                    checkoutToken: getCheckoutToken(),
                }),
            })
            const data = await response.json().catch(() => null)
            if (!response.ok || !data?.payment?.action || !data?.payment?.fields) {
                throw new Error(checkoutErrorMessage(data, "Secure payment could not be started. Please try again."))
            }
            saveDraft()
            submitPayFastForm(data.payment as PayFastPayment)
            return true
        } catch (error) {
            showFeedback(error instanceof Error ? error.message : "Secure payment could not be started.")
            return false
        } finally {
            requestInFlight = false
            root.querySelectorAll<HTMLButtonElement>(".mm-checkout-nav button").forEach((button) => {
                button.disabled = false
            })
        }
    }

    function updateProgress(index: number) {
        count.textContent = `Step ${index + 1} of ${steps.length}`
        stepName.textContent = STEP_NAMES[index].replace(/^\d+\.\s*/, "")
        segments.forEach((segment, segmentIndex) => {
            segment.dataset.complete = String(segmentIndex <= index)
            if (segmentIndex === index) segment.setAttribute("aria-current", "step")
            else segment.removeAttribute("aria-current")
        })
    }

    function getInvalidField(step: HTMLElement) {
        validateFields()
        const fields = Array.from(
            step.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
                "input, select, textarea"
            )
        )
        return fields.find((field) => !field.checkValidity())
    }

    async function goTo(nextIndex: number) {
        if (animating || nextIndex < 0 || nextIndex >= steps.length || nextIndex === activeIndex) return

        const movingForward = nextIndex > activeIndex
        if (movingForward) {
            const invalidField = getInvalidField(steps[activeIndex])
            if (invalidField) {
                invalidField.reportValidity()
                invalidField.focus()
                return
            }
        }

        animating = true
        root.querySelectorAll<HTMLButtonElement>(".mm-checkout-nav button").forEach((button) => {
            button.disabled = true
        })

        const outgoing = steps[activeIndex]
        const incoming = steps[nextIndex]
        const direction = movingForward ? 1 : -1
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches

        if (!reduceMotion) {
            const exitAnimation = outgoing.animate(
                [
                    { opacity: 1, transform: "translateX(0)" },
                    { opacity: 0, transform: `translateX(${-direction * 42}px)` },
                ],
                { duration: 170, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }
            )
            await exitAnimation.finished.catch(() => undefined)
        }

        outgoing.dataset.mmActive = "false"
        outgoing.setAttribute("aria-hidden", "true")
        outgoing.getAnimations().forEach((animation) => animation.cancel())

        activeIndex = nextIndex
        root.dataset.mmActiveStep = String(activeIndex + 1)
        incoming.dataset.mmActive = "true"
        incoming.setAttribute("aria-hidden", "false")
        updateProgress(activeIndex)

        if (!reduceMotion) {
            const enterAnimation = incoming.animate(
                [
                    { opacity: 0, transform: `translateX(${direction * 42}px)` },
                    { opacity: 1, transform: "translateX(0)" },
                ],
                { duration: 280, easing: "cubic-bezier(.22,1,.36,1)" }
            )
            await enterAnimation.finished.catch(() => undefined)
        }

        root.querySelectorAll<HTMLButtonElement>(".mm-checkout-nav button").forEach((button) => {
            button.disabled = false
        })
        animating = false

        const heading = incoming.firstElementChild as HTMLElement | null
        if (heading) {
            heading.tabIndex = -1
            heading.focus({ preventScroll: true })
        }
        root.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" })
    }

    steps.forEach((step, index) => {
        step.dataset.mmCheckoutStep = String(index + 1)
        step.dataset.mmActive = String(index === activeIndex)
        step.setAttribute("aria-hidden", String(index !== activeIndex))

        const nav = document.createElement("div")
        nav.className = "mm-checkout-nav"
        nav.dataset.first = String(index === 0)

        if (index > 0) {
            const back = document.createElement("button")
            back.type = "button"
            back.className = "mm-checkout-back"
            back.textContent = "Back"
            back.setAttribute("aria-label", `Back to step ${index}`)
            const onBack = () => {
                if (recoveryInFlight || requestInFlight || paymentLocked) return
                const previousIndex = index === 3 && fulfilmentMethod === "collection" ? 1 : index - 1
                void goTo(previousIndex)
            }
            back.addEventListener("click", onBack)
            cleanups.push(() => back.removeEventListener("click", onBack))
            nav.appendChild(back)
        }

        if (index < steps.length) {
            const next = document.createElement("button")
            next.type = "button"
            next.className = "mm-checkout-next"
            next.textContent = index === steps.length - 1 ? "Pay securely" : "Continue"
            next.setAttribute("aria-label", index === steps.length - 1 ? "Pay securely with PayFast" : "Continue to the next checkout step")
            const onNext = async () => {
                if (recoveryInFlight || requestInFlight) return
                if (paymentLocked) { showStepImmediately(3); void recoverReturn(false); return }
                const invalid = getInvalidField(step)
                if (invalid) { invalid.reportValidity(); invalid.focus(); return }
                const stage: CheckoutStage = index === 0 ? "started" : index === 1 ? "fulfilment" : index === 2 ? "address" : "complete"
                if (index === steps.length - 1) {
                    next.textContent = "Opening PayFast…"
                    const started = await beginPayFastPayment()
                    if (!started) next.textContent = "Pay securely"
                    return
                } else {
                    try {
                        checkoutPayload(stage)
                        showFeedback("")
                    } catch (error) {
                        showFeedback(error instanceof Error ? error.message : "Please complete this step.")
                        return
                    }
                    // Save each completed checkout stage to Neon. An order is
                    // therefore visible in admin even if PayFast never opens or
                    // the customer leaves the checkout before paying.
                    const saved = await syncOrder(stage)
                    if (!saved) return
                }
                const nextIndex = index === 1 && fulfilmentMethod === "collection" ? 3 : index + 1
                void goTo(nextIndex)
            }
            next.addEventListener("click", onNext as EventListener)
            cleanups.push(() => next.removeEventListener("click", onNext as EventListener))
            nav.appendChild(next)

            if (returnState.payment) next.disabled = true
        }

        step.appendChild(nav)
        injectedNodes.push(nav)
    })

    updateProgress(activeIndex)

    function showStepImmediately(index: number) {
        activeIndex = index
        root.dataset.mmActiveStep = String(index + 1)
        steps.forEach((step, stepIndex) => {
            step.dataset.mmActive = String(stepIndex === index)
            step.setAttribute("aria-hidden", String(stepIndex !== index))
        })
        updateProgress(index)
    }
    function updatePaymentButtons(paid = false) {
        root.querySelectorAll<HTMLButtonElement>(".mm-checkout-nav button").forEach(button => {
            const statusButton = button.closest('[data-mm-checkout-step="4"]') && button.classList.contains("mm-checkout-next")
            button.disabled = recoveryInFlight || paid || (paymentLocked && !statusButton)
            if (button.closest('[data-mm-checkout-step="4"]') && button.classList.contains("mm-checkout-next")) {
                button.textContent = paid ? "Payment confirmed" : recoveryInFlight ? "Checking payment…" : paymentLocked ? "Check payment status" : "Pay securely"
            }
        })
    }
    async function recoverReturn(poll = true) {
        recoveryInFlight = true
        updatePaymentButtons()
        const savedToken = window.localStorage.getItem(CHECKOUT_TOKEN_KEY)
        let draft: any = null
        try {
            const saved = JSON.parse(window.sessionStorage.getItem(CHECKOUT_DRAFT_KEY) || "null")
            if (saved?.token === savedToken && saved.orderReference === orderReference && Date.now() - saved.savedAt < 24 * 60 * 60 * 1000) draft = saved
        } catch { /* Do not trust a damaged draft. */ }
        if (draft) {
            Object.entries(draft.fields || {}).forEach(([name, value]) => {
                if (name in CHECKOUT_FIELDS && typeof value === "string") restoreField(root, name, value)
            })
            if (["collection", "delivery"].includes(draft.fulfilmentMethod)) setFulfilmentMethod(draft.fulfilmentMethod)
            if (!readCartItems().length && Array.isArray(draft.cart)) {
                window.localStorage.setItem(CART_KEY, JSON.stringify(draft.cart))
                window.dispatchEvent(new CustomEvent("moving-modesty-cart-updated", { detail: draft.cart }))
            }
        }
        try {
            if (!savedToken || !orderReference) throw new Error("We couldn't restore this checkout session. Your cart has not been cleared.")
            for (let attempt = 0; attempt < (poll && returnState.payment === "processing" ? 5 : 1); attempt++) {
                const response = await checkoutFetch(`${ORDER_API_BASE}/api/checkout/session`, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ checkoutToken: savedToken, orderNumber: orderReference }),
                    signal: AbortSignal.any([recoveryController.signal, AbortSignal.timeout(12_000)]),
                })
                const data = await response.json().catch(() => null)
                if (!response.ok || !data?.session) throw new Error(checkoutErrorMessage(data, "Payment status could not be checked. Your cart is safe; check again shortly."))
                if (disposed) return
                if (window.localStorage.getItem(CHECKOUT_TOKEN_KEY) !== savedToken) {
                    throw new Error("Another checkout was started in this browser. This order has not changed and your current cart is safe. Please contact us if you need help confirming payment.")
                }
                const session = data.session
                if (attempt === 0 && !draft) {
                    const fields = { checkoutFullName: session.customer.firstName, lastName: session.customer.lastName,
                        checkoutEmail: session.customer.email, checkoutPhone: session.customer.phone,
                        checkoutStreet: session.address?.line1 || "", checkoutStreet2: session.address?.line2 || "",
                        suburb: session.address?.suburb || "", checkoutCity: session.address?.city || "",
                        checkoutProvince: session.address?.province || "", checkoutPostal: session.address?.postalCode || "" }
                    Object.entries(fields).forEach(([name, value]) => restoreField(root, name, String(value)))
                    setFulfilmentMethod(session.fulfilmentMethod)
                    if (!readCartItems().length && session.paymentStatus !== "paid") {
                        const cart = session.items.map((item: any) => ({ ...item.productSnapshot, id: item.sku,
                            sku: item.sku, productSlug: item.productSnapshot?.slug, name: item.name,
                            quantity: item.quantity, price: Number(item.price), priceLabel: `R ${Number(item.price).toFixed(2)}` }))
                        window.localStorage.setItem(CART_KEY, JSON.stringify(cart))
                        window.dispatchEvent(new CustomEvent("moving-modesty-cart-updated", { detail: cart }))
                    }
                }
                if (session.paymentStatus === "paid") {
                    paymentLocked = true
                    if (cartFingerprint(readCartItems()) === cartFingerprint(session.items)) {
                        window.localStorage.removeItem(CART_KEY)
                        window.dispatchEvent(new CustomEvent("moving-modesty-cart-updated", { detail: [] }))
                    }
                    if (window.localStorage.getItem(CHECKOUT_TOKEN_KEY) === savedToken) {
                        window.localStorage.removeItem(CHECKOUT_TOKEN_KEY)
                        window.sessionStorage.removeItem(CHECKOUT_DRAFT_KEY)
                    }
                    showStepImmediately(3)
                    showFeedback(`Payment confirmed for ${orderReference}. Thank you. ${session.fulfilmentMethod === "collection" ? "We will contact you with collection details." : "We will send your delivery details soon."}`, "success")
                    recoveryInFlight = false
                    updatePaymentButtons(true)
                    return
                }
                if (session.paymentStatus === "failed" && session.status === "new") {
                    paymentLocked = false
                    showFeedback("The payment wasn't completed. Your details and cart have been restored; you can try again.")
                    break
                }
                paymentLocked = true
                showFeedback(session.paymentStatus === "refunded" || session.status !== "new"
                    ? "This order is closed. Please contact us if you need help with it."
                    : `Payment for ${orderReference} is awaiting confirmation. Don't pay again yet. Check the status shortly.`)
                if (attempt < 4 && poll && returnState.payment === "processing") {
                    await new Promise<void>(resolve => {
                        const timer = window.setTimeout(resolve, 2500 * (attempt + 1))
                        recoveryController.signal.addEventListener("abort", () => { window.clearTimeout(timer); resolve() }, { once: true })
                    })
                    if (disposed) return
                }
            }
        } catch (error) {
            if (disposed) return
            showFeedback(error instanceof Error ? error.message : "Checkout could not be restored. Your cart has not been cleared.")
            paymentLocked = true
        }
        if (disposed) return
        recoveryInFlight = false
        if (!paymentLocked && (getInvalidField(steps[0]) || (fulfilmentMethod === "delivery" && getInvalidField(steps[2])) || fulfilmentMethod === "to_be_confirmed")) {
            showStepImmediately(getInvalidField(steps[0]) ? 0 : fulfilmentMethod === "to_be_confirmed" ? 1 : 2)
        }
        updatePaymentButtons()
        if (!paymentLocked) saveDraft()
    }
    if (returnState.payment) {
        showFeedback("Restoring your checkout and checking payment status…", "success")
        void recoverReturn()
    }

    return () => {
        cleanups.forEach((cleanup) => cleanup())
        injectedNodes.forEach((node) => node.remove())
        steps.forEach((step) => {
            delete step.dataset.mmCheckoutStep
            delete step.dataset.mmActive
            step.removeAttribute("aria-hidden")
        })
        fulfilmentOptions.forEach((option) => {
            delete option.dataset.mmFulfilmentOption
            delete option.dataset.mmSelected
            option.removeAttribute("role")
            option.removeAttribute("aria-checked")
            option.removeAttribute("tabindex")
        })
        if (fulfilmentGroup) {
            fulfilmentGroup.removeAttribute("role")
            fulfilmentGroup.removeAttribute("aria-label")
        }
        addressFields.forEach((field) => {
            field.disabled = originalDisabledStates.get(field) ?? false
        })
        if (submit) delete submit.dataset.mmCheckoutSubmit
        delete root.dataset.mmCheckoutReady
        delete root.dataset.mmActiveStep
    }
}

export function CheckoutSlider(Component: ComponentType<any>): ComponentType<any> {
    const CheckoutSliderOverride = forwardRef<HTMLElement, any>((props, forwardedRef) => {
        const rootRef = useRef<HTMLElement | null>(null)

        function setRootRef(node: HTMLElement | null) {
            rootRef.current = node
            if (typeof forwardedRef === "function") forwardedRef(node)
            else if (forwardedRef) forwardedRef.current = node
        }

        useEffect(() => {
            if (typeof document === "undefined" || !rootRef.current) return
            addStyles()
            const cleanup = setupSlider(rootRef.current)
            return cleanup ?? undefined
        }, [])

        return <Component {...props} ref={setRootRef} data-mm-checkout-slider="true" />
    })

    CheckoutSliderOverride.displayName = `CheckoutSlider(${Component.displayName || Component.name || "Component"})`
    return CheckoutSliderOverride
}
