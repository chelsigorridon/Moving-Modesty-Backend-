/* eslint-disable @typescript-eslint/no-explicit-any -- Fully isolated PostgreSQL and provider adapters for inventory audit. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

test("inventory lifecycle audit uses real application logic with no live network or database", async t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), require = createRequire(import.meta.url);
  const pg = new PGlite(), db = require("drizzle-orm/pglite").drizzle(pg), cache = new Map<string, any>();
  let transactionScope: any, counter = 0, validationValid = true, callbacks = 0;
  const transact = db.transaction.bind(db);
  db.transaction = (work: any, options: any) => transact(async (tx: any) => {
    transactionScope = tx; try { return await work(tx); } finally { transactionScope = undefined; }
  }, options);
  const environment = { NODE_ENV: "test", PRODUCT_MANAGEMENT_ENABLED: "true", AUTH_SECRET: "ISOLATED-INVENTORY-AUDIT-NOT-A-LIVE-KEY", STORE_URL: "https://store.test.invalid" };
  const configuration = { environment: "production", merchantId: "12345678", merchantKey: "TEST-ONLY", passphrase: "AUDIT-ONLY", storeUrl: environment.STORE_URL, processUrl: "https://test.invalid/pay", validationUrl: "https://test.invalid/validate", enforceSourceIp: false };
  class PreflightError extends Error {}
  function load(file: string): any {
    const path = resolve(root, file);
    if (/lib[\\/]db(?:[\\/]index)?\.ts$/.test(path)) return { db, requireDatabase: () => transactionScope ?? db };
    if (/lib[\\/]framer-catalogue-live\.ts$/.test(path)) return { CataloguePublishPreflightError: PreflightError, publishCmsCatalogue: async (_doc: any, mapping: any) => mapping };
    if (/lib[\\/]monitoring\.ts$/.test(path)) return { reportFailure: async () => ({ reference: "AUDIT-ONLY" }), resolveFailures: async () => {}, getOperationalIssues: async () => [] };
    if (/lib[\\/]auth\.ts$/.test(path)) return { getRequestAdmin: async () => ({ email: "audit@test.invalid", role: "owner" }) };
    if (/payfast[\\/]configuration\.ts$/.test(path)) return { requirePayFastConfiguration: () => configuration };
    if (/bobgo[\\/]order-sync\.ts$/.test(path)) return { enqueuePaidBobGoOrder: async () => { callbacks++; } };
    if (cache.has(path)) return cache.get(path);
    const compiledModule = { exports: {} }; cache.set(path, compiledModule.exports);
    const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = (name: string) => {
      if (name === "server-only") return {};
      if (name === "resend") return { Resend: class { constructor() { throw new Error("Email is not allowed in inventory audit"); } } };
      if (name.startsWith("@/")) return load(name.slice(2) + ".ts");
      if (name.startsWith(".")) return load(resolve(dirname(path), name) + (name.endsWith(".ts") ? "" : name === "./db" ? "/index.ts" : ".ts"));
      return require(name);
    };
    const fakeFetch = async (url: string) => { assert.equal(url, configuration.validationUrl, "No real external request is permitted"); return new Response(validationValid ? "VALID" : "INVALID"); };
    new Function("require", "module", "exports", "process", "fetch", code)(localRequire, compiledModule, compiledModule.exports, { env: environment }, fakeFetch);
    return compiledModule.exports;
  }
  try {
    const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
    for (const migration of journal.entries) for (const sql of readFileSync(resolve(root, `drizzle/${migration.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (sql.trim()) await pg.exec(sql);
    const live = load("lib/catalogue-live.ts"), stock = load("lib/catalogue-storefront.ts"), checkout = load("lib/checkout-order.ts");
    const payment = load("lib/integrations/payfast/checkout.ts"), notification = load("lib/integrations/payfast/notification.ts"), signature = load("lib/integrations/payfast/signature.ts");
    const returnRoute = load("app/api/payments/payfast/return/route.ts"), aftersales = load("lib/aftersales.ts"), admin = load("lib/admin-data.ts");
    async function fixture(onHand = 5, verified = true) {
      const number = ++counter, smallId = randomUUID(), largeId = randomUUID();
      const document = { name: `AUDIT product ${number}`, slug: `audit-product-${number}`, description: "Isolated inventory test only", category: "Hijabs", homepageImage: { url: "https://test.invalid/image.jpg", alt: "TEST" }, showOnHomepage: true, homepageOrder: number,
        colours: [{ id: randomUUID(), name: "Black", available: true, photos: [{ url: "https://test.invalid/image.jpg", alt: "TEST" }], variants: [{ id: smallId, size: "Small", price: 420, stock: onHand, stockVerified: verified, available: true }, { id: largeId, size: "Large", price: 450, stock: 7, stockVerified: true, available: true }] }] };
      let product = await live.saveLiveCatalogue({ expectedRevision: 0, document });
      product = await live.publishLiveCatalogue(product.id, product.revision, "audit@test.invalid");
      const sku = `MM-${smallId.replaceAll("-", "").toUpperCase()}`, largeSku = `MM-${largeId.replaceAll("-", "").toUpperCase()}`;
      return { product, sku, largeSku, smallId, largeId };
    }
    async function order(f: any, quantity = 1, extra: any[] = []) {
      const token = randomUUID();
      const result = await checkout.upsertCheckoutOrder({ checkoutToken: token, stage: "complete", fulfilmentMethod: "collection", customer: { firstName: "TEST", lastName: "Audit", email: `inventory-${randomUUID()}@test.invalid`, phone: "0821234567" }, items: [{ sku: f.sku, quantity }, ...extra] }, db);
      const row = (await pg.query<any>("select id,total,status,payment_status from orders where order_number=$1", [result.orderNumber])).rows[0];
      return { ...result, ...row, checkoutToken: token };
    }
    async function pay(o: any) { return payment.createPayFastCheckout({ orderNumber: o.orderNumber, checkoutToken: o.checkoutToken }, "https://test.invalid/api/payments/payfast/checkout"); }
    async function notify(o: any, status = "COMPLETE", transaction = `AUDIT-${o.id}`) {
      const params = new URLSearchParams({ merchant_id: configuration.merchantId, m_payment_id: o.orderNumber, pf_payment_id: transaction, payment_status: status, amount_gross: o.total });
      params.append("signature", signature.createPayFastNotificationSignature(params, configuration.passphrase));
      return notification.processPayFastNotification(new Request("https://test.invalid/notify", { method: "POST" }), params.toString());
    }
    const onHand = async (id: string) => (await pg.query<{ stock_on_hand: number }>("select stock_on_hand from product_variants where id=$1", [id])).rows[0].stock_on_hand;
    const current = async (id: string) => (await live.listLiveCatalogue()).find((p: any) => p.id === id);

    await t.test("a cart/order draft does not reserve or deduct stock; payment initiation reserves only", async () => {
      const f = await fixture(), o = await order(f, 2);
      assert.equal((await stock.resolveLiveCheckoutItem(f.sku)).stock, 5);
      assert.equal((await pg.query("select * from stock_reservations where order_id=$1", [o.id])).rows.length, 0);
      await pay(o);
      assert.equal(await onHand(f.smallId), 5);
      assert.equal((await stock.resolveLiveCheckoutItem(f.sku)).stock, 3);
      await pay(o);
      assert.equal((await pg.query("select * from stock_reservations where order_id=$1", [o.id])).rows.length, 1);
      assert.equal((await stock.resolveLiveCheckoutItem(f.sku)).stock, 3);
    });
    await t.test("only verified payment deducts, including both sizes, and duplicate/late callbacks deduct once", async () => {
      const f = await fixture(), o = await order(f, 2, [{ sku: f.largeSku, quantity: 3 }]); await pay(o);
      validationValid = false; await assert.rejects(notify(o), /rejected/); validationValid = true;
      assert.equal(await onHand(f.smallId), 5); assert.equal(await onHand(f.largeId), 7);
      await notify(o); await notify(o); await notify(o, "FAILED");
      assert.equal(await onHand(f.smallId), 3); assert.equal(await onHand(f.largeId), 4);
      const movement = (await pg.query<any>("select * from inventory_movements where order_id=$1 and type='order_allocated'", [o.id])).rows;
      assert.equal(movement.length, 2);
      assert.deepEqual(movement.map((m: any) => m.quantity).sort((a: number, b: number) => a - b), [-3, -2]);
      assert.equal((await stock.resolveLiveCheckoutItem(f.sku)).stock, 3, "Consumed reservations are not subtracted twice");
    });
    await t.test("two shoppers cannot reserve the same last unit; a rejected basket leaves no partial reservation", async () => {
      const f = await fixture(1), first = await order(f), second = await order(f);
      await pay(first); await assert.rejects(pay(second), /no longer available|not enough stock/);
      assert.equal(await onHand(f.smallId), 1);
      assert.equal((await stock.resolveLiveCheckoutItem(f.sku)).available, false);
      assert.equal((await pg.query("select * from stock_reservations where order_id=$1", [second.id])).rows.length, 0);
      assert.equal((await stock.resolveLiveCheckoutItem(f.largeSku)).available, true);
    });
    await t.test("duplicate cart lines are combined before stock limits are checked", async () => {
      const f = await fixture(2);
      await assert.rejects(order(f, 2, [{ sku: f.sku.toLowerCase(), quantity: 1 }]), /not available in this quantity/);
      const o = await order(f, 1, [{ sku: f.sku, quantity: 1 }]);
      const lines = (await pg.query<any>("select quantity from order_items where order_id=$1", [o.id])).rows;
      assert.equal(lines.length, 1); assert.equal(lines[0].quantity, 2);
    });
    await t.test("expired holds return to availability without changing physical stock", async () => {
      const f = await fixture(2), o = await order(f, 2); await pay(o);
      await pg.query("update stock_reservations set expires_at=now()-interval '1 minute' where order_id=$1", [o.id]);
      assert.equal((await stock.resolveLiveCheckoutItem(f.sku)).stock, 2);
      assert.equal(await onHand(f.smallId), 2);
    });
    await t.test("late paid confirmation after expiry flags shortage rather than creating negative stock", async () => {
      const f = await fixture(1), old = await order(f); await pay(old);
      await pg.query("update stock_reservations set expires_at=now()-interval '1 minute' where order_id=$1", [old.id]);
      const next = await order(f); await pay(next); await notify(next); await notify(old);
      assert.equal(await onHand(f.smallId), 0);
      const row = (await pg.query<{ inventory_issue: string }>("select inventory_issue from orders where id=$1", [old.id])).rows[0];
      assert.match(row.inventory_issue, /stock check after payment/);
    });
    await t.test("uncounted zero stock is intentionally unlimited until an actual count is confirmed", async () => {
      const f = await fixture(0, false), o = await order(f, 2); await pay(o); await notify(o);
      assert.equal((await stock.resolveLiveCheckoutItem(f.sku)).stock, null);
      assert.equal((await stock.resolveLiveCheckoutItem(f.sku)).available, true);
      assert.equal(await onHand(f.smallId), 0);
      assert.equal((await pg.query("select * from inventory_movements where order_id=$1", [o.id])).rows.length, 0);
    });
    await t.test("a stock update that fails halfway rolls back all sizes and publication state", async () => {
      const f = await fixture(), baseline = await current(f.product.id);
      const document = structuredClone(baseline.document); document.colours[0].variants[0].stock = 4; document.colours[0].variants[1].stock = 10;
      const saved = await live.saveLiveCatalogue({ id: baseline.id, expectedRevision: baseline.revision, stockVersion: baseline.stockVersion, document });
      await pg.exec("alter table product_variants add constraint audit_stock_limit check(stock_on_hand<10)");
      try { await assert.rejects(live.publishLiveCatalogue(saved.id, saved.revision, "audit@test.invalid")); }
      finally { await pg.exec("alter table product_variants drop constraint audit_stock_limit"); }
      assert.equal(await onHand(f.smallId), 5); assert.equal(await onHand(f.largeId), 7);
      const after = await current(saved.id); assert.equal(after.publicationState, "idle"); assert.equal(after.publishedRevision, baseline.publishedRevision);
    });
    await t.test("received resaleable returns restore only the original deduction and only once", async () => {
      const f = await fixture(), o = await order(f, 2); await pay(o); await notify(o);
      await pg.query("update orders set status='collected' where id=$1", [o.id]);
      const item = (await pg.query<any>("select id from order_items where order_id=$1", [o.id])).rows[0];
      const returnId = randomUUID();
      await aftersales.updateAftersales(o.orderNumber, { action: "approve_return", requestId: returnId, reason: "TEST return", items: [{ itemId: item.id, quantity: 2 }] }, "audit@test.invalid");
      assert.equal(await onHand(f.smallId), 3);
      const receipt = { action: "receive_return", returnId, inspected: true, restock: [{ itemId: item.id, quantity: 1 }] };
      await aftersales.updateAftersales(o.orderNumber, receipt, "audit@test.invalid"); await aftersales.updateAftersales(o.orderNumber, receipt, "audit@test.invalid");
      assert.equal(await onHand(f.smallId), 4);
      assert.equal((await pg.query("select * from inventory_movements where order_id=$1 and type='return'", [o.id])).rows.length, 1);
    });
    await t.test("audit observation: a browser cancellation keeps its hold until the 30-minute expiry", async () => {
      const f = await fixture(2), o = await order(f, 2), fields = await pay(o);
      await returnRoute.GET(new Request(fields.fields.cancel_url));
      assert.equal((await stock.resolveLiveCheckoutItem(f.sku)).stock, 0);
      assert.equal(await onHand(f.smallId), 2);
      assert.equal((await pg.query<{ payment_status: string }>("select payment_status from orders where id=$1", [o.id])).rows[0].payment_status, "failed");
    });
    await t.test("audit observation: cancelling a paid, unshipped order does not automatically restock it", async () => {
      const f = await fixture(), o = await order(f, 2); await pay(o); await notify(o);
      await admin.updateOrderStatus(o.orderNumber, "Cancelled");
      assert.equal(await onHand(f.smallId), 3);
      assert.equal((await pg.query<{ status: string }>("select status from orders where id=$1", [o.id])).rows[0].status, "cancelled");
    });
    await t.test("a stale inventory draft can be reloaded and saved after a customer purchase", async () => {
      const f = await fixture(), before = await current(f.product.id), document = structuredClone(before.document);
      document.colours[0].variants[1].available = false;
      const draft = await live.saveLiveCatalogue({ id: before.id, expectedRevision: before.revision, stockVersion: before.stockVersion, document });
      const o = await order(f); await pay(o); await notify(o);
      await assert.rejects(live.publishLiveCatalogue(draft.id, draft.revision, "audit@test.invalid"), /Stock changed/);
      const storedBefore = (await pg.query<any>("select document,metadata,revision,updated_at from catalogue_products where id=$1", [draft.id])).rows[0];
      const reloaded = await current(before.id);
      const dbRows = (await pg.query<any>("select id,stock_on_hand,stock_verified,updated_at from product_variants where id in ($1,$2)", [f.smallId, f.largeId])).rows;
      const expectedVersion = live.inventoryVersion(dbRows.map((r: any) => ({ id: r.id, stockOnHand: r.stock_on_hand, stockVerified: r.stock_verified, updatedAt: r.updated_at })));
      assert.equal(reloaded.stockVersion, expectedVersion, "Reload must supply the current version so the draft is not permanently blocked");
      assert.equal(reloaded.document.colours[0].variants[0].stock, 4, "Latest purchase is reflected without losing the availability edit");
      assert.equal(reloaded.document.colours[0].variants[1].available, false);
      assert.equal(reloaded.stockReviewRequired, false);
      assert.deepEqual((await pg.query<any>("select document,metadata,revision,updated_at from catalogue_products where id=$1", [draft.id])).rows[0], storedBefore, "Reload itself does not persist any edits");
      const saved = await live.saveLiveCatalogue({ id: reloaded.id, expectedRevision: reloaded.revision, stockVersion: reloaded.stockVersion, document: reloaded.document });
      await live.publishLiveCatalogue(saved.id, saved.revision, "audit@test.invalid");
      assert.equal(await onHand(f.smallId), 4, "Recovering a draft cannot replenish the purchased unit");
      assert.equal((await stock.resolveLiveCheckoutItem(f.largeSku)).available, false);
    });
    await t.test("conflicting count edits require review on the server, and another purchase invalidates that review", async () => {
      const f = await fixture(), before = await current(f.product.id), document = structuredClone(before.document);
      document.colours[0].variants[0].stock = 8;
      await live.saveLiveCatalogue({ id: before.id, expectedRevision: before.revision, stockVersion: before.stockVersion, document });
      const o = await order(f); await pay(o); await notify(o);
      let reloaded = await current(before.id);
      assert.equal(reloaded.stockReviewRequired, true); assert.equal(reloaded.stockConflicts[0].currentStock, 4);
      assert.equal(reloaded.document.colours[0].variants[0].stock, 8);
      const input = { id: reloaded.id, expectedRevision: reloaded.revision, stockVersion: reloaded.stockVersion, document: reloaded.document };
      await assert.rejects(live.saveLiveCatalogue(input), /confirm your physical stock/);
      const next = await order(f); await pay(next); await notify(next);
      await assert.rejects(live.saveLiveCatalogue({ ...input, stockReviewConfirmed: true }), /Stock changed while/);
      reloaded = await current(before.id);
      assert.equal(reloaded.stockConflicts[0].currentStock, 3);
      // The owner reviews the actual count and keeps it, retaining other edits.
      reloaded.document.colours[0].variants[0].stock = 3;
      const saved = await live.saveLiveCatalogue({ id: reloaded.id, expectedRevision: reloaded.revision, stockVersion: reloaded.stockVersion, document: reloaded.document, stockReviewConfirmed: true });
      await live.publishLiveCatalogue(saved.id, saved.revision, "audit@test.invalid");
      assert.equal(await onHand(f.smallId), 3);
      assert.equal((await pg.query("select * from inventory_movements where variant_id=$1 and type='order_allocated'", [f.smallId])).rows.length, 2);
    });
    await t.test("legacy saved drafts never guess which old quantities the owner intended to change", async () => {
      const f = await fixture(), before = await current(f.product.id), document = structuredClone(before.document);
      document.colours[0].variants[1].available = false;
      const draft = await live.saveLiveCatalogue({ id: before.id, expectedRevision: before.revision, stockVersion: before.stockVersion, document });
      await pg.query("update catalogue_products set metadata=metadata-'stockBaseline' where id=$1", [draft.id]);
      const o = await order(f); await pay(o); await notify(o);
      const reloaded = await current(before.id);
      assert.equal(reloaded.stockReviewRequired, true);
      assert.deepEqual([reloaded.stockConflicts[0].draftStock, reloaded.stockConflicts[0].currentStock], [5, 4]);
      assert.equal(reloaded.document.colours[0].variants[0].stock, 4);
      assert.equal(reloaded.document.colours[0].variants[1].available, false);
      const saved = await live.saveLiveCatalogue({ id: reloaded.id, expectedRevision: reloaded.revision, stockVersion: reloaded.stockVersion, document: reloaded.document, stockReviewConfirmed: true });
      await live.publishLiveCatalogue(saved.id, saved.revision, "audit@test.invalid");
      assert.equal(await onHand(f.smallId), 4);
    });
    await t.test("the admin API validates and enforces stock review before saving a recovered draft", async () => {
      const f = await fixture(), before = await current(f.product.id), document = structuredClone(before.document);
      document.colours[0].variants[0].stock = 8;
      await live.saveLiveCatalogue({ id: before.id, expectedRevision: before.revision, stockVersion: before.stockVersion, document });
      const o = await order(f); await pay(o); await notify(o);
      const reloaded = await current(before.id), route = load("app/api/admin/product-catalogue/route.ts");
      const body = { id: reloaded.id, expectedRevision: reloaded.revision, stockVersion: reloaded.stockVersion, document: reloaded.document };
      const request = (values: any) => route.POST(new Request("https://test.invalid/api/admin/product-catalogue", { method: "POST", headers: { Origin: "https://test.invalid", "Content-Type": "application/json" }, body: JSON.stringify(values) }));
      assert.equal((await request(body)).status, 409);
      assert.equal((await request({ ...body, stockReviewConfirmed: "true" })).status, 400);
      const confirmed = await request({ ...body, stockReviewConfirmed: true });
      assert.equal(confirmed.status, 200);
      assert.equal((await confirmed.json()).published, false);
      assert.equal(await onHand(f.smallId), 4, "Confirming a draft is not a live stock change");
    });
    assert.ok(callbacks > 0, "Verified payment path exercised its outbox boundary without contacting Bob Go");
  } finally { await pg.close(); }
});
