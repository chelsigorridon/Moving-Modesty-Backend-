// Supplied by Zarina, 22 October 2026. Product weights exclude packaging.
// Packed weights are references only: confirm the actual sealed parcel before booking.
export const zarinaProductMeasurements = [
  { product: "Hawa Tri-Instant", size: "Small", productGrams: 126, singlePackedGrams: 183 },
  { product: "Hawa Tri-Instant", size: "Large", productGrams: 145, singlePackedGrams: 200 },
  { product: "Amina Tie-Back", size: "One size fits all", productGrams: 212, singlePackedGrams: 267 },
] as const;

export const movingModestyBoxPreset = {
  id: "moving-modesty-scarf-box", name: "Moving Modesty scarf box", lengthCm: 25, widthCm: 20, heightCm: 3,
} as const;

export const zarinaPackedReferences = [
  { label: "1 Hawa Small", grams: 183, approximate: false },
  { label: "1 Hawa Large", grams: 200, approximate: false },
  { label: "1 Amina", grams: 267, approximate: false },
  { label: "2 Hawa Small", grams: 305, approximate: true },
  { label: "1 Hawa Small + 1 Hawa Large", grams: 335, approximate: false },
  { label: "1 Hawa + 1 Amina", grams: 393, approximate: false },
] as const;

export function zarinaProductMeasurement(product: string, size: string) {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const name = normalize(product).replace(/ scarf$/, ""), variant = normalize(size);
  if (["hawa", "hawa tri instant"].includes(name)) {
    if (["small", "s"].includes(variant)) return zarinaProductMeasurements[0];
    if (["large", "l"].includes(variant)) return zarinaProductMeasurements[1];
  }
  if (["amina", "amina tie back"].includes(name) && ["one size fits all", "one size", "onesize", "os"].includes(variant)) return zarinaProductMeasurements[2];
  return undefined;
}
