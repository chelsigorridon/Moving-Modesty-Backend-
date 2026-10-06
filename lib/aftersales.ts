import { and, eq, sql } from "drizzle-orm";
import { requireDatabase } from "./db";
import { inventoryMovements, orderItems, orderRefunds, orderReturns, orders, payments, productVariants } from "./db/schema";
import { AftersalesConflict, moneyCents, type AftersalesInput } from "./aftersales-input";

function conflict(message: string): never { throw new AftersalesConflict(message); }

export async function updateAftersales(orderNumber: string, input: AftersalesInput, actor: string) {
  return requireDatabase().transaction(async transaction => {
    const [order] = await transaction.select().from(orders).where(eq(orders.orderNumber, orderNumber)).for("update").limit(1);
    if (!order) return null;
    const [payment] = await transaction.select().from(payments).where(eq(payments.orderId, order.id)).limit(1);
    // Never infer a payment from an editable order status alone.
    if (!payment || payment.status !== "paid" || !payment.providerPaymentId || !payment.verifiedAt)
      conflict("This order has no verified PayFast payment. Contact website support before recording a return or refund.");
    const returns = await transaction.select().from(orderReturns).where(eq(orderReturns.orderId, order.id));
    const refunds = await transaction.select().from(orderRefunds).where(eq(orderRefunds.orderId, order.id));
    const purchased = await transaction.select().from(orderItems).where(eq(orderItems.orderId, order.id));

    if (input.action === "approve_return") {
      const existing = returns.find(record => record.id === input.requestId);
      if (existing) {
        if (existing.reason !== input.reason || JSON.stringify(existing.items.map(({ itemId, quantity }) => ({ itemId, quantity }))) !== JSON.stringify(input.items)) conflict("This request was already used for a different return.");
        return { duplicate: true, refundId: null };
      }
      if (!["delivered", "collected"].includes(order.status)) conflict("Returns can only be approved after the customer has received the order.");
      if (returns.some(record => record.status !== "received")) conflict("Finish the existing return before approving another one.");
      if (new Set(input.items.map(item => item.itemId)).size !== input.items.length) conflict("Choose each item only once.");
      for (const item of input.items) {
        const original = purchased.find(row => row.id === item.itemId);
        const alreadyReturned = returns.flatMap(row => row.items).filter(row => row.itemId === item.itemId).reduce((sum, row) => sum + row.quantity, 0);
        if (!original || item.quantity > original.quantity - alreadyReturned) conflict("The return quantity exceeds the items remaining on this order.");
      }
      await transaction.insert(orderReturns).values({ id: input.requestId, orderId: order.id, reason: input.reason,
        items: input.items.map(item => ({ ...item, restocked: 0 })), recordedBy: actor });
    } else if (input.action === "return_waybill") {
      const record = returns.find(row => row.id === input.returnId);
      if (!record) conflict("Return not found on this order.");
      if (record.status !== "approved" && !(record.status === "in_transit" && record.waybillReference === input.reference)) conflict("This return waybill has already been recorded. Refresh the order.");
      await transaction.update(orderReturns).set({ status: "in_transit", waybillReference: input.reference, updatedAt: new Date() }).where(eq(orderReturns.id, record.id));
    } else if (input.action === "receive_return") {
      const record = returns.find(row => row.id === input.returnId);
      if (!record) conflict("Return not found on this order.");
      if (new Set(input.restock.map(item => item.itemId)).size !== input.restock.length) conflict("Choose each stock item only once.");
      if (record.status === "received") {
        if (input.restock.some(item => !record.items.some(row => row.itemId === item.itemId)) || record.items.some(item => item.restocked !== (input.restock.find(row => row.itemId === item.itemId)?.quantity || 0))) conflict("This return receipt was already saved with different stock quantities.");
        return { duplicate: true, refundId: null };
      }
      if (!["approved", "in_transit"].includes(record.status)) conflict("This return cannot be received at its current stage.");
      const updatedItems = record.items.map(item => ({ ...item, restocked: input.restock.find(row => row.itemId === item.itemId)?.quantity || 0 }));
      if (input.restock.some(item => !record.items.some(row => row.itemId === item.itemId))) conflict("Only items from this return can be added back to stock.");
      // Lock variants in stable order, including concurrent returns on different orders.
      const variantIds = [...new Set(purchased.filter(item => updatedItems.some(row => row.itemId === item.id && row.restocked > 0)).map(item => item.variantId).filter((id): id is string => Boolean(id)))].sort();
      for (const variantId of variantIds) await transaction.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.id, variantId)).for("update");
      for (const item of updatedItems) {
        if (item.restocked > item.quantity) conflict("Restocked quantities cannot exceed received quantities.");
        if (!item.restocked) continue;
        const original = purchased.find(row => row.id === item.itemId)!;
        if (!original.variantId) conflict("This product variant no longer exists. Record receipt without restocking and review Products.");
        const movements = await transaction.select().from(inventoryMovements).where(and(eq(inventoryMovements.orderId, order.id), eq(inventoryMovements.variantId, original.variantId)));
        const deducted = movements.filter(row => row.type === "order_allocated").reduce((sum, row) => sum + Math.abs(row.quantity), 0);
        const restored = movements.filter(row => row.type === "return").reduce((sum, row) => sum + Math.max(0, row.quantity), 0);
        if (item.restocked > deducted - restored) conflict("The original sale has no remaining stock deduction to reverse. Receive without restocking, then review stock in Products to avoid double-counting.");
        await transaction.update(productVariants).set({ stockOnHand: sql`${productVariants.stockOnHand} + ${item.restocked}`, updatedAt: new Date() }).where(eq(productVariants.id, original.variantId));
        await transaction.insert(inventoryMovements).values({ variantId: original.variantId, orderId: order.id, type: "return", quantity: item.restocked, note: `Inspected resaleable return ${record.id}; recorded by ${actor}` });
      }
      await transaction.update(orderReturns).set({ status: "received", items: updatedItems, receivedAt: new Date(), updatedAt: new Date() }).where(eq(orderReturns.id, record.id));
    } else {
      const existing = refunds.find(record => record.id === input.requestId);
      if (existing) {
        if (moneyCents(existing.amount) !== moneyCents(input.amount) || existing.reference !== input.reference || existing.reason !== input.reason || existing.refundedAt.toISOString().slice(0, 10) !== input.refundedAt) conflict("This request was already used for a different refund.");
        return { duplicate: true, refundId: existing.id };
      }
      if (order.status !== "cancelled" && (!returns.length || returns.some(record => record.status !== "received"))) conflict("Cancel the eligible order, or receive and inspect its return, before recording the refund.");
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      if (input.refundedAt > today) conflict("The refund date cannot be in the future.");
      const refunded = refunds.reduce((sum, row) => sum + moneyCents(row.amount), 0);
      const paid = Math.min(moneyCents(order.total), moneyCents(payment.amount));
      if (moneyCents(input.amount) > paid - refunded) conflict("The refund exceeds the remaining paid amount.");
      const [used] = await transaction.select({ id: orderRefunds.id }).from(orderRefunds).where(eq(orderRefunds.reference, input.reference)).limit(1);
      if (used) conflict("That PayFast refund reference has already been recorded.");
      await transaction.insert(orderRefunds).values({ id: input.requestId, orderId: order.id, amount: (moneyCents(input.amount) / 100).toFixed(2), reference: input.reference,
        reason: input.reason, refundedAt: new Date(`${input.refundedAt}T12:00:00Z`), recordedBy: actor });
      // Preserve the original verified payment and provider response as audit evidence.
      if (refunded + moneyCents(input.amount) === paid) await transaction.update(orders).set({ paymentStatus: "refunded", updatedAt: new Date() }).where(eq(orders.id, order.id));
      return { duplicate: false, refundId: input.requestId };
    }
    return { duplicate: false, refundId: null };
  });
}
