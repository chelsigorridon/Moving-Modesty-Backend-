"use client";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";

const address = { company: "", line1: "20 Example Road", line2: "", suburb: "Example", city: "Cape Town", province: "Western Cape", postalCode: "7800" };
const plan = { version: 1, collection: { kind: "door", address: { ...address, line1: "10 Example Street" }, contact: { name: "TEST Sender", email: "sender@example.invalid", phone: "0821234567" } },
  delivery: { kind: "door", address, contact: { name: "TEST Customer", email: "customer@example.invalid", phone: "0827654321" } },
  collectionInstructions: "", deliveryInstructions: "", customerApprovedPickup: false, collectionSchedule: { date: "2099-07-16", after: "09:00", before: "16:00" } };
const sampleOrder = { id: "MM-LOCAL-REVIEW", paymentStatus: "Paid", status: "Ready", deliveryMethod: "Courier", deliveryFee: 99,
  address: "20 Example Road, Cape Town", deliveryDetails: { revision: 1, plan, draftPlan: plan, privateNote: "", canEdit: true },
  bobGoSync: { status: "Synced with Bob Go", remoteOrderId: "LOCAL-EXAMPLE" }, shipping: { status: "Not ready", environment: "production", blockers: [] } };
type PanelProps = { order: typeof sampleOrder; loading: boolean; connection: { enabled: boolean; configured: boolean; environment: string };
  requestShipping: (order: typeof sampleOrder, action: string, payload: Record<string, unknown>) => Promise<unknown>; confirm: (value: unknown) => void };

/** Actual Framer shipping panel with local-only sample state and no provider transport. */
export default function DeliveryResponseReview({ source }: { source: string }) {
  const [order, setOrder] = React.useState(sampleOrder), [notice, setNotice] = React.useState("");
  const preview = React.useMemo(() => {
    const mod = { exports: {} as { deliveryResponsePreview: { ShippingPanel: React.ComponentType<PanelProps>; styles: string } } };
    const dependencies: Record<string, unknown> = { react: React, "react/jsx-runtime": jsxRuntime, framer: { addPropertyControls() {}, ControlType: {}, useIsStaticRenderer: () => true } };
    new Function("require", "module", "exports", "fetch", source)((name: string) => {
      if (!(name in dependencies)) throw new Error("Unexpected preview import.");
      return dependencies[name];
    }, mod, mod.exports, async () => { throw new Error("Provider requests are disabled in this preview."); });
    return mod.exports.deliveryResponsePreview;
  }, [source]);
  const Panel = preview.ShippingPanel;
  const theme = { width: "100%", maxWidth: 920, margin: "0 auto", padding: "24px 16px", color: "#302A24", fontFamily: "Inter, Arial, sans-serif",
    "--mm-surface": "#EEEAE6", "--mm-soft": "#CDD2CE", "--mm-ink": "#302A24", "--mm-muted": "#746D65", "--mm-sage": "#7D896D", "--mm-border": "#A69E95" } as React.CSSProperties;
  return <main className="mm-admin" style={theme}>
    <style dangerouslySetInnerHTML={{ __html: `body{margin:0;background:#f5f3f0}${preview.styles}` }} />
    <h1 style={{ fontSize: 24 }}>Delivery · local review</h1>
    <p className="mm-admin__notice">Sample details and courier prices only. Nothing is sent or booked.</p>
    <Panel key={`${order.id}:${order.deliveryDetails.revision}`} order={order} loading={false} connection={{ enabled: true, configured: true, environment: "production" }}
      requestShipping={async (_order, action, payload) => {
        if (action === "save_delivery") {
          if (payload.action !== "delivery") return {};
          const next = payload.plan as typeof plan;
          setOrder(current => ({ ...current, deliveryDetails: { ...current.deliveryDetails, revision: current.deliveryDetails.revision + 1, plan: next, draftPlan: next } }));
          setNotice("Sample address saved in this preview only."); return {};
        }
        if (action === "quote") return { environment: "production", expires: Date.now() + 600000, declaredValue: 0, rates: [
          { providerName: "Example Courier A", serviceName: "Economy", serviceCode: "ECO", amount: 95, quoteToken: "LOCAL-ONLY-A" },
          { providerName: "Example Courier B", serviceName: "Express", serviceCode: "EXP", amount: 115, quoteToken: "LOCAL-ONLY-B" },
          { providerName: "Example Courier C", serviceName: "Road", serviceCode: "ROAD", amount: 105, quoteToken: "LOCAL-ONLY-C" },
        ] };
        if (action === "packages") return { packages: [] };
        if (action === "pickup_points") return { points: [], limited: true };
        throw new Error("This action is disabled in the local review.");
      }} confirm={() => setNotice("Booking is disabled in this preview. No waybill was requested.")} />
    {notice ? <p className="mm-admin__notice" role="status">{notice}</p> : null}
  </main>;
}
