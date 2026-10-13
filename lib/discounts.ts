import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { requireDatabase } from "./db";
import { discounts, discountHistory, products, productVariants } from "./db/schema";
import { discountCodeSchema, discountSaveSchema, discountSaving, DiscountConflictError, DiscountValidationError,
  type DiscountSaveInput, type DiscountSnapshot } from "./discount-input";
import { calculateShippingQuote, type ShippingMethod } from "./shipping/policy";

type Database = Pick<ReturnType<typeof requireDatabase>, "select" | "insert" | "update" | "execute">;
export function discountsEnabled() { return process.env.DISCOUNTS_ENABLED === "true"; }
export async function listDiscounts() {
  const database = requireDatabase();
  const [rows, productOptions] = await Promise.all([
    database.select().from(discounts).orderBy(asc(discounts.code)),
    database.select({ id: products.id, name: products.name }).from(products).where(eq(products.status, "active")).orderBy(asc(products.name)),
  ]);
  return { discounts: rows.map(row => ({ ...row, value: Number(row.value), minimumSpend: Number(row.minimumSpend) })), products: productOptions };
}

export async function saveDiscount(input: DiscountSaveInput, actor: string, database = requireDatabase()) {
  const checked = discountSaveSchema.parse(input);
  return database.transaction(async transaction => {
    // Serializes code reuse/renames as well as concurrent creates.
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"discount:" + checked.code}, 0))`);
    const [existing] = checked.id ? await transaction.select().from(discounts).where(eq(discounts.id, checked.id)).for("update").limit(1) : [];
    if (checked.id && (!existing || existing.revision !== checked.expectedRevision)) throw new DiscountConflictError("This discount changed in another tab. Reload Discounts before saving.");
    const [duplicate] = await transaction.select({ id: discounts.id }).from(discounts).where(eq(discounts.code, checked.code)).limit(1);
    if (duplicate && duplicate.id !== checked.id) throw new DiscountValidationError("That code already exists. Edit its existing discount or choose a different code.");
    const productIds = [...new Set(checked.productIds)];
    if (productIds.length) {
      const found = await transaction.select({ id: products.id }).from(products).where(and(inArray(products.id, productIds), eq(products.status, "active")));
      if (found.length !== productIds.length) throw new DiscountValidationError("One of the selected products is no longer active. Reload the product list.");
    }
    const values = { code: checked.code, type: checked.type, value: checked.value.toFixed(2), active: checked.active, productIds,
      minimumSpend: checked.minimumSpend.toFixed(2), startsAt: checked.startsAt ? new Date(checked.startsAt) : null,
      endsAt: checked.endsAt ? new Date(checked.endsAt) : null, updatedBy: actor, revision: (existing?.revision ?? 0) + 1, updatedAt: new Date() };
    const [saved] = existing ? await transaction.update(discounts).set(values).where(eq(discounts.id, existing.id)).returning()
      : await transaction.insert(discounts).values(values).returning();
    await transaction.insert(discountHistory).values({ discountId: saved.id, revision: saved.revision, snapshot: saved, changedBy: actor });
    return { ...saved, value: Number(saved.value), minimumSpend: Number(saved.minimumSpend) };
  });
}

export async function checkoutPricing(code: string | undefined, lines: Array<{ productId?: string; sku?: string; lineTotal: number }>, method: ShippingMethod,
  database: Database = requireDatabase(), frozen?: DiscountSnapshot | null, paymentStarted = false, lock = false) {
  const subtotal = lines.reduce((sum, line) => sum + Math.round(line.lineTotal * 100), 0) / 100;
  const normalized = code?.trim().toUpperCase() || "";
  let snapshot: DiscountSnapshot | null = null;
  if (normalized) {
    if (paymentStarted && frozen?.code === normalized) snapshot = frozen;
    else {
      if (!discountsEnabled()) throw new DiscountValidationError("Discount codes are not currently available.");
      const validated = discountCodeSchema.safeParse(normalized);
      if (!validated.success) throw new DiscountValidationError("Please check your discount code.");
      const query = database.select().from(discounts).where(eq(discounts.code, normalized));
      const [rule] = await (lock ? query.for("update") : query).limit(1);
      if (!rule) throw new DiscountValidationError("This discount code is not currently available.");
      const unmapped = lines.filter(line => !line.productId && line.sku).map(line => line.sku!.toUpperCase());
      const variants = rule.productIds.length && unmapped.length ? await database.select({ sku: productVariants.sku, productId: productVariants.productId })
        .from(productVariants).where(inArray(productVariants.sku, unmapped)) : [];
      const eligibleLines = lines.map(line => ({ ...line, productId: line.productId || variants.find(variant => variant.sku === line.sku?.toUpperCase())?.productId }));
      snapshot = { id: rule.id, revision: rule.revision, code: rule.code, type: rule.type as "percentage" | "amount",
        value: Number(rule.value), amount: discountSaving(rule, eligibleLines) };
    }
  }
  // Free delivery qualifies on the product subtotal before discounts.
  // Product discounts never reduce the separate courier fee.
  const quote = calculateShippingQuote(subtotal, method);
  const discountAmount = snapshot?.amount ?? 0;
  if (discountAmount < 0 || discountAmount >= subtotal && subtotal > 0) throw new DiscountValidationError("The saved discount is invalid. Please start a new checkout.");
  return { ...quote, discountAmount, discountSnapshot: snapshot, total: Math.round((subtotal - discountAmount + quote.deliveryFee) * 100) / 100 };
}
