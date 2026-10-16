import { z } from "zod";

const dimension = z.union([z.number(), z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/)]).transform(value => Number(value)).pipe(z.number().finite().positive().max(150).multipleOf(0.01));
const dimensions = z.object({ name: z.string().trim().min(1).max(150), length_cm: dimension, width_cm: dimension, height_cm: dimension });

export function parseBobGoPackages(value: unknown) {
  const rows = Array.isArray(value) ? value : value && typeof value === "object" && "packages" in value ? value.packages : null;
  if (!Array.isArray(rows) || rows.length > 250) throw new Error("Bob Go did not return a supported saved-package list.");
  return rows.flatMap((row, index) => {
    const parsed = dimensions.safeParse(row);
    if (!parsed.success) return [];
    // This is a selection identifier only, never an instruction to Bob Go.
    return [{ id: String(index), name: parsed.data.name, lengthCm: parsed.data.length_cm, widthCm: parsed.data.width_cm, heightCm: parsed.data.height_cm }];
  });
}
