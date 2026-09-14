import {
    forwardRef,
    useEffect,
    useRef,
    type ComponentType,
} from "react"

const STYLE_ID = "moving-modesty-checkout-slider-styles"
const ROOT_SELECTOR = '[data-mm-checkout-slider="true"]'
const CART_KEY = "moving-modesty-cart-v1"
const FULFILMENT_KEY = "moving-modesty-fulfilment-v1"
const FULFILMENT_EVENT = "moving-modesty-fulfilment-updated"
const CHECKOUT_TOKEN_KEY = "moving-modesty-checkout-token-v1"
const ORDER_API_BASE = "https://movingmodesty.vercel.app"
const STEP_NAMES = [
    "1. Contact details",
    "2. Fulfilment method",
    "3. Delivery address",
    "4. Payment",
]

type Cleanup = () => void
type FulfilmentMethod = "delivery" | "collection"
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

    if (readCartItems().length === 0 && window.location.pathname.replace(/\/$/, "") === "/checkout") {
        window.location.replace("/cart")
        return null
    }

    const submit = directChildren.find((child) => !steps.includes(child))
    const cleanups: Cleanup[] = []
    const injectedNodes: HTMLElement[] = []
    let activeIndex = 0
    let animating = false
    let fulfilmentMethod: FulfilmentMethod = "delivery"
    let orderReference = ""
    let requestInFlight = false

    root.dataset.mmCheckoutReady = "true"
    root.dataset.mmActiveStep = "1"
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
            option.tabIndex = selected ? 0 : -1
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
        try {
            return window.localStorage.getItem(FULFILMENT_KEY) === "collection" ? "collection" : "delivery"
        } catch {
            return "delivery"
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
        const address = effectiveMethod === "delivery" ? {
            line1: fieldValue(root, "checkoutStreet"),
            line2: fieldValue(root, "checkoutStreet2", "addressLine2"),
            suburb: fieldValue(root, "suburb"),
            city: fieldValue(root, "checkoutCity"),
            province: fieldValue(root, "checkoutProvince"),
            postalCode: fieldValue(root, "checkoutPostal"),
        } : undefined

        if ((stage === "address" || stage === "complete") && effectiveMethod === "delivery") {
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
            const response = await fetch(`${ORDER_API_BASE}/api/checkout/orders`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(checkoutPayload(stage)),
            })
            const data = await response.json().catch(() => null)
            if (!response.ok || !data?.order?.orderNumber) {
                throw new Error(data?.error || "Your order could not be saved. Please try again.")
            }
            orderReference = data.order.orderNumber
            if (stage === "complete") {
                window.localStorage.removeItem(CART_KEY)
                window.localStorage.removeItem(CHECKOUT_TOKEN_KEY)
                window.dispatchEvent(new CustomEvent("moving-modesty-cart-updated", { detail: [] }))
                showFeedback(`Order ${orderReference} has been created and is awaiting payment.`, "success")
            }
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
        step.dataset.mmActive = String(index === 0)
        step.setAttribute("aria-hidden", String(index !== 0))

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
            next.textContent = index === steps.length - 1 ? "Create order" : "Continue"
            next.setAttribute("aria-label", index === steps.length - 1 ? "Create order" : "Continue to the next checkout step")
            const onNext = async () => {
                const stage: CheckoutStage = index === 0 ? "started" : index === 1 ? "fulfilment" : index === 2 ? "address" : "complete"
                if (index === steps.length - 1) {
                    const synced = await syncOrder("complete")
                    if (!synced) return
                } else {
                    try {
                        checkoutPayload(stage)
                        showFeedback("")
                    } catch (error) {
                        showFeedback(error instanceof Error ? error.message : "Please complete this step.")
                        return
                    }
                }
                if (index === steps.length - 1) {
                    next.disabled = true
                    next.textContent = "Order created"
                    return
                }
                const nextIndex = index === 1 && fulfilmentMethod === "collection" ? 3 : index + 1
                void goTo(nextIndex)
            }
            next.addEventListener("click", onNext as EventListener)
            cleanups.push(() => next.removeEventListener("click", onNext as EventListener))
            nav.appendChild(next)
        }

        step.appendChild(nav)
        injectedNodes.push(nav)
    })

    updateProgress(0)

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
