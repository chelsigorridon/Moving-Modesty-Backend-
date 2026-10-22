"use client";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";

type ParcelValues = { weightGrams: string; lengthCm: string; widthCm: string; heightCm: string };
type EditorProps = { value: ParcelValues; change: (value: ParcelValues) => void; loadPackages: () => Promise<[]> };

/** Actual embedded Framer component and CSS; all provider transport is disconnected. */
export default function PackedWeightReview({ source }: { source: string }) {
  const [parcel, setParcel] = React.useState<ParcelValues>({ weightGrams: "", lengthCm: "25", widthCm: "20", heightCm: "3" });
  const [checked, setChecked] = React.useState(false);
  const preview = React.useMemo(() => {
    const mod = { exports: {} as { packedWeightPreview: { ParcelEditor: React.ComponentType<EditorProps>; styles: string } } };
    const dependencies: Record<string, unknown> = { react: React, "react/jsx-runtime": jsxRuntime,
      framer: { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => true } };
    new Function("require", "module", "exports", "fetch", source)((name: string) => {
      if (!(name in dependencies)) throw new Error("Unexpected preview import.");
      return dependencies[name];
    }, mod, mod.exports, async () => { throw new Error("No provider requests are allowed in this preview."); });
    return mod.exports.packedWeightPreview;
  }, [source]);
  const Editor = preview.ParcelEditor;
  const theme = { width: "100%", maxWidth: 860, margin: "0 auto", padding: "24px 16px", color: "#302A24", fontFamily: "Inter, Arial, sans-serif",
    "--mm-surface": "#EEEAE6", "--mm-soft": "#CDD2CE", "--mm-ink": "#302A24", "--mm-muted": "#746D65", "--mm-sage": "#7D896D", "--mm-border": "#A69E95" } as React.CSSProperties;
  return <main className="mm-admin" style={theme}>
    <style dangerouslySetInnerHTML={{ __html: `body{margin:0;background:#f5f3f0}${preview.styles}` }} />
    <h1 style={{ fontSize: 24 }}>Packed weight · preview</h1>
    <p className="mm-admin__notice">Local review only. Nothing is sent or booked.</p>
    <Editor value={parcel} change={value => { setParcel(value); setChecked(false); }} loadPackages={async () => []} />
    <label className="mm-admin__courier-check"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />Dimensions and packed weight checked.</label>
    <button type="button" className="mm-admin__button" disabled>Compare couriers</button>
    <p className="mm-admin__helper">Courier requests are disabled in this review.</p>
  </main>;
}
