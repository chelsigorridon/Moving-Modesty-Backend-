/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated PostgreSQL and provider doubles; no live credentials or network. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

test("Bob Go sync outbox is isolated, reconciles uncertain creates and never changes payment or stock", async t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), require = createRequire(import.meta.url);
  const postgres = new PGlite(), db = require("drizzle-orm/pglite").drizzle(postgres), cache = new Map<string, any>();
  const remote = new Map<string, any>(), calls: Array<{ action: string; value: any }> = [];
  const remoteShipments = new Map<string, any>();
  let mode = "success", clock = Date.now() + 60000, afterLookup: undefined | (() => Promise<void>), remoteShipment: any;
  function load(file: string): any {
    const path = resolve(root, file);
    if (/lib[\\/]db(?:[\\/]index)?\.ts$/.test(path)) return { db, requireDatabase: () => db };
    if (cache.has(path)) return cache.get(path);
    const loaded = { exports: {} }; cache.set(path, loaded.exports);
    const compiled = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("require", "module", "exports", compiled)((name: string) => {
      if (name === "server-only") return {};
      if (name.startsWith("@/")) return load(name.slice(2) + ".ts");
      if (name.startsWith(".")) return load(resolve(dirname(path), name) + (name.endsWith(".ts") ? "" : ".ts"));
      return require(name);
    }, loaded, loaded.exports);
    return loaded.exports;
  }
  try {
    const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
    for (const migration of journal.entries) for (const sql of readFileSync(resolve(root, `drizzle/${migration.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (sql.trim()) await postgres.exec(sql);
    const schema = load("lib/db/schema.ts"), sync = load("lib/integrations/bobgo/order-sync.ts");
    const config = { enabled: true, environment: "sandbox", channelRef: "TEST-CHANNEL-ONLY" };
    const provider = {
      async findOrders(number: string) {
        calls.push({ action: "lookup", value: number });
        const change = afterLookup; afterLookup = undefined; await change?.();
        if (mode === "lookup-outage") throw new Error("SECRET TEST ERROR WITH CUSTOMER DETAILS");
        const found = remote.get(number);
        return found ? mode === "duplicate" ? [found, { ...found, id: found.id + 1 }] : [found] : [];
      },
      async createOrder(payload: any) {
        calls.push({ action: "create", value: payload });
        const job = (await postgres.query<Record<string, any>>("select * from bobgo_order_sync where request_snapshot->>'channel_order_number'=$1", [payload.channel_order_number])).rows[0];
        assert.ok(job.submitted_at && job.lease_token, "Unknown-outcome guard must be committed before create");
        const result = { ...structuredClone(payload), id: 10000 + remote.size };
        if (mode !== "timeout-empty") remote.set(payload.channel_order_number, result);
        if (mode.startsWith("timeout")) throw new Error("TEST-only provider timeout");
        return result;
      },
      async readShipment(id: string) { calls.push({ action: "tracking", value: id }); return remoteShipments.get(id) || remoteShipment; },
    };
    const service = sync.createBobGoOrderSyncService(db, provider, config, () => clock);
    async function seed(number: string, changes: Record<string, any> = {}) {
      const id = randomUUID(), customerId = randomUUID(), addressId = randomUUID(), productId = randomUUID(), variantId = randomUUID();
      await db.insert(schema.customers).values({ id: customerId, email: `${id}@example.invalid`, firstName: "TEST", lastName: "Customer", phone: "0821234567" });
      await db.insert(schema.addresses).values({ id: addressId, customerId, recipientName: "TEST Customer", line1: "10 Example Street", suburb: "Example", city: "Cape Town", province: "Western Cape", postalCode: "7800" });
      await db.insert(schema.products).values({ id: productId, name: "TEST Product", slug: id, category: "TEST" });
      await db.insert(schema.productVariants).values({ id: variantId, productId, sku: id, size: "Small", colour: "Black", price: "450", stockOnHand: 9, shippingWeightGrams: 120 });
      await db.insert(schema.orders).values({ id, orderNumber: number, customerId, deliveryAddressId: addressId, status: "ready", paymentStatus: "paid", deliveryMethod: "courier", subtotal: "450", total: "549", deliveryFee: "99", ...changes });
      await db.insert(schema.orderItems).values({ orderId: id, variantId, productName: "TEST Product", variantName: "Black Small", sku: id, quantity: 1, unitPrice: "450", lineTotal: "450" });
      await db.insert(schema.payments).values({ orderId: id, provider: "payfast-sandbox", merchantPaymentId: number, providerPaymentId: id, status: "paid", amount: "549", verifiedAt: new Date(clock) });
      return { id, variantId, addressId };
    }
    const job = async (id: string) => (await postgres.query<Record<string, any>>("select * from bobgo_order_sync where order_id=$1", [id])).rows[0];
    const createCount = () => calls.filter(call => call.action === "create").length;

    await t.test("disabled enqueue and worker access neither database nor provider", async () => {
      const disabled = sync.createBobGoOrderSyncService(new Proxy({}, { get() { throw new Error("No database access permitted"); } }), provider, { ...config, enabled: false });
      const before = calls.length;
      assert.equal((await disabled.sync(randomUUID())).status, "disabled");
      assert.equal((await disabled.refreshTracking(randomUUID())).status, "disabled");
      assert.equal((await sync.enqueuePaidBobGoOrder(null, randomUUID())).reason, "disabled");
      assert.equal(calls.length, before);
    });
    await t.test("repeated verified-payment enqueue makes one durable job and creates one matching Bob Go order", async () => {
      const { id } = await seed("MM-SYNC-SUCCESS");
      for (let i = 0; i < 3; i++) await db.transaction((tx: any) => sync.enqueuePaidBobGoOrder(tx, id, config));
      assert.equal((await postgres.query<{ count: number }>("select count(*) from bobgo_order_sync where order_id=$1", [id])).rows[0].count, 1);
      const count = createCount();
      assert.equal((await service.sync(id)).status, "synced");
      assert.equal((await service.sync(id)).status, "synced");
      assert.equal(createCount(), count + 1);
      assert.equal((await job(id)).status, "synced");
    });
    await t.test("lookup outage is retryable, without losing the paid order or exposing the raw error", async () => {
      const { id } = await seed("MM-SYNC-OUTAGE"), count = createCount(); mode = "lookup-outage";
      assert.equal((await service.sync(id)).status, "retry");
      assert.equal(createCount(), count);
      assert.equal((await job(id)).last_error_code, "lookup_failed");
      assert.doesNotMatch(JSON.stringify(await job(id)), /SECRET TEST ERROR/);
      assert.equal((await service.sync(id)).status, "waiting");
      clock += 61000; mode = "success";
      assert.equal((await service.sync(id)).status, "synced");
    });
    await t.test("an uncertain create is found on retry rather than submitted twice", async () => {
      const { id } = await seed("MM-SYNC-TIMEOUT"), count = createCount(); mode = "timeout-found";
      assert.equal((await service.sync(id)).status, "checking"); clock += 61000; mode = "success";
      assert.equal((await service.sync(id)).status, "synced");
      assert.equal(createCount(), count + 1);
      const second = await seed("MM-SYNC-UNKNOWN"); mode = "timeout-empty";
      assert.equal((await service.sync(second.id)).status, "checking"); clock += 61000; mode = "success";
      assert.equal((await service.sync(second.id)).status, "checking");
      assert.equal(calls.filter(call => call.action === "create" && call.value.channel_order_number === "MM-SYNC-UNKNOWN").length, 1);
    });
    await t.test("active leases prevent competing workers; expired unknown submissions remain reconciliation-only", async () => {
      const { id } = await seed("MM-SYNC-LEASE"); await db.transaction((tx: any) => sync.enqueuePaidBobGoOrder(tx, id, config));
      await postgres.query("update bobgo_order_sync set lease_token=$1, lease_expires_at=$2, submitted_at=$3 where order_id=$4", [randomUUID(), new Date(clock + 120000), new Date(clock), id]);
      const count = calls.length;
      assert.equal((await service.sync(id)).status, "busy"); assert.equal(calls.length, count);
      clock += 121000;
      assert.equal((await service.sync(id)).status, "checking");
      assert.equal(calls.filter(call => call.action === "create" && call.value.channel_order_number === "MM-SYNC-LEASE").length, 0);
    });
    await t.test("missing measured weights and ineligible orders do not call the provider; discounts retain the paid value", async () => {
      const missing = await seed("MM-SYNC-WEIGHT"); await postgres.query("update product_variants set shipping_weight_grams=null where id=$1", [missing.variantId]);
      const discounted = await seed("MM-SYNC-DISCOUNT", { discountAmount: "10", total: "539" });
      await postgres.query("update payments set amount=539 where order_id=$1", [discounted.id]);
      assert.equal((await service.sync(discounted.id)).status, "synced");
      assert.equal(remote.get("MM-SYNC-DISCOUNT").order_items[0].unit_price, 440);
      const count = calls.length;
      assert.equal((await service.sync(missing.id)).status, "needs_attention");
      assert.equal((await job(missing.id)).last_error_code, "weights_missing");
      for (const [index, change] of [{ paymentStatus: "pending" }, { archivedAt: new Date() }, { deliveryMethod: "collection" }, { status: "cancelled" }].entries()) {
        const { id } = await seed(`MM-SYNC-INELIGIBLE-${index}`, change);
        assert.equal((await service.sync(id)).status, "ineligible"); assert.equal(await job(id), undefined);
      }
      const live = await seed("MM-SYNC-WRONG-ENV"); await postgres.query("update payments set provider='payfast-production' where order_id=$1", [live.id]);
      assert.equal((await service.sync(live.id)).status, "ineligible");
      assert.equal(calls.length, count);
    });
    await t.test("edits during lookup or after syncing cannot silently send stale delivery details", async () => {
      const { id, addressId } = await seed("MM-SYNC-EDIT-RACE"), count = createCount();
      afterLookup = async () => { await postgres.query("update addresses set line_1='20 Changed Road' where id=$1", [addressId]); };
      assert.equal((await service.sync(id)).status, "needs_attention"); assert.equal(createCount(), count);
      assert.equal((await job(id)).last_error_code, "delivery_changed");
      const done = await seed("MM-SYNC-EDIT-AFTER"); assert.equal((await service.sync(done.id)).status, "synced");
      await postgres.query("update addresses set line_1='20 Changed Road' where id=$1", [done.addressId]);
      const before = calls.length;
      assert.equal((await service.sync(done.id)).status, "needs_attention"); assert.equal(calls.length, before);
    });
    await t.test("wrong or duplicate remote records are never adopted or followed by another create", async () => {
      for (const duplicate of [false, true]) {
        const number = duplicate ? "MM-SYNC-DUPLICATE" : "MM-SYNC-MISMATCH", { id } = await seed(number);
        mode = "timeout-found"; await service.sync(id); clock += 61000;
        if (!duplicate) remote.set(number, { ...remote.get(number), customer_email: "wrong@example.invalid" });
        mode = duplicate ? "duplicate" : "success";
        const count = createCount();
        assert.equal((await service.sync(id)).status, "needs_attention"); assert.equal(createCount(), count);
        assert.equal((await job(id)).last_error_code, duplicate ? "duplicate_remote" : "remote_mismatch");
      }
      mode = "success";
    });
    await t.test("already-booked orders are not newly mirrored; a booking during lookup stops a create", async () => {
      const booked = await seed("MM-SYNC-ALREADY-BOOKED");
      await db.insert(schema.shipments).values({ orderId: booked.id, status: "booked", providerShipmentId: "TEST-BOOKED" });
      assert.equal((await service.sync(booked.id)).status, "ineligible"); assert.equal(await job(booked.id), undefined);
      const pending = await seed("MM-SYNC-BOOK-RACE"), count = createCount();
      afterLookup = async () => { await db.insert(schema.shipments).values({ orderId: pending.id, status: "booking" }); };
      assert.equal((await service.sync(pending.id)).status, "needs_attention");
      assert.equal((await job(pending.id)).last_error_code, "shipment_exists"); assert.equal(createCount(), count);
    });
    await t.test("tracking reads only matching account-bound shipments and cannot regress delivered status", async () => {
      const { id } = await seed("MM-SYNC-TRACKING");
      await db.insert(schema.shipments).values({ orderId: id, provider: "bobgo-sandbox", status: "booked", providerShipmentId: "8000", trackingNumber: "TEST-TRACKING" });
      const before = (await postgres.query<Record<string, any>>("select * from orders where id=$1", [id])).rows[0];
      remoteShipment = { id: 8000, tracking_reference: "OTHER-TRACKING", status: "delivered", tracking_last_event_time: new Date(clock).toISOString() };
      assert.equal((await service.refreshTracking(id)).status, "needs_attention");
      remoteShipment.tracking_reference = "TEST-TRACKING";
      assert.equal((await service.refreshTracking(id)).status, "updated");
      remoteShipment.status = "in-transit"; remoteShipment.tracking_last_event_time = new Date(clock + 1000).toISOString();
      assert.equal((await service.refreshTracking(id)).status, "unchanged");
      const shipment = (await postgres.query<Record<string, any>>("select * from shipments where order_id=$1", [id])).rows[0];
      assert.equal(shipment.courier_status, "delivered");
      assert.deepEqual((await postgres.query<Record<string, any>>("select * from orders where id=$1", [id])).rows[0], before);
      assert.equal((await postgres.query<{ count: number }>("select count(*) from inventory_movements")).rows[0].count, 0);
      assert.equal((await postgres.query<{ count: number }>("select count(*) from email_events")).rows[0].count, 0);
      assert.equal((await postgres.query<{ count: number }>("select count(*) from payments where status <> 'paid'")).rows[0].count, 0);
    });
    await t.test("support retries preserve the unknown-submission guard and cannot create a second copy", async () => {
      const { id } = await seed("MM-SYNC-SUPPORT-RETRY"); mode = "timeout-empty";
      await service.sync(id); const first = await job(id), count = createCount();
      await postgres.query("update bobgo_order_sync set attempts=8, status='needs_attention' where order_id=$1", [id]);
      assert.equal((await service.retry(id)).status, "queued");
      assert.equal((await job(id)).submitted_at.toISOString(), first.submitted_at.toISOString());
      mode = "success";
      assert.equal((await service.sync(id)).status, "checking"); assert.equal(createCount(), count);
    });
    await t.test("the bounded runner processes only due channel jobs and known shipments, not historical paid orders", async () => {
      await postgres.query("update bobgo_order_sync set status='needs_attention'");
      const queued = await seed("MM-SYNC-RUNNER-QUEUED"), historical = await seed("MM-SYNC-RUNNER-HISTORY");
      await db.transaction((tx: any) => sync.enqueuePaidBobGoOrder(tx, queued.id, config));
      const before = createCount(); const reports: any[] = [];
      const { createBobGoSyncRunner } = load("lib/integrations/bobgo/order-sync-runner.ts");
      const run = createBobGoSyncRunner(db, provider, config, async (...args: any[]) => { reports.push(args); }, () => clock);
      const result = await run();
      assert.equal(result.ordersChecked, 1); assert.equal(createCount(), before + 1);
      assert.equal(await job(historical.id), undefined); assert.equal(remote.has("MM-SYNC-RUNNER-HISTORY"), false);
      assert.equal((await run()).ordersChecked, 0); assert.equal(reports[0][2], false);
      const disabled = createBobGoSyncRunner(new Proxy({}, { get() { throw new Error("No database allowed"); } }), provider, { ...config, enabled: false });
      assert.equal((await disabled()).enabled, false);
    });
    await t.test("tracking polling is bounded and fair, ignores completed shipments and does not alter fulfilment", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { id } = await seed(`MM-SYNC-POLL-${i}`); ids.push(id);
        await db.insert(schema.shipments).values({ orderId: id, provider: "bobgo-sandbox", status: "booked", providerShipmentId: String(9100 + i), trackingNumber: `TEST-POLL-${i}` });
        remoteShipments.set(String(9100 + i), { id: 9100 + i, tracking_reference: `TEST-POLL-${i}`, status: "in-transit", tracking_last_event_time: new Date(clock).toISOString() });
      }
      const { createBobGoSyncRunner } = load("lib/integrations/bobgo/order-sync-runner.ts"), run = createBobGoSyncRunner(db, provider, config, async () => {}, () => clock);
      assert.equal((await run()).shipmentsChecked, 2); assert.equal((await run()).shipmentsChecked, 1); assert.equal((await run()).shipmentsChecked, 0);
      for (const id of ids) assert.equal((await postgres.query<any>("select status from orders where id=$1", [id])).rows[0].status, "ready");
    });
    await t.test("verified weight configuration is audited, optimistic and independent of stock, payments and sync activation", async () => {
      const first = await seed("MM-SYNC-WEIGHTS-FIRST"), second = await seed("MM-SYNC-WEIGHTS-SECOND"), count = calls.length;
      const weights = load("lib/shipping-weights.ts");
      assert.ok((await weights.getShippingWeights()).some((row: any) => row.id === first.variantId && row.grams === 120));
      const result = await weights.saveShippingWeights({ confirmed: true, changes: [{ id: first.variantId, expectedGrams: 120, grams: 135 }] }, "owner@example.invalid");
      assert.equal(result.saved, true); assert.equal(result.weights.find((row: any) => row.id === first.variantId).grams, 135);
      const history = (await postgres.query<any>("select * from shipping_weight_history where variant_id=$1", [first.variantId])).rows;
      assert.equal(history.length, 1); assert.equal(history[0].previous_grams, 120); assert.equal(history[0].grams, 135);
      await assert.rejects(weights.saveShippingWeights({ confirmed: true, changes: [{ id: first.variantId, expectedGrams: 120, grams: 140 }, { id: second.variantId, expectedGrams: 120, grams: 140 }] }, "owner@example.invalid"));
      assert.equal((await postgres.query<any>("select shipping_weight_grams, stock_on_hand from product_variants where id=$1", [second.variantId])).rows[0].shipping_weight_grams, 120);
      assert.equal((await postgres.query<any>("select stock_on_hand from product_variants where id=$1", [first.variantId])).rows[0].stock_on_hand, 9);
      await assert.rejects(weights.saveShippingWeights({ confirmed: false, changes: [{ id: first.variantId, expectedGrams: 135, grams: 140 }] }, "owner@example.invalid"));
      assert.equal(await job(first.id), undefined); assert.equal(calls.length, count);
    });
  } finally { await postgres.close(); }
});
