"use client";
import { useState, type FormEvent } from "react";

type ShippingWeightRow = { id: string; product: string; colour: string; size: string; grams: number | null };
interface ShippingWeightSettingsProps {
  request: (changes?: Array<{ id: string; expectedGrams: number | null; grams: number | null }>) => Promise<ShippingWeightRow[]>;
}
export default function ShippingWeightSettings({ request }: ShippingWeightSettingsProps) {
  const [rows, setRows] = useState<ShippingWeightRow[] | null>(null), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState(""), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  async function load() {
    setBusy(true); setError("");
    try { setRows(await request()); setRevision(value => value + 1); setConfirmed(false); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Weights could not be loaded."); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setError(""); setMessage("");
    const changes = (rows || []).map(row => { const raw = String(form.get(row.id) || "").trim(); return { id: row.id, expectedGrams: row.grams, grams: raw ? Number(raw) : null }; }).filter(row => row.grams !== row.expectedGrams);
    if (changes.some(row => row.grams !== null && (!Number.isInteger(row.grams) || row.grams < 1 || row.grams > 30000))) { setError("Enter measured whole grams between 1 and 30000."); return; }
    if (!form.has("confirmed")) return;
    if (!changes.length) { setMessage("No weights changed."); return; }
    setBusy(true);
    try { setRows(await request(changes)); setRevision(value => value + 1); setConfirmed(false); setMessage("Measured weights saved. Automatic sync remains off."); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Weights could not be saved."); }
    finally { setBusy(false); }
  }
  return <details className="mm-delivery__private mm-admin__weight-settings"><summary>Product weights for future order sync</summary>
    <style>{`.mm-admin__weight-settings{margin-top:18px;padding-top:14px;border-top:1px solid var(--mm-border,#a69e95)}.mm-admin__weight-settings summary{cursor:pointer}.mm-admin__weight-settings .mm-admin__field{display:grid;gap:6px;min-width:0}.mm-admin__weight-settings .mm-admin__field input{width:100%;box-sizing:border-box}.mm-admin__weight-settings .mm-delivery__check{display:flex;align-items:flex-start;gap:10px}.mm-admin__weight-settings .mm-delivery__check input{flex:none;width:20px;height:20px}.mm-admin__weight-settings .mm-delivery__actions{display:flex;flex-wrap:wrap;gap:12px}`}</style>
    <p className="mm-admin__helper">One-time setup: weigh one scarf of each colour/size, without shipping packaging. Leave unknown weights blank. Never use the combined parcel weight or volumetric weight. This does not enable automatic sync.</p>
    {!rows ? <button type="button" className="mm-admin__secondary-button" disabled={busy} onClick={() => { void load(); }}>{busy ? "Loading…" : "Load product weights"}</button> : <form key={revision} onSubmit={save}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}>
        {rows.map(row => <label className="mm-admin__field" key={row.id}>{row.product} · {row.colour} · {row.size} (g)<input name={row.id} type="number" min={1} max={30000} step={1} inputMode="numeric" defaultValue={row.grams ?? ""} /></label>)}
        <label className="mm-delivery__check"><input type="checkbox" name="confirmed" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />These are measured individual product weights.</label>
        <div className="mm-delivery__actions"><button type="submit" className="mm-admin__secondary-button" disabled={busy || !confirmed}>{busy ? "Saving…" : "Save product weights"}</button><button type="button" className="mm-admin__text-button" disabled={busy} onClick={() => { void load(); }}>Reload saved weights</button></div>
      </fieldset></form>}
    {error ? <p role="alert" className="mm-admin__error">{error}</p> : null}{message ? <p role="status" className="mm-admin__helper">{message}</p> : null}
  </details>;
}
