"use client";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";

const samples = ["One", "Two", "Three"].map((name, index) => ({
  id: `DEMO-${index + 1}`, customer: `Sample Customer ${name}`, email: "customer@example.invalid", phone: "0000000000",
  placedAt: "22 Oct, 10:15", placedDate: "2026-10-22T08:15:00Z", total: 420, deliveryFee: 0,
  paymentStatus: "Paid", payment: { provider: "PayFast", environment: "production" }, status: index === 1 ? "Confirmed" : "New", deliveryMethod: index === 2 ? "Courier" : "Collection",
  items: [{ quantity: 1, name: "Sample scarf", variant: "Example colour", price: 420 }],
  workflow: { nextStatus: null, actionLabel: "", guidance: "Review this sample order. Delivery and payment actions are disconnected in this preview.", canCancel: false },
}));

/** Runs the actual portal source with an allowlisted fake transport, never a live API. */
export default function AdminPerformanceReview({ source }: { source: string }) {
  const [view, setView] = React.useState("orders"), [reads, setReads] = React.useState(0);
  const [mobile, setMobile] = React.useState(false);
  const Portal = React.useMemo(() => {
    const compiledModule = { exports: {} as { default: React.ComponentType<Record<string, unknown>> } };
    const fakeFetch = async (url: string, init: RequestInit = {}) => {
      const path = new URL(url);
      if ((init.method || "GET") !== "GET" || path.pathname !== "/api/admin/data") throw new Error("Preview only: this action is disconnected.");
      setReads(value => value + 1);
      await new Promise(resolve => setTimeout(resolve, path.searchParams.has("order") ? 600 : 100));
      const id = path.searchParams.get("order");
      return Response.json({ orders: id ? samples.filter(order => order.id === id)
        : samples.map(order => ({ ...order, detailsLoaded: false, items: [], workflow: undefined, listNeedsAttention: true, listInProgress: false })),
        paymentEnvironment: "production", bobGoConnection: { environment: "sandbox", enabled: false, configured: false } });
    };
    const fakeWindow = typeof window === "undefined" ? undefined : new Proxy(window, { get(target, key) {
      if (key === "sessionStorage") return { getItem: () => "TEST-only-disconnected-preview", setItem() {}, removeItem() {} };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const dependencies: Record<string, unknown> = { react: React, "react/jsx-runtime": jsxRuntime,
      framer: { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => false } };
    // Source is read from this repository by a development-only server page.
    new Function("require", "module", "exports", "fetch", "window", source)((name: string) => {
      if (!(name in dependencies)) throw new Error("Unexpected preview import.");
      return dependencies[name];
    }, compiledModule, compiledModule.exports, fakeFetch, fakeWindow);
    return compiledModule.exports.default;
  }, [source]);
  return <main style={{ width: "100%", maxWidth: mobile ? 375 : 1040, margin: "0 auto", minHeight: "100vh", background: "#F5F3F0", color: "#302A24", fontFamily: "Arial, sans-serif" }}>
    <style>{"body{margin:0;background:#F5F3F0}*{box-sizing:border-box}"}</style>
    <aside style={{ padding: "18px 24px", borderBottom: "1px solid #A69E95", fontSize: 14 }}>
      <p style={{ margin: "0 0 12px" }}>PRIVATE REVIEW · Sample data only. No orders, payments, waybills or sync connections.</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
        {(["orders", "dashboard"] as const).map(value => <button type="button" key={value} aria-pressed={value === view}
          style={{ padding: "12px 16px", minHeight: 44, border: "1px solid #A69E95", background: value === view ? "#535F46" : "transparent", color: value === view ? "#fff" : "#302A24", cursor: "pointer" }}
          onClick={() => setView(value)}>{value === "orders" ? "Review orders" : "Review dashboard"}</button>)}
        <span role="status">Sample reads: {reads}</span>
        <button type="button" aria-pressed={mobile} style={{ minHeight: 44, padding: "10px 12px", background: "transparent", color: "#302A24", border: "1px solid #A69E95", cursor: "pointer" }} onClick={() => setMobile(value => !value)}>{mobile ? "Desktop width" : "Mobile width (375px)"}</button>
      </div>
    </aside>
    <Portal key={view} view={view} apiBaseUrl="https://preview.example.invalid" />
  </main>;
}
