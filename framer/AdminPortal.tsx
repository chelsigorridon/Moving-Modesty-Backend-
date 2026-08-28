import {
    startTransition,
    useEffect,
    useMemo,
    useState,
    type CSSProperties,
    type FormEvent,
    type ReactNode,
} from "react"
import { addPropertyControls, ControlType, useIsStaticRenderer } from "framer"

type View = "login" | "dashboard" | "orders" | "products"
type OrderStatus =
    | "New"
    | "Confirmed"
    | "Processing"
    | "Ready"
    | "Dispatched"
    | "Delivered"

interface OrderItem {
    name: string
    variant: string
    quantity: number
    price: number
}

interface AdminOrder {
    id: string
    customer: string
    email: string
    phone: string
    placedAt: string
    total: number
    paymentStatus: "Paid" | "Pending"
    status: OrderStatus
    deliveryMethod: "Courier" | "Collection" | "To be confirmed"
    address?: string
    items: OrderItem[]
}

interface ProductVariant {
    id?: string
    size: string
    colour: string
    sku: string
    stock: number
    price?: number
    lowStockThreshold?: number
}

interface AdminProduct {
    id: string
    name: string
    category: string
    description?: string
    price: number
    image?: string
    status: "Active" | "Draft"
    variants: ProductVariant[]
}

interface Snapshot {
    orders: AdminOrder[]
    products: AdminProduct[]
}

interface AdminPortalProps {
    view: View
    apiBaseUrl: string
    demoMode: boolean
    background: string
    surface: string
    softSurface: string
    ink: string
    muted: string
    sage: string
    border: string
    style?: CSSProperties
}

const demoSnapshot: Snapshot = {
    orders: [
        {
            id: "MM-1048",
            customer: "Naledi Mokoena",
            email: "naledi@example.com",
            phone: "+27 72 555 0148",
            placedAt: "28 Aug, 10:42",
            total: 1498,
            paymentStatus: "Paid",
            status: "New",
            deliveryMethod: "To be confirmed",
            address: "18 Acacia Avenue, Midrand, Gauteng, 1685",
            items: [
                { name: "Amina Abaya", variant: "Black · Size 54", quantity: 1, price: 749 },
                { name: "Amina Abaya", variant: "Lilac · Size 54", quantity: 1, price: 749 },
            ],
        },
        {
            id: "MM-1047",
            customer: "Aisha Khan",
            email: "aisha@example.com",
            phone: "+27 82 555 0112",
            placedAt: "28 Aug, 09:16",
            total: 899,
            paymentStatus: "Paid",
            status: "Processing",
            deliveryMethod: "Courier",
            address: "42 Rosebank Road, Cape Town, Western Cape, 7700",
            items: [{ name: "Hawa Dress", variant: "Soft Pink · Size 52", quantity: 1, price: 899 }],
        },
        {
            id: "MM-1046",
            customer: "Zanele Dlamini",
            email: "zanele@example.com",
            phone: "+27 71 555 0166",
            placedAt: "27 Aug, 16:03",
            total: 2147,
            paymentStatus: "Paid",
            status: "Ready",
            deliveryMethod: "Collection",
            items: [
                { name: "Amina Abaya", variant: "Black · Size 56", quantity: 1, price: 749 },
                { name: "Hawa Dress", variant: "Soft Pink · Size 54", quantity: 1, price: 899 },
            ],
        },
    ],
    products: [
        {
            id: "amina-abaya",
            name: "Amina Abaya",
            category: "Abayas",
            price: 749,
            status: "Active",
            variants: [
                { size: "52", colour: "Black", sku: "AMN-BLK-52", stock: 6 },
                { size: "54", colour: "Black", sku: "AMN-BLK-54", stock: 1 },
                { size: "56", colour: "Lilac", sku: "AMN-LIL-56", stock: 2 },
            ],
        },
        {
            id: "hawa-dress",
            name: "Hawa Dress",
            category: "Dresses",
            price: 899,
            status: "Active",
            variants: [
                { size: "52", colour: "Soft Pink", sku: "HAW-PNK-52", stock: 0 },
                { size: "54", colour: "Soft Pink", sku: "HAW-PNK-54", stock: 8 },
            ],
        },
        {
            id: "essential-hijab",
            name: "Essential Hijab",
            category: "Accessories",
            price: 499,
            status: "Draft",
            variants: [{ size: "One size", colour: "Taupe", sku: "HIJ-TAU-OS", stock: 12 }],
        },
    ],
}

const money = new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    maximumFractionDigits: 0,
})

function normalizeBaseUrl(value: string) {
    return value.trim().replace(/\/$/, "")
}

function token() {
    if (typeof window === "undefined") return ""
    return window.sessionStorage.getItem("moving_modesty_admin_token") || ""
}

function route(path: string) {
    if (typeof window !== "undefined") window.location.href = path
}

function badgeClass(status: string) {
    return `mm-admin__badge mm-admin__badge--${status.toLowerCase().replaceAll(" ", "-")}`
}

/**
 * Moving Modesty admin portal data surface.
 *
 * @framerIntrinsicWidth 920
 * @framerIntrinsicHeight 780
 * @framerSupportedLayoutWidth any-prefer-fixed
 * @framerSupportedLayoutHeight auto
 */
export default function AdminPortal(props: AdminPortalProps) {
    const {
        view = "dashboard",
        apiBaseUrl = "",
        demoMode = true,
        background = "#F5F3F0",
        surface = "#EEEAE6",
        softSurface = "#CDD2CE",
        ink = "#302A24",
        muted = "#746D65",
        sage = "#7D896D",
        border = "#A69E95",
        style,
    } = props

    const isStatic = useIsStaticRenderer()
    const [snapshot, setSnapshot] = useState<Snapshot>(demoSnapshot)
    const [loading, setLoading] = useState(false)
    const [notice, setNotice] = useState("")
    const [selectedOrderId, setSelectedOrderId] = useState(demoSnapshot.orders[0]?.id || "")
    const [orderFilter, setOrderFilter] = useState("All orders")
    const [search, setSearch] = useState("")

    const liveEnabled = Boolean(normalizeBaseUrl(apiBaseUrl)) && !isStatic

    useEffect(() => {
        if (!liveEnabled) return
        let active = true
        startTransition(() => setLoading(true))
        fetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/data`, {
            headers: token() ? { Authorization: `Bearer ${token()}` } : {},
        })
            .then(async (response) => {
                if (response.status === 401) {
                    route("/admin/login")
                    throw new Error("Please sign in again.")
                }
                if (!response.ok) throw new Error("The admin data could not be loaded.")
                return response.json()
            })
            .then((data: Snapshot) => {
                if (!active) return
                startTransition(() => {
                    setSnapshot(data)
                    setSelectedOrderId(data.orders[0]?.id || "")
                    setNotice("")
                })
            })
            .catch((error: Error) => {
                if (!active) return
                startTransition(() => setNotice(error.message))
            })
            .finally(() => {
                if (active) startTransition(() => setLoading(false))
            })
        return () => {
            active = false
        }
    }, [apiBaseUrl, liveEnabled])

    const selectedOrder =
        snapshot.orders.find((order) => order.id === selectedOrderId) || snapshot.orders[0]

    const filteredOrders = useMemo(() => {
        if (orderFilter === "Paid") return snapshot.orders.filter((order) => order.paymentStatus === "Paid")
        if (orderFilter === "Pending") return snapshot.orders.filter((order) => order.paymentStatus === "Pending")
        return snapshot.orders
    }, [orderFilter, snapshot.orders])

    const filteredProducts = useMemo(() => {
        const query = search.trim().toLowerCase()
        if (!query) return snapshot.products
        return snapshot.products.filter((product) =>
            `${product.name} ${product.category} ${product.variants.map((variant) => variant.sku).join(" ")}`
                .toLowerCase()
                .includes(query)
        )
    }, [search, snapshot.products])

    async function updateOrderStatus(order: AdminOrder, status: OrderStatus) {
        if (!liveEnabled) {
            startTransition(() => {
                setSnapshot((current) => ({
                    ...current,
                    orders: current.orders.map((item) => (item.id === order.id ? { ...item, status } : item)),
                }))
                setNotice(`Demo updated: ${order.id} is now ${status.toLowerCase()}.`)
            })
            return
        }
        startTransition(() => setLoading(true))
        try {
            const response = await fetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/orders/${order.id}`, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token()}`,
                },
                body: JSON.stringify({ status }),
            })
            if (!response.ok) throw new Error("The order status could not be updated.")
            const data = await response.json()
            startTransition(() => {
                setSnapshot((current) => ({
                    ...current,
                    orders: current.orders.map((item) => (item.id === order.id ? data.order : item)),
                }))
                setNotice(`${order.id} updated. The customer email has been queued when Resend is configured.`)
            })
        } catch (error) {
            startTransition(() => setNotice(error instanceof Error ? error.message : "Update failed."))
        } finally {
            startTransition(() => setLoading(false))
        }
    }

    async function saveProduct(product: AdminProduct) {
        const isNew = product.id.startsWith("new:")
        const normalizedProduct: AdminProduct = {
            ...product,
            id: isNew
                ? product.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `product-${Date.now()}`
                : product.id,
            price: product.variants[0]?.price ?? product.price,
            variants: product.variants.map((variant) => ({
                ...variant,
                price: Number(variant.price ?? product.price),
                stock: Number(variant.stock),
                lowStockThreshold: Number(variant.lowStockThreshold ?? 3),
            })),
        }

        if (!liveEnabled) {
            startTransition(() => {
                setSnapshot((current) => ({
                    ...current,
                    products: isNew
                        ? [normalizedProduct, ...current.products]
                        : current.products.map((item) => (item.id === product.id ? normalizedProduct : item)),
                }))
                setNotice(`${normalizedProduct.name} saved in demo mode.`)
            })
            return true
        }

        startTransition(() => setLoading(true))
        try {
            const endpoint = isNew
                ? `${normalizeBaseUrl(apiBaseUrl)}/api/admin/products`
                : `${normalizeBaseUrl(apiBaseUrl)}/api/admin/products/${encodeURIComponent(product.id)}`
            const response = await fetch(endpoint, {
                method: isNew ? "POST" : "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token()}`,
                },
                body: JSON.stringify({
                    name: product.name,
                    category: product.category,
                    description: product.description || "",
                    image: product.image || "",
                    status: product.status,
                    variants: normalizedProduct.variants,
                }),
            })
            const data = await response.json()
            if (!response.ok || !data.product) throw new Error(data.error || "The product could not be saved.")
            startTransition(() => {
                setSnapshot((current) => ({
                    ...current,
                    products: isNew
                        ? [data.product, ...current.products]
                        : current.products.map((item) => (item.id === product.id ? data.product : item)),
                }))
                setNotice(`${data.product.name} and its inventory were saved.`)
            })
            return true
        } catch (error) {
            startTransition(() => setNotice(error instanceof Error ? error.message : "The product could not be saved."))
            return false
        } finally {
            startTransition(() => setLoading(false))
        }
    }

    function logout() {
        if (typeof window !== "undefined") window.sessionStorage.removeItem("moving_modesty_admin_token")
        route("/admin/login")
    }

    const cssVariables = {
        ...style,
        position: "relative",
        width: "100%",
        minHeight: view === "login" ? 560 : 720,
        containerType: "inline-size",
        background,
        color: ink,
        "--mm-surface": surface,
        "--mm-soft": softSurface,
        "--mm-ink": ink,
        "--mm-muted": muted,
        "--mm-sage": sage,
        "--mm-border": border,
    } as CSSProperties

    return (
        <section className="mm-admin" style={cssVariables} aria-busy={loading}>
            <style>{styles}</style>
            {view === "login" ? (
                <LoginView apiBaseUrl={apiBaseUrl} liveEnabled={liveEnabled} demoMode={demoMode} />
            ) : (
                <div className="mm-admin__page">
                    {notice ? <div className="mm-admin__notice">{notice}</div> : null}
                    {view === "dashboard" ? (
                        <DashboardView snapshot={snapshot} logout={logout} />
                    ) : view === "orders" ? (
                        <OrdersView
                            orders={filteredOrders}
                            selected={selectedOrder}
                            selectedOrderId={selectedOrderId}
                            setSelectedOrderId={setSelectedOrderId}
                            filter={orderFilter}
                            setFilter={setOrderFilter}
                            updateOrderStatus={updateOrderStatus}
                            loading={loading}
                        />
                    ) : (
                        <ProductsView
                            products={filteredProducts}
                            search={search}
                            setSearch={setSearch}
                            saveProduct={saveProduct}
                            loading={loading}
                        />
                    )}
                    {!liveEnabled && demoMode ? (
                        <p className="mm-admin__demo">Demo data · Add the Vercel API URL in this component’s Framer properties to go live.</p>
                    ) : null}
                </div>
            )}
        </section>
    )
}

function LoginView({ apiBaseUrl, liveEnabled, demoMode }: { apiBaseUrl: string; liveEnabled: boolean; demoMode: boolean }) {
    const [email, setEmail] = useState("")
    const [password, setPassword] = useState("")
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState("")

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        if (!liveEnabled) {
            if (demoMode) route("/admin")
            else startTransition(() => setError("Add the Vercel API URL in Framer before signing in."))
            return
        }
        startTransition(() => {
            setLoading(true)
            setError("")
        })
        try {
            const response = await fetch(`${normalizeBaseUrl(apiBaseUrl)}/api/admin/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
            })
            const data = await response.json()
            if (!response.ok || !data.token) throw new Error(data.error || "Sign-in failed.")
            if (typeof window !== "undefined") {
                window.sessionStorage.setItem("moving_modesty_admin_token", data.token)
            }
            route("/admin")
        } catch (caught) {
            startTransition(() => setError(caught instanceof Error ? caught.message : "Sign-in failed."))
        } finally {
            startTransition(() => setLoading(false))
        }
    }

    return (
        <div className="mm-admin__login-stage">
            <form className="mm-admin__login-card" onSubmit={submit}>
                <p className="mm-admin__eyebrow">MOVING MODESTY / ADMIN</p>
                <h1 className="mm-admin__login-title">Sign in</h1>
                <p className="mm-admin__lead">Administrator access only.</p>
                <label className="mm-admin__field">
                    <span>Email address</span>
                    <input
                        type="email"
                        autoComplete="username"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="owner@movingmodesty.co.za"
                        required
                    />
                </label>
                <label className="mm-admin__field">
                    <span>Password</span>
                    <input
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="Password"
                        required
                    />
                </label>
                {error ? <p className="mm-admin__error" role="alert">{error}</p> : null}
                <button className="mm-admin__button" type="submit" disabled={loading}>
                    {loading ? "Signing in…" : "Sign in"}
                </button>
                <p className="mm-admin__helper">
                    {liveEnabled ? "Secure administrator session." : "Demo access until the Vercel API URL is connected."}
                </p>
            </form>
        </div>
    )
}

function PageHeader({ eyebrow, title, action, onAction }: { eyebrow: string; title: string; action: string; onAction: () => void }) {
    return (
        <header className="mm-admin__header">
            <div>
                <p className="mm-admin__eyebrow">{eyebrow}</p>
                <h1 className="mm-admin__title">{title}</h1>
            </div>
            <button className="mm-admin__button" type="button" onClick={onAction}>{action}</button>
        </header>
    )
}

function DashboardView({ snapshot, logout }: { snapshot: Snapshot; logout: () => void }) {
    const paidRevenue = snapshot.orders
        .filter((order) => order.paymentStatus === "Paid")
        .reduce((sum, order) => sum + order.total, 0)
    const stats = [
        ["New orders", snapshot.orders.filter((order) => order.status === "New").length],
        ["Processing", snapshot.orders.filter((order) => order.status === "Processing").length],
        ["Ready", snapshot.orders.filter((order) => order.status === "Ready").length],
        ["Revenue", money.format(paidRevenue)],
    ]
    return (
        <>
            <PageHeader eyebrow="ADMIN PORTAL" title="Dashboard" action="Log out" onAction={logout} />
            <div className="mm-admin__stats">
                {stats.map(([label, value]) => (
                    <article className="mm-admin__stat" key={String(label)}>
                        <p>{label}</p>
                        <strong>{value}</strong>
                    </article>
                ))}
            </div>
            <div className="mm-admin__section-heading">
                <h2>Recent orders</h2>
                <button className="mm-admin__button" type="button" onClick={() => route("/admin/orders")}>Manage orders</button>
            </div>
            <div className="mm-admin__order-table">
                {snapshot.orders.slice(0, 5).map((order) => (
                    <button className="mm-admin__order-row" type="button" key={order.id} onClick={() => route("/admin/orders")}>
                        <strong>{order.id}</strong>
                        <span>{order.customer}</span>
                        <span>{order.placedAt}</span>
                        <span>{money.format(order.total)}</span>
                        <em className={badgeClass(order.status)}>{order.status}</em>
                    </button>
                ))}
            </div>
            <div className="mm-admin__quick-grid">
                <article className="mm-admin__quick-card">
                    <h3>Inventory</h3>
                    <p>Manage products, variants, and stock levels.</p>
                    <button className="mm-admin__button" type="button" onClick={() => route("/admin/products")}>Open</button>
                </article>
                <article className="mm-admin__quick-card">
                    <h3>Delivery</h3>
                    <p>Courier, collection, or to be confirmed per order.</p>
                    <span className="mm-admin__muted-label">Provider-neutral for now</span>
                </article>
            </div>
        </>
    )
}

function OrdersView({
    orders,
    selected,
    selectedOrderId,
    setSelectedOrderId,
    filter,
    setFilter,
    updateOrderStatus,
    loading,
}: {
    orders: AdminOrder[]
    selected?: AdminOrder
    selectedOrderId: string
    setSelectedOrderId: (id: string) => void
    filter: string
    setFilter: (filter: string) => void
    updateOrderStatus: (order: AdminOrder, status: OrderStatus) => void
    loading: boolean
}) {
    return (
        <>
            <PageHeader eyebrow="ADMIN / ORDERS" title="Orders" action="Back to dashboard" onAction={() => route("/admin")} />
            <div className="mm-admin__filters" role="group" aria-label="Order filters">
                {["All orders", "Pending", "Paid"].map((label) => (
                    <button
                        className={`mm-admin__button ${filter === label ? "is-active" : ""}`}
                        type="button"
                        key={label}
                        onClick={() => setFilter(label)}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <div className="mm-admin__orders-layout">
                <div className="mm-admin__order-list">
                    {orders.map((order) => (
                        <button
                            className={`mm-admin__order-card ${selectedOrderId === order.id ? "is-selected" : ""}`}
                            type="button"
                            key={order.id}
                            onClick={() => setSelectedOrderId(order.id)}
                        >
                            <span className="mm-admin__order-card-top">
                                <strong>{order.id}</strong>
                                <em className={badgeClass(order.status)}>{order.status}</em>
                            </span>
                            <span>{order.customer}</span>
                            <span>{order.placedAt}</span>
                            <strong>{money.format(order.total)}</strong>
                        </button>
                    ))}
                </div>
                {selected ? (
                    <article className="mm-admin__detail">
                        <p className="mm-admin__eyebrow">SELECTED ORDER</p>
                        <h2>{selected.id}</h2>
                        <Detail title="Customer">
                            <p>{selected.customer}</p><p>{selected.email}</p><p>{selected.phone}</p>
                        </Detail>
                        <Detail title="Items">
                            {selected.items.map((item, index) => (
                                <p key={`${item.name}-${index}`}>{item.quantity} × {item.name} · {item.variant} · {money.format(item.price)}</p>
                            ))}
                        </Detail>
                        <Detail title="Payment">
                            <p>{selected.paymentStatus} · {money.format(selected.total)}</p>
                        </Detail>
                        <Detail title="Fulfilment">
                            <p>{selected.deliveryMethod}</p><p>{selected.address || "Collection address to be confirmed."}</p>
                        </Detail>
                        <div className="mm-admin__actions">
                            <button className="mm-admin__button" type="button" disabled={loading || selected.status === "Ready"} onClick={() => updateOrderStatus(selected, "Ready")}>Mark ready</button>
                            <button className="mm-admin__button" type="button" disabled={loading || selected.status === "Dispatched"} onClick={() => updateOrderStatus(selected, "Dispatched")}>Mark dispatched</button>
                            <button className="mm-admin__button" type="button" disabled={loading || selected.status === "Delivered"} onClick={() => updateOrderStatus(selected, "Delivered")}>Mark delivered</button>
                        </div>
                    </article>
                ) : <p>No orders match this filter.</p>}
            </div>
        </>
    )
}

function Detail({ title, children }: { title: string; children: ReactNode }) {
    return <section className="mm-admin__detail-block"><h3>{title}</h3>{children}</section>
}

function editableProduct(product?: AdminProduct): AdminProduct {
    if (!product) {
        return {
            id: `new:${Date.now()}`,
            name: "",
            category: "",
            description: "",
            price: 0,
            image: "",
            status: "Draft",
            variants: [{ size: "", colour: "", sku: "", stock: 0, price: 0, lowStockThreshold: 3 }],
        }
    }
    return {
        ...product,
        description: product.description || "",
        variants: product.variants.map((variant) => ({
            ...variant,
            price: variant.price ?? product.price,
            lowStockThreshold: variant.lowStockThreshold ?? 3,
        })),
    }
}

function ProductsView({
    products,
    search,
    setSearch,
    saveProduct,
    loading,
}: {
    products: AdminProduct[]
    search: string
    setSearch: (value: string) => void
    saveProduct: (product: AdminProduct) => Promise<boolean>
    loading: boolean
}) {
    const [editor, setEditor] = useState<AdminProduct | null>(null)
    const [editorError, setEditorError] = useState("")

    function updateVariant(index: number, values: Partial<ProductVariant>) {
        setEditor((current) => current ? {
            ...current,
            variants: current.variants.map((variant, variantIndex) =>
                variantIndex === index ? { ...variant, ...values } : variant
            ),
        } : current)
    }

    function addVariant() {
        setEditor((current) => current ? {
            ...current,
            variants: [
                ...current.variants,
                {
                    size: "",
                    colour: "",
                    sku: "",
                    stock: 0,
                    price: current.variants[0]?.price ?? current.price,
                    lowStockThreshold: 3,
                },
            ],
        } : current)
    }

    async function submitProduct(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        if (!editor) return
        const normalizedSkus = editor.variants.map((variant) => variant.sku.trim().toLowerCase())
        if (!editor.name.trim() || !editor.category.trim()) {
            setEditorError("Product name and category are required.")
            return
        }
        if (editor.variants.some((variant) => !variant.size.trim() || !variant.colour.trim() || !variant.sku.trim())) {
            setEditorError("Every variant needs a size, colour, and SKU.")
            return
        }
        if (new Set(normalizedSkus).size !== normalizedSkus.length) {
            setEditorError("Each variant needs a unique SKU.")
            return
        }
        if (editor.variants.some((variant) => Number(variant.price) < 0 || variant.stock < 0 || Number(variant.lowStockThreshold) < 0)) {
            setEditorError("Price, stock, and low-stock thresholds cannot be negative.")
            return
        }
        setEditorError("")
        if (await saveProduct(editor)) setEditor(null)
    }

    return (
        <>
            <PageHeader eyebrow="ADMIN / INVENTORY" title="Products & stock" action="Back to dashboard" onAction={() => route("/admin")} />
            <div className="mm-admin__product-toolbar">
                <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search products or SKU" aria-label="Search products" />
                <p className="mm-admin__eyebrow">{products.length} PRODUCTS</p>
                <button className="mm-admin__button" type="button" onClick={() => { setEditor(editableProduct()); setEditorError("") }}>Add product</button>
            </div>
            {editor ? (
                <form className="mm-admin__product-editor" onSubmit={submitProduct}>
                    <div className="mm-admin__editor-heading">
                        <div>
                            <p className="mm-admin__eyebrow">{editor.id.startsWith("new:") ? "NEW PRODUCT" : "EDIT PRODUCT"}</p>
                            <h2>{editor.id.startsWith("new:") ? "Add product" : editor.name}</h2>
                        </div>
                        <button className="mm-admin__text-button" type="button" onClick={() => setEditor(null)}>Close</button>
                    </div>
                    <div className="mm-admin__editor-grid">
                        <label className="mm-admin__field">
                            <span>Product name</span>
                            <input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} placeholder="Amina Abaya" required />
                        </label>
                        <label className="mm-admin__field">
                            <span>Category</span>
                            <input value={editor.category} onChange={(event) => setEditor({ ...editor, category: event.target.value })} placeholder="Abayas" required />
                        </label>
                        <label className="mm-admin__field">
                            <span>Status</span>
                            <select value={editor.status} onChange={(event) => setEditor({ ...editor, status: event.target.value as "Active" | "Draft" })}>
                                <option value="Draft">Draft</option>
                                <option value="Active">Active</option>
                            </select>
                        </label>
                        <label className="mm-admin__field mm-admin__field--wide">
                            <span>Image URL</span>
                            <input type="url" value={editor.image || ""} onChange={(event) => setEditor({ ...editor, image: event.target.value })} placeholder="https://…" />
                        </label>
                        <label className="mm-admin__field mm-admin__field--wide">
                            <span>Description</span>
                            <textarea value={editor.description || ""} onChange={(event) => setEditor({ ...editor, description: event.target.value })} placeholder="Product description" rows={4} />
                        </label>
                    </div>
                    <div className="mm-admin__editor-heading mm-admin__editor-heading--variants">
                        <div><p className="mm-admin__eyebrow">VARIANTS & STOCK</p><p className="mm-admin__editor-help">Stock changes are logged as inventory movements when Neon is connected.</p></div>
                        <button className="mm-admin__secondary-button" type="button" onClick={addVariant}>Add variant</button>
                    </div>
                    <div className="mm-admin__variant-editor-list">
                        {editor.variants.map((variant, index) => (
                            <fieldset className="mm-admin__variant-editor" key={variant.id || `new-variant-${index}`}>
                                <legend>Variant {index + 1}</legend>
                                <label className="mm-admin__field"><span>Size</span><input value={variant.size} onChange={(event) => updateVariant(index, { size: event.target.value })} placeholder="54" required /></label>
                                <label className="mm-admin__field"><span>Colour</span><input value={variant.colour} onChange={(event) => updateVariant(index, { colour: event.target.value })} placeholder="Black" required /></label>
                                <label className="mm-admin__field"><span>SKU</span><input value={variant.sku} onChange={(event) => updateVariant(index, { sku: event.target.value.toUpperCase() })} placeholder="AMN-BLK-54" required /></label>
                                <label className="mm-admin__field"><span>Price (R)</span><input type="number" min="0" step="0.01" value={variant.price ?? editor.price} onChange={(event) => updateVariant(index, { price: Number(event.target.value) })} required /></label>
                                <label className="mm-admin__field"><span>Stock</span><input type="number" min="0" step="1" value={variant.stock} onChange={(event) => updateVariant(index, { stock: Number(event.target.value) })} required /></label>
                                <label className="mm-admin__field"><span>Low at</span><input type="number" min="0" step="1" value={variant.lowStockThreshold ?? 3} onChange={(event) => updateVariant(index, { lowStockThreshold: Number(event.target.value) })} required /></label>
                            </fieldset>
                        ))}
                    </div>
                    {editorError ? <p className="mm-admin__error" role="alert">{editorError}</p> : null}
                    <div className="mm-admin__actions">
                        <button className="mm-admin__button" type="submit" disabled={loading}>{loading ? "Saving…" : "Save product"}</button>
                        <button className="mm-admin__secondary-button" type="button" onClick={() => setEditor(null)}>Cancel</button>
                    </div>
                </form>
            ) : null}
            <div className="mm-admin__product-list">
                {products.map((product) => {
                    const stock = product.variants.reduce((sum, variant) => sum + variant.stock, 0)
                    const lowStock = product.variants.some((variant) => variant.stock <= (variant.lowStockThreshold ?? 3))
                    return (
                        <article className="mm-admin__product-card" key={product.id}>
                            <div className="mm-admin__product-row">
                                <div className="mm-admin__product-thumb" aria-hidden="true">
                                    {product.image ? <img src={product.image} alt="" /> : product.name.slice(0, 1)}
                                </div>
                                <div><h3>{product.name}</h3><p>{product.category}</p></div>
                                <div><p className="mm-admin__eyebrow">FROM</p><strong>{money.format(product.variants.length ? Math.min(...product.variants.map((variant) => variant.price ?? product.price)) : product.price)}</strong></div>
                                <div><p className="mm-admin__eyebrow">VARIANTS</p><strong>{product.variants.length}</strong></div>
                                <div><p className="mm-admin__eyebrow">STOCK</p><strong>{stock}</strong></div>
                                <em className={badgeClass(lowStock ? "Low stock" : product.status)}>{lowStock ? "Low stock" : product.status}</em>
                                <button className="mm-admin__button" type="button" onClick={() => { setEditor(editableProduct(product)); setEditorError("") }}>Edit</button>
                            </div>
                            <div className="mm-admin__variant-list">
                                {product.variants.map((variant, index) => (
                                    <div className="mm-admin__variant-row" key={variant.id || `${variant.sku}-${index}`}>
                                        <span><small>SKU</small><strong>{variant.sku}</strong></span>
                                        <span><small>OPTION</small>{variant.colour} · {variant.size}</span>
                                        <span><small>PRICE</small>{money.format(variant.price ?? product.price)}</span>
                                        <span><small>STOCK</small><strong>{variant.stock}</strong></span>
                                        <em className={badgeClass(variant.stock === 0 ? "Out of stock" : variant.stock <= (variant.lowStockThreshold ?? 3) ? "Low stock" : "In stock")}>
                                            {variant.stock === 0 ? "Out of stock" : variant.stock <= (variant.lowStockThreshold ?? 3) ? "Low stock" : "In stock"}
                                        </em>
                                    </div>
                                ))}
                            </div>
                        </article>
                    )
                })}
            </div>
            <div className="mm-admin__inventory-note">
                <p className="mm-admin__eyebrow">INVENTORY WORKFLOW</p>
                <p>Product details, variant prices, SKUs, stock levels, and low-stock thresholds are managed here. Stock corrections are recorded separately so inventory changes remain traceable.</p>
            </div>
        </>
    )
}

const styles = `
.mm-admin, .mm-admin * { box-sizing: border-box; }
.mm-admin { font-family: Inter, Arial, sans-serif; font-size: 15px; line-height: 1.45; }
.mm-admin button, .mm-admin input, .mm-admin select, .mm-admin textarea { font: inherit; }
.mm-admin button { color: inherit; }
.mm-admin__page { display: flex; flex-direction: column; gap: 30px; padding: 40px; width: 100%; }
.mm-admin__notice { border: 1px solid var(--mm-border); background: var(--mm-soft); padding: 12px 16px; }
.mm-admin__header, .mm-admin__section-heading, .mm-admin__product-toolbar, .mm-admin__order-card-top, .mm-admin__actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.mm-admin__eyebrow { margin: 0 0 8px; color: var(--mm-muted); font-size: 12px; font-weight: 700; letter-spacing: .08em; }
.mm-admin__title { margin: 0; color: #fff; font-family: Montserrat, Inter, sans-serif; font-size: clamp(46px, 6vw, 72px); font-weight: 400; letter-spacing: -.035em; line-height: .95; text-transform: uppercase; }
.mm-admin__button { appearance: none; border: 0; border-radius: 0; background: var(--mm-sage); color: #fff !important; cursor: pointer; font-weight: 700; padding: 13px 20px; transition: opacity .18s ease; }
.mm-admin__button:hover { opacity: .82; }
.mm-admin__button:disabled { cursor: not-allowed; opacity: .45; }
.mm-admin__button.is-active { box-shadow: inset 0 0 0 2px var(--mm-ink); }
.mm-admin__secondary-button, .mm-admin__text-button { appearance: none; border: 1px solid var(--mm-border); background: transparent; color: var(--mm-ink); cursor: pointer; font-weight: 700; padding: 12px 18px; }
.mm-admin__text-button { border: 0; padding: 8px 0; text-decoration: underline; }
.mm-admin__stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.mm-admin__stat { min-height: 132px; margin: 0; border: 1px solid var(--mm-border); background: var(--mm-surface); padding: 24px; }
.mm-admin__stat p { margin: 0 0 12px; text-transform: uppercase; }
.mm-admin__stat strong { display: block; font-family: Montserrat, Inter, sans-serif; font-size: 38px; font-weight: 500; }
.mm-admin__section-heading h2 { margin: 0; font-family: Montserrat, Inter, sans-serif; font-size: 42px; font-weight: 500; letter-spacing: -.04em; text-transform: uppercase; }
.mm-admin__order-table, .mm-admin__order-list, .mm-admin__product-list { display: flex; flex-direction: column; background: var(--mm-border); gap: 1px; }
.mm-admin__order-row { display: grid; grid-template-columns: .8fr 1.2fr 1fr .8fr .7fr; align-items: center; gap: 16px; width: 100%; border: 0; background: var(--mm-surface); padding: 18px; text-align: left; cursor: pointer; }
.mm-admin__order-row:hover, .mm-admin__order-card:hover, .mm-admin__order-card.is-selected { background: var(--mm-soft); }
.mm-admin__order-row em, .mm-admin__product-row em { justify-self: end; }
.mm-admin__badge { display: inline-block; border: 1px solid var(--mm-border); background: #E3E8DF; color: #536047; font-size: 11px; font-style: normal; font-weight: 700; padding: 3px 8px; white-space: nowrap; }
.mm-admin__badge--pending, .mm-admin__badge--new, .mm-admin__badge--low-stock { background: #F1E7D2; color: #765C35; }
.mm-admin__badge--delivered, .mm-admin__badge--active, .mm-admin__badge--paid { background: #E1E9DD; color: #4E6545; }
.mm-admin__quick-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.mm-admin__quick-card { border: 1px solid var(--mm-border); background: var(--mm-surface); padding: 26px; }
.mm-admin__quick-card h3 { margin: 0 0 8px; font-size: 21px; }
.mm-admin__quick-card p { margin: 0 0 18px; color: var(--mm-muted); letter-spacing: .05em; text-transform: uppercase; }
.mm-admin__muted-label { color: var(--mm-muted); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.mm-admin__filters { display: flex; flex-wrap: wrap; gap: 12px; }
.mm-admin__orders-layout { display: grid; grid-template-columns: minmax(260px, .9fr) minmax(360px, 1.1fr); align-items: start; gap: 24px; }
.mm-admin__order-card { display: flex; flex-direction: column; gap: 8px; width: 100%; border: 0; background: var(--mm-surface); cursor: pointer; padding: 18px; text-align: left; }
.mm-admin__detail { display: flex; flex-direction: column; gap: 20px; border: 1px solid var(--mm-border); background: var(--mm-surface); padding: 28px; }
.mm-admin__detail > h2 { margin: -4px 0 4px; font-family: Montserrat, Inter, sans-serif; font-size: 42px; font-weight: 500; }
.mm-admin__detail-block { border: 1px solid var(--mm-border); background: var(--mm-soft); padding: 17px; }
.mm-admin__detail-block h3, .mm-admin__detail-block p { margin: 0; }
.mm-admin__detail-block h3 { margin-bottom: 8px; font-size: 20px; }
.mm-admin__detail-block p + p { margin-top: 5px; }
.mm-admin__actions { justify-content: flex-start; flex-wrap: wrap; }
.mm-admin__product-toolbar input, .mm-admin__field input, .mm-admin__field select, .mm-admin__field textarea { width: min(320px, 100%); border: 1px solid var(--mm-border); border-radius: 10px; background: var(--mm-surface); color: var(--mm-ink); padding: 13px 15px; outline: none; }
.mm-admin__product-toolbar input:focus, .mm-admin__field input:focus, .mm-admin__field select:focus, .mm-admin__field textarea:focus { border-color: var(--mm-sage); box-shadow: 0 0 0 2px color-mix(in srgb, var(--mm-sage) 22%, transparent); }
.mm-admin__product-editor { display: flex; flex-direction: column; gap: 24px; border: 1px solid var(--mm-border); background: var(--mm-soft); padding: 26px; }
.mm-admin__editor-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.mm-admin__editor-heading h2 { margin: 0; font-family: Montserrat, Inter, sans-serif; font-size: 32px; font-weight: 500; text-transform: uppercase; }
.mm-admin__editor-heading--variants { align-items: center; border-top: 1px solid var(--mm-border); padding-top: 22px; }
.mm-admin__editor-help { margin: 0; color: var(--mm-muted); }
.mm-admin__editor-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.mm-admin__field--wide { grid-column: 1 / -1; }
.mm-admin__field--wide input, .mm-admin__field--wide textarea { width: 100%; }
.mm-admin__variant-editor-list { display: flex; flex-direction: column; gap: 12px; }
.mm-admin__variant-editor { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; margin: 0; border: 1px solid var(--mm-border); background: var(--mm-surface); padding: 16px; }
.mm-admin__variant-editor legend { padding: 0 8px; color: var(--mm-muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.mm-admin__variant-editor .mm-admin__field input { width: 100%; }
.mm-admin__product-card { background: var(--mm-surface); }
.mm-admin__product-row { display: grid; grid-template-columns: 58px 1.5fr repeat(3, .7fr) .8fr auto; align-items: center; gap: 16px; background: var(--mm-surface); padding: 16px; }
.mm-admin__product-row h3, .mm-admin__product-row p { margin: 0; }
.mm-admin__product-row h3 { font-size: 19px; }
.mm-admin__product-row p:not(.mm-admin__eyebrow) { color: var(--mm-muted); }
.mm-admin__product-thumb { display: grid; place-items: center; width: 56px; height: 68px; overflow: hidden; border: 1px solid var(--mm-border); background: var(--mm-soft); color: var(--mm-muted); font-size: 22px; }
.mm-admin__product-thumb img { width: 100%; height: 100%; object-fit: cover; }
.mm-admin__variant-list { display: flex; flex-direction: column; border-top: 1px solid var(--mm-border); background: var(--mm-soft); }
.mm-admin__variant-row { display: grid; grid-template-columns: 1.05fr 1.4fr .75fr .55fr auto; align-items: center; gap: 16px; padding: 12px 16px 12px 90px; }
.mm-admin__variant-row + .mm-admin__variant-row { border-top: 1px solid color-mix(in srgb, var(--mm-border) 55%, transparent); }
.mm-admin__variant-row span { display: flex; flex-direction: column; min-width: 0; }
.mm-admin__variant-row small { margin-bottom: 3px; color: var(--mm-muted); font-size: 9px; font-weight: 700; letter-spacing: .08em; }
.mm-admin__variant-row em { justify-self: end; }
.mm-admin__inventory-note { border: 1px solid var(--mm-border); background: var(--mm-soft); padding: 24px; }
.mm-admin__inventory-note p:last-child { margin: 0; max-width: 780px; letter-spacing: .04em; text-transform: uppercase; }
.mm-admin__demo { margin: 0; color: var(--mm-muted); font-size: 12px; }
.mm-admin__login-stage { display: grid; min-height: 720px; place-items: center; background: var(--mm-soft); padding: 32px 20px; }
.mm-admin__login-card { display: flex; flex-direction: column; gap: 18px; width: min(440px, 100%); border: 1px solid var(--mm-border); background: var(--mm-surface); padding: 40px; }
.mm-admin__login-title { margin: 2px 0 0; font-family: Montserrat, Inter, sans-serif; font-size: 42px; font-weight: 500; letter-spacing: -.04em; text-transform: uppercase; }
.mm-admin__lead { margin: 0 0 2px; letter-spacing: .08em; text-transform: uppercase; }
.mm-admin__field { display: flex; flex-direction: column; gap: 8px; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.mm-admin__field input, .mm-admin__field select { width: 100%; height: 48px; text-transform: none; }
.mm-admin__field textarea { width: 100%; resize: vertical; text-transform: none; }
.mm-admin__error { margin: 0; color: #8A342C; font-size: 13px; }
.mm-admin__helper { margin: 0; color: var(--mm-muted); font-size: 13px; }
@container (max-width: 900px) {
  .mm-admin__page { padding: 28px 24px; }
  .mm-admin__stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mm-admin__orders-layout { grid-template-columns: 1fr; }
  .mm-admin__editor-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mm-admin__variant-editor { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .mm-admin__product-row { grid-template-columns: 56px 1.4fr repeat(2, .7fr) auto; }
  .mm-admin__product-row > :nth-child(4), .mm-admin__product-row > :nth-child(6) { display: none; }
  .mm-admin__variant-row { padding-left: 16px; }
}
@container (max-width: 620px) {
  .mm-admin__page { gap: 22px; padding: 24px 18px; }
  .mm-admin__header, .mm-admin__section-heading, .mm-admin__product-toolbar { align-items: flex-start; flex-direction: column; }
  .mm-admin__title { font-size: 44px; }
  .mm-admin__stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mm-admin__quick-grid { grid-template-columns: 1fr; }
  .mm-admin__section-heading h2 { font-size: 34px; }
  .mm-admin__order-row { grid-template-columns: 1fr auto; }
  .mm-admin__order-row > :nth-child(3), .mm-admin__order-row > :nth-child(4) { display: none; }
  .mm-admin__product-toolbar, .mm-admin__product-toolbar input { width: 100%; }
  .mm-admin__product-editor { padding: 20px; }
  .mm-admin__editor-heading, .mm-admin__editor-heading--variants { align-items: flex-start; flex-direction: column; }
  .mm-admin__editor-grid { grid-template-columns: 1fr; }
  .mm-admin__variant-editor { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mm-admin__product-row { grid-template-columns: 48px 1fr auto; }
  .mm-admin__product-row > :nth-child(3), .mm-admin__product-row > :nth-child(4), .mm-admin__product-row > :nth-child(5), .mm-admin__product-row > :nth-child(6) { display: none; }
  .mm-admin__product-thumb { width: 46px; height: 56px; }
  .mm-admin__variant-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mm-admin__variant-row em { justify-self: start; }
  .mm-admin__login-card { padding: 28px; }
}
@container (max-width: 430px) {
  .mm-admin__stats { grid-template-columns: 1fr; }
  .mm-admin__variant-editor, .mm-admin__variant-row { grid-template-columns: 1fr; }
}
`

addPropertyControls(AdminPortal, {
    view: {
        type: ControlType.Enum,
        title: "View",
        options: ["login", "dashboard", "orders", "products"],
        optionTitles: ["Login", "Dashboard", "Orders", "Products"],
        defaultValue: "dashboard",
    },
    apiBaseUrl: {
        type: ControlType.String,
        title: "Vercel API",
        defaultValue: "",
        placeholder: "https://admin-api.vercel.app",
    },
    demoMode: {
        type: ControlType.Boolean,
        title: "Demo Data",
        defaultValue: true,
    },
    background: { type: ControlType.Color, title: "Background", defaultValue: "#F5F3F0" },
    surface: { type: ControlType.Color, title: "Surface", defaultValue: "#EEEAE6" },
    softSurface: { type: ControlType.Color, title: "Soft Surface", defaultValue: "#CDD2CE" },
    ink: { type: ControlType.Color, title: "Text", defaultValue: "#302A24" },
    muted: { type: ControlType.Color, title: "Muted", defaultValue: "#746D65" },
    sage: { type: ControlType.Color, title: "Action", defaultValue: "#7D896D" },
    border: { type: ControlType.Color, title: "Border", defaultValue: "#A69E95" },
})
