import { z } from "zod";

export const discountCodeSchema = z.string().trim().toUpperCase().min(2, "Enter a discount code.")
  .max(40).regex(/^[A-Z0-9][A-Z0-9_-]*$/, "Use letters, numbers, hyphens or underscores, without spaces.");
const date = z.string().datetime({ offset: true }).nullable().optional().default(null);
export const discountSaveSchema = z.object({
  id: z.string().uuid().optional(),
  expectedRevision: z.number().int().nonnegative(),
  code: discountCodeSchema,
  type: z.enum(["percentage", "amount"]),
  value: z.number().finite().positive("Enter a discount greater than zero.").max(100000),
  active: z.boolean().default(false),
  productIds: z.array(z.string().uuid()).max(100).default([]),
  minimumSpend: z.number().finite().min(0).max(100000).default(0),
  startsAt: date,
  endsAt: date,
}).superRefine((value, context) => {
  if (value.type === "percentage" && value.value >= 100) context.addIssue({ code: "custom", path: ["value"], message: "Percentage discounts must be below 100%." });
  if (Math.abs(value.value * 100 - Math.round(value.value * 100)) > 0.000001) context.addIssue({ code: "custom", path: ["value"], message: "Use no more than two decimal places." });
  if (Math.abs(value.minimumSpend * 100 - Math.round(value.minimumSpend * 100)) > 0.000001) context.addIssue({ code: "custom", path: ["minimumSpend"], message: "Use no more than two decimal places." });
  if (value.startsAt && value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) context.addIssue({ code: "custom", path: ["endsAt"], message: "The end date must be after the start date." });
  if (!value.id && value.expectedRevision !== 0) context.addIssue({ code: "custom", path: ["expectedRevision"], message: "Reload Discounts before saving." });
});
export type DiscountSaveInput = z.infer<typeof discountSaveSchema>;
export type DiscountSnapshot = { id: string; revision: number; code: string; type: "percentage" | "amount"; value: number; amount: number };
export class DiscountValidationError extends Error {}
export class DiscountConflictError extends Error {}

export function discountSaving(rule: { active: boolean; type: string; value: string | number; minimumSpend: string | number;
  startsAt: Date | null; endsAt: Date | null; productIds: string[] }, lines: Array<{ productId?: string; lineTotal: number }>, now = new Date()) {
  if (!["percentage", "amount"].includes(rule.type) || !Number.isFinite(Number(rule.value)) || Number(rule.value) <= 0 || Number(rule.value) > 100000
    || (rule.type === "percentage" && Number(rule.value) >= 100) || !Number.isFinite(Number(rule.minimumSpend)) || Number(rule.minimumSpend) < 0
    || lines.some(line => !Number.isFinite(line.lineTotal) || line.lineTotal < 0)) throw new DiscountValidationError("This discount code is not currently available.");
  if (!rule.active || (rule.startsAt && now < rule.startsAt) || (rule.endsAt && now >= rule.endsAt)) throw new DiscountValidationError("This discount code is not currently available.");
  const subtotalCents = lines.reduce((sum, line) => sum + Math.round(line.lineTotal * 100), 0);
  if (subtotalCents < Math.round(Number(rule.minimumSpend) * 100)) throw new DiscountValidationError(`Spend at least R${Number(rule.minimumSpend).toFixed(2)} on products to use this code.`);
  const eligibleCents = lines.filter(line => !rule.productIds.length || (line.productId && rule.productIds.includes(line.productId)))
    .reduce((sum, line) => sum + Math.round(line.lineTotal * 100), 0);
  if (eligibleCents <= 0) throw new DiscountValidationError("This code does not apply to the products in your cart.");
  const saving = rule.type === "percentage" ? Math.round(eligibleCents * Number(rule.value) / 100) : Math.round(Number(rule.value) * 100);
  const amount = Math.min(saving, eligibleCents);
  if (amount <= 0) throw new DiscountValidationError("This code does not provide a discount on this cart.");
  if (subtotalCents - amount <= 0) throw new DiscountValidationError("This code would make the products free. Please use a smaller discount or contact us.");
  return amount / 100;
}
