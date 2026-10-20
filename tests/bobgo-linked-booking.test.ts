/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic DB/provider only; no network or real environment. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
import { inspectLinkedBookingPermissions, linkedBookingPermissions, linkedWaybillChangePermissions } from "../lib/integrations/bobgo/permissions.ts";
import { getOrderSyncConfiguration, buildBobGoOrderPayload, matchRemoteOrder } from "../lib/integrations/bobgo/order-sync-policy.ts";
import { collectionBookId } from "../lib/integrations/bobgo/linked-booking-policy.ts";

const permissionBody = { user: { role_id: 7 }, roles: [{ id: 7, permissions: [...linkedBookingPermissions, ...linkedWaybillChangePermissions] }] };
test("permission inspection uses only the key user's role and never treats a successful GET as write permission", () => {
  assert.equal(inspectLinkedBookingPermissions(permissionBody).allowed, true);
  assert.equal(inspectLinkedBookingPermissions({ ...permissionBody, user: { role_id: 8 } }).known, false);
  assert.equal(inspectLinkedBookingPermissions({ user: { role: { permissions: ["API_/orders:GET"] } }, roles: permissionBody.roles }).allowed, false);
  assert.equal(inspectLinkedBookingPermissions({ orders: [] }).allowed, false);
  assert.equal(getOrderSyncConfiguration().enabled, false);
});

test("linked quotes, booking and timeout reconciliation are isolated and fenced against duplicates", async t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), require = createRequire(import.meta.url);
  const pg = new PGlite(), db = require("drizzle-orm/pglite").drizzle(pg), cache = new Map<string, any>();
  const calls: string[] = [], remote = new Map<string, any>(), fulfillments = new Map<string, any>(), remoteShipments = new Map<string, any>();
  let mode = "normal", changeDuringRead: (() => Promise<void>) | undefined, changeDuringShipmentRead: (() => Promise<void>) | undefined;
  const contact = { name: "TEST Sender", email: "sender@example.invalid", phone: "0821234567" };
  const address = { company: "", line1: "10 Example Road", line2: "", suburb: "Example", city: "Cape Town", province: "Western Cape", postalCode: "7800" };
  const plan = { version: 1, collection: { kind: "door", contact, address }, delivery: { kind: "door", contact: { ...contact, name: "TEST Buyer", email: "buyer@example.invalid" }, address },
    collectionInstructions: "Test collection note", deliveryInstructions: "Test delivery note", customerApprovedPickup: false };
  const parcel = { weightGrams: 412, lengthCm: 25, widthCm: 20.5, heightCm: 3.5 };
  const providerAddress = { company: "", street_address: address.line1, local_area: address.suburb, city: address.city, zone: "WC", country: "South Africa", code: address.postalCode };
  function load(file: string): any {
    const path = resolve(root, file);
    if (/lib[\\/]db(?:[\\/]index)?\.ts$/.test(path)) return { requireDatabase: () => db };
    if (/lib[\\/]monitoring\.ts$/.test(path)) return { reportFailure: async () => ({}), resolveFailures: async () => {} };
    if (/lib[\\/]integrations[\\/]bobgo[\\/]client\.ts$/.test(path)) return { bobGoRequest: async (path: string, body: unknown) => {
      assert.equal(body, undefined); assert.match(path, /^\/locations\?/);
      const id = new URL(`https://example.invalid${path}`).searchParams.get("location_id");
      return [{ id: Number(id), provider_slug: "demo-b", active: true, type: id === "91" ? "counter" : "locker", name: `TEST Point ${id}`, address: providerAddress }];
    } };
    if (cache.has(path)) return cache.get(path);
    const loadedModule = { exports: {} }; cache.set(path, loadedModule.exports);
    const compiled = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("require", "module", "exports", "process", "fetch", compiled)((name: string) => {
      if (name === "server-only") return {};
      if (name.startsWith(".")) return load(resolve(dirname(path), name) + (name.endsWith(".ts") ? "" : ".ts"));
      return require(name);
    }, loadedModule, loadedModule.exports, { env: {} }, () => { throw new Error("Live network forbidden"); });
    return loadedModule.exports;
  }
  try {
    const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
    for (const entry of journal.entries) for (const sql of readFileSync(resolve(root, `drizzle/${entry.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (sql.trim()) await pg.exec(sql);
    const schema = load("lib/db/schema.ts"), { createLinkedBookingService } = load("lib/integrations/bobgo/linked-booking.ts");
    const secret = "TEST-ONLY-SIGNING-NOT-A-LIVE-SECRET", config = { enabled: true, environment: "sandbox", channelRef: "store.example.invalid" };
    let numberIndex = 0, shipmentSerial = 9000, fulfillmentSerial = 8000;
    async function seed(selectedPlan = plan) {
      const id = randomUUID(), customerId = randomUUID(), addressId = randomUUID(), productId = randomUUID(), variantId = randomUUID(), number = `MM-LINKED-TEST-${++numberIndex}`;
      const expected = buildBobGoOrderPayload({ orderNumber: number, contact: plan.delivery.contact, address, deliveryFee: 99, subtotal: 450, total: 549, discountAmount: 0,
        items: [{ sku: variantId, description: "TEST Product — Black Small", quantity: 1, unitPrice: 450, weightGrams: 120 }] });
      await db.insert(schema.customers).values({ id: customerId, firstName: "TEST", lastName: "Buyer", email: `${id}@example.invalid`, phone: contact.phone });
      await db.insert(schema.addresses).values({ id: addressId, customerId, recipientName: "TEST Buyer", ...address, countryCode: "ZA" });
      await db.insert(schema.products).values({ id: productId, name: "TEST Product", slug: id, category: "TEST" });
      await db.insert(schema.productVariants).values({ id: variantId, productId, sku: variantId, size: "Small", colour: "Black", price: "450", stockOnHand: 9, shippingWeightGrams: 120 });
      await db.insert(schema.orders).values({ id, orderNumber: number, customerId, deliveryAddressId: addressId, status: "ready", paymentStatus: "paid", deliveryMethod: "courier",
        courierPlan: selectedPlan, subtotal: "450", total: "549", deliveryFee: "99", customerSnapshot: { firstName: "TEST", lastName: "Buyer", email: "buyer@example.invalid", phone: contact.phone } });
      await db.insert(schema.orderItems).values({ orderId: id, variantId, productName: "TEST Product", variantName: "Black Small", sku: variantId, quantity: 1, unitPrice: "450", lineTotal: "450" });
      await db.insert(schema.payments).values({ orderId: id, provider: "payfast-sandbox", merchantPaymentId: number, providerPaymentId: id, status: "paid", amount: "549", verifiedAt: new Date() });
      const remoteId = String(1000 + numberIndex);
      remote.set(remoteId, { ...expected, delivery_address: providerAddress, id: Number(remoteId), account_id: 77, status: "new",
        order_items: expected.order_items.map((item, i) => ({ ...item, id: 5000 + numberIndex * 10 + i, fulfilled_qty: 0 })) });
      fulfillments.set(remoteId, { order_fulfillments: [], count: 0 });
      await db.insert(schema.bobgoOrderSync).values({ orderId: id, environment: config.environment, channelRef: config.channelRef, status: "synced", remoteOrderId: remoteId, requestSnapshot: expected, submittedAt: new Date() });
      return { id, number, remoteId };
    }
    const provider = {
      async findOrders(number: string) { return [...remote.values()].filter(row => row.channel_order_number === number).map(row => structuredClone(row)); },
      async createOrder() { throw new Error("Order creation forbidden in cancellation tests"); },
      async readPermissions() { calls.push("permissions"); return mode === "permission-denied" ? {} : permissionBody; },
      async readCollections() { calls.push("collections"); return { count: 2, items: [
        { id: 90, address: providerAddress, contact_name: "TEST", contact_surname: "Sender", contact_email: contact.email, contact_number: contact.phone },
        { id: 91, address: null, contact_name: "TEST", contact_surname: "Sender", email: contact.email, mobile_number: contact.phone, pickup_point_location_id: 90, pickup_point_provider_slug: "demo-b" },
      ] }; },
      async readOrder(id: string) { calls.push("readOrder"); const change = changeDuringRead; changeDuringRead = undefined; await change?.(); return structuredClone(remote.get(id)); },
      async readOrderFulfillments(id: string) { calls.push("fulfillments"); return structuredClone(fulfillments.get(id)); },
      async readShipment(id: string) { calls.push("shipmentRead"); const row = structuredClone(remoteShipments.get(id)); const callback = changeDuringShipmentRead; changeDuringShipmentRead = undefined; await callback?.(); return row; },
      async updateOrder(body: any) { calls.push("update"); assert.equal(body.order_items, undefined); assert.equal(body.payment_status, undefined); assert.equal(body.account_id, undefined);
        const row = remote.get(String(body.id)); Object.assign(row, structuredClone(body)); return structuredClone(row); },
      async orderRates(body: any) { calls.push("rates"); assert.equal(body.order_id > 0, true); const row = remote.get(String(body.order_id));
        row.rate_request = { id: 3000, provider_rate_requests: ["demo-a", "demo-b"].map(provider_slug => ({ provider_slug, provider_name: provider_slug, status: mode === "pending-rates" && provider_slug === "demo-b" ? "pending" : "success", responses: [{ status: "success", service_level_code: "ECO", rate_amount: 95 }] })) };
        return structuredClone(row); },
      async createFulfillment(body: any) {
        calls.push("book");
        const row = remote.get(String(body.order_id));
        const local = (await pg.query<any>("select s.* from shipments s join orders o on o.id=s.order_id where o.order_number=$1", [row.channel_order_number])).rows[0];
        assert.equal(local.status, "booking", "durable fence precedes external POST"); assert.equal(local.waybill_reference, body.custom_tracking_reference);
        assert.equal(body.method, "shipment"); assert.equal(body.items, null); assert.equal(body.order_items, undefined); assert.equal(body.account_id, undefined);
        assert.equal(body.selected_rate_request_id, undefined); assert.equal(body.order_fulfillment_presets.provider_slug, "demo-b");
        if (mode === "timeout-empty") throw new Error("PRIVATE uncertain POST");
        const shipmentId = String(++shipmentSerial), tracking = `TEST-${shipmentId}`;
        const rows = fulfillments.get(String(body.order_id)).order_fulfillments;
        rows.unshift({ order_fulfillment: { id: ++fulfillmentSerial, order_id: body.order_id, method: "shipment", type: "original", status: "success", method_id: Number(shipmentId), method_reference: tracking,
          items: row.order_items.map((item: any) => ({ order_item_id: item.id, qty: item.qty })) } });
        fulfillments.set(String(body.order_id), { order_fulfillments: rows, count: rows.length });
        for (const item of row.order_items) item.fulfilled_qty = item.qty;
        remoteShipments.set(shipmentId, { id: Number(shipmentId), tracking_reference: tracking, custom_tracking_reference: body.custom_tracking_reference,
          submission_status: "success", status: row.order_fulfillment_presets.collection_address_book_id === 91 ? "awaiting-dropoff" : "pending-collection", provider_slug: "demo-b", service_level_code: "ECO", time_created: new Date().toISOString(),
          collection_location_type: row.order_fulfillment_presets.collection_address_book_id === 91 ? "locker" : "door", delivery_location_type: body.pickup_point_location_id ? "counter" : "door",
          ...(row.order_fulfillment_presets.collection_address_book_id === 91 ? { collection_pickup_point_location_id: 90 } : {}),
          ...(body.pickup_point_location_id ? { delivery_pickup_point_location_id: body.pickup_point_location_id } : {}),
          collection_address: mode === "wrong-collection" ? { ...providerAddress, code: "9999" } : providerAddress, collection_contact_name: "TEST", collection_contact_surname: "Sender", collection_contact_email: contact.email, collection_contact_mobile_number: contact.phone,
          delivery_address: { ...row.delivery_address, country: "South Africa", zone: "WC" }, delivery_contact_name: "TEST", delivery_contact_surname: "Buyer", delivery_contact_email: "buyer@example.invalid", delivery_contact_mobile_number: contact.phone });
        if (mode === "timeout-accepted") throw new Error("PRIVATE uncertain POST");
        return { order_id: body.order_id, status: "success", method_id: Number(shipmentId), method_reference: tracking };
      },
      async cancelFulfillment(id: string) {
        calls.push("cancel");
        const rows = [...fulfillments.values()].flatMap(value => value.order_fulfillments), entry = rows.find(value => String(value.order_fulfillment?.id) === id);
        assert.ok(entry); const fulfillment = entry.order_fulfillment, row = remote.get(String(fulfillment.order_id));
        const history = await pg.query<any>("select h.* from order_delivery_history h join orders o on o.id=h.order_id where o.order_number=$1 and h.action='waybill_cancel_requested' and h.after->>'fulfillmentId'=$2", [row.channel_order_number, id]);
        assert.equal(history.rows.length, 1, "linked cancellation fence must be durable before provider POST");
        if (mode === "cancel-timeout" || mode === "cancel-rejected") throw new Error("PRIVATE cancellation outcome");
        if (mode !== "cancel-pending") {
          const shipment = remoteShipments.get(String(fulfillment.method_id));
          if (mode !== "cancel-fulfillment-only") shipment.status = "cancelled";
          if (mode !== "cancel-shipment-only") fulfillment.status = "cancelled";
          shipment.time_modified = new Date().toISOString();
          if (mode !== "cancel-quantities-held" && mode !== "cancel-shipment-only") for (const item of row.order_items) item.fulfilled_qty = 0;
        }
        if (mode === "cancel-timeout-accepted") throw new Error("PRIVATE cancellation outcome");
        return { success: true }; // Never trusted in place of the three GET checks.
      },
    };
    const service = createLinkedBookingService(db, provider, config, secret);
    const { createLinkedWaybillChanges } = load("lib/integrations/bobgo/linked-waybill-change.ts");
    const changes = createLinkedWaybillChanges(db, config, provider);
    const quote = async (row: any) => (await service.quotes(row.number, parcel, false)).rates.at(-1).quoteToken;
    const bookings = () => calls.filter(call => call === "book").length;
    const cancellations = () => calls.filter(call => call === "cancel").length;
    const localShipment = async (row: any) => (await pg.query<any>("select * from shipments where order_id=$1", [row.id])).rows[0];
    async function change(row: any, action: string, overrides: any = {}) {
      const order = (await pg.query<any>("select * from orders where id=$1", [row.id])).rows[0], shipment = await localShipment(row);
      return changes.change(row.number, { action, expectedRevision: order.delivery_revision, expectedWaybill: shipment.tracking_number, confirm: true, ...overrides }, "owner@example.invalid");
    }
    async function bookedSeed() { const row = await seed(); await service.book(row.number, await quote(row)); return row; }
    await t.test("disabled service touches neither database nor provider", async () => {
      const disabled = createLinkedBookingService(new Proxy({}, { get() { throw new Error("No DB"); } }), new Proxy({}, { get() { throw new Error("No provider"); } }), { ...config, enabled: false }, secret);
      await assert.rejects(disabled.quotes("MM-TEST", parcel, false), /not activated/);
      await assert.rejects(disabled.book("MM-TEST", "bad"), /not activated/);
      await assert.rejects(disabled.reconcile("MM-TEST"), /not activated/);
      const disabledChanges = createLinkedWaybillChanges(new Proxy({}, { get() { throw new Error("No DB"); } }), { ...config, enabled: false }, new Proxy({}, { get() { throw new Error("No provider"); } }));
      await assert.rejects(disabledChanges.change("MM-TEST", {}, "owner@example.invalid"), /not activated/);
    });
    await t.test("permissions are required before changing the remote order or requesting rates", async () => {
      const row = await seed(), before = calls.length; mode = "permission-denied";
      await assert.rejects(quote(row), /permissions/); assert.deepEqual(calls.slice(before), ["permissions"]); mode = "normal";
    });
    await t.test("one signed courier choice creates one full order-linked fulfilment and preserves financial state", async () => {
      const row = await seed(), token = await quote(row), before = bookings();
      assert.equal((await service.book(row.number, token)).booked, true);
      await assert.rejects(service.book(row.number, token), /already exists/); assert.equal(bookings(), before + 1);
      const order = (await pg.query<any>("select * from orders where id=$1", [row.id])).rows[0];
      assert.equal(order.status, "ready"); assert.equal(order.payment_status, "paid"); assert.equal(Number(order.total), 549); assert.equal(Number(order.delivery_fee), 99);
      assert.match(order.tracking_number, /^TEST-/);
      assert.equal((await pg.query<any>("select stock_on_hand from product_variants where id=(select variant_id from order_items where order_id=$1)", [row.id])).rows[0].stock_on_hand, 9);
      assert.equal((await service.reconcile(row.number)).booked, true);
    });
    await t.test("an accepted timeout is reconciled by GET only, never by another booking POST", async () => {
      const row = await seed(), token = await quote(row), before = bookings(); mode = "timeout-accepted";
      await assert.rejects(service.book(row.number, token), /Do not book again/); mode = "normal";
      await assert.rejects(service.book(row.number, token), /already exists/);
      assert.equal((await service.reconcile(row.number)).booked, true); assert.equal(bookings(), before + 1);
    });
    await t.test("an empty read-back after timeout never unlocks the durable fence", async () => {
      const row = await seed(), token = await quote(row), before = bookings(); mode = "timeout-empty";
      await assert.rejects(service.book(row.number, token), /Do not book again/); mode = "normal";
      assert.equal((await service.reconcile(row.number)).booked, false);
      await assert.rejects(quote(row), /already exists/); await assert.rejects(service.book(row.number, token), /already exists/); assert.equal(bookings(), before + 1);
    });
    await t.test("stale local edits and remote dashboard edits invalidate approved quotes before POST", async () => {
      const row = await seed(), token = await quote(row), before = bookings();
      remote.get(row.remoteId).customer_email = "different@example.invalid";
      await assert.rejects(service.book(row.number, token), /Bob Go order changed/); assert.equal(bookings(), before);
      const other = await seed(), otherToken = await quote(other);
      await pg.query("update orders set delivery_revision=delivery_revision+1 where id=$1", [other.id]);
      await assert.rejects(service.book(other.number, otherToken), /changed/); assert.equal(bookings(), before);
    });
    await t.test("a concurrent local edit during remote checks cannot reserve a stale booking", async () => {
      const row = await seed(), token = await quote(row), before = bookings();
      changeDuringRead = async () => { await pg.query("update orders set delivery_revision=delivery_revision+1 where id=$1", [row.id]); };
      await assert.rejects(service.book(row.number, token)); assert.equal(bookings(), before);
    });
    await t.test("existing or partial remote fulfilments block quoting, not just a second portal click", async () => {
      const row = await seed(), before = bookings(); fulfillments.set(row.remoteId, { order_fulfillments: [{ status: "pending" }] });
      await assert.rejects(quote(row), /already has a fulfilment/); assert.equal(bookings(), before);
    });
    await t.test("a provider still calculating rates cannot silently hide other courier choices", async () => {
      const row = await seed(), before = bookings(); mode = "pending-rates";
      await assert.rejects(quote(row), /not finished/); mode = "normal"; assert.equal(bookings(), before);
    });
    await t.test("unconfirmed collection address read-back cannot be labelled as a successful booking", async () => {
      const row = await seed(), token = await quote(row), before = bookings(); mode = "wrong-collection";
      await assert.rejects(service.book(row.number, token), /not confirmed/); mode = "normal";
      await assert.rejects(service.reconcile(row.number)); await assert.rejects(service.book(row.number, token), /already exists/);
      assert.equal(bookings(), before + 1);
      assert.equal((await pg.query<any>("select status from shipments where order_id=$1", [row.id])).rows[0].status, "booking");
    });
    await t.test("pre-booking address edits update the same remote order without replacing its item IDs", async () => {
      const row = await seed(), itemIds = remote.get(row.remoteId).order_items.map((item: any) => item.id);
      const changed = { ...plan, delivery: { ...plan.delivery, address: { ...address, line1: "22 New Example Road" } } };
      await db.update(schema.orders).set({ courierPlan: changed, deliveryRevision: 1 }).where(require("drizzle-orm").eq(schema.orders.id, row.id));
      await db.update(schema.addresses).set({ line1: "22 New Example Road" }).where(require("drizzle-orm").eq(schema.addresses.id,
        (await pg.query<any>("select delivery_address_id from orders where id=$1", [row.id])).rows[0].delivery_address_id));
      await db.update(schema.bobgoOrderSync).set({ status: "needs_attention", lastErrorCode: "delivery_changed" }).where(require("drizzle-orm").eq(schema.bobgoOrderSync.orderId, row.id));
      await quote(row);
      assert.equal(remote.get(row.remoteId).delivery_address.street_address, "22 New Example Road");
      assert.deepEqual(remote.get(row.remoteId).order_items.map((item: any) => item.id), itemIds);
    });
    await t.test("linked locker/counter routes preserve verified pickup IDs and restrict couriers to the selected point provider", async () => {
      for (const [collectionPoint, deliveryPoint] of [[true, false], [false, true], [true, true]]) {
        const selected: any = { ...plan,
          collection: collectionPoint ? { kind: "pickup_point", contact, point: { id: "90", providerSlug: "demo-b", name: "TEST Collection" } } : plan.collection,
          delivery: deliveryPoint ? { kind: "pickup_point", contact: plan.delivery.contact, point: { id: "91", providerSlug: "demo-b", name: "TEST Delivery" } } : plan.delivery,
          customerApprovedPickup: Boolean(deliveryPoint) };
        const row = await seed(selected), result = await service.quotes(row.number, parcel, false);
        assert.equal(result.rates.length, 1); assert.equal(result.rates[0].providerSlug, "demo-b");
        assert.equal((await service.book(row.number, result.rates[0].quoteToken)).booked, true);
      }
    });
    await t.test("packed measurement changes invalidate quotes even without a delivery revision change", async () => {
      const row = await seed(), token = await quote(row), before = bookings();
      await pg.query("update shipments set weight_grams=900 where order_id=$1", [row.id]);
      await assert.rejects(service.book(row.number, token), /measurements changed/); assert.equal(bookings(), before);
    });
    await t.test("another channel submission or recorded stock issue cannot book a second waybill", async () => {
      const row = await seed(), before = bookings();
      await db.insert(schema.bobgoOrderSync).values({ orderId: row.id, environment: config.environment, channelRef: "another.example.invalid", status: "checking", submittedAt: new Date() });
      await assert.rejects(quote(row), /another channel/);
      const other = await seed(); await pg.query("update orders set inventory_issue='TEST shortage' where id=$1", [other.id]);
      await assert.rejects(quote(other), /verified paid/); assert.equal(bookings(), before);
    });
    await t.test("wrong payment environment and forged quotes never book", async () => {
      const row = await seed(), token = await quote(row), before = bookings();
      await assert.rejects(service.book(row.number, token + "x"));
      await pg.query("update payments set provider='payfast-production' where order_id=$1", [row.id]);
      await assert.rejects(service.book(row.number, token), /verified paid/); assert.equal(bookings(), before);
    });
    await t.test("linked cancellation requires confirmation, current revision/reference, correct payment and cancellation permissions", async () => {
      const row = await bookedSeed(), before = cancellations();
      for (const overrides of [{ confirm: false }, { expectedRevision: 999 }, { expectedWaybill: "OTHER-WAYBILL" }]) await assert.rejects(change(row, "cancel_waybill", overrides));
      mode = "permission-denied"; await assert.rejects(change(row, "cancel_waybill"), /permissions/); mode = "normal";
      await pg.query("update payments set provider='payfast-production' where order_id=$1", [row.id]);
      await assert.rejects(change(row, "cancel_waybill"), /matching verified payment/); assert.equal(cancellations(), before);
    });
    await t.test("a timeout or provider refusal is fenced and can only be checked, never automatically cancelled twice", async () => {
      for (const outcome of ["cancel-timeout", "cancel-rejected", "cancel-timeout-accepted"]) {
        const row = await bookedSeed(), before = cancellations(); mode = outcome;
        await assert.rejects(change(row, "cancel_waybill"), /Do not repeat/); mode = "normal";
        await change(row, "cancel_waybill"); await change(row, "check_cancellation");
        assert.equal(cancellations(), before + 1);
        assert.equal((await localShipment(row)).status, outcome === "cancel-timeout-accepted" ? "cancelled" : "booked");
        if (outcome !== "cancel-timeout-accepted") await assert.rejects(change(row, "prepare_replacement"), /must confirm/);
      }
    });
    await t.test("shipment-only, fulfilment-only or unreleased quantities cannot unlock a replacement", async () => {
      for (const outcome of ["cancel-pending", "cancel-shipment-only", "cancel-fulfillment-only", "cancel-quantities-held"]) {
        const row = await bookedSeed(), before = cancellations(); mode = outcome;
        const result = await change(row, "cancel_waybill"); assert.match(result.message, /remains locked/); mode = "normal";
        await assert.rejects(change(row, "prepare_replacement"), /must confirm/);
        await assert.rejects(quote(row), /already exists/); await change(row, "cancel_waybill"); assert.equal(cancellations(), before + 1);
      }
    });
    await t.test("two admin sessions cannot submit two linked cancellation requests", async () => {
      const row = await bookedSeed(), before = cancellations(); mode = "cancel-pending";
      const shipment = await localShipment(row), input = { action: "cancel_waybill", expectedRevision: 0, expectedWaybill: shipment.tracking_number, confirm: true };
      await Promise.allSettled([changes.change(row.number, input, "owner@example.invalid"), changes.change(row.number, input, "owner@example.invalid")]);
      mode = "normal"; assert.equal(cancellations(), before + 1);
    });
    await t.test("a handed-over or different linked waybill is never cancelled", async () => {
      const row = await bookedSeed(), shipment = await localShipment(row), raw = remoteShipments.get(shipment.provider_shipment_id), before = cancellations();
      raw.status = "collected"; await assert.rejects(change(row, "cancel_waybill"), /handed over/);
      raw.status = "pending-collection"; raw.collected_date = new Date().toISOString(); await assert.rejects(change(row, "cancel_waybill"), /handed over/); raw.collected_date = null;
      const entry = fulfillments.get(row.remoteId).order_fulfillments[0]; entry.order_fulfillment.method_id = 99999;
      await assert.rejects(change(row, "cancel_waybill")); assert.equal(cancellations(), before);
    });
    await t.test("cancellation and separately approved replacement keep history and the same channel order across repeated replacements", async () => {
      const row = await bookedSeed(), original = await localShipment(row);
      for (let round = 0; round < 2; round++) {
        const previous = await localShipment(row), beforeBooks = bookings();
        await change(row, "cancel_waybill");
        assert.equal((await localShipment(row)).booking_snapshot.linkedOrder.cancellationConfirmed, true);
        await change(row, "prepare_replacement");
        const reset = await localShipment(row); assert.equal(reset.status, "not_ready"); assert.equal(reset.provider_shipment_id, null); assert.equal(reset.weight_grams, null);
        assert.equal(bookings(), beforeBooks, "preparing a replacement never books or charges one");
        await service.book(row.number, await quote(row));
        const next = await localShipment(row); assert.notEqual(next.tracking_number, previous.tracking_number);
        assert.equal(next.booking_snapshot.linkedOrder.remoteOrderId, row.remoteId); assert.equal(bookings(), beforeBooks + 1);
      }
      const history = (await pg.query<any>("select * from order_delivery_history where order_id=$1 and action='waybill_replacement_prepared' order by revision", [row.id])).rows;
      assert.equal(history.length, 2); assert.equal(history[0].before.shipment.providerShipmentId, original.provider_shipment_id);
      const order = (await pg.query<any>("select * from orders where id=$1", [row.id])).rows[0];
      assert.equal(order.payment_status, "paid"); assert.equal(order.status, "ready"); assert.equal(Number(order.total), 549); assert.equal(Number(order.delivery_fee), 99);
      assert.equal(fulfillments.get(row.remoteId).order_fulfillments.length, 3);
    });
    await t.test("a reactivated retired waybill, unexplained extra fulfilment or missing cancellation history blocks another quote", async () => {
      const row = await bookedSeed(), old = await localShipment(row); await change(row, "cancel_waybill"); await change(row, "prepare_replacement");
      const before = bookings(), raw = remoteShipments.get(old.provider_shipment_id); raw.status = "pending-collection";
      await assert.rejects(quote(row), /not confirmed cancelled/); raw.status = "cancelled";
      const saved = fulfillments.get(row.remoteId), oldEntry = saved.order_fulfillments[0];
      saved.order_fulfillments = []; saved.count = 0; await assert.rejects(quote(row), /full previous cancellation history/);
      saved.order_fulfillments = [oldEntry, { order_fulfillment: { ...oldEntry.order_fulfillment, id: 77777, status: "success" } }]; saved.count = 2;
      await assert.rejects(quote(row), /already has a fulfilment/); assert.equal(bookings(), before);
    });
    await t.test("late tracking for an old waybill cannot overwrite a replacement", async () => {
      const row = await bookedSeed(), old = await localShipment(row); await change(row, "cancel_waybill"); await change(row, "prepare_replacement"); await service.book(row.number, await quote(row));
      const next = await localShipment(row), tracker = load("lib/integrations/bobgo/tracking.ts").createDirectShipmentTracking(db, config.environment,
        async () => ({ shipments: [remoteShipments.get(old.provider_shipment_id)] }));
      await assert.rejects(tracker.refresh(next.id)); assert.equal((await localShipment(row)).tracking_number, next.tracking_number);
    });
    await t.test("a cancelled channel order can change its address before a fresh, separately approved replacement", async () => {
      const row = await bookedSeed(); await change(row, "cancel_waybill"); await change(row, "prepare_replacement");
      await load("lib/delivery-management.ts").saveOrderDelivery(row.number, { action: "delivery", expectedRevision: 2, confirmed: true,
        plan: { ...plan, delivery: { ...plan.delivery, address: { ...address, line1: "44 Replacement Road" } } } }, "owner@example.invalid");
      await service.book(row.number, await quote(row));
      assert.equal(remote.get(row.remoteId).delivery_address.street_address, "44 Replacement Road");
      assert.equal((await localShipment(row)).booking_snapshot.linkedOrder.remoteOrderId, row.remoteId);
    });
    await t.test("the background linker handles retired history and cannot resurrect an old read during cancellation", async () => {
      const row = await bookedSeed(), sync = load("lib/integrations/bobgo/order-sync.ts").createBobGoOrderSyncService(db, provider, config);
      changeDuringShipmentRead = async () => { await change(row, "cancel_waybill"); await change(row, "prepare_replacement"); };
      assert.equal((await sync.refreshWaybillLink(row.id)).status, "needs_attention");
      assert.equal((await localShipment(row)).status, "not_ready");
      assert.equal((await sync.refreshWaybillLink(row.id)).status, "not_booked");
      await service.book(row.number, await quote(row));
      assert.equal((await sync.refreshWaybillLink(row.id)).status, "unchanged");
    });
    await t.test("an externally confirmed cancellation can be checked and prepared without another cancellation POST", async () => {
      const row = await bookedSeed(), local = await localShipment(row), before = cancellations();
      const entry = fulfillments.get(row.remoteId).order_fulfillments[0].order_fulfillment; entry.status = "cancelled";
      remoteShipments.get(local.provider_shipment_id).status = "cancelled";
      for (const item of remote.get(row.remoteId).order_items) item.fulfilled_qty = 0;
      await change(row, "check_cancellation"); await change(row, "prepare_replacement"); assert.equal(cancellations(), before);
      assert.equal((await localShipment(row)).provider_shipment_id, null);
    });
    assert.equal(getOrderSyncConfiguration().enabled, false);
  } finally { await pg.close(); }
});

test("documented country/province and separate surname are supported without accepting other countries", () => {
  const expected = buildBobGoOrderPayload({ orderNumber: "MM-TEST-ADDRESS", contact: { name: "TEST Buyer", email: "buyer@example.invalid", phone: "0821234567" },
    address: { company: "", line1: "10 Example Road", line2: "", suburb: "Example", city: "Cape Town", province: "Western Cape", postalCode: "7800" },
    deliveryFee: 99, subtotal: 450, total: 549, discountAmount: 0, items: [{ sku: "TEST", description: "TEST", quantity: 1, unitPrice: 450, weightGrams: 100 }] });
  const remote = { ...expected, id: 1, delivery_address: { ...expected.delivery_address, zone: "WC", country: "South Africa" } };
  assert.equal(matchRemoteOrder(remote, expected), "1");
  assert.equal(matchRemoteOrder({ ...remote, delivery_address: { ...remote.delivery_address, country: "Namibia" } }, expected), null);
  assert.throws(() => collectionBookId({ items: [] }, {} as any), /collection address/);
});
