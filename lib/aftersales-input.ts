import { z } from "zod";

const items = z.array(z.object({ itemId: z.uuid(), quantity: z.number().int().min(1).max(1000) })).min(1).max(100);
const reason = z.string().trim().min(3).max(1000);
export const aftersalesInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve_return"), requestId: z.uuid(), reason, items }),
  z.object({ action: z.literal("return_waybill"), returnId: z.uuid(), reference: z.string().trim().min(3).max(100) }),
  z.object({ action: z.literal("receive_return"), returnId: z.uuid(), inspected: z.literal(true),
    restock: z.array(z.object({ itemId: z.uuid(), quantity: z.number().int().min(0).max(1000) })).max(100) }),
  z.object({ action: z.literal("record_refund"), requestId: z.uuid(), completedInPayFast: z.literal(true),
    amount: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/).refine(value => Number(value) > 0, "Enter a positive refund amount."),
    reference: z.string().trim().min(3).max(100), reason,
    refundedAt: z.iso.date() }),
]);
export type AftersalesInput = z.infer<typeof aftersalesInput>;
export class AftersalesConflict extends Error {}
export function moneyCents(value: string | number) {
  const [whole, fraction = ""] = String(value).split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
}
