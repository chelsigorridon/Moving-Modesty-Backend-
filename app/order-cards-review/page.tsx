import { notFound } from "next/navigation";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import OrderCardsReview from "@/components/order-cards-review";

export default async function Page() {
  if (process.env.NODE_ENV !== "development" || process.env.VERCEL_ENV) notFound();
  const source = await readFile(join(process.cwd(), "framer/AdminPortal.tsx"), "utf8");
  const styles = source.match(/const styles = `([\s\S]*?)`/)?.[1];
  if (!styles) throw new Error("The shared admin styles are unavailable.");
  return <OrderCardsReview portalStyles={styles} />;
}
