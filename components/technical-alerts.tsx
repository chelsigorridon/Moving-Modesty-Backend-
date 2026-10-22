"use client";
import { useEffect, useId, useRef, useState } from "react";

interface TechnicalIncident {
  id: string;
  reference: string;
  orderNumber: string | null;
  source: string;
  operation: string;
  code: string;
  summary: string;
  severity: string;
  environment: string;
  httpStatus: number | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}
interface TechnicalAlertsData {
  incidents: TechnicalIncident[];
  counts: { open: number; resolved: number };
  pagination: { page: number; pageSize: number; hasMore: boolean };
}
interface TechnicalAlertsProps {
  load: (status: "open" | "resolved", page: number) => Promise<TechnicalAlertsData>;
  resolve: (incident: TechnicalIncident) => Promise<void>;
  close: () => void;
}

function technicalAlertTitle(incident: TechnicalIncident) {
  const names: Record<string, string> = {
    admin_login: "Admin sign-in", admin_auth: "Admin access", admin_logout: "Admin sign-out",
    admin_load: "Loading the admin portal", admin_update: "Saving admin changes", admin_product: "Product update",
    checkout_save: "Saving checkout", checkout_recover: "Recovering checkout",
    payment_start: "Starting payment", payment_notify: "Payment verification", payment_return: "Payment return",
    courier_quote: "Courier quote", courier_book: "Waybill booking", courier_cancel: "Waybill cancellation",
    courier_connection: "Bob Go connection", courier_sync: "Sales-channel sync", courier_tracking: "Courier tracking",
    courier_refresh: "Shipment status check", courier_waybill: "Waybill PDF", courier_webhook: "Tracking update",
    email_send: "Sending email", email_webhook: "Email delivery update", contact_send: "Contact form",
    server_request: "Website service", browser_admin: "Admin connection", browser_checkout: "Checkout connection", browser_contact: "Contact form connection",
  };
  return names[incident.operation] || ({ admin: "Admin portal", courier: "Bob Go delivery", payment: "Payment", email: "Email", checkout: "Checkout", browser: "Browser connection", contact: "Contact form" }[incident.source]) || "Website service";
}
function technicalAlertDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : new Intl.DateTimeFormat("en-ZA", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Johannesburg",
  }).format(date) + " SAST";
}

export default function TechnicalAlerts({ load, resolve, close }: TechnicalAlertsProps) {
  const titleId = useId(), descriptionId = useId(), confirmationId = useId();
  const dialog = useRef<HTMLDialogElement>(null), detailHeading = useRef<HTMLHeadingElement>(null), confirmationHeading = useRef<HTMLHeadingElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null), listHeading = useRef<HTMLDivElement>(null);
  const mounted = useRef(true), pending = useRef(false), wasConfirming = useRef(false);
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [page, setPage] = useState(0), [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<TechnicalAlertsData | null>(null), [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<TechnicalIncident | null>(null);
  const [reviewed, setReviewed] = useState(false), [confirming, setConfirming] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");

  useEffect(() => {
    mounted.current = true;
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => { mounted.current = false; if (node?.open) node.close(); };
  }, []);
  useEffect(() => {
    let active = true;
    // Keep late responses from a closed dialog or previous filter out of view.
    Promise.resolve().then(async () => {
      if (!active) return;
      setLoading(true); setError(""); setSelected(null); setReviewed(false); setConfirming(false);
      const result = await load(status, page);
      if (active) setData(result);
    }).catch(() => {
      if (active) { setData(null); setError("Alerts could not be loaded. Refresh to try again."); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load, status, page, refresh]);
  useEffect(() => { if (selected) detailHeading.current?.focus(); }, [selected]);
  useEffect(() => {
    if (confirming) confirmationHeading.current?.focus();
    else if (wasConfirming.current) reviewButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  function showList() {
    setSelected(null); setReviewed(false); setConfirming(false); setError("");
    listHeading.current?.focus();
  }
  async function confirmResolution() {
    if (!selected || selected.resolvedAt || !reviewed || !confirming || pending.current || loading) return;
    pending.current = true; setSaving(true); setError("");
    try {
      await resolve(selected);
      if (!mounted.current) return;
      setNotice("Alert marked as resolved. Its history is kept under Resolved.");
      setSelected(null); setReviewed(false); setConfirming(false); setPage(0); setRefresh(value => value + 1);
      listHeading.current?.focus();
    } catch (reason) {
      if (!mounted.current) return;
      setError(reason instanceof Error ? reason.message : "Resolution could not be confirmed. Refresh and check the alert before trying again.");
      setReviewed(false); setConfirming(false);
    } finally { pending.current = false; if (mounted.current) setSaving(false); }
  }
  const disabled = loading || saving;
  return <dialog className="mm-admin__dialog mm-admin__alerts" ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { if (pending.current) event.preventDefault(); else close(); }}
    onClick={event => {
      if (event.target !== event.currentTarget || pending.current) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
    <div className="mm-admin__settings-heading">
      <h2 id={titleId}>Technical alerts</h2>
      <button type="button" className="mm-admin__text-button" autoFocus disabled={saving} onClick={close}>Close</button>
    </div>
    <p id={descriptionId} className="mm-admin__helper">Review recorded website issues. Resolving an alert keeps its history; it does not repair the problem.</p>
    <div className="mm-admin__alerts-toolbar" ref={listHeading} tabIndex={-1} aria-label="Alert filters">
      <div className="mm-admin__alerts-filters" role="group" aria-label="Alert status">
        {(["open", "resolved"] as const).map(value => <button key={value} type="button" className={status === value ? "mm-admin__button" : "mm-admin__secondary-button"}
          aria-pressed={status === value} disabled={saving} onClick={() => { setStatus(value); setPage(0); showList(); setNotice(""); }}>
          {value === "open" ? "Open" : "Resolved"}{data ? ` (${data.counts[value]})` : ""}
        </button>)}
      </div>
      <button type="button" className="mm-admin__text-button" disabled={disabled} onClick={() => { setRefresh(value => value + 1); setNotice(""); }}>{loading ? "Loading…" : "Refresh alerts"}</button>
    </div>
    {notice ? <p role="status" className="mm-admin__notice">{notice}</p> : null}
    {error ? <div role="alert" className="mm-admin__alerts-error"><p className="mm-admin__error">{error}</p>
      <button type="button" className="mm-admin__secondary-button" disabled={disabled} onClick={() => setRefresh(value => value + 1)}>Refresh and review</button></div> : null}
    <div aria-busy={disabled}>
    {loading ? <p role="status">Loading alerts…</p> : selected ? <section className="mm-admin__alert-detail">
      <button type="button" className="mm-admin__text-button" disabled={saving} onClick={showList}>Back to alerts</button>
      <div className="mm-admin__alerts-heading"><h3 tabIndex={-1} ref={detailHeading}>{technicalAlertTitle(selected)}</h3><span className="mm-admin__alert-status">{selected.resolvedAt ? "Resolved" : "Open"}</span></div>
      <p>{selected.summary}</p>
      <dl className="mm-admin__alert-facts">
        <div><dt>Last recorded</dt><dd>{technicalAlertDate(selected.lastSeenAt)}</dd></div>
        <div><dt>First recorded</dt><dd>{technicalAlertDate(selected.firstSeenAt)}</dd></div>
        <div><dt>Occurrences</dt><dd>{selected.occurrences}</dd></div>
        <div><dt>Environment</dt><dd>{selected.environment === "production" ? "Live website" : selected.environment}</dd></div>
        <div><dt>Level</dt><dd>{selected.severity}</dd></div>
        <div><dt>Related order</dt><dd>{selected.orderNumber || "General website alert"}</dd></div>
        {selected.resolvedAt ? <div><dt>Resolved</dt><dd>{technicalAlertDate(selected.resolvedAt)}</dd></div> : null}
      </dl>
      <details className="mm-admin__technical"><summary>Support reference & technical details</summary>
        <dl className="mm-admin__alert-facts">
          <div><dt>Reference</dt><dd>{selected.reference}</dd></div><div><dt>Operation</dt><dd>{selected.operation}</dd></div>
          <div><dt>Error code</dt><dd>{selected.code}</dd></div>
          {selected.httpStatus ? <div><dt>HTTP status</dt><dd>{selected.httpStatus}</dd></div> : null}
        </dl>
      </details>
      {!selected.resolvedAt ? <div className="mm-admin__alert-resolution">
        <p className="mm-admin__helper">Check that this issue is no longer happening before resolving it. If it happens again, it will reopen.</p>
        <label className="mm-admin__courier-check"><input type="checkbox" checked={reviewed} disabled={saving || confirming || Boolean(error)} onChange={event => setReviewed(event.target.checked)} />I have checked this issue.</label>
        {confirming ? <section className="mm-admin__alert-confirmation" aria-labelledby={confirmationId}>
          <h4 tabIndex={-1} ref={confirmationHeading} id={confirmationId}>Mark this alert as resolved?</h4>
          <p>This only updates the alert. It does not change orders, payments or waybills.</p>
          <div className="mm-admin__alerts-actions">
            <button type="button" className="mm-admin__secondary-button" disabled={saving} onClick={() => { setConfirming(false); reviewButton.current?.focus(); }}>Keep open</button>
            <button type="button" className="mm-admin__button" disabled={saving} onClick={confirmResolution}>{saving ? "Resolving…" : "Confirm resolution"}</button>
          </div>
        </section> : <button type="button" ref={reviewButton} className="mm-admin__button" disabled={!reviewed || disabled || Boolean(error)} onClick={() => setConfirming(true)}>Mark as resolved</button>}
      </div> : null}
    </section> : data && !error ? <>
      {data.incidents.length ? <ul className="mm-admin__alerts-list">{data.incidents.map(incident => <li key={incident.id}>
        <div className="mm-admin__alerts-heading"><h3>{technicalAlertTitle(incident)}</h3><span className="mm-admin__alert-status">{incident.resolvedAt ? "Resolved" : "Open"} · {incident.severity}</span></div>
        <p>{incident.summary}</p><p className="mm-admin__helper">{technicalAlertDate(incident.lastSeenAt)} · {incident.occurrences} {incident.occurrences === 1 ? "occurrence" : "occurrences"}</p>
        <button type="button" className="mm-admin__secondary-button" onClick={() => { setSelected(incident); setReviewed(false); setConfirming(false); setNotice(""); }}>Review alert</button>
      </li>)}</ul> : <p className="mm-admin__notice">{status === "open" ? "No open alerts." : "No resolved alerts yet."}</p>}
      {page > 0 || data.pagination.hasMore ? <nav className="mm-admin__alerts-actions" aria-label="Alert pages">
        <button type="button" className="mm-admin__secondary-button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</button>
        <span>Page {page + 1}</span><button type="button" className="mm-admin__secondary-button" disabled={!data.pagination.hasMore} onClick={() => setPage(value => value + 1)}>Next</button>
      </nav> : null}
    </> : null}
    </div>
  </dialog>;
}

export const technicalAlertsCss = `
.mm-admin__alerts { width:min(680px,calc(100% - 32px)); box-sizing:border-box; font:inherit; line-height:1.5; }
.mm-admin__alerts *, .mm-admin__alerts *::before, .mm-admin__alerts *::after { box-sizing:border-box; }
.mm-admin__alerts > .mm-admin__helper { margin:12px 0 20px; }
.mm-admin__alerts-toolbar,.mm-admin__alerts-filters,.mm-admin__alerts-actions,.mm-admin__alerts-heading { display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
.mm-admin__alerts-toolbar,.mm-admin__alerts-heading { justify-content:space-between; }
.mm-admin__alerts-toolbar { margin-bottom:20px; }
.mm-admin__alerts-list { list-style:none; padding:0; margin:0; display:grid; gap:16px; }
.mm-admin__alerts-list li,.mm-admin__alert-confirmation { min-width:0; border:1px solid var(--mm-border); padding:18px; }
.mm-admin__alerts h3 { font:500 18px/1.35 Montserrat,Inter,sans-serif; margin:0; }
.mm-admin__alerts h4 { font:600 16px/1.4 Montserrat,Inter,sans-serif; margin:0 0 12px; }
.mm-admin__alerts .mm-admin__helper { color:var(--mm-ink); }
.mm-admin__alerts-list p,.mm-admin__alert-detail > p,.mm-admin__alert-resolution p { margin:12px 0; }
.mm-admin__alerts p,.mm-admin__alerts dd,.mm-admin__alerts h3 { overflow-wrap:anywhere; }
.mm-admin__alert-status { font-size:13px; font-weight:600; }
.mm-admin__alert-facts { display:grid; gap:12px; margin:20px 0; }
.mm-admin__alert-facts > div { display:grid; grid-template-columns:minmax(110px,1fr) minmax(0,2fr); gap:12px; }
.mm-admin__alert-facts dt { font-weight:600; }
.mm-admin__alert-facts dd { margin:0; }
.mm-admin__alert-resolution { border-top:1px solid var(--mm-border); margin-top:20px; padding-top:8px; }
.mm-admin__alert-confirmation { background:var(--mm-soft); margin-top:16px; }
.mm-admin__alerts-actions { margin-top:16px; }
.mm-admin__alerts button { min-height:44px; font:inherit; cursor:pointer; max-width:100%; white-space:normal; }
.mm-admin__alerts button:disabled { cursor:not-allowed; opacity:.5; }
.mm-admin__alerts :is(button,input,summary):focus-visible { outline:2px solid var(--mm-sage); outline-offset:3px; }
.mm-admin__alerts-error { margin:16px 0; }
@media(max-width:420px) { .mm-admin__alerts { padding:18px; } .mm-admin__alert-facts > div { grid-template-columns:1fr; gap:2px; } }
`;
