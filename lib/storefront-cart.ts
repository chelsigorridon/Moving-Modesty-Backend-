// Bundled into Framer's single-file components by build-framer-cart.mjs.
type StorefrontCartLine = {
  id: string; sku?: string; productSlug?: string; name: string; colour: string;
  size: string; quantity: number;
};

export function canonicalCartSku(item: StorefrontCartLine): string {
  if (item.sku?.trim()) return item.sku.trim().toUpperCase();
  const identity = `${item.productSlug || ""} ${item.name || ""}`.toLowerCase();
  const colour = String(item.colour || "").trim().toLowerCase();
  const bases: Record<string, string> = identity.includes("amina")
    ? { lavender: "AMINA-LAV", lilac: "AMINA-LIL", black: "AMINA-BLK" }
    : identity.includes("hawa")
      ? { black: "HAWA-BLK", pink: "HAWA-PNK", "soft pink": "HAWA-PNK", sage: "HAWA-SGE", grey: "HAWA-GRY", gray: "HAWA-GRY" }
      : {};
  const size = String(item.size || "").trim().toLowerCase();
  const suffix = size === "small" ? "S" : size === "large" ? "L" : size.includes("one size") ? "OS" : "";
  return bases[colour] && suffix ? `${bases[colour]}-${suffix}` : "";
}

export function normalizeStorefrontCart<T extends StorefrontCartLine>(items: T[]): T[] {
  const result: T[] = [];
  const positions = new Map<string, number>();
  for (const item of items) {
    const sku = canonicalCartSku(item);
    // Leave unidentifiable or invalid lines visible for the existing validation
    // flow. Never guess an unknown variant or silently discard its quantity.
    if (!sku || !Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      result.push({ ...item });
      continue;
    }
    const position = positions.get(sku);
    if (position !== undefined) {
      const total = result[position].quantity + item.quantity;
      if (Number.isSafeInteger(total)) result[position] = { ...result[position], quantity: total };
      else result.push({ ...item });
    } else {
      positions.set(sku, result.length);
      result.push({ ...item, id: sku, sku });
    }
  }
  return result;
}
