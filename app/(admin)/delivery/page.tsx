import { Check, PackageCheck, Truck } from "lucide-react";
import { findNearbyBobGoLocation } from "@/lib/integrations/bobgo/client";
import { getBobGoConfiguration } from "@/lib/integrations/bobgo/configuration";

export const metadata = { title: "Delivery" };
export const dynamic = "force-dynamic";

const CONSTANTIA_EMPORIUM = {
  lat: -34.02937198,
  lng: 18.44505579,
  lengthCm: 25,
  widthCm: 20.5,
  heightCm: 3.5,
  weightKg: 0.412,
};

async function bobGoStatus() {
  const config = getBobGoConfiguration();
  if (!config.apiTokenConfigured) {
    return {
      title: "API token still required",
      detail: "Add the Bob Go bearer token in Vercel before checking the locker.",
    };
  }

  try {
    const lookup = await findNearbyBobGoLocation(CONSTANTIA_EMPORIUM);
    if (lookup.matches.length === 0) {
      return {
        title: "Bob Go connected",
        detail: "The token works, but Constantia Emporium was not present in the nearby location response.",
      };
    }
    return {
      title: "Constantia Emporium found",
      detail: JSON.stringify(lookup.matches[0], null, 2),
    };
  } catch (error) {
    return {
      title: "Bob Go connection needs attention",
      detail: error instanceof Error ? error.message : "The location lookup could not be completed.",
    };
  }
}

export default async function DeliveryPage() {
  const status = await bobGoStatus();
  return <>
    <header className="page-header page-header-top">
      <div>
        <p className="eyebrow">Fulfilment</p>
        <h1>Delivery</h1>
        <p className="page-intro">Review paid orders before booking their Bob Go door delivery.</p>
      </div>
    </header>

    <section className="delivery-callout">
      <div className="delivery-callout-icon"><Truck size={25} /></div>
      <div>
        <p className="eyebrow">Safe setup</p>
        <h2>{status.title}</h2>
        {status.detail.startsWith("{")
          ? <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>{status.detail}</pre>
          : <p>{status.detail}</p>}
      </div>
      <span className="ready-chip"><Check size={14} /> Booking disabled</span>
    </section>

    <section className="dashboard-grid two-column-grid">
      <section className="panel delivery-option selected-option">
        <div className="option-top"><span><PackageCheck size={22} /></span><em>Active</em></div>
        <h2>Manual approval</h2>
        <p>Every paid delivery remains available for Zarina to review before a Bob Go shipment is created.</p>
        <ul>
          <li><Check size={14} /> Fixed R99 customer delivery fee</li>
          <li><Check size={14} /> Free delivery from R1,500</li>
          <li><Check size={14} /> No automatic live bookings</li>
        </ul>
      </section>
    </section>
  </>;
}
