"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { adminRequest } from "@/lib/admin-client";

type DiscountRecord = { id: string; revision: number; code: string; type: "percentage" | "amount"; value: number; active: boolean;
  productIds: string[]; minimumSpend: number; startsAt: string | null; endsAt: string | null };
type DiscountProduct = { id: string; name: string };
type DiscountDraft = Omit<DiscountRecord, "id" | "revision" | "value" | "minimumSpend"> & { id?: string; expectedRevision: number; value: string; minimumSpend: string };
type DiscountManagerProps = { demo?: boolean; apiBaseUrl?: string; enabled?: boolean; products?: DiscountProduct[]; onReviewChange?: (records: DiscountRecord[]) => void };
const discountMoney = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", minimumFractionDigits: 2 });
function blankDiscount(): DiscountDraft { return { expectedRevision: 0, code: "", type: "percentage", value: "", active: false,
  productIds: [], minimumSpend: "", startsAt: null, endsAt: null }; }
function localDiscountDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function discountStatus(discount: DiscountRecord) {
  if (!discount.active) return "Off";
  if (discount.endsAt && new Date(discount.endsAt).getTime() <= Date.now()) return "Expired";
  if (discount.startsAt && new Date(discount.startsAt).getTime() > Date.now()) return "Scheduled";
  return "On";
}

export default function DiscountManager({ demo = false, apiBaseUrl = "", enabled = true, products: initialProducts = [], onReviewChange }: DiscountManagerProps) {
  const [records, setRecords] = useState<DiscountRecord[]>([]);
  const [products, setProducts] = useState(initialProducts);
  const [draft, setDraft] = useState<DiscountDraft | null>(null);
  const [loading, setLoading] = useState(!demo && enabled);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(demo || !enabled);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [scope, setScope] = useState("all");
  const pending = useRef(false);
  const codeField = useRef<HTMLInputElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const base = apiBaseUrl.trim().replace(/\/$/, "");
  async function requestDiscounts(payload?: unknown, signal?: AbortSignal) {
    const response = await adminRequest(`${base}/api/admin/discounts`, { method: payload ? "POST" : "GET",
      headers: { ...(payload ? { "Content-Type": "application/json" } : {}) },
      body: payload ? JSON.stringify(payload) : undefined, signal: signal || AbortSignal.timeout(20000) });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${result?.error || "Discounts could not be loaded."}${result?.errorRef ? ` Reference: ${result.errorRef}` : ""}`);
    return result;
  }
  useEffect(() => {
    if (demo || !enabled) return;
    const controller = new AbortController();
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A changed external API target or explicit reload resets confirmed backend state.
    setLoading(true); setError(""); setReady(false);
    requestDiscounts(undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]))
      .then(result => { if (active) { setRecords(result.discounts); setProducts(result.products); setReady(true); } })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Discounts could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Reload is explicit; draft edits must never trigger a fetch.
  }, [base, demo, enabled, refresh]);
  const editorOpen = Boolean(draft);
  const editorId = draft?.id;
  useEffect(() => { if (editorOpen) codeField.current?.focus(); }, [editorId, editorOpen]);
  useEffect(() => { if (demo) onReviewChange?.(records); }, [demo, records, onReviewChange]);
  function editDiscount(record?: DiscountRecord) {
    setError(""); setMessage("");
    setScope(record?.productIds.length ? "selected" : "all");
    setDraft(record ? { ...record, expectedRevision: record.revision, value: String(record.value), minimumSpend: record.minimumSpend ? String(record.minimumSpend) : "" } : blankDiscount());
  }
  function closeEditor() {
    if (busy) return;
    setDraft(null); setError(""); createButton.current?.focus();
  }
  async function persistDiscount(current: DiscountDraft) {
    if (pending.current) return;
    const code = current.code.trim().toUpperCase();
    const value = Number(current.value);
    if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(code)) { setError("Enter a code using 2–40 letters, numbers, hyphens or underscores, without spaces."); codeField.current?.focus(); return; }
    if (!current.value.trim() || !Number.isFinite(value) || value <= 0 || (current.type === "percentage" && value >= 100)) { setError("Enter a discount greater than zero. Percentage discounts must be below 100%."); return; }
    if (value > 100000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) { setError("Use an amount no greater than R100,000, with no more than two decimal places."); return; }
    if (current.startsAt && current.endsAt && new Date(current.endsAt) <= new Date(current.startsAt)) { setError("The end date must be after the start date."); return; }
    if (demo && records.some(record => record.id !== current.id && record.code === code)) { setError("That code already exists. Edit its existing discount or choose a different code."); return; }
    const minimumSpend = Number(current.minimumSpend || 0);
    if (!Number.isFinite(minimumSpend) || minimumSpend < 0 || minimumSpend > 100000 || Math.abs(minimumSpend * 100 - Math.round(minimumSpend * 100)) > 0.000001) { setError("Enter a valid minimum spend, with no more than two decimal places."); return; }
    pending.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const payload = { ...current, code, value, minimumSpend };
      const saved: DiscountRecord = demo ? { ...payload, id: current.id || crypto.randomUUID(), revision: current.expectedRevision + 1 }
        : (await requestDiscounts(payload)).discount;
      setRecords(previous => [...previous.filter(record => record.id !== saved.id), saved].sort((a, b) => a.code.localeCompare(b.code)));
      setDraft(null); setMessage(demo ? "Saved in this review only. Nothing on the live website changed." : `Saved. ${saved.code} is ${discountStatus(saved).toLowerCase()}.`);
      createButton.current?.focus();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The save could not be confirmed. Reload Discounts before trying again."); }
    finally { pending.current = false; setBusy(false); }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft && scope === "selected" && !draft.productIds.length) { setError("Select at least one product, or choose All products."); return; }
    if (draft) void persistDiscount(draft);
  }
  function update<K extends keyof DiscountDraft>(key: K, value: DiscountDraft[K]) { setDraft(previous => previous ? { ...previous, [key]: value } : previous); }

  return <section className="mm-discounts" aria-label="Discount management" aria-busy={busy || loading}>
    <style dangerouslySetInnerHTML={{ __html: discountStyles }} />
    <header className="mm-discounts__header"><div><p className="mm-discounts__eyebrow">MOVING MODESTY · DISCOUNTS</p><h1>{draft ? draft.id ? "Edit discount" : "Create discount" : "Discounts"}</h1>
      <p>{draft ? "One shared code that customers enter at checkout." : "Create and control your specials without changing product prices."}</p></div>
      {!draft ? <button ref={createButton} type="button" className="mm-discounts__primary" disabled={busy || loading || !ready || !enabled} onClick={() => editDiscount()}>Create discount</button> : null}
    </header>
    {demo ? <p className="mm-discounts__review">Unpublished review · Changes stay in this browser tab. No live codes, orders or payments are created.</p> : null}
    {error ? <div className="mm-discounts__error" role="alert">{error}{!draft && !ready ? <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Reload discounts</button> : null}</div> : null}
    {message ? <p className="mm-discounts__notice" role="status">{message}</p> : null}
    {draft ? <form className="mm-discounts__form" onSubmit={save}>
      <label>Discount code<input ref={codeField} value={draft.code} required maxLength={40} autoComplete="off" autoCapitalize="characters" spellCheck={false} onChange={event => update("code", event.target.value)} disabled={busy} /><span>Choose your own code. Everyone uses this same code.</span></label>
      <div className="mm-discounts__fields"><label>Discount type<select value={draft.type} disabled={busy} onChange={event => update("type", event.target.value as DiscountDraft["type"])}><option value="percentage">Percentage off (%)</option><option value="amount">Rand amount off (R)</option></select></label>
        <label>{draft.type === "percentage" ? "Percentage off" : "Rand amount off"}<input type="number" value={draft.value} required min="0.01" max={draft.type === "percentage" ? "99.99" : "100000"} step="0.01" inputMode="decimal" disabled={busy} onChange={event => update("value", event.target.value)} /></label></div>
      <label>Applies to<select disabled={busy} value={scope} onChange={event => {
        setScope(event.target.value); if (event.target.value === "all") update("productIds", []);
      }}><option value="all">All products</option><option value="selected" disabled={!products.length}>Selected products</option></select></label>
      {scope === "selected" ? <fieldset className="mm-discounts__products"><legend>Select products</legend>{products.map(product => <label key={product.id}><input type="checkbox" checked={draft.productIds.includes(product.id)} disabled={busy} onChange={event => update("productIds", event.target.checked ? [...draft.productIds, product.id] : draft.productIds.filter(id => id !== product.id))} />{product.name}</label>)}</fieldset> : null}
      <div className="mm-discounts__active"><div><strong>Discount active</strong><p>{draft.active ? "Customers can use it while its dates are valid." : "Off. Customers cannot use this code yet."}</p></div>
        <button className="mm-discounts__switch" type="button" role="switch" aria-label="Discount active" aria-checked={draft.active} disabled={busy} onClick={() => update("active", !draft.active)}><span aria-hidden="true" />{draft.active ? "ON" : "OFF"}</button></div>
      <details className="mm-discounts__options"><summary>More options</summary><div className="mm-discounts__fields"><label>Start date and time<input type="datetime-local" value={localDiscountDate(draft.startsAt)} disabled={busy} onChange={event => update("startsAt", event.target.value ? new Date(event.target.value).toISOString() : null)} /></label>
        <label>End date and time<input type="datetime-local" value={localDiscountDate(draft.endsAt)} disabled={busy} onChange={event => update("endsAt", event.target.value ? new Date(event.target.value).toISOString() : null)} /></label></div><p>Times use this device’s local time zone. Leave dates blank to control it manually.</p>
        <label>Minimum product spend (R)<input type="number" min="0" max="100000" step="0.01" inputMode="decimal" value={draft.minimumSpend} disabled={busy} onChange={event => update("minimumSpend", event.target.value)} /></label></details>
      <p className="mm-discounts__helper">One code per order. Discounts apply to products, not the delivery fee. Free delivery still qualifies at R1,200 before discounts. Already-started payments and paid orders keep their saved discount.</p>
      <footer><button type="submit" className="mm-discounts__primary" disabled={busy}>{busy ? "Saving…" : "Save discount"}</button><button type="button" className="mm-discounts__secondary" disabled={busy} onClick={closeEditor}>Cancel</button></footer>
    </form> : loading ? <p role="status">Loading discounts…</p> : ready && !records.length ? <div className="mm-discounts__empty"><h2>No discounts yet</h2><p>When you’re ready to run a special, choose Create discount.</p><span>No codes or specials are active.</span></div>
      : <div className="mm-discounts__list">{records.map(record => <article key={record.id} className="mm-discounts__row"><div><h2>{record.code}</h2><p>{record.type === "percentage" ? `${record.value}% off` : `${discountMoney.format(record.value)} off`} · {record.productIds.length ? "Selected products" : "All products"}</p>
        {discountStatus(record) === "Scheduled" || discountStatus(record) === "Expired" ? <span>{discountStatus(record)}{record.endsAt ? ` · Ends ${new Date(record.endsAt).toLocaleString("en-ZA")}` : ""}</span> : null}</div><div className="mm-discounts__actions">
        <button type="button" className="mm-discounts__secondary" disabled={busy} onClick={() => editDiscount(record)}>Edit<span className="mm-discounts__sr"> {record.code}</span></button>
        <button type="button" className="mm-discounts__switch" role="switch" aria-label={`${record.code} active`} aria-checked={record.active} disabled={busy} onClick={() => void persistDiscount({ ...record, expectedRevision: record.revision, value: String(record.value), minimumSpend: String(record.minimumSpend), active: !record.active })}><span aria-hidden="true" />{record.active ? "ON" : "OFF"}</button>
      </div></article>)}</div>}
  </section>;
}

const discountStyles = `
.mm-discounts h2{font-family:Jost,Arial,sans-serif}.mm-discounts .mm-discounts__primary{background:#536047}.mm-discounts .mm-discounts__primary:hover{background:#405339}
.mm-discounts{position:relative;box-sizing:border-box;color:var(--mm-ink,#302a24);font:16px/1.5 Jost,Arial,sans-serif;width:100%;container-type:inline-size}
.mm-discounts *{box-sizing:border-box}.mm-discounts button,.mm-discounts input,.mm-discounts select{font:inherit;color:inherit}
.mm-discounts button{cursor:pointer;transition:background .15s,opacity .15s}.mm-discounts button:disabled{cursor:not-allowed;opacity:.55}
.mm-discounts button:focus-visible,.mm-discounts input:focus-visible,.mm-discounts select:focus-visible,.mm-discounts summary:focus-visible{outline:2px solid var(--mm-ink,#302a24);outline-offset:3px}
.mm-discounts__header{display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:28px}.mm-discounts__eyebrow{font-size:11px;letter-spacing:.15em;margin:0 0 12px;color:var(--mm-muted,#746d65)}
.mm-discounts h1{font:400 38px/1.15 Montserrat,Arial,sans-serif;margin:0 0 12px}.mm-discounts h2{font-size:22px;font-weight:500;margin:0 0 8px}.mm-discounts p{margin:0;color:var(--mm-muted,#746d65)}
.mm-discounts__primary,.mm-discounts__secondary{min-height:46px;padding:10px 20px;border:1px solid var(--mm-border,#a69e95);border-radius:3px;white-space:nowrap}.mm-discounts__primary{background:var(--mm-sage,#738063);color:#fff!important;border-color:transparent}.mm-discounts__primary:hover{background:#536047}.mm-discounts__secondary{background:transparent}.mm-discounts__secondary:hover{background:var(--mm-surface,#eeeae6)}
.mm-discounts__review,.mm-discounts__notice,.mm-discounts__error{margin:0 0 24px!important;padding:12px 16px;border:1px solid var(--mm-border,#a69e95);font-size:14px}.mm-discounts__error{color:#7a352b;background:#f5e6e1}.mm-discounts__error button{margin-left:16px}.mm-discounts__notice{color:#405339}
.mm-discounts__empty{padding:56px 28px;text-align:center;border:1px solid var(--mm-border,#a69e95);border-radius:4px;background:var(--mm-surface,#eeeae6)}.mm-discounts__empty span{display:block;margin-top:16px;color:var(--mm-muted,#746d65);font-size:14px}
.mm-discounts__form{max-width:760px;border:1px solid var(--mm-border,#a69e95);padding:28px;background:var(--mm-surface,#eeeae6);border-radius:4px;display:grid;gap:24px}.mm-discounts__form label{display:grid;gap:8px;font-size:15px;font-weight:500}.mm-discounts__form label>span,.mm-discounts__helper{font-size:13px;font-weight:400;color:var(--mm-muted,#746d65)}
.mm-discounts__form input:not([type=checkbox]),.mm-discounts__form select{width:100%;min-width:0;min-height:46px;padding:10px 12px;border:1px solid var(--mm-border,#a69e95);border-radius:3px;background:#faf8f5}.mm-discounts__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.mm-discounts__active{display:flex;justify-content:space-between;align-items:center;gap:20px}.mm-discounts__active p{font-size:14px}.mm-discounts__switch{display:inline-flex;align-items:center;justify-content:center;gap:9px;min-width:92px;min-height:44px;padding:8px 12px;border:1px solid var(--mm-border,#a69e95);border-radius:30px;background:#e2ded9;font-size:13px!important;font-weight:600!important;flex-shrink:0}.mm-discounts__switch[aria-checked=true]{background:#536047;border-color:#536047;color:#fff}.mm-discounts__switch>span{width:15px;height:15px;background:currentColor;border-radius:50%;opacity:.85}
.mm-discounts__options{border-top:1px solid var(--mm-border,#a69e95);padding-top:18px}.mm-discounts__options summary{cursor:pointer}.mm-discounts__options[open] .mm-discounts__fields{margin-top:18px}.mm-discounts__options p{font-size:13px;margin:12px 0 18px}.mm-discounts__form footer{display:flex;gap:12px;flex-wrap:wrap}.mm-discounts__products{padding:16px;border:1px solid var(--mm-border,#a69e95)}.mm-discounts__products label{display:flex;align-items:center;margin:8px 0}.mm-discounts__products input{width:18px;height:18px;accent-color:#536047}
.mm-discounts__list{display:grid;gap:16px}.mm-discounts__row{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:24px;border:1px solid var(--mm-border,#a69e95);border-radius:4px;background:var(--mm-surface,#eeeae6)}.mm-discounts__row h2{overflow-wrap:anywhere}.mm-discounts__row span{font-size:13px;color:var(--mm-muted,#746d65)}.mm-discounts__actions{display:flex;gap:12px;flex-shrink:0}.mm-discounts__sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
@container(max-width:600px){.mm-discounts__header{align-items:flex-start;flex-direction:column;gap:16px}.mm-discounts h1{font-size:30px}.mm-discounts__form{padding:20px}.mm-discounts__fields{grid-template-columns:1fr;gap:20px}.mm-discounts__row{align-items:flex-start;flex-direction:column;padding:20px;gap:18px}.mm-discounts__actions{width:100%;justify-content:space-between}.mm-discounts__empty{padding:36px 20px}}
`;
