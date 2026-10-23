/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated PostgreSQL and provider fixtures; no live services. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
import { deliveryEvent, readDeliveryBody, verifyDeliverySignature } from "../lib/integrations/bobgo/webhook-policy.ts";
import { verifiedShipment, shipmentList } from "../lib/integrations/bobgo/tracking-policy.ts";
import { contactName, rateRequestId } from "../lib/integrations/bobgo/protocol.ts";

test("direct bookings keep quote identity and first/surname contact fields", () => {
  assert.equal(rateRequestId({ id: 123 }), 123);
  for (const id of [undefined, null, "123", 0, -1, NaN, 1.2, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => rateRequestId({ id }));
  assert.deepEqual(contactName("  Zarina   Sonday "), { name: "Zarina", surname: "Sonday" });
  assert.deepEqual(contactName("Zarina"), { name: "Zarina", surname: "" });
});
test("webhook signatures use the exact raw bytes and literal secret, and exclude sales-channel events", () => {
  const secret = "1234abcdef-literal-secret-not-a-live-key", raw = Buffer.from('{"id":321,"tracking_reference":"TEST-WAYBILL"}');
  const signature = createHmac("sha256", secret).update(raw).digest("base64");
  assert.equal(verifyDeliverySignature(raw, signature, secret), true);
  for (const supplied of [null, "", "bad", signature.slice(1), signature.replace(/^./, signature[0] === "a" ? "b" : "a")]) assert.equal(verifyDeliverySignature(raw, supplied, secret), false);
  assert.equal(verifyDeliverySignature(Buffer.concat([raw, Buffer.from(" ")]), signature, secret), false);
  const event = deliveryEvent(raw, "shipment_submission_status/updated", "production")!;
  assert.equal(event.remoteId, "321"); assert.equal(event.tracking, "TEST-WAYBILL");
  assert.equal(event.id, deliveryEvent(raw, event.topic, "production")!.id);
  assert.notEqual(event.id, deliveryEvent(raw, event.topic, "sandbox")!.id);
  assert.equal(deliveryEvent(raw, "order/updated", "production"), null);
  assert.equal(deliveryEvent(raw, "fulfillment/created", "production"), null);
  assert.throws(() => deliveryEvent(Buffer.from("{}"), "tracking/updated", "production"));
});
test("webhook bodies have a streamed byte limit, including requests without content-length", async () => {
  assert.deepEqual(await readDeliveryBody(new Request("https://example.invalid", { method: "POST", body: "{}" })), Buffer.from("{}"));
  await assert.rejects(readDeliveryBody(new Request("https://example.invalid", { method: "POST", body: "x".repeat(262145) })), RangeError);
});
test("shipment read-back fails closed on mismatches, unknown envelopes and invalid states", () => {
  const now = Date.now(), local = { providerShipmentId: "321", trackingNumber: "TEST-WAYBILL", waybillReference: "TEST-WAYBILL", serviceLevelCode: "ECO", bookingSnapshot: null };
  const remote = { id: 321, tracking_reference: "TEST-WAYBILL", service_level_code: "ECO", submission_status: "success", status: "awaiting-dropoff", time_modified: new Date(now).toISOString(), charged_amount: 109.93 };
  assert.equal(verifiedShipment(remote, local, "MM-TEST", now).booked, true);
  for (const change of [{ id: 999 }, { tracking_reference: "WRONG" }, { service_level_code: "OVN" }, { submission_status: "unknown" }, { status: "unknown" }, { charged_amount: "NaN" }, { time_modified: new Date(now + 600000).toISOString() }]) assert.throws(() => verifiedShipment({ ...remote, ...change }, local, "MM-TEST", now));
  assert.throws(() => shipmentList({ data: [remote] }));
  assert.throws(() => verifiedShipment({ ...remote, custom_tracking_reference: "attempt", meta: { custom_order_number: "WRONG" } }, { ...local, providerShipmentId: null, trackingNumber: null, waybillReference: "attempt" }, "MM-TEST", now));
});

test("delivery webhook route rejects forged requests before database access and acknowledges durable work before running it", async () => {
  const require = createRequire(import.meta.url), secret = "test-only-webhook-signing-secret", raw = '{"id":321,"tracking_reference":"TEST-WAYBILL"}';
  let enabled = false, enqueues = 0, drains = 0, fail = false;
  const callbacks: Array<() => Promise<void>> = [];
  const mod = { exports: {} as any };
  const compiled = ts.transpileModule(readFileSync(new URL("../app/api/webhooks/bobgo/route.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", compiled)((name: string) => {
    if (name === "next/server") return { after: (callback: () => Promise<void>) => callbacks.push(callback) };
    if (name.endsWith("/delivery-runtime")) return { deliveryUpdatesConfiguration: () => enabled ? { environment: "production", secret } : null,
      configuredDeliveryQueue: () => ({ enqueue: async () => { enqueues++; if (fail) throw new Error("PRIVATE TOKEN"); return { queued: true }; } }),
      runDeliveryUpdates: async () => { drains++; } };
    if (name.endsWith("/webhook-policy")) return { deliveryEvent, readDeliveryBody, verifyDeliverySignature };
    if (name.endsWith("/monitoring")) return { reportFailure: async () => ({ reference: "TEST-REF" }) };
    return require(name);
  }, mod, mod.exports);
  const request = (body = raw, topic = "shipment_submission_status/updated", signature?: string) => new Request("https://example.invalid/api/webhooks/bobgo", {
    method: "POST", headers: { "content-type": "application/json", "x-bobgroup-type": "webhook", "x-bobgroup-topic": topic,
      "bobgo-webhook-signature": signature ?? createHmac("sha256", secret).update(body).digest("base64") }, body,
  });
  assert.equal((await mod.exports.POST(request())).status, 503); assert.equal(enqueues, 0);
  enabled = true;
  assert.equal((await mod.exports.POST(request(raw, undefined, "forged"))).status, 401); assert.equal(enqueues, 0);
  assert.equal((await mod.exports.POST(request("not json"))).status, 400); assert.equal(enqueues, 0);
  assert.equal((await mod.exports.POST(request(raw, "order/updated"))).status, 200); assert.equal(enqueues, 0);
  assert.equal((await mod.exports.POST(request())).status, 200); assert.equal(enqueues, 1); assert.equal(drains, 0);
  await callbacks[0](); assert.equal(drains, 1);
  fail = true;
  const error = await mod.exports.POST(request()); assert.equal(error.status, 503); assert.doesNotMatch(await error.text(), /PRIVATE|TOKEN/);
});

test("delivery updates are separately gated, require protected recovery access, and never activate order sync", async () => {
  const require = createRequire(import.meta.url), mod = { exports: {} as any };
  const compiled = ts.transpileModule(readFileSync(new URL("../lib/integrations/bobgo/delivery-runtime.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", compiled)((name: string) => {
    if (name === "server-only") return {};
    if (name === "./configuration") return { getBobGoConfiguration: () => ({ enabled: true, apiTokenConfigured: true, environment: "production" }) };
    if (name === "../../db") return { requireDatabase: () => { throw new Error("Disabled gate must never access the database"); } };
    if (name === "../../db/schema") return {};
    if (name === "../../monitoring") return { reportFailure: async () => ({}), resolveFailures: async () => {} };
    if (["./client", "./tracking", "./delivery-events"].includes(name)) return {};
    return require(name);
  }, mod, mod.exports);
  const keys = ["BOBGO_DELIVERY_UPDATES_ENABLED", "BOBGO_WEBHOOK_SECRET", "VERCEL_ENV"], before = keys.map(key => process.env[key]);
  try {
    process.env.BOBGO_DELIVERY_UPDATES_ENABLED = "false";
    process.env.BOBGO_WEBHOOK_SECRET = "test-only-not-a-live-secret";
    process.env.VERCEL_ENV = "production";
    assert.equal(mod.exports.deliveryUpdatesConfiguration(), null);
    assert.deepEqual(await mod.exports.runDeliveryUpdates(true), { enabled: false, processed: 0, failed: 0 });
    const secret = "x".repeat(40), request = (value?: string) => new Request("https://example.invalid", { headers: value ? { authorization: value } : {} });
    assert.equal(mod.exports.deliveryRunnerAuthorized(request(), secret), false);
    assert.equal(mod.exports.deliveryRunnerAuthorized(request(`Bearer ${secret}`), secret), true);
    assert.equal(mod.exports.deliveryRunnerAuthorized(request(`Bearer ${secret}`), "short"), false);
    process.env.BOBGO_DELIVERY_UPDATES_ENABLED = "true";
    assert.equal(mod.exports.deliveryUpdatesConfiguration().environment, "production");
    process.env.VERCEL_ENV = "preview";
    assert.throws(() => mod.exports.deliveryUpdatesConfiguration());
    assert.match(readFileSync(new URL("../lib/integrations/bobgo/order-sync-policy.ts", import.meta.url), "utf8"), /newOrderConfiguration\("BOBGO_ORDER_SYNC_ENABLED"\)/);
  } finally { keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; }); }
});

test("direct tracking and its durable notification queue work with order sync off and never book or alter payments", async t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), require = createRequire(import.meta.url), postgres = new PGlite();
  const database = require("drizzle-orm/pglite").drizzle(postgres), cache = new Map<string, any>();
  function load(file: string): any {
    const absolute = resolve(root, file);
    if (/lib[\\/]db(?:[\\/]index)?\.ts$/.test(absolute)) return { requireDatabase: () => database };
    if (cache.has(absolute)) return cache.get(absolute);
    const mod = { exports: {} as any }; cache.set(absolute, mod.exports);
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("require", "module", "exports", compiled)((name: string) => {
      if (name === "server-only") return {};
      if (name.startsWith(".")) return load(resolve(dirname(absolute), name) + (name.endsWith(".ts") ? "" : ".ts"));
      return require(name);
    }, mod, mod.exports);
    return mod.exports;
  }
  try {
    const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
    for (const migration of journal.entries) for (const sql of readFileSync(resolve(root, `drizzle/${migration.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (sql.trim()) await postgres.exec(sql);
    const schema = load("lib/db/schema.ts"), tracking = load("lib/integrations/bobgo/tracking.ts"), events = load("lib/integrations/bobgo/delivery-events.ts");
    assert.equal(load("lib/integrations/bobgo/order-sync-policy.ts").getOrderSyncConfiguration().enabled, false);
    const customerId = randomUUID(), orderId = randomUUID(), shipmentId = randomUUID();
    await database.insert(schema.customers).values({ id: customerId, email: "test@example.invalid", firstName: "TEST", lastName: "Buyer", phone: "0821234567" });
    await database.insert(schema.orders).values({ id: orderId, orderNumber: "MM-DIRECT-TEST", checkoutToken: randomUUID(), customerId, status: "ready", paymentStatus: "paid", deliveryMethod: "courier", subtotal: "450", total: "549", deliveryFee: "99" });
    await database.insert(schema.payments).values({ orderId, provider: "payfast-production", merchantPaymentId: "MM-DIRECT-TEST", providerPaymentId: "TEST-PAYMENT", status: "paid", amount: "549", verifiedAt: new Date() });
    await database.insert(schema.shipments).values({ id: shipmentId, orderId, provider: "bobgo-production", status: "booking", providerShipmentId: "321", waybillReference: "MMATTEMPT", serviceLevelCode: "ECO" });
    let now = Date.now(), fail = false, response: any;
    const calls: string[] = [];
    let remote: any = { id: 321, provider_slug: "tcg", service_level_code: "ECO", tracking_reference: "TEST-WAYBILL", custom_tracking_reference: "MMATTEMPT",
      meta: { custom_order_number: "MM-DIRECT-TEST" }, submission_status: "success", status: "pending-collection", charged_amount: 109.93, time_modified: new Date(now).toISOString() };
    const service = tracking.createDirectShipmentTracking(database, "production", async (path: string) => {
      assert.match(path, /^\/shipments\?/); calls.push(path);
      if (fail) throw new Error("PRIVATE PROVIDER ERROR AND SECRET");
      return response || { shipments: [remote], count: 1 };
    }, () => now);
    const queue = events.createDeliveryEventQueue(database, "production", service.refresh, () => now);
    const event = (topic = "shipment_submission_status/updated") => deliveryEvent(Buffer.from(JSON.stringify(remote)), topic, "production")!;
    await t.test("notifications are deduplicated, durably stored without PII, and unknown shipments ignored", async () => {
      assert.equal((await queue.enqueue(event())).queued, true);
      assert.equal((await queue.enqueue(event())).duplicate, true);
      const unknown = { ...event(), id: "unknown", remoteId: "999" };
      assert.equal((await queue.enqueue(unknown)).ignored, true);
      const row = (await postgres.query<any>("select * from bobgo_delivery_events")).rows[0];
      assert.equal(row.status, "queued"); assert.doesNotMatch(JSON.stringify(row), /customer|email|phone|address|SECRET|charged_amount/);
    });
    await t.test("a known pending shipment becomes booked using GET read-back, not webhook status", async () => {
      assert.deepEqual(await queue.drain(), { processed: 1, failed: 0 });
      const row = (await postgres.query<any>("select * from shipments where id=$1", [shipmentId])).rows[0];
      assert.equal(row.status, "booked"); assert.equal(row.courier_status, "pending-collection"); assert.equal(row.courier_charged_amount, "109.93");
      assert.equal(row.tracking_number, "TEST-WAYBILL"); assert.equal(calls.length, 1);
      assert.deepEqual(await queue.drain(), { processed: 0, failed: 0 });
      const order = (await postgres.query<any>("select * from orders where id=$1", [orderId])).rows[0];
      assert.equal(order.status, "ready"); assert.equal(order.payment_status, "paid"); assert.equal(order.total, "549.00");
      assert.equal((await postgres.query<any>("select status from payments where order_id=$1", [orderId])).rows[0].status, "paid");
      for (const table of ["bobgo_order_sync", "email_events", "inventory_movements"]) assert.equal((await postgres.query<any>(`select count(*) from ${table}`)).rows[0].count, 0);
    });
    await t.test("tracking updates are independently processed while order import remains disabled", async () => {
      now += 1000; remote = { ...remote, status: "delivered", time_modified: new Date(now).toISOString() };
      const notification = deliveryEvent(Buffer.from('{"shipment_tracking_reference":"TEST-WAYBILL","status":"in-transit"}'), "tracking/updated", "production")!;
      assert.equal((await queue.enqueue(notification)).queued, true);
      await queue.drain();
      assert.equal((await postgres.query<any>("select courier_status from shipments where id=$1", [shipmentId])).rows[0].courier_status, "delivered");
      assert.equal((await postgres.query<any>("select status from orders where id=$1", [orderId])).rows[0].status, "ready");
      now += 1000; remote = { ...remote, status: "in-transit", time_modified: new Date(now).toISOString() };
      await service.refresh(shipmentId);
      assert.equal((await postgres.query<any>("select courier_status from shipments where id=$1", [shipmentId])).rows[0].courier_status, "delivered");
    });
    await t.test("provider failures remain queued for retry with sanitized diagnostics", async () => {
      fail = true;
      await queue.enqueue(event("shipment_charged_amount/updated"));
      assert.deepEqual(await queue.drain(), { processed: 0, failed: 1 });
      const row = (await postgres.query<any>("select * from bobgo_delivery_events where status='queued'")).rows[0];
      assert.equal(row.attempts, 1); assert.equal(row.last_error_code, "shipment_readback_failed");
      assert.doesNotMatch(JSON.stringify(row), /PRIVATE|SECRET/);
      assert.deepEqual(await queue.drain(), { processed: 0, failed: 0 });
      fail = false; now += 15 * 60_000 + 1;
      assert.deepEqual(await queue.drain(), { processed: 1, failed: 0 });
    });
    await t.test("another environment and conflicting provider references cannot overwrite a shipment", async () => {
      const foreign = tracking.createDirectShipmentTracking(database, "sandbox", async () => { throw new Error("Must not call"); });
      await assert.rejects(foreign.refresh(shipmentId));
      response = { shipments: [{ ...remote, tracking_reference: "WRONG" }] };
      await assert.rejects(service.refresh(shipmentId)); response = undefined;
      assert.equal((await postgres.query<any>("select tracking_number from shipments where id=$1", [shipmentId])).rows[0].tracking_number, "TEST-WAYBILL");
    });
    await t.test("a lost booking response is recovered only by the exact attempt and order reference, without another POST", async () => {
      const id = randomUUID(), localId = randomUUID();
      await database.insert(schema.orders).values({ id, orderNumber: "MM-RECOVER-TEST", checkoutToken: randomUUID(), customerId, status: "ready", paymentStatus: "paid", deliveryMethod: "courier", subtotal: "450", total: "549", deliveryFee: "99" });
      await database.insert(schema.shipments).values({ id: localId, orderId: id, provider: "bobgo-production", status: "booking", waybillReference: "MMRECOVERATTEMPT", serviceLevelCode: "ECO" });
      response = { shipments: [{ ...remote, id: 322, tracking_reference: "TEST-RECOVER", custom_tracking_reference: "MMRECOVERATTEMPT", meta: { custom_order_number: "WRONG" } }], count: 1 };
      await assert.rejects(service.refresh(localId));
      assert.equal((await postgres.query<any>("select status from shipments where id=$1", [localId])).rows[0].status, "booking");
      response.shipments[0].meta.custom_order_number = "MM-RECOVER-TEST";
      assert.equal((await service.refresh(localId)).booked, true);
      assert.match(calls.at(-1)!, /start_date=.*end_date=/);
      assert.equal((await postgres.query<any>("select provider_shipment_id from shipments where id=$1", [localId])).rows[0].provider_shipment_id, "322");
      assert.ok(calls.every(path => path.startsWith("/shipments?")));
      now += 1000;
      response.shipments[0].status = "cancelled-by-courier";
      response.shipments[0].time_modified = new Date(now).toISOString();
      assert.equal((await service.refresh(localId)).booked, false);
      assert.equal((await postgres.query<any>("select status from shipments where id=$1", [localId])).rows[0].status, "cancelled");
      assert.equal((await postgres.query<any>("select status from orders where id=$1", [id])).rows[0].status, "ready");
    });
    await t.test("two pending cancellation notifications require one verified provider read and do not retry the second", async () => {
      const eq = require("drizzle-orm").eq;
      await database.update(schema.shipments).set({ status: "booked", courierStatus: null, courierStatusAt: null }).where(eq(schema.shipments.id, shipmentId));
      now += 1000; remote = { ...remote, status: "cancelled", time_modified: new Date(now).toISOString() }; response = undefined;
      await queue.enqueue({ ...event(), id: randomUUID() });
      await queue.enqueue({ ...event(), id: randomUUID() });
      const before = calls.length;
      assert.deepEqual(await queue.drain(), { processed: 2, failed: 0 });
      assert.equal(calls.length, before + 1);
      assert.equal((await postgres.query<any>("select status from shipments where id=$1", [shipmentId])).rows[0].status, "cancelled");
    });
    await t.test("queued events for cancelled, reset or foreign bookings finish without provider reads or shipment changes", async () => {
      for (const [status, provider] of [["cancelled", "bobgo-production"], ["not_ready", "bobgo-production"], ["booked", "bobgo-sandbox"]]) {
        await database.update(schema.shipments).set({ status: "booked", provider: "bobgo-production" }).where(require("drizzle-orm").eq(schema.shipments.id, shipmentId));
        await queue.enqueue({ ...event(), id: randomUUID() });
        await database.update(schema.shipments).set({ status, provider }).where(require("drizzle-orm").eq(schema.shipments.id, shipmentId));
        const before = (await postgres.query<any>("select * from shipments where id=$1", [shipmentId])).rows;
        const callCount = calls.length;
        assert.deepEqual(await queue.drain(), { processed: 1, failed: 0 });
        assert.equal(calls.length, callCount);
        assert.deepEqual((await postgres.query<any>("select * from shipments where id=$1", [shipmentId])).rows, before);
      }
    });
    await t.test("cancellation or replacement during read-back retires only that obsolete event", async () => {
      for (const replacement of [false, true]) {
        await database.update(schema.shipments).set({ status: "booked", provider: "bobgo-production", providerShipmentId: "321" }).where(require("drizzle-orm").eq(schema.shipments.id, shipmentId));
        const notification = { ...event(), id: randomUUID() };
        await queue.enqueue(notification);
        const racingQueue = events.createDeliveryEventQueue(database, "production", async () => {
          await database.update(schema.shipments).set(replacement ? { providerShipmentId: "REPLACEMENT" } : { status: "cancelled" })
            .where(require("drizzle-orm").eq(schema.shipments.id, shipmentId));
          throw new Error("Read-back lost to another worker");
        }, () => now);
        assert.deepEqual(await racingQueue.drain(), { processed: 1, failed: 0 });
        const row = (await postgres.query<any>("select * from bobgo_delivery_events where id=$1", [notification.id])).rows[0];
        assert.equal(row.status, "processed"); assert.equal(row.last_error_code, null); assert.equal(row.lease_token, null);
      }
      assert.equal((await postgres.query<any>("select count(*) from bobgo_delivery_events where status in ('queued','needs_attention')")).rows[0].count, 0);
      assert.equal((await postgres.query<any>("select status from payments where order_id=$1", [orderId])).rows[0].status, "paid");
      assert.equal((await postgres.query<any>("select status from orders where id=$1", [orderId])).rows[0].status, "ready");
    });
  } finally { await postgres.close(); }
});
