/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated PostgreSQL fixture, never a live connection. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

const require = createRequire(import.meta.url), root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("admin summaries preserve filters while detail reads are scoped and never modify data", async () => {
  const postgres = new PGlite(), queries: string[] = [];
  const database = require("drizzle-orm/pglite").drizzle(postgres, { logger: { logQuery: (query: string) => queries.push(query) } });
  const cache = new Map<string, any>();
  let incidents: any[] = [], authorized = true, issueReads = 0, errorWrites = 0;
  function load(file: string): any {
    const absolute = resolve(root, file);
    if (/lib[\\/]db(?:[\\/]index)?\.ts$/.test(absolute)) return { db: database, requireDatabase: () => database };
    if (/lib[\\/]auth\.ts$/.test(absolute)) return { getRequestAdmin: async () => authorized ? { role: "owner" } : null };
    if (/lib[\\/]monitoring\.ts$/.test(absolute)) return { getOperationalIssues: async () => { issueReads++; return incidents; }, reportFailure: async () => { errorWrites++; return { reference: "TEST-REF" }; }, resolveFailures: () => assert.fail("GET cannot resolve alerts") };
    if (absolute.endsWith("payfast\\configuration.ts")) return { getPayFastConfiguration: () => ({ environment: "production" }) };
    if (absolute.endsWith("bobgo\\configuration.ts")) return { getBobGoConfiguration: () => ({ enabled: false, apiTokenConfigured: false, environment: "production", senderName: "TEST", senderEmail: "test@example.invalid", senderPhone: "0000000000" }) };
    if (cache.has(absolute)) return cache.get(absolute);
    const compiledModule = { exports: {} }; cache.set(absolute, compiledModule.exports);
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("require", "module", "exports", "process", compiled)((name: string) => {
      if (name === "server-only") return {};
      if (name.startsWith("@/")) return load(name.slice(2) + (name.endsWith(".ts") ? "" : ".ts"));
      if (name.startsWith(".")) return load(resolve(dirname(absolute), name) + (name.endsWith(".ts") ? "" : ".ts"));
      return require(name);
    }, compiledModule, compiledModule.exports, { env: { NODE_ENV: "test" } });
    return compiledModule.exports;
  }
  try {
    for (const file of readdirSync(resolve(root, "drizzle")).filter(file => /^\d{4}_.*\.sql$/.test(file)).sort()) {
      for (const statement of readFileSync(resolve(root, "drizzle", file), "utf8").split("--> statement-breakpoint")) if (statement.trim()) await postgres.exec(statement);
    }
    const schema = load("lib/db/schema.ts");
    const scenarios = [
      ["new", "paid", null], ["ready", "paid", "booked"], ["delivered", "paid", "booked"],
      ["cancelled", "paid", null], ["processing", "paid", null], ["ready", "paid", "failed"],
      ["new", "pending", null], ["delivered", "paid", null], ["ready", "paid", "booked"],
      ["cancelled", "refunded", null],
    ];
    const ids: string[] = [];
    for (const [index, [status, paymentStatus, shipmentStatus]] of scenarios.entries()) {
      const [order] = await database.insert(schema.orders).values({ orderNumber: `MM-TEST-${index}`, status, paymentStatus, deliveryMethod: "courier", subtotal: "420", total: "519", createdAt: new Date("2026-10-22T23:15:00Z"),
        customerSnapshot: { firstName: "Test", lastName: String(index), email: "test@example.invalid", phone: "PRIVATE-PHONE" } }).returning();
      ids.push(order.id);
      const paidBefore = ["paid", "refunded"].includes(paymentStatus!);
      await database.insert(schema.payments).values({ orderId: order.id, merchantPaymentId: order.orderNumber, provider: "payfast-production", status: paymentStatus, amount: "519", providerPaymentId: paidBefore ? `TEST-${index}` : null, verifiedAt: paidBefore ? new Date() : null });
      if (shipmentStatus) await database.insert(schema.shipments).values({ orderId: order.id, provider: "bobgo-production", status: shipmentStatus, providerShipmentId: String(index + 1), trackingNumber: `TEST-${index}` });
    }
    for (const index of [2, 7]) await database.insert(schema.orderReturns).values({ id: randomUUID(), orderId: ids[index], status: index === 2 ? "approved" : "received", reason: "TEST return", items: [], recordedBy: "TEST" });
    await database.insert(schema.orderRefunds).values({ id: randomUUID(), orderId: ids[3], amount: "519", reference: "TEST-REFUND", reason: "TEST", refundedAt: new Date(), recordedBy: "TEST" });
    await database.insert(schema.orderDeliveryHistory).values({ orderId: ids[8], revision: 0, action: "waybill_cancel_requested", before: {}, after: { provider: "bobgo-production", providerShipmentId: "9", trackingNumber: "TEST-8" }, changedBy: "TEST" });
    incidents = [{ orderId: ids[6], source: "server", code: "unexpected", severity: "error", reference: "TEST-ALERT" }];
    const hiddenCases = [
      { missingPayment: true }, { payment: { verifiedAt: null } }, { payment: { providerPaymentId: null } },
      { payment: { providerPaymentId: "   " } }, { payment: { status: "pending" } }, { payment: { status: "failed" } },
      { payment: { amount: "1" } }, { payment: { provider: "unverified-other" } },
      { orderPaymentStatus: "pending" }, { orderPaymentStatus: "failed" },
      { orderPaymentStatus: "refunded", payment: { verifiedAt: null } },
    ];
    const hiddenNumbers = ["MM-TEST-6"];
    for (const [index, entry] of hiddenCases.entries()) {
      const orderNumber = `MM-HIDDEN-${index}`; hiddenNumbers.push(orderNumber);
      const [record] = await database.insert(schema.orders).values({ orderNumber, status: "new", paymentStatus: entry.orderPaymentStatus || "paid", deliveryMethod: "courier", subtotal: "420", total: "519" }).returning();
      if (!entry.missingPayment) await database.insert(schema.payments).values({ orderId: record.id, merchantPaymentId: orderNumber, provider: "payfast-production", status: "paid", amount: "519", providerPaymentId: `TEST-HIDDEN-${index}`, verifiedAt: new Date(), ...entry.payment });
    }
    for (const [index, provider] of ["payfast", "payfast-live", "payfast-sandbox"].entries()) {
      const [record] = await database.insert(schema.orders).values({ orderNumber: `MM-VERIFIED-${index}`, status: "confirmed", paymentStatus: "paid", deliveryMethod: "collection", subtotal: "420", total: "420", createdAt: new Date("2026-10-22T23:15:00Z") }).returning();
      await database.insert(schema.payments).values({ orderId: record.id, merchantPaymentId: record.orderNumber, provider, status: "paid", amount: "420", providerPaymentId: `TEST-VERIFIED-${index}`, verifiedAt: new Date() });
    }
    const admin = load("lib/admin-data.ts");
    queries.length = 0; issueReads = 0;
    const summary = await admin.getAdminOverview();
    assert.equal(queries.length + issueReads, 2, "List needs one summary query and one incident read");
    assert.ok(summary.orders.every((order: any) => order.detailsLoaded === false && order.items.length === 0));
    assert.equal(summary.orders.length, 12, "only verified sales, including refunded/cancelled paid history and private sandbox tests");
    assert.ok(summary.orders.some((order: any) => order.id === "MM-TEST-9" && order.paymentStatus === "Refunded"));
    assert.ok(!summary.orders.some((order: any) => hiddenNumbers.includes(order.id)), "even malformed paid flags and failed attempts are excluded server-side");
    assert.doesNotMatch(JSON.stringify(summary), /PRIVATE-PHONE|TEST-REFUND/);
    const summaryQueries = [...queries];
    queries.length = 0;
    const full = await admin.getAdminSnapshot();
    assert.deepEqual(full.orders.map((order: any) => order.id).sort(), summary.orders.map((order: any) => order.id).sort());
    assert.ok(queries.length >= 12, "Legacy full snapshot still loads all modules");
    for (const order of full.orders) {
      const expectedAttention = Boolean(order.actionNeeded?.length || order.aftersales?.returns.some((record: any) => record.status !== "received") || order.aftersales?.canRecordRefund
        || order.paymentStatus === "Paid" && (["New", "Confirmed"].includes(order.status) || order.status === "Ready" && !["Booking", "Booked"].includes(order.shipping?.status)
        || !["Collected", "Delivered", "Cancelled"].includes(order.status) && order.shipping?.status === "Failed"));
      const light = summary.orders.find((row: any) => row.id === order.id);
      assert.equal(light.placedAt, order.placedAt, "Summary and full detail use the same South African time");
      assert.match(order.placedAt, /23 Oct.*01:15 SAST$/, "UTC timestamp crosses midnight in South Africa");
      assert.equal(light.placedDate, "2026-10-22T23:15:00.000Z", "Stored timestamp is not shifted");
      assert.equal(light.listNeedsAttention, expectedAttention, order.id);
      assert.equal(light.listInProgress, order.paymentStatus === "Paid" && (["Preparing", "Dispatched"].includes(order.status) || order.status === "Ready" && ["Booking", "Booked"].includes(order.shipping?.status)), order.id);
    }
    queries.length = 0;
    const detail = await admin.getAdminSnapshot({ orderNumber: "MM-TEST-0", includeProducts: false });
    assert.deepEqual(detail.orders.map((order: any) => order.id), ["MM-TEST-0"]);
    assert.equal(detail.products.length, 0);
    assert.ok(!queries.some(query => /from "products"|from "product_variants"/.test(query)));
    assert.ok(queries.filter(query => /from "(?:order_items|shipments|email_events|order_returns|order_refunds|inventory_movements|bobgo_order_sync|order_delivery_history)"/.test(query)).every(query => query.includes('in (select "id" from "orders"')));
    assert.ok([...summaryQueries, ...queries].every(query => /^select /i.test(query)), "All admin load queries are read-only");
    const route = load("app/api/admin/data/route.ts");
    for (const number of hiddenNumbers) assert.equal((await route.GET(new Request(`https://api.test/api/admin/data?order=${number}`))).status, 404, number);
    for (const suffix of ["", "?view=orders", "?view=dashboard"]) {
      const response = await route.GET(new Request(`https://api.test/api/admin/data${suffix}`));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.orders.length, 12); assert.ok(!body.orders.some((order: any) => hiddenNumbers.includes(order.id)));
    }
    queries.length = 0; issueReads = 0;
    assert.equal((await route.GET(new Request("https://api.test/api/admin/data?view=products"))).status, 200);
    assert.equal(queries.length, 0, "Products must not fetch order tables");
    assert.equal(issueReads, 1);
    assert.equal((await route.GET(new Request("https://api.test/api/admin/data?order=MM-MISSING"))).status, 404);
    assert.equal((await route.GET(new Request("https://api.test/api/admin/data?order=bad%20id"))).status, 400);
    authorized = false; queries.length = 0;
    assert.equal((await route.GET(new Request("https://api.test/api/admin/data?view=orders"))).status, 401);
    assert.equal(queries.length, 0); assert.equal(errorWrites, 0);
  } finally { await postgres.close(); }
});
