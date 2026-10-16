"use client";
import { useState } from "react";

type ParcelValues = { weightGrams: string; lengthCm: string; widthCm: string; heightCm: string };
type SavedParcelPackage = { id: string; name: string; lengthCm: number; widthCm: number; heightCm: number };
interface ParcelEditorProps {
  value: ParcelValues; change: (value: ParcelValues) => void; disabled?: boolean;
  loadPackages: () => Promise<SavedParcelPackage[]>;
}

export default function ParcelEditor({ value, change, disabled = false, loadPackages }: ParcelEditorProps) {
  const [packages, setPackages] = useState<SavedParcelPackage[]>([]), [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState("");
  async function load() {
    setLoading(true); setError("");
    try { setPackages(await loadPackages()); setLoaded(true); }
    catch { setError("Saved packages could not be loaded. Retry or use custom dimensions below."); }
    finally { setLoading(false); }
  }
  function choose(id: string) {
    setSelected(id); const item = packages.find(entry => entry.id === id);
    if (item) change({ ...value, lengthCm: String(item.lengthCm), widthCm: String(item.widthCm), heightCm: String(item.heightCm) });
  }
  return <section className="mm-admin__parcel-editor" aria-label="Packed parcel">
    <h4>2. Choose the packed parcel</h4>
    {!loaded || error ? <button type="button" className="mm-admin__secondary-button" disabled={disabled || loading} onClick={() => { void load(); }}>{loading ? "Loading packages…" : error ? "Retry saved packages" : "Load my saved Bob Go packages"}</button> : null}
    {loaded && packages.length ? <label className="mm-admin__field">Package<select value={selected} disabled={disabled || loading} onChange={event => choose(event.target.value)}>
      <option value="">Custom dimensions</option>{packages.map(item => <option key={item.id} value={item.id}>{item.name} · {item.lengthCm} × {item.widthCm} × {item.heightCm} cm</option>)}
    </select></label> : loaded ? <p className="mm-admin__helper">No saved packages returned. Use custom dimensions, or save your packaging sizes in Bob Go.</p> : null}
    {error ? <p role="status" className="mm-admin__helper">{error}</p> : null}
    {selected ? <p>Package dimensions: <strong>{value.lengthCm} × {value.widthCm} × {value.heightCm} cm</strong> <button type="button" className="mm-admin__text-button" disabled={disabled} onClick={() => setSelected("")}>Change dimensions</button></p> :
      <div className="mm-admin__parcel-grid">{([["lengthCm", "Length (cm)"], ["widthCm", "Width (cm)"], ["heightCm", "Height (cm)"]] as const).map(([key, label]) =>
        <label className="mm-admin__field" key={key}>{label}<input type="number" required min={0.01} max={150} step={0.01} inputMode="decimal" value={value[key]} disabled={disabled} onChange={event => change({ ...value, [key]: event.target.value })} /></label>)}</div>}
    <label className="mm-admin__field">Actual packed weight (g)<input type="number" required min={1} max={30000} step={1} inputMode="numeric" disabled={disabled} value={value.weightGrams} onChange={event => change({ ...value, weightGrams: event.target.value })} /></label>
    <p className="mm-admin__helper">Weigh the sealed parcel, including packaging. A saved package fills dimensions only—not the actual weight or Bob Go’s volumetric weight.</p>
  </section>;
}
