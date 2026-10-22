import { notFound } from "next/navigation";
import TechnicalAlertsReview from "@/components/technical-alerts-review";

export default function Page() {
  if (process.env.NODE_ENV !== "development" || process.env.VERCEL_ENV) notFound();
  return <TechnicalAlertsReview />;
}
