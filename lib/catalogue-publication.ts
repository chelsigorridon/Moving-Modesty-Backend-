import type { CatalogueDocument } from "./catalogue-input.ts";

// These are the only fields owned entirely by the backend stock service.
// Everything else (including price, identities, ordering and photos) still
// requires the existing guarded Framer publication flow.
export function inventoryOnlyPublication(document: CatalogueDocument, published: CatalogueDocument | null) {
  if (!published) return false;
  const content = (value: CatalogueDocument) => ({ ...value, colours: value.colours.map(colour => {
    const { available: _available, ...rest } = colour;
    void _available;
    return { ...rest, variants: colour.variants.map(variant => {
      const { stock: _stock, stockVerified: _verified, available: _available, ...rest } = variant;
      void _stock; void _verified; void _available;
      return rest;
    }) };
  }) });
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)])) : value;
  return JSON.stringify(stable(content(document))) === JSON.stringify(stable(content(published)));
}
