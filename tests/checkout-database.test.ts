/* eslint-disable @typescript-eslint/no-explicit-any -- This harness loads transpiled modules across an isolated database boundary. */
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

test("checkout/payment/return safeguards operate on actual PostgreSQL tables without touching live services", async () => {
  const postgres = new PGlite();
  const database = require("drizzle-orm/pglite").drizzle(postgres);
  const cache = new Map<string, any>();
  const configuration = { environment: "production", merchantId: "12345678", merchantKey: "test-key", passphrase: "test-only", storeUrl: "https://store.test.invalid",
    processUrl: "https://www.payfast.co.za/eng/process", validationUrl: "https://test.invalid/validate", enforceSourceIp: false };
  function load(file: string): any {
    const absolute = resolve(root, file);
    if (absolute.endsWith("lib\\db.ts") || absolute.endsWith("lib\\db\\index.ts")) return { db: database, requireDatabase: () => database };
    if (absolute.endsWith("payfast\\configuration.ts")) return { requirePayFastConfiguration: () => configuration };
    if (cache.has(absolute)) return cache.get(absolute);
    const compiledModule = { exports: {} };
    cache.set(absolute, compiledModule.exports);
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = (name: string) => {
      if (name === "server-only") return {};
      if (name.startsWith("@/")) return load(name.slice(2) + ".ts");
      if (name.startsWith(".")) {
        const path = resolve(dirname(absolute), name);
        return load(path + (name === "./db" ? "/index.ts" : name.endsWith(".ts") ? "" : ".ts"));
      }
      return require(name);
    };
    new Function("require", "module", "exports", compiled)(localRequire, compiledModule, compiledModule.exports);
    return compiledModule.exports;
  }
  try {
    for (const migration of ["0000_amusing_wallop", "0001_ordinary_lord_tyger", "0002_past_lester", "0003_slippery_pet_avengers", "0004_checkout_customer_snapshot", "0005_nostalgic_wallow", "0006_clever_titania", "0007_archive_test_orders"]) {
      const sql = readFileSync(resolve(root, `drizzle/${migration}.sql`), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) if (statement.trim()) await postgres.exec(statement);
    }
    const { upsertCheckoutOrder } = load("lib/checkout-order.ts");
    const { createPayFastCheckout, recordPayFastCheckoutFailure } = load("lib/integrations/payfast/checkout.ts");
    const { processPayFastNotification } = load("lib/integrations/payfast/notification.ts");
    const { createPayFastNotificationSignature } = load("lib/integrations/payfast/signature.ts");
    const { GET: paymentReturn } = load("app/api/payments/payfast/return/route.ts");
    const { POST: restoreSession } = load("app/api/checkout/session/route.ts");
    const { getAdminSnapshot, updateOrderStatus } = load("lib/admin-data.ts");
    const customer = { firstName: "Original", lastName: "Customer", email: "test@example.com", phone: "0821234567" };
    const input = { checkoutToken: "c4c5b18e-4e64-4d3b-845e-d6432157f723", stage: "complete", fulfilmentMethod: "delivery", customer,
      address: { line1: "10 Test Street", suburb: "Test Suburb", city: "Cape Town", province: "Western Cape", postalCode: "0081" },
      items: [{ sku: "AMINA-LAV-OS", quantity: 1 }] };
    const order = await upsertCheckoutOrder(input, database);
    assert.equal(order.total, 519);
    const checkout = { orderNumber: order.orderNumber, checkoutToken: input.checkoutToken };
    await createPayFastCheckout(checkout, "https://test.invalid/api/payments/payfast/checkout");
    const cancelled = await paymentReturn(new Request(`https://test.invalid/api/payments/payfast/return?state=cancelled&order=${order.orderNumber}&token=${input.checkoutToken}`));
    assert.equal(cancelled.status, 302);
    assert.equal(new URL(cancelled.headers.get("location")!).searchParams.get("payment"), "cancelled");
    assert.equal(new URL(cancelled.headers.get("location")!).searchParams.has("token"), false);
    assert.equal((await upsertCheckoutOrder(input, database)).created, false);
    await assert.rejects(upsertCheckoutOrder({ ...input, items: [{ sku: "AMINA-LAV-OS", quantity: 2 }] }, database), /new checkout/);
    // A second order updates the shared profile, never the first order's snapshot.
    const newerInput = { ...input, checkoutToken: "3f1ad40c-9fe5-44f4-aaba-98f567b32b70", customer: { ...customer, firstName: "Changed", phone: "0837654321" } };
    const newerOrder = await upsertCheckoutOrder(newerInput, database);
    const retried = await createPayFastCheckout(checkout, "https://test.invalid/api/payments/payfast/checkout");
    assert.equal(retried.fields.name_first, "Original");
    assert.equal(retried.fields.cell_number, "0821234567");
    const sessionRequest = (checkoutToken: string) => new Request("https://test.invalid/api/checkout/session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ checkoutToken, orderNumber: order.orderNumber }),
    });
    assert.equal((await restoreSession(sessionRequest("d596be61-1a8a-4c3a-85b0-3d482d8c57b2"))).status, 404);
    const recovered = await (await restoreSession(sessionRequest(input.checkoutToken))).json();
    assert.equal(recovered.session.customer.firstName, "Original");
    assert.equal(recovered.session.address.postalCode, "0081");
    assert.equal(recovered.session.items[0].quantity, 1);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("VALID");
    const notify = async (status: string) => {
      const params = new URLSearchParams({ merchant_id: configuration.merchantId, m_payment_id: order.orderNumber,
        pf_payment_id: "TEST-TRANSACTION", payment_status: status, amount_gross: "519.00" });
      params.append("signature", createPayFastNotificationSignature(params, configuration.passphrase));
      return processPayFastNotification(new Request("https://test.invalid/notify", { method: "POST" }), params.toString());
    };
    try {
      const result = await notify("COMPLETE");
      assert.equal(result.paymentStatus, "paid");
      await assert.rejects(upsertCheckoutOrder({ ...input, customer: { ...customer, firstName: "Tampered" } }, database), /paid or closed/);
      await assert.rejects(createPayFastCheckout(checkout, "https://test.invalid/checkout"), /paid or closed/);
      await recordPayFastCheckoutFailure(checkout, "Delayed setup failure");
      await paymentReturn(new Request(`https://test.invalid/api/payments/payfast/return?state=cancelled&order=${order.orderNumber}&token=${input.checkoutToken}`));
      const delayed = await notify("FAILED");
      assert.equal(delayed.paymentStatus, "paid");
      const rows = await postgres.query<{ total: string; payment_status: string; customer_snapshot: typeof customer }>("select total, payment_status, customer_snapshot from orders where order_number = $1", [order.orderNumber]);
      assert.equal(rows.rows[0].payment_status, "paid");
      assert.equal(rows.rows[0].total, "519.00");
      assert.equal(rows.rows[0].customer_snapshot.firstName, "Original");
      const admin = await getAdminSnapshot();
      const savedOrder = admin.orders.find((entry: { id: string }) => entry.id === order.orderNumber);
      assert.equal(savedOrder.customer, "Original Customer");
      assert.equal(savedOrder.paymentStatus, "Paid");
      assert.equal(savedOrder.deliveryMethod, "Courier");
      // Archiving is recoverable and never deletes items/payment history or
      // changes the paid status. Fresh orders stay visible in the same portal.
      await postgres.query("update orders set archived_at = now(), archive_reason = $2 where order_number = $1", [order.orderNumber, "TEST cleanup"]);
      const cleaned = await getAdminSnapshot();
      assert.equal(cleaned.orders.some((entry: { id: string }) => entry.id === order.orderNumber), false);
      assert.equal(cleaned.orders.length, 1, "the newer checkout remains visible");
      assert.equal((await postgres.query("select * from order_items where order_id = (select id from orders where order_number = $1)", [order.orderNumber])).rows.length, 1);
      assert.equal((await postgres.query<{ status: string }>("select status from payments where merchant_payment_id = $1", [order.orderNumber])).rows[0].status, "paid");
      assert.equal((await restoreSession(sessionRequest(input.checkoutToken))).status, 404);
      await assert.rejects(upsertCheckoutOrder(input, database), { code: "CHECKOUT_CHANGED" });
      await assert.rejects(createPayFastCheckout(checkout, "https://test.invalid/checkout"), /archived/);
      assert.equal(await updateOrderStatus(order.orderNumber, "Cancelled"), null);
      await postgres.query("update orders set archived_at = now(), archive_reason = $2 where order_number = $1", [newerOrder.orderNumber, "TEST cleanup"]);
      const archivedUnpaid = { orderNumber: newerOrder.orderNumber, checkoutToken: newerInput.checkoutToken };
      await assert.rejects(createPayFastCheckout(archivedUnpaid, "https://test.invalid/checkout"), /archived/);
      await recordPayFastCheckoutFailure(archivedUnpaid, "Attempt to reuse an archived checkout");
      assert.equal((await postgres.query("select * from payments where merchant_payment_id = $1", [newerOrder.orderNumber])).rows.length, 0);
      assert.equal((await getAdminSnapshot()).orders.length, 0);
      const fresh = await upsertCheckoutOrder({ ...input, checkoutToken: "f9ffec76-a82c-4d9b-a988-09dcd45e01f1" }, database);
      assert.equal(fresh.created, true);
      assert.deepEqual((await getAdminSnapshot()).orders.map((entry: { id: string }) => entry.id), [fresh.orderNumber]);
      await postgres.query("update orders set archived_at = null, archive_reason = null where order_number = $1", [order.orderNumber]);
      assert.equal((await getAdminSnapshot()).orders.find((entry: { id: string }) => entry.id === order.orderNumber).paymentStatus, "Paid");
    } finally { globalThis.fetch = originalFetch; }
  } finally { await postgres.close(); }
});
