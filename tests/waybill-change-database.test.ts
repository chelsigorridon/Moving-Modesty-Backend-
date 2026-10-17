/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated PostgreSQL and Bob Go fixtures; no network. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

test("waybill changes use verified cancellation, preserve history and never repeat an uncertain cancellation", async t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), require = createRequire(import.meta.url);
  const postgres = new PGlite(), database = require("drizzle-orm/pglite").drizzle(postgres), cache = new Map<string, any>();
  let authenticated = true, cancellationMode = "success", number = 1000, beforeReadReturn: (() => Promise<void>) | undefined;
  const config = { enabled: true, apiTokenConfigured: true, environment: "production", senderName: "TEST Sender", senderEmail: "sender@example.invalid", senderPhone: "0821234567" };
  const remote = new Map<string, any>(), calls: Array<{ path: string; body?: any }> = [];
  const secret = process.env.AUTH_SECRET; process.env.AUTH_SECRET = "offline-waybill-test-signing-secret";
  async function provider(path: string, body?: any) {
    calls.push({ path, body });
    if (path.startsWith("/shipments?")) {
      const id = new URL(`https://fixture.invalid${path}`).searchParams.get("id")!;
      const result = structuredClone(remote.get(id));
      const callback = beforeReadReturn; beforeReadReturn = undefined; await callback?.();
      return { shipments: result ? [result] : [] };
    }
    if (path === "/shipments/cancel") {
      const shipment = [...remote.values()].find(row => row.tracking_reference === body.tracking_reference)!;
      if (cancellationMode === "timeout") throw new Error("Fixture timeout after possible acceptance");
      if (cancellationMode === "rejected") throw Object.assign(new Error("Fixture refusal"), { status: 400 });
      if (cancellationMode !== "pending") shipment.status = "cancelled";
      return { ...shipment };
    }
    if (path === "/rates") return { id: 98765, provider_rate_requests: ["ie", "tgc"].map((slug, index) => ({ provider_slug: slug,
      provider_name: `TEST ${slug}`, status: "success", responses: [{ status: "success", service_level_code: "ECO", rate_amount: 99 + index * 10 }] })) };
    if (path === "/shipments") return { id: ++number, tracking_reference: `REPLACEMENT-${number}`, submission_status: "success", collection_location_type: "door", delivery_location_type: "door" };
    throw new Error(`Forbidden fixture provider request: ${path}`);
  }
  function load(file: string): any {
    const absolute = resolve(root, file);
    if (/lib[\\/]db(?:[\\/]index)?\.ts$/.test(absolute)) return { db: database, requireDatabase: () => database };
    if (/lib[\\/]auth\.ts$/.test(absolute)) return { getRequestAdmin: async () => authenticated ? { email: "owner@example.invalid", role: "owner" } : null };
    if (/lib[\\/]monitoring\.ts$/.test(absolute)) return { reportFailure: async () => ({ reference: "OFFLINE-ONLY" }), resolveFailures: async () => {}, getOperationalIssues: async () => [] };
    if (/lib[\\/]integrations[\\/]bobgo[\\/]client\.ts$/.test(absolute)) return { bobGoRequest: provider };
    if (/lib[\\/]integrations[\\/]bobgo[\\/]configuration\.ts$/.test(absolute)) return { getBobGoConfiguration: () => config };
    if (cache.has(absolute)) return cache.get(absolute);
    const loadedModule = { exports: {} }; cache.set(absolute, loadedModule.exports);
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("require", "module", "exports", compiled)((name: string) => {
      if (name === "server-only") return {};
      if (name.startsWith("@/")) return load(name.slice(2) + ".ts");
      if (name.startsWith(".")) return load(resolve(dirname(absolute), name) + (name === "./db" ? "/index.ts" : name.endsWith(".ts") ? "" : ".ts"));
      return require(name);
    }, loadedModule, loadedModule.exports);
    return loadedModule.exports;
  }
  try {
    const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
    for (const migration of journal.entries) for (const statement of readFileSync(resolve(root, `drizzle/${migration.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (statement.trim()) await postgres.exec(statement);
    const schema = load("lib/db/schema.ts"), { createWaybillChanges } = load("lib/integrations/bobgo/waybill-change.ts");
    const service = createWaybillChanges(database, config, provider), admin = load("lib/admin-data.ts"), management = load("lib/delivery-management.ts"), shipping = load("lib/integrations/bobgo/shipping.ts");
    const contact = { name: "TEST Contact", email: "contact@example.invalid", phone: "0821234567" };
    const address = { company: "", line1: "20 Test Road", line2: "", suburb: "Test Suburb", city: "Cape Town", province: "Western Cape", postalCode: "7800" };
    const door = { kind: "door", contact, address }, plan = { version: 1, collection: door, delivery: door, collectionInstructions: "Call at gate", deliveryInstructions: "Use bell", customerApprovedPickup: false };
    const endpoint = { kind: "door", contact, address: { company: "", street_address: address.line1, local_area: address.suburb, city: address.city, zone: address.province, code: address.postalCode, country: "ZA" } };
    const snapshot = { collection: endpoint, delivery: endpoint, collectionInstructions: "Call", deliveryInstructions: "Gate", providerSlug: "ie", providerName: "Internet Express", serviceCode: "ECO", serviceName: "Economy", amount: 99 };
    async function seed(options: { status?: string; remoteStatus?: string; pickup?: boolean } = {}) {
      const id = randomUUID(), customerId = randomUUID(), addressId = randomUUID(), remoteId = String(++number), orderNumber = `MM-CHANGE-${number}`;
      await database.insert(schema.customers).values({ id: customerId, email: `${id}@example.invalid`, firstName: "TEST", lastName: "Buyer", phone: contact.phone });
      await database.insert(schema.addresses).values({ id: addressId, customerId, recipientName: contact.name, ...address });
      await database.insert(schema.orders).values({ id, orderNumber, customerId, deliveryAddressId: addressId, courierPlan: plan, privateNote: "PRIVATE DO NOT SEND",
        status: options.status || "ready", paymentStatus: "paid", deliveryMethod: "courier", subtotal: "450", total: "549", deliveryFee: "99", checkoutToken: randomUUID(),
        customerSnapshot: { firstName: "TEST", lastName: "Buyer", email: contact.email, phone: contact.phone }, trackingNumber: `TEST-${remoteId}` });
      await database.insert(schema.payments).values({ orderId: id, provider: "payfast-live", merchantPaymentId: orderNumber, providerPaymentId: id, status: "paid", amount: "549", verifiedAt: new Date() });
      const booking = structuredClone(snapshot); if (options.pickup) (booking.collection as any).kind = "pickup_point";
      await database.insert(schema.shipments).values({ orderId: id, provider: "bobgo-production", status: "booked", providerShipmentId: remoteId, trackingNumber: `TEST-${remoteId}`,
        waybillReference: `TEST-${remoteId}`, serviceLevelCode: "ECO", bookingSnapshot: booking, bookedAt: new Date(), courierStatus: options.remoteStatus || "pending-collection",
        weightGrams: 412, lengthCm: "25", widthCm: "20.5", heightCm: "3.5", courierChargedAmount: "99" });
      remote.set(remoteId, { id: Number(remoteId), tracking_reference: `TEST-${remoteId}`, service_level_code: "ECO", provider_slug: "ie", submission_status: "success",
        status: options.remoteStatus || "pending-collection", charged_amount: 99, collected_date: null, delivered_date: null, meta: { custom_order_number: orderNumber } });
      return { id, orderNumber, remoteId, waybill: `TEST-${remoteId}` };
    }
    async function row(id: string) { return (await postgres.query<any>("select * from orders where id=$1", [id])).rows[0]; }
    async function act(item: Awaited<ReturnType<typeof seed>>, action: string, extra: any = {}) {
      return service.change(item.orderNumber, { action, expectedRevision: (await row(item.id)).delivery_revision, expectedWaybill: item.waybill, confirm: true, ...extra }, "owner@example.invalid");
    }
    const writes = () => calls.filter(call => call.path === "/shipments/cancel").length;
    await t.test("auth, confirmation, stale revision/reference, invalid payment, environment, closed and linked orders block all provider writes", async () => {
      const item = await seed(), route = load("app/api/admin/orders/[orderNumber]/shipment-change/route.ts");
      const context = { params: Promise.resolve({ orderNumber: item.orderNumber }) };
      authenticated = false;
      assert.equal((await route.POST(new Request("https://fixture.invalid", { method: "POST", body: "{}" }), context)).status, 401);
      authenticated = true;
      assert.equal((await route.POST(new Request("https://fixture.invalid", { method: "POST", body: JSON.stringify({ action: "cancel_waybill", expectedRevision: 0, expectedWaybill: item.waybill }) }), context)).status, 400);
      await assert.rejects(act(item, "cancel_waybill", { expectedRevision: 99 }), /Refresh/i);
      await assert.rejects(act(item, "cancel_waybill", { expectedWaybill: "OTHER-WAYBILL" }), /matched/);
      await postgres.query("update payments set amount=1 where order_id=$1", [item.id]);
      await assert.rejects(act(item, "cancel_waybill"), /verified payment/);
      await postgres.query("update payments set amount=549, provider='payfast-sandbox' where order_id=$1", [item.id]);
      await assert.rejects(act(item, "cancel_waybill"), /environment/);
      const terminal = await seed({ status: "dispatched" });
      await assert.rejects(act(terminal, "cancel_waybill"), /handed over/);
      const linked = await seed();
      await database.insert(schema.bobgoOrderSync).values({ orderId: linked.id, environment: "production", channelRef: "fixture", status: "synced", remoteOrderId: "999" });
      await assert.rejects(act(linked, "cancel_waybill"), /sales-channel/);
      assert.equal(calls.length, 0);
    });
    await t.test("fresh provider identity, collection mode and handover state are verified before cancellation", async () => {
      const item = await seed(), count = writes();
      remote.get(item.remoteId).tracking_reference = "WRONG";
      await assert.rejects(act(item, "cancel_waybill"), /matched safely/);
      remote.get(item.remoteId).tracking_reference = item.waybill;
      remote.get(item.remoteId).collected_date = new Date().toISOString();
      await assert.rejects(act(item, "cancel_waybill"), /handed over/);
      remote.get(item.remoteId).collected_date = null; remote.get(item.remoteId).status = "in-transit";
      await assert.rejects(act(item, "cancel_waybill"), /current stage/);
      const pickup = await seed({ pickup: true });
      await assert.rejects(act(pickup, "cancel_waybill"), /current stage/);
      for (const submission of ["no-rates", "failed-indefinitely"]) {
        const unsubmitted = await seed(); remote.get(unsubmitted.remoteId).submission_status = submission;
        await assert.rejects(act(unsubmitted, "cancel_waybill"), /current stage/);
      }
      assert.equal(writes(), count);
    });
    await t.test("concurrent newer tracking prevents stale cancellation or unlock", async () => {
      const item = await seed(), count = writes();
      beforeReadReturn = async () => { await postgres.query("update shipments set courier_checked_at=now()+interval '1 second' where order_id=$1", [item.id]); };
      await assert.rejects(act(item, "cancel_waybill"), /status changed/);
      assert.equal(writes(), count);
    });
    await t.test("separate admin sessions cannot send two cancellation requests", async () => {
      const item = await seed(), count = writes(); cancellationMode = "pending";
      const input = { action: "cancel_waybill", expectedRevision: 0, expectedWaybill: item.waybill, confirm: true };
      const outcomes = await Promise.allSettled([service.change(item.orderNumber, input, "owner@example.invalid"), service.change(item.orderNumber, input, "owner@example.invalid")]);
      assert.ok(outcomes.some(result => result.status === "fulfilled")); assert.equal(writes(), count + 1);
      cancellationMode = "success";
    });
    await t.test("a stale tracking refresh and old-waybill webhook cannot overwrite a prepared replacement", async () => {
      const item = await seed({ remoteStatus: "cancelled" });
      const [shipment] = await database.select().from(schema.shipments).where(require("drizzle-orm").eq(schema.shipments.orderId, item.id));
      const tracker = load("lib/integrations/bobgo/tracking.ts").createDirectShipmentTracking(database, "production", provider);
      beforeReadReturn = async () => { await act(item, "prepare_replacement"); };
      await assert.rejects(tracker.refresh(shipment.id), /matched safely/);
      const current = (await postgres.query<any>("select * from shipments where order_id=$1", [item.id])).rows[0];
      assert.equal(current.status, "not_ready"); assert.equal(current.provider_shipment_id, null);
      const queue = load("lib/integrations/bobgo/delivery-events.ts").createDeliveryEventQueue(database, "production", async () => { throw new Error("Must not refresh replaced waybill"); });
      const event = await queue.enqueue({ id: "offline-old-event", topic: "tracking/updated", remoteId: item.remoteId, tracking: item.waybill });
      assert.equal(event.ignored, true);
    });
    await t.test("timeout and provider refusal leave durable guard, no repeated POST, no dispatch or address overwrite", async () => {
      for (const mode of ["timeout", "rejected"]) {
        const item = await seed(), before = writes(); cancellationMode = mode;
        await assert.rejects(act(item, "cancel_waybill"));
        assert.equal(writes(), before + 1);
        const snapshot = (await admin.getAdminSnapshot()).orders.find((o: any) => o.id === item.orderNumber);
        assert.equal(snapshot.deliveryDetails.waybillChange.action, "check_cancellation");
        assert.equal(snapshot.workflow.nextStatus, null);
        await assert.rejects(admin.updateOrderStatus(item.orderNumber, "Dispatched"), /cannot be changed/);
        await assert.rejects(management.saveOrderDelivery(item.orderNumber, { action: "delivery", expectedRevision: 1, confirmed: true, plan }, "owner@example.invalid"), /confirmed in Bob Go/);
        await act(item, "cancel_waybill"); await act(item, "check_cancellation");
        assert.equal(writes(), before + 1);
        await assert.rejects(act(item, "prepare_replacement"), /not confirmed/);
      }
      cancellationMode = "success";
    });
    await t.test("successful POST without final GET confirmation stays locked, then confirms without a second POST", async () => {
      const item = await seed(), count = writes(); cancellationMode = "pending";
      assert.match((await act(item, "cancel_waybill")).message, /not yet confirmed/);
      await assert.rejects(act(item, "prepare_replacement"), /not confirmed/);
      remote.get(item.remoteId).status = "cancelled";
      assert.match((await act(item, "check_cancellation")).message, /confirms/);
      assert.equal(writes(), count + 1); cancellationMode = "success";
    });
    await t.test("confirmed cancellation archives the full previous waybill, resets delivery only, and requires fresh signed quotes", async () => {
      const item = await seed(), before = await row(item.id), count = writes();
      await act(item, "cancel_waybill");
      assert.equal(writes(), count + 1);
      assert.deepEqual(calls.filter(c => c.path === "/shipments/cancel").at(-1)!.body, { tracking_reference: item.waybill, note: "Store owner requested a delivery change before parcel handover." });
      const prepared = await act(item, "prepare_replacement"); assert.match(prepared.message, /history/);
      const after = await row(item.id);
      for (const key of ["status", "payment_status", "subtotal", "total", "delivery_fee", "discount_amount", "customer_snapshot", "private_note"]) assert.deepEqual(after[key], before[key]);
      assert.equal(after.tracking_number, null); assert.equal(after.delivery_revision, 2);
      const old = (await postgres.query<any>("select * from order_delivery_history where order_id=$1 and action='waybill_replacement_prepared'", [item.id])).rows[0];
      assert.equal(old.before.shipment.providerShipmentId, item.remoteId); assert.deepEqual(old.before.shipment.bookingSnapshot, snapshot);
      const current = (await postgres.query<any>("select * from shipments where order_id=$1", [item.id])).rows[0];
      assert.equal(current.status, "not_ready");
      for (const key of ["provider_shipment_id", "tracking_number", "waybill_reference", "booking_snapshot", "weight_grams", "length_cm", "width_cm", "height_cm", "courier_status"]) assert.equal(current[key], null);
      await assert.rejects(act(item, "prepare_replacement"), /matched/);
      let view = (await admin.getAdminSnapshot()).orders.find((o: any) => o.id === item.orderNumber);
      assert.equal(view.deliveryDetails.canEdit, true); assert.equal(view.deliveryDetails.previousWaybills.length, 1);
      await management.saveOrderDelivery(item.orderNumber, { action: "delivery", expectedRevision: 2, confirmed: true, plan: { ...plan, delivery: { ...door, address: { ...address, line1: "99 Changed Road" } } } }, "owner@example.invalid");
      const parcel = { weightGrams: 420, lengthCm: 25, widthCm: 20, heightCm: 4 };
      const quote = await shipping.getCourierQuotes(item.orderNumber, parcel, false);
      await management.saveOrderDelivery(item.orderNumber, { action: "private_note", expectedRevision: 3, note: "PRIVATE changed" }, "owner@example.invalid");
      await assert.rejects(shipping.bookCourierShipment(item.orderNumber, quote.rates[0].quoteToken), /changed/);
      const fresh = await shipping.getCourierQuotes(item.orderNumber, parcel, false);
      assert.equal((await shipping.bookCourierShipment(item.orderNumber, fresh.rates[1].quoteToken)).booked, true);
      const booking = calls.filter(c => c.path === "/shipments").at(-1)!;
      assert.equal(booking.body.provider_slug, "tgc"); assert.equal(booking.body.delivery_address.street_address, "99 Changed Road");
      await assert.rejects(shipping.bookCourierShipment(item.orderNumber, fresh.rates[1].quoteToken), /already exists/);
      view = (await admin.getAdminSnapshot()).orders.find((o: any) => o.id === item.orderNumber);
      assert.equal(view.deliveryDetails.previousWaybills[0].trackingNumber, item.waybill);
      assert.equal(view.deliveryDetails.waybillChange.action, "cancel_waybill", "Old cancellation fence does not attach to replacement");
      assert.equal((await postgres.query<any>("select count(*) from email_events")).rows[0].count, 0);
      assert.equal((await postgres.query<any>("select count(*) from inventory_movements")).rows[0].count, 0);
      assert.doesNotMatch(JSON.stringify(calls), /PRIVATE/);
      assert.equal(load("lib/integrations/bobgo/order-sync-policy.ts").getOrderSyncConfiguration().enabled, false);
    });
    await t.test("an externally cancelled waybill is rechecked without another cancellation, including cancelled-by-courier formal cancellation", async () => {
      const item = await seed({ remoteStatus: "cancelled" }), count = writes();
      await act(item, "check_cancellation"); await act(item, "prepare_replacement");
      assert.equal(writes(), count);
      const courierCancelled = await seed({ remoteStatus: "cancelled-by-courier", pickup: true });
      await assert.rejects(act(courierCancelled, "prepare_replacement"), /not confirmed/);
      await act(courierCancelled, "cancel_waybill"); await act(courierCancelled, "prepare_replacement");
      assert.equal(writes(), count + 1);
    });
  } finally {
    if (secret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = secret;
    await postgres.close();
  }
});
