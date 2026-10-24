import type { CatalogueDocument } from "./catalogue-input.ts";

export type CatalogueStockBaseline = Record<string, { stock: number; stockVerified: boolean }>;
type CurrentStock = { id: string; stockOnHand: number; stockVerified: boolean };
export type CatalogueStockConflict = {
  id: string; colour: string; size: string; currentStock: number; draftStock: number;
  currentStockVerified: boolean; draftStockVerified: boolean;
};

// Read-only three-way merge. Availability, price, photos and all other draft
// fields are untouched. An explicit count can never silently replace a sale.
export function recoverCatalogueStock(document: CatalogueDocument, baseline: CatalogueStockBaseline | undefined, current: CurrentStock[]) {
  const recovered = structuredClone(document);
  const actualById = new Map(current.map(entry => [entry.id, entry]));
  const conflicts: CatalogueStockConflict[] = [];
  for (const colour of recovered.colours) for (const variant of colour.variants) {
    const actual = actualById.get(variant.id);
    if (!actual) continue; // A newly added draft size has no live inventory yet.
    const before = baseline?.[variant.id];
    const draftVerified = variant.stockVerified ?? before?.stockVerified ?? actual.stockVerified;
    const same = (stock: number, verified: boolean) => stock === actual.stockOnHand && verified === actual.stockVerified;
    if (before && variant.stock === before.stock && draftVerified === before.stockVerified) {
      variant.stock = actual.stockOnHand; variant.stockVerified = actual.stockVerified;
    } else if ((!before || !same(before.stock, before.stockVerified)) && !same(variant.stock, draftVerified)) {
      conflicts.push({ id: variant.id, colour: colour.name, size: variant.size,
        currentStock: actual.stockOnHand, currentStockVerified: actual.stockVerified,
        draftStock: variant.stock, draftStockVerified: draftVerified });
      // Legacy drafts lack a reliable save-time baseline. Start with the safe
      // live count; retain the old proposal in the explicit review information.
      if (!before) { variant.stock = actual.stockOnHand; variant.stockVerified = actual.stockVerified; }
    }
  }
  return { document: recovered, conflicts };
}

export function catalogueStockBaseline(stock: CurrentStock[]): CatalogueStockBaseline {
  return Object.fromEntries(stock.map(entry => [entry.id, { stock: entry.stockOnHand, stockVerified: entry.stockVerified }]));
}
