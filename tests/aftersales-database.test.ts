/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated PostgreSQL and mocked provider test boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("returns and refund records use locked PostgreSQL transactions without transferring money or booking couriers", async t => {
  const postgres = new PGlite();
  const database = require("drizzle-orm/pglite").drizzle(postgres);
  const cache = new Map<string, any>();
  const sent: any[] = [];
  let emailFails = true;
  let admin: any = { email: "owner@test.invalid", role: "owner" };
  const fakeProcess = { env: { NODE_ENV: "test", RESEND_API_KEY: "TEST-NOT-A-REAL-KEY" } };
  function load(file: string): any {
    const absolute = resolve(root, file);
    if (/lib[\\/]db(?:[\\/]index)?\.ts$/.test(absolute)) return { db: database, requireDatabase: () => database };
    if (/lib[\\/]auth\.ts$/.test(absolute)) return { getRequestAdmin: () => admin };
    if (cache.has(absolute)) return cache.get(absolute);
    const compiledModule = { exports: {} };
    cache.set(absolute, compiledModule.exports);
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = (name: string) => {
      if (name === "server-only") return {};
      if (name === "resend") return { Resend: class { emails = { send: async (email: any, options: any) => {
        sent.push({ email, options });
        return emailFails ? { error: { message: "TEST failure" } } : { data: { id: `TEST-MESSAGE-${sent.length}` } };
      } }; } };
      if (name.startsWith("@/")) return load(name.slice(2) + ".ts");
      if (name.startsWith(".")) return load(resolve(dirname(absolute), name) + (name.endsWith(".ts") ? "" : name === "./db" ? "/index.ts" : ".ts"));
      return require(name);
    };
    new Function("require", "module", "exports", "process", compiled)(localRequire, compiledModule, compiledModule.exports, fakeProcess);
    return compiledModule.exports;
  }
  try {
    const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
    for (const migration of journal.entries) for (const statement of readFileSync(resolve(root, `drizzle/${migration.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (statement.trim()) await postgres.exec(statement);
    const { customers, products, productVariants, orders, orderItems, payments, orderReturns, orderRefunds, inventoryMovements, emailEvents } = load("lib/db/schema.ts");
    const { eq } = require("drizzle-orm");
    const { aftersalesInput } = load("lib/aftersales-input.ts");
    const { updateAftersales } = load("lib/aftersales.ts");
    const { getAdminSnapshot } = load("lib/admin-data.ts");
    const { POST } = load("app/api/admin/orders/[orderNumber]/aftersales/route.ts");
    const { sendOrderStatusEmail, retryOrderNotification } = load("lib/email.ts");
    const [customer] = await database.insert(customers).values({ firstName: "TEST", lastName: "Customer", email: "test@example.com" }).returning();
    const [product] = await database.insert(products).values({ slug: "TEST-AFTERSALES", name: "TEST Amina", category: "TEST", status: "active" }).returning();
    const [variant] = await database.insert(productVariants).values({ productId: product.id, sku: "TEST-AFTERSALES-OS", size: "One size", colour: "Black", price: "420", stockOnHand: 4 }).returning();
    async function fixture(status = "delivered", verified = true, quantity = 2) {
      const [record] = await database.insert(orders).values({ orderNumber: `MM-TEST-${randomUUID()}`, customerId: customer.id,
        subtotal: "840", deliveryFee: "99", total: "939", deliveryMethod: "courier", paymentStatus: verified ? "paid" : "pending", status }).returning();
      const [item] = await database.insert(orderItems).values({ orderId: record.id, variantId: variant.id, productName: product.name,
        variantName: "Black", sku: variant.sku, quantity, unitPrice: "420", lineTotal: "840" }).returning();
      await database.insert(payments).values({ orderId: record.id, merchantPaymentId: record.orderNumber, provider: "payfast-production", amount: "939",
        status: verified ? "paid" : "pending", providerPaymentId: verified ? `TEST-${record.id}` : null, verifiedAt: verified ? new Date() : null }).returning();
      return { record, item };
    }
    const returned = await fixture();
    const cancelled = await fixture("cancelled");
    const unpaid = await fixture("delivered", false);
    const ready = await fixture("ready");
    const actor = "owner@test.invalid";
    const approve = (itemId: string, quantity = 1) => aftersalesInput.parse({ action: "approve_return", requestId: randomUUID(), reason: "TEST wrong fit", items: [{ itemId, quantity }] });
    const completedRefund = (amount = "100.00") => aftersalesInput.parse({ action: "record_refund", requestId: randomUUID(), completedInPayFast: true, amount,
      reference: `TEST-REFUND-${randomUUID()}`, reason: "TEST agreed refund", refundedAt: "2026-10-05" });
    const snapshot = async (number: string) => (await getAdminSnapshot()).orders.find((order: any) => order.id === number);
    const request = (body: any, number = cancelled.record.orderNumber) => POST(new Request("https://test.invalid/aftersales", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ orderNumber: number }) });

    await t.test("authorization, validation and order ownership are enforced", async () => {
      admin = null;
      assert.equal((await request(completedRefund())).status, 401);
      admin = { email: actor, role: "fulfilment" };
      assert.equal((await request(completedRefund())).status, 403);
      admin = { email: actor, role: "owner" };
      assert.equal((await request({ ...completedRefund(), completedInPayFast: false })).status, 400);
      assert.equal((await request({ ...completedRefund(), amount: "-1" })).status, 400);
      assert.equal((await request(completedRefund(), "NOT-AN-ORDER")).status, 404);
      await assert.rejects(updateAftersales(unpaid.record.orderNumber, approve(unpaid.item.id), actor), /no verified/);
      await assert.rejects(updateAftersales(ready.record.orderNumber, approve(ready.item.id), actor), /after the customer/);
      await assert.rejects(updateAftersales(returned.record.orderNumber, approve(cancelled.item.id), actor), /quantity exceeds/);
      await assert.rejects(updateAftersales(returned.record.orderNumber, approve(returned.item.id, 3), actor), /quantity exceeds/);
      await assert.rejects(updateAftersales(returned.record.orderNumber, completedRefund(), actor), /receive and inspect/);
      assert.equal((await database.select().from(orderReturns)).length, 0);
      assert.equal((await database.select().from(orderRefunds)).length, 0);
    });

    let returnId: string;
    await t.test("approval and waybill records do not restock, refund or change outbound fulfilment", async () => {
      const input = approve(returned.item.id);
      returnId = input.requestId;
      await updateAftersales(returned.record.orderNumber, input, actor);
      assert.equal((await updateAftersales(returned.record.orderNumber, input, actor)).duplicate, true);
      await assert.rejects(updateAftersales(returned.record.orderNumber, { ...input, reason: "different" }, actor), /different return/);
      await assert.rejects(updateAftersales(returned.record.orderNumber, approve(returned.item.id), actor), /existing return/);
      await assert.rejects(updateAftersales(cancelled.record.orderNumber, { action: "return_waybill", returnId, reference: "TEST-BG" }, actor), /not found/);
      await updateAftersales(returned.record.orderNumber, { action: "return_waybill", returnId, reference: "TEST-BG" }, actor);
      await updateAftersales(returned.record.orderNumber, { action: "return_waybill", returnId, reference: "TEST-BG" }, actor);
      const current = await snapshot(returned.record.orderNumber);
      assert.equal(current.status, "Delivered");
      assert.equal(current.paymentStatus, "Paid");
      assert.equal(current.aftersales.returns[0].status, "in_transit");
      assert.equal(current.aftersales.canRecordRefund, false);
      assert.equal((await database.select().from(productVariants))[0].stockOnHand, 4);
    });

    await t.test("receipt cannot inflate undeducted stock, and a valid deduction reverses once only", async () => {
      const receipt = { action: "receive_return", returnId, inspected: true, restock: [{ itemId: returned.item.id, quantity: 1 }] };
      await assert.rejects(updateAftersales(returned.record.orderNumber, receipt, actor), /no remaining stock deduction/);
      assert.equal((await database.select().from(orderReturns))[0].status, "in_transit");
      await database.insert(inventoryMovements).values({ orderId: returned.record.id, variantId: variant.id, type: "order_allocated", quantity: -1 });
      await updateAftersales(returned.record.orderNumber, receipt, actor);
      assert.equal((await updateAftersales(returned.record.orderNumber, receipt, actor)).duplicate, true);
      await assert.rejects(updateAftersales(returned.record.orderNumber, { ...receipt, restock: [] }, actor), /different stock/);
      assert.equal((await database.select().from(productVariants))[0].stockOnHand, 5);
      assert.equal((await database.select().from(inventoryMovements)).filter((row: any) => row.type === "return").length, 1);
      const next = approve(returned.item.id);
      await updateAftersales(returned.record.orderNumber, next, actor);
      await assert.rejects(updateAftersales(returned.record.orderNumber, { ...receipt, returnId: next.requestId }, actor), /stock deduction/);
      await updateAftersales(returned.record.orderNumber, { ...receipt, returnId: next.requestId, restock: [] }, actor);
      assert.equal((await snapshot(returned.record.orderNumber)).aftersales.canStartReturn, false);
      assert.equal((await snapshot(returned.record.orderNumber)).aftersales.canRecordRefund, true);
      assert.equal((await database.select().from(productVariants))[0].stockOnHand, 5);
    });

    await t.test("partial/full refunds are limited to paid value and preserve the original payment audit", async () => {
      const partial = completedRefund("400.00");
      await updateAftersales(returned.record.orderNumber, partial, actor);
      assert.equal((await updateAftersales(returned.record.orderNumber, partial, actor)).duplicate, true);
      await assert.rejects(updateAftersales(returned.record.orderNumber, { ...partial, amount: "401" }, actor), /different refund/);
      await assert.rejects(updateAftersales(cancelled.record.orderNumber, { ...partial, requestId: randomUUID() }, actor), /already been recorded/);
      assert.equal((await snapshot(returned.record.orderNumber)).paymentStatus, "Paid");
      assert.equal((await snapshot(returned.record.orderNumber)).aftersales.remainingRefundable, 539);
      await assert.rejects(updateAftersales(returned.record.orderNumber, completedRefund("540"), actor), /exceeds/);
      await assert.rejects(updateAftersales(returned.record.orderNumber, { ...completedRefund(), refundedAt: "2099-01-01" }, actor), /future/);
      await updateAftersales(returned.record.orderNumber, completedRefund("539"), actor);
      const current = await snapshot(returned.record.orderNumber);
      assert.equal(current.paymentStatus, "Refunded");
      assert.equal(current.aftersales.canRecordRefund, false);
      const original = (await database.select().from(payments).where(eq(payments.orderId, returned.record.id)))[0];
      assert.equal(original.status, "paid");
      assert.equal(original.providerPaymentId, `TEST-${returned.record.id}`);
      assert.ok(original.verifiedAt);
      await assert.rejects(updateAftersales(returned.record.orderNumber, completedRefund("0.01"), actor), /exceeds/);
    });

    await t.test("refund is saved despite email failure; retry uses the same ledger and notification", async () => {
      const refund = completedRefund("99.00");
      const response = await request(refund);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.saved, true);
      assert.match(body.warning, /record saved.*email failed/);
      assert.match(body.message, /No money was transferred/);
      assert.equal(body.order.aftersales.refundedTotal, 99);
      const notification = body.order.notifications.find((row: any) => row.title === "Customer refund confirmation");
      assert.equal(notification.status, "failed");
      assert.equal(notification.retryable, true);
      assert.match(sent.at(-1).email.html, /R\s*99.00/);
      assert.match(sent.at(-1).email.html, /TEST-REFUND/);
      emailFails = false;
      await retryOrderNotification(await snapshot(cancelled.record.orderNumber), notification.id);
      const sentCount = sent.length;
      assert.equal((await request(refund)).status, 200);
      assert.equal(sent.length, sentCount);
      assert.equal((await database.select().from(orderRefunds).where(eq(orderRefunds.orderId, cancelled.record.id))).length, 1);
      assert.equal((await database.select().from(emailEvents).where(eq(emailEvents.id, notification.id)))[0].status, "sent");
    });

    await t.test("cancellation uses the visible hosted template and does not claim a completed refund", async () => {
      const current = await snapshot(cancelled.record.orderNumber);
      await sendOrderStatusEmail(current, "Cancelled");
      const email = sent.at(-1).email;
      assert.equal(email.template.id, "customer-order-cancelled");
      assert.equal(email.template.variables.CUSTOMER_NAME, "TEST");
      assert.equal(email.template.variables.ORDER_NUMBER, cancelled.record.orderNumber);
      assert.equal(email.html, undefined);
      assert.equal(email.replyTo, "movingmodesty@gmail.com");
      const template = readFileSync(resolve(root, "email-templates/customer-order-cancelled.html"), "utf8");
      assert.match(template, /not automatically refund/);
      assert.match(template, /moving-modesty-email-logo.png/);
      assert.doesNotMatch(template, /Zarina.*address/);
    });
  } finally { await postgres.close(); }
});
