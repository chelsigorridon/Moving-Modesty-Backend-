/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated PostgreSQL and email-provider test boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("recorded dispatch emails contain tracking, survive failure, retry safely and do not repeat successful sends", async () => {
  const postgres = new PGlite();
  const database = require("drizzle-orm/pglite").drizzle(postgres);
  const cache = new Map<string, any>();
  const sent: any[] = [];
  let fail = true;
  let authorized = true;
  const fakeProcess = { env: { NODE_ENV: "test", RESEND_API_KEY: "TEST-NOT-A-REAL-KEY" } };
  function load(file: string): any {
    const absolute = resolve(root, file);
    if (/lib[\\/]db(?:[\\/]index)?\.ts$/.test(absolute)) return { db: database, requireDatabase: () => database };
    if (/lib[\\/]auth\.ts$/.test(absolute)) return { getRequestAdmin: () => authorized };
    if (cache.has(absolute)) return cache.get(absolute);
    const compiledModule = { exports: {} };
    cache.set(absolute, compiledModule.exports);
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = (name: string) => {
      if (name === "server-only") return {};
      if (name === "resend") return { Resend: class { emails = { send: async (email: any, options: any) => {
        sent.push({ email, options });
        return fail ? { error: { message: "TEST provider unavailable" } } : { data: { id: "TEST-ACCEPTED" } };
      } }; } };
      if (name.startsWith("@/")) return load(name.slice(2) + ".ts");
      if (name.startsWith(".")) return load(resolve(dirname(absolute), name) + (name.endsWith(".ts") ? "" : name === "./db" ? "/index.ts" : ".ts"));
      return require(name);
    };
    new Function("require", "module", "exports", "process", compiled)(localRequire, compiledModule, compiledModule.exports, fakeProcess);
    return compiledModule.exports;
  }
  try {
    for (const migration of ["0000_amusing_wallop", "0001_ordinary_lord_tyger", "0002_past_lester", "0003_slippery_pet_avengers", "0004_checkout_customer_snapshot", "0005_nostalgic_wallow", "0006_clever_titania", "0007_archive_test_orders"]) {
      for (const statement of readFileSync(resolve(root, `drizzle/${migration}.sql`), "utf8").split("--> statement-breakpoint")) if (statement.trim()) await postgres.exec(statement);
    }
    const { customers, orders, shipments, emailEvents } = load("lib/db/schema.ts");
    const { eq } = require("drizzle-orm");
    const [customer] = await database.insert(customers).values({ firstName: "TEST", lastName: "Customer", email: "test@example.com" }).returning();
    const [record] = await database.insert(orders).values({ orderNumber: "MM-TEST-EMAIL", customerId: customer.id, subtotal: "420", deliveryFee: "99", total: "519", deliveryMethod: "courier", paymentStatus: "paid", status: "ready" }).returning();
    await database.insert(shipments).values({ orderId: record.id, status: "booked", provider: "bobgo-production" });
    const { getAdminSnapshot, updateOrderStatus } = load("lib/admin-data.ts");
    const { sendOrderStatusEmail, retryOrderNotification } = load("lib/email.ts");
    await assert.rejects(updateOrderStatus(record.orderNumber, "Dispatched"), /cannot be changed/);
    assert.equal((await database.select().from(orders))[0].status, "ready");
    await database.update(shipments).set({ trackingNumber: "BG123456789" }).where(eq(shipments.orderId, record.id));
    const { PATCH } = load("app/api/admin/orders/[orderNumber]/route.ts");
    const response = await PATCH(new Request("https://test.invalid/api/order", { method: "PATCH", body: JSON.stringify({ status: "Dispatched" }) }), { params: Promise.resolve({ orderNumber: record.orderNumber }) });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.order.status, "Dispatched");
    assert.equal(body.email.failed, true);
    assert.equal(body.order.notifications[0].status, "failed");
    assert.equal(body.order.notifications[0].retryable, true);
    assert.match(sent[0].email.html, /BG123456789/);
    assert.match(sent[0].email.html, /href="https:\/\/track\.bobgo\.co\.za\/"/);
    assert.match(sent[0].email.html, /Enter the tracking number/);
    const eventId = body.order.notifications[0].id;
    const { POST: retry } = load("app/api/admin/orders/[orderNumber]/notifications/route.ts");
    const retryRequest = () => new Request("https://test.invalid/api/order/notifications", { method: "POST", body: JSON.stringify({ notificationId: eventId }) });
    const context = { params: Promise.resolve({ orderNumber: record.orderNumber }) };
    authorized = false;
    assert.equal((await retry(retryRequest(), context)).status, 401);
    authorized = true;
    assert.equal((await retry(retryRequest(), { params: Promise.resolve({ orderNumber: "OTHER-ORDER" }) })).status, 404);
    assert.equal((await retry(retryRequest(), context)).status, 503);
    fail = false;
    const success = await retry(retryRequest(), context);
    assert.equal(success.status, 200);
    assert.equal((await success.json()).order.notifications[0].status, "sent");
    const numberSent = sent.length;
    assert.equal((await retry(retryRequest(), context)).status, 409);
    const current = (await getAdminSnapshot()).orders[0];
    assert.equal((await sendOrderStatusEmail(current, "Dispatched")).skipped, true);
    assert.equal(sent.length, numberSent);
    await database.update(emailEvents).set({ status: "failed" }).where(eq(emailEvents.id, eventId));
    await database.update(orders).set({ status: "delivered" }).where(eq(orders.id, record.id));
    await assert.rejects(retryOrderNotification((await getAdminSnapshot()).orders[0], eventId), /current stage/);
    const beforeInternal = (await database.select().from(emailEvents)).length;
    assert.equal((await sendOrderStatusEmail(current, "Preparing")).skipped, true);
    assert.equal((await database.select().from(emailEvents)).length, beforeInternal);
  } finally { await postgres.close(); }
});
