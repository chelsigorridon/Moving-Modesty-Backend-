"use client";
import { useState } from "react";
import { movingModestyBoxPreset, zarinaPackedReferences } from "../lib/shipping/owner-measurements";

type ParcelValues = { weightGrams: string; lengthCm: string; widthCm: string; heightCm: string };
type SavedParcelPackage = { id: string; name: string; lengthCm: number; widthCm: number; heightCm: number };
interface ParcelEditorProps {
  value: ParcelValues; change: (value: ParcelValues) => void; disabled?: boolean;
  loadPackages: () => Promise<SavedParcelPackage[]>;
}

export default function ParcelEditor({ value, change, disabled = false, loadPackages }: ParcelEditorProps) {
  const [packages, setPackages] = useState<SavedParcelPackage[]>([]), [selected, setSelected] = useState(() =>
    Number(value.lengthCm) === movingModestyBoxPreset.lengthCm && Number(value.widthCm) === movingModestyBoxPreset.widthCm && Number(value.heightCm) === movingModestyBoxPreset.heightCm ? movingModestyBoxPreset.id : "");
  const availablePackages: SavedParcelPackage[] = [movingModestyBoxPreset, ...packages];
  const [loading, setLoading] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState("");
  async function load() {
    setLoading(true); setError("");
    try { setPackages((await loadPackages()).map(item => ({ ...item, id: `bobgo:${item.id}` }))); setLoaded(true); }
    catch { setError("Saved boxes could not be loaded. You can still choose the Moving Modesty box or enter dimensions yourself."); }
    finally { setLoading(false); }
  }
  function choose(id: string) {
    setSelected(id); const item = availablePackages.find(entry => entry.id === id);
    if (item) change({ ...value, lengthCm: String(item.lengthCm), widthCm: String(item.widthCm), heightCm: String(item.heightCm) });
  }
  return <section className="mm-admin__parcel-editor" aria-label="Packed parcel">
    <h4>2. Check the parcel</h4>
    <style>{`.mm-admin__packing-reference{margin:14px 0;font-size:13px}.mm-admin__packing-reference summary{min-height:44px;padding:12px 0;cursor:pointer}.mm-admin__packing-reference dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 14px}.mm-admin__packing-reference dt,.mm-admin__packing-reference dd{margin:0}.mm-admin__packing-reference dd{white-space:nowrap}.mm-admin__parcel-editor>button{max-width:100%;white-space:normal}`}</style>
    <label className="mm-admin__field">Choose a box<select value={selected} disabled={disabled || loading} onChange={event => choose(event.target.value)}>
      <option value="">Enter dimensions myself</option><option value={movingModestyBoxPreset.id}>{movingModestyBoxPreset.name} · {movingModestyBoxPreset.lengthCm} × {movingModestyBoxPreset.widthCm} × {movingModestyBoxPreset.heightCm} cm</option>
      {packages.length ? <optgroup label="Saved in Bob Go">{packages.map(item => <option key={item.id} value={item.id}>{item.name} · {item.lengthCm} × {item.widthCm} × {item.heightCm} cm</option>)}</optgroup> : null}
    </select></label>
    <p className="mm-admin__helper">Up to 2 scarves per box.</p>
    {selected ? <button type="button" className="mm-admin__text-button" disabled={disabled} onClick={() => setSelected("")}>Change dimensions</button> :
      <div className="mm-admin__parcel-grid">{([["lengthCm", "Length (cm)"], ["widthCm", "Width (cm)"], ["heightCm", "Height (cm)"]] as const).map(([key, label]) =>
        <label className="mm-admin__field" key={key}>{label}<input type="number" required min={0.01} max={150} step={0.01} inputMode="decimal" value={value[key]} disabled={disabled} onChange={event => change({ ...value, [key]: event.target.value })} /></label>)}</div>}
    <label className="mm-admin__field">Weight of sealed parcel (g)<input type="number" required min={1} max={30000} step={1} inputMode="numeric" disabled={disabled} value={value.weightGrams} onChange={event => change({ ...value, weightGrams: event.target.value })} /></label>
    <p className="mm-admin__helper">Include the box and packaging.</p>
    <details className="mm-admin__packing-reference"><summary>Need a weight guide?</summary>
      <p className="mm-admin__helper">Reference weights only. Use the weight of your sealed parcel.</p>
      <p className="mm-admin__helper">This form quotes one parcel; extra boxes must also be included in the courier booking.</p>
      <dl>{zarinaPackedReferences.map(item => <div key={item.label} style={{ display: "contents" }}><dt>{item.label}</dt><dd>{item.approximate ? "≈ " : ""}{item.grams}g</dd></div>)}</dl>
    </details>
    <details className="mm-admin__packing-reference"><summary>Other saved boxes (optional)</summary>
      {!loaded || error ? <button type="button" className="mm-admin__secondary-button" disabled={disabled || loading} onClick={() => { void load(); }}>{loading ? "Loading boxes…" : error ? "Retry saved boxes" : "Load saved Bob Go boxes"}</button> : null}
      {loaded ? <p className="mm-admin__helper">{packages.length ? "Saved boxes are now available in Choose a box above." : "No other saved boxes were found. You can still use the Moving Modesty box or enter dimensions yourself."}</p> : null}
      {error ? <p role="status" className="mm-admin__helper">{error}</p> : null}
    </details>
  </section>;
}
