"use client";
import { useCallback, useState, type ComponentProps } from "react";
import TechnicalAlerts, { technicalAlertsCss } from "./technical-alerts";

type Alert = Parameters<ComponentProps<typeof TechnicalAlerts>["resolve"]>[0];
const samples: Alert[] = [
  { id: "demo-open", reference: "DEMO-REFERENCE-001", orderNumber: null, source: "admin", operation: "admin_login", code: "unexpected",
    summary: "An unexpected application error interrupted the operation.", severity: "error", environment: "production", httpStatus: null,
    occurrences: 1, firstSeenAt: "2026-10-16T09:32:20.014Z", lastSeenAt: "2026-10-16T09:32:20.014Z", resolvedAt: null },
  { id: "demo-resolved", reference: "DEMO-REFERENCE-002", orderNumber: null, source: "courier", operation: "courier_connection", code: "provider_auth",
    summary: "The service rejected the connection credentials.", severity: "error", environment: "production", httpStatus: 401,
    occurrences: 2, firstSeenAt: "2026-10-15T08:00:00Z", lastSeenAt: "2026-10-15T08:10:00Z", resolvedAt: "2026-10-15T09:00:00Z" },
];
export default function TechnicalAlertsReview() {
  const [open, setOpen] = useState(false), [alerts, setAlerts] = useState(samples);
  const [failure, setFailure] = useState(false), [recur, setRecur] = useState(false);
  const load = useCallback(async (status: "open" | "resolved", page: number) => {
    if (failure) throw new Error("DEMO loading failure");
    return { incidents: alerts.filter(alert => Boolean(alert.resolvedAt) === (status === "resolved")),
      counts: { open: alerts.filter(alert => !alert.resolvedAt).length, resolved: alerts.filter(alert => alert.resolvedAt).length },
      pagination: { page, pageSize: 50, hasMore: false } };
  }, [alerts, failure]);
  return <main className="mm-admin mm-alerts-review">
    <style>{reviewStyles + technicalAlertsCss}</style>
    <p className="mm-admin__helper">MOVING MODESTY / PRIVATE REVIEW</p><h1>Account · Technical alerts</h1>
    <p className="mm-admin__notice">Preview only · Sample alerts. Nothing is sent to the live website, orders or Bob Go.</p>
    <details className="mm-admin__account"><summary>Account</summary><div className="mm-admin__account-menu"><button type="button" className="mm-admin__text-button" aria-haspopup="dialog" onClick={() => setOpen(true)}>Technical alerts</button></div></details>
    {alerts.some(alert => !alert.resolvedAt) ? <div className="mm-admin__notice"><p>Recorded website issues need review. Open Technical alerts under Account.</p><button type="button" className="mm-admin__text-button" onClick={() => setOpen(true)}>Review technical alerts</button></div> : <p>No open alerts in this preview.</p>}
    <details><summary>Preview test controls</summary><label><input type="checkbox" checked={failure} onChange={event => setFailure(event.target.checked)} />Simulate loading error</label><label><input type="checkbox" checked={recur} onChange={event => setRecur(event.target.checked)} />Simulate a repeat while resolving</label><button type="button" className="mm-admin__secondary-button" onClick={() => setAlerts(samples)}>Reset sample alerts</button></details>
    {open ? <TechnicalAlerts load={load} close={() => setOpen(false)} resolve={async incident => {
      if (recur) throw new Error("This alert happened again. Refresh and review the latest details before resolving it.");
      setAlerts(current => current.map(alert => alert.id === incident.id ? { ...alert, resolvedAt: new Date().toISOString() } : alert));
    }} /> : null}
  </main>;
}
const reviewStyles = `
body { margin:0; background:#F5F3F0; }
.mm-admin { --mm-surface:#EEEAE6; --mm-soft:#CDD2CE; --mm-ink:#302A24; --mm-muted:#746D65; --mm-sage:#7D896D; --mm-border:#A69E95; color:var(--mm-ink); font:15px/1.5 Inter,Arial,sans-serif; }
.mm-alerts-review { max-width:1000px; margin:0 auto; padding:32px; box-sizing:border-box; }
.mm-alerts-review h1 { font:500 32px/1.2 Montserrat,Inter,sans-serif; }
.mm-admin__dialog { max-height:calc(100dvh - 48px); overflow-y:auto; border:1px solid var(--mm-border); background:var(--mm-surface); color:var(--mm-ink); padding:24px; }
.mm-admin__dialog::backdrop { background:rgba(0,0,0,.4); }
.mm-admin__settings-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; }
.mm-admin__dialog h2 { margin:0; font:500 24px/1.2 Montserrat,Inter,sans-serif; }
.mm-admin__helper { color:var(--mm-muted); font-size:13px; }
.mm-admin__button { min-height:44px; border:0; background:#536047; color:#fff; padding:13px 20px; font:inherit; font-weight:700; }
.mm-admin__secondary-button { min-height:44px; border:1px solid var(--mm-border); background:transparent; color:var(--mm-ink); padding:12px 18px; font:inherit; font-weight:700; }
.mm-admin__text-button { border:0; background:transparent; color:var(--mm-ink); min-height:44px; padding:8px 0; text-decoration:underline; font:inherit; font-weight:700; }
.mm-admin__notice { padding:12px 16px; border:1px solid var(--mm-border); background:var(--mm-soft); margin:20px 0; }
.mm-admin__technical summary { min-height:44px; cursor:pointer; padding:12px 0; font-weight:600; }
.mm-admin__courier-check { display:flex; align-items:flex-start; gap:10px; margin:16px 0; cursor:pointer; }
.mm-admin__courier-check input { flex:0 0 20px; width:20px; height:20px; margin:1px 0 0; accent-color:var(--mm-sage); }
.mm-admin__error { color:#8A342C; }
.mm-admin__account { margin:20px 0; } .mm-admin__account summary { padding:12px 0; cursor:pointer; }
.mm-alerts-review > details > label { display:flex; gap:8px; margin:12px 0; }
`;
