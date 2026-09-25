export type PackageDimensions = {
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
};

export type ShippingLine = {
  sku: string;
  quantity: number;
};

export const HAWA_AND_AMINA_PACKAGE: PackageDimensions = {
  weightGrams: 412,
  lengthCm: 25,
  widthCm: 20.5,
  heightCm: 3.5,
};

export function resolveVerifiedPackage(lines: ShippingLine[]): PackageDimensions | null {
  const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);
  if (totalQuantity !== 2) return null;

  const hasOneHawa = lines.some(
    (line) => line.quantity === 1 && line.sku.toUpperCase().startsWith("HAWA-"),
  );
  const hasOneAmina = lines.some(
    (line) => line.quantity === 1 && line.sku.toUpperCase().startsWith("AMINA-"),
  );

  return hasOneHawa && hasOneAmina ? HAWA_AND_AMINA_PACKAGE : null;
}
