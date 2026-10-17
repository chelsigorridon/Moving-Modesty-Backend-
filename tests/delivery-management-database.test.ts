/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated PostgreSQL/provider test doubles. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

test("delivery editing and all courier routes preserve payments, quotes and booked shipments", async t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), require = createRequire(import.meta.url);
  const postgres = new PGlite(), database = require("drizzle-orm/pglite").drizzle(postgres), cache = new Map<string, any>();
  let authenticated = true, pendingBooking = false, rejectLocations = false;
  let afterTransaction: (() => Promise<void>) | undefined;
  const transaction = database.transaction.bind(database);
  database.transaction = async (...args: any[]) => {
    const result = await transaction(...args);
    const callback = afterTransaction; afterTransaction = undefined;
    await callback?.();
    return result;
  };
  const calls: Array<{ path: string; body?: any }> = [];
  const previousSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "test-only-quote-signing-not-a-production-secret";
  const address = { company: "", street_address: "10 Test Street", local_area: "Test Suburb", city: "Cape Town", zone: "Western Cape", country: "ZA", code: "7800" };
  async function provider(path: string, body?: any) {
    calls.push({ path, body });
    if (path.startsWith("/locations")) {
      if (rejectLocations) throw new Error("test-only lookup failure");
      const id = new URL(`https://example.invalid${path}`).searchParams.get("location_id");
      return [{ id: Number(id || 1156), provider_slug: "ie", active: true, type: id === "2000" ? "counter" : "locker", name: `Verified point ${id}`, address }];
    }
    if (path === "/rates") return { id: 123456, provider_rate_requests: [
      { provider_slug: "ie", provider_name: "Internet Express", status: "success", responses: [{ status: "success", service_level_code: "ECO", rate_amount: 99 }] },
      { provider_slug: "tgc", provider_name: "TEST Other Courier", status: "success", responses: [{ status: "success", service_level_code: "OVN", rate_amount: 115 }] },
    ] };
    if (path === "/shipments") return { id: randomUUID(), tracking_reference: "TEST-WAYBILL", submission_status: pendingBooking ? "failed-will-retry" : "success",
      collection_location_type: body.collection_pickup_point_location_id ? "locker" : "door",
      delivery_location_type: body.delivery_pickup_point_location_id === 2000 ? "counter" : body.delivery_pickup_point_location_id ? "locker" : "door" };
    throw new Error(`Unexpected test provider operation: ${path}`);
  }
  function load(file: string): any {
    const absolute = resolve(root, file);
    if (/lib[\\/]db(?:[\\/]index)?\.ts$/.test(absolute)) return { db: database, requireDatabase: () => database };
    if (/lib[\\/]auth\.ts$/.test(absolute)) return { getRequestAdmin: async () => authenticated ? { email: "owner@example.invalid", role: "owner" } : null };
    if (/lib[\\/]monitoring\.ts$/.test(absolute)) return { reportFailure: async () => ({ reference: "TEST-REF" }), resolveFailures: async () => undefined, getOperationalIssues: async () => [] };
    if (/lib[\\/]integrations[\\/]bobgo[\\/]client\.ts$/.test(absolute)) return { bobGoRequest: provider, getConfiguredBobGoLocation: () => provider("/locations?location_id=1156") };
    if (/lib[\\/]integrations[\\/]bobgo[\\/]configuration\.ts$/.test(absolute)) return { getBobGoConfiguration: () => ({ enabled: true, environment: "production", apiTokenConfigured: true,
      senderName: "TEST Sender", senderEmail: "sender@example.invalid", senderPhone: "0821234567", senderLocationName: "TEST old locker", pickupPointLocationId: "1156", pickupPointProviderSlug: "ie" }) };
    if (cache.has(absolute)) return cache.get(absolute);
    const loadedModule = { exports: {} }; cache.set(absolute, loadedModule.exports);
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = (name: string) => {
      if (name === "server-only") return {};
      if (name.startsWith("@/")) return load(name.slice(2) + ".ts");
      if (name.startsWith(".")) return load(resolve(dirname(absolute), name) + (name === "./db" ? "/index.ts" : name.endsWith(".ts") ? "" : ".ts"));
      return require(name);
    };
    new Function("require", "module", "exports", compiled)(localRequire, loadedModule, loadedModule.exports);
    return loadedModule.exports;
  }
  try {
    const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
    for (const migration of journal.entries) for (const statement of readFileSync(resolve(root, `drizzle/${migration.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (statement.trim()) await postgres.exec(statement);
    const schema = load("lib/db/schema.ts"), management = load("lib/delivery-management.ts"), shipping = load("lib/integrations/bobgo/shipping.ts");
    const contact = { name: "TEST Contact", email: "contact@example.invalid", phone: "0821234567" };
    const door = { kind: "door", contact, address: { company: "", line1: "20 Test Road", line2: "", suburb: "Test Suburb", city: "Cape Town", province: "western cape", postalCode: "7800" } };
    const point = { kind: "pickup_point", contact, point: { id: "1156", providerSlug: "ie", name: "Untrusted display name" } };
    const plan = { version: 1, collection: door, delivery: door, collectionInstructions: "Call at gate", deliveryInstructions: "Use bell", customerApprovedPickup: false };
    const parcel = { weightGrams: 412, lengthCm: 25, widthCm: 20.5, heightCm: 3.5 };
    async function seed(number: string) {
      const id = randomUUID(), customerId = randomUUID(), addressId = randomUUID();
      await database.insert(schema.customers).values({ id: customerId, email: `${id}@example.invalid`, firstName: "TEST", lastName: "Buyer", phone: "0821234567" });
      await database.insert(schema.addresses).values({ id: addressId, customerId, recipientName: "TEST Buyer", line1: "Original checkout address", suburb: "Test Suburb", city: "Cape Town", province: "Western Cape", postalCode: "7800" });
      await database.insert(schema.orders).values({ id, orderNumber: number, customerId, deliveryAddressId: addressId, status: "ready", paymentStatus: "paid", deliveryMethod: "courier",
        subtotal: "450", total: "549", deliveryFee: "99", checkoutToken: randomUUID(), customerSnapshot: { firstName: "TEST", lastName: "Buyer", email: "buyer@example.invalid", phone: "0821234567" } });
      await database.insert(schema.payments).values({ orderId: id, provider: "payfast-live", merchantPaymentId: number, providerPaymentId: id, status: "paid", amount: "549", verifiedAt: new Date() });
      return id;
    }
    const orderId = await seed("MM-DELIVERY-TEST");
    await t.test("mirrored or uncertain Bob Go orders cannot book a separate portal shipment, even with an older approved quote", async () => {
      const number = "MM-DELIVERY-LINKED-GUARD", id = await seed(number);
      await management.saveOrderDelivery(number, { action: "delivery", expectedRevision: 0, confirmed: true, plan }, "owner@example.invalid");
      const quotes = await shipping.getCourierQuotes(number, parcel, false), count = calls.length;
      await database.insert(schema.bobgoOrderSync).values({ orderId: id, environment: "production", channelRef: "store.example.invalid", status: "checking", submittedAt: new Date() });
      await assert.rejects(shipping.getCourierQuotes(number, parcel, false), /existing order in Bob Go/);
      await assert.rejects(shipping.bookCourierShipment(number, quotes.rates[0].quoteToken), /existing order in Bob Go/);
      assert.equal(calls.length, count, "No quote or shipment POST reaches the provider");
      calls.length = 0; // Keep the pre-existing no-network assertions isolated.
    });
    await t.test("delivery changes immediately flag an existing Bob Go order without clearing its remote reference or guard", async () => {
      const id = await seed("MM-DELIVERY-SYNCED"), submittedAt = new Date();
      await database.insert(schema.bobgoOrderSync).values({ orderId: id, environment: "sandbox", channelRef: "TEST", status: "synced", remoteOrderId: "7000", submittedAt });
      await management.saveOrderDelivery("MM-DELIVERY-SYNCED", { action: "delivery", expectedRevision: 0, confirmed: true, plan }, "owner@example.invalid");
      const row = (await postgres.query<Record<string, any>>("select * from bobgo_order_sync where order_id=$1", [id])).rows[0];
      assert.equal(row.status, "needs_attention"); assert.equal(row.last_error_code, "delivery_changed");
      assert.equal(row.remote_order_id, "7000"); assert.equal(row.submitted_at.toISOString(), submittedAt.toISOString());
      assert.equal(calls.length, 0);
    });
    await t.test("editing delivery creates a private order address and leaves payment, prices and customer snapshot intact", async () => {
      const before = (await postgres.query<Record<string, any>>("select * from orders where id=$1", [orderId])).rows[0];
      await management.saveOrderDelivery("MM-DELIVERY-TEST", { action: "delivery", expectedRevision: 0, confirmed: true, plan, rememberCollection: true }, "owner@example.invalid");
      const after = (await postgres.query<Record<string, any>>("select * from orders where id=$1", [orderId])).rows[0];
      assert.notEqual(after.delivery_address_id, before.delivery_address_id);
      for (const key of ["subtotal", "total", "delivery_fee", "discount_amount", "customer_snapshot", "payment_status"]) assert.deepEqual(after[key], before[key]);
      assert.equal((await postgres.query<{ line_1: string }>("select line_1 from addresses where id=$1", [before.delivery_address_id])).rows[0].line_1, "Original checkout address");
      assert.equal((await postgres.query<{ count: number }>("select count(*) from courier_settings")).rows[0].count, 1);
      assert.equal(calls.length, 0, "Door address saving does not contact Bob Go");
    });
    let quote: any;
    await t.test("door-to-door quotes include multiple eligible couriers, with no fixed provider or pickup point", async () => {
      quote = await shipping.getCourierQuotes("MM-DELIVERY-TEST", parcel, false);
      assert.equal(quote.rates.length, 2);
      const request = calls.find(call => call.path === "/rates")!.body;
      assert.equal(request.providers, undefined); assert.equal(request.collection_pickup_point_location_id, undefined);
      assert.equal(request.delivery_pickup_point_location_id, undefined); assert.equal(request.declared_value, 0);
    });
    await t.test("changing an address invalidates an earlier quote and stale edits cannot overwrite it", async () => {
      await management.saveOrderDelivery("MM-DELIVERY-TEST", { action: "delivery", expectedRevision: 1, confirmed: true, plan: { ...plan, deliveryInstructions: "Changed before booking" } }, "owner@example.invalid");
      await assert.rejects(management.saveOrderDelivery("MM-DELIVERY-TEST", { action: "private_note", expectedRevision: 1, note: "Stale" }, "owner@example.invalid"), /edited elsewhere/);
      await assert.rejects(shipping.bookCourierShipment("MM-DELIVERY-TEST", quote.rates[1].quoteToken), /changed/);
      assert.equal(calls.filter(call => call.path === "/shipments").length, 0);
    });
    await t.test("booking the selected non-IE courier sends the exact signed route once only", async () => {
      quote = await shipping.getCourierQuotes("MM-DELIVERY-TEST", parcel, false);
      const booked = await shipping.bookCourierShipment("MM-DELIVERY-TEST", quote.rates[1].quoteToken);
      assert.equal(booked.booked, true);
      const booking = calls.filter(call => call.path === "/shipments");
      assert.equal(booking.length, 1); assert.equal(booking[0].body.provider_slug, "tgc");
      assert.equal(booking[0].body.selected_rate_request_id, 123456);
      assert.equal(booking[0].body.collection_contact_name, "TEST");
      assert.equal(booking[0].body.collection_contact_surname, "Contact");
      assert.equal(booking[0].body.delivery_contact_name, "TEST");
      assert.equal(booking[0].body.delivery_contact_surname, "Contact");
      assert.equal(booking[0].body.instructions_delivery, "Changed before booking");
      assert.equal(booking[0].body.collection_pickup_point_location_id, undefined);
      await assert.rejects(shipping.bookCourierShipment("MM-DELIVERY-TEST", quote.rates[1].quoteToken), /already exists/);
      assert.equal(calls.filter(call => call.path === "/shipments").length, 1);
    });
    await t.test("an edit just after quote persistence cannot sign stale rates against the newer order", async () => {
      const id = await seed("MM-QUOTE-RACE");
      await management.saveOrderDelivery("MM-QUOTE-RACE", { action: "delivery", expectedRevision: 0, confirmed: true, plan }, "owner@example.invalid");
      afterTransaction = async () => { await postgres.query("update orders set delivery_revision=delivery_revision+1, delivery_notes=$1 where id=$2", ["Concurrent delivery edit", id]); };
      await assert.rejects(shipping.getCourierQuotes("MM-QUOTE-RACE", parcel, false), /order changed/);
    });
    await t.test("booked delivery cannot be locally rewritten, but private notes remain editable without provider calls", async () => {
      const count = calls.length;
      await assert.rejects(management.saveOrderDelivery("MM-DELIVERY-TEST", { action: "delivery", expectedRevision: 2, confirmed: true, plan }, "owner@example.invalid"), /confirmed in Bob Go/);
      await management.saveOrderDelivery("MM-DELIVERY-TEST", { action: "private_note", expectedRevision: 2, note: "PRIVATE: customer called" }, "owner@example.invalid");
      assert.equal(calls.length, count);
      assert.equal((await postgres.query<{ status: string }>("select status from shipments where order_id=$1", [orderId])).rows[0].status, "booked");
      assert.equal((await postgres.query<{ count: number }>("select count(*) from order_delivery_history where order_id=$1", [orderId])).rows[0].count, 3);
      assert.doesNotMatch(JSON.stringify(calls), /PRIVATE:/);
    });
    await t.test("pickup points are verified server-side and support all remaining route combinations", async () => {
      for (const [index, collection, delivery] of [[1, point, door], [2, door, { ...point, point: { ...point.point, id: "2000" } }], [3, point, point]] as const) {
        const number = `MM-POINT-${index}`; await seed(number);
        await management.saveOrderDelivery(number, { action: "delivery", expectedRevision: 0, confirmed: true, plan: { ...plan, collection, delivery, customerApprovedPickup: true } }, "owner@example.invalid");
        const rates = await shipping.getCourierQuotes(number, parcel, false);
        assert.equal(rates.rates.length, 1, "Pickup-point rates stay with the verified point provider");
        assert.equal((await shipping.bookCourierShipment(number, rates.rates[0].quoteToken)).booked, true);
        const request = calls.filter(call => call.path === "/shipments").at(-1)!.body;
        assert.equal(Boolean(request.collection_pickup_point_location_id), collection.kind === "pickup_point");
        assert.equal(Boolean(request.delivery_pickup_point_location_id), delivery.kind === "pickup_point");
      }
    });
    await t.test("failed point lookup cannot alter an order; pending bookings remain locked", async () => {
      const id = await seed("MM-PENDING-TEST");
      rejectLocations = true;
      await assert.rejects(management.saveOrderDelivery("MM-PENDING-TEST", { action: "delivery", expectedRevision: 0, confirmed: true, plan: { ...plan, collection: point } }, "owner@example.invalid"));
      assert.equal((await postgres.query<{ delivery_revision: number }>("select delivery_revision from orders where id=$1", [id])).rows[0].delivery_revision, 0);
      rejectLocations = false;
      await management.saveOrderDelivery("MM-PENDING-TEST", { action: "delivery", expectedRevision: 0, confirmed: true, plan }, "owner@example.invalid");
      pendingBooking = true;
      const rates = await shipping.getCourierQuotes("MM-PENDING-TEST", parcel, false);
      assert.equal((await shipping.bookCourierShipment("MM-PENDING-TEST", rates.rates[0].quoteToken)).booked, false);
      await assert.rejects(management.saveOrderDelivery("MM-PENDING-TEST", { action: "delivery", expectedRevision: 1, confirmed: true, plan }, "owner@example.invalid"), /processing/);
      pendingBooking = false;
    });
    await t.test("archived, unpaid, collection and completed orders reject delivery rewrites", async () => {
      for (const [index, change] of [{ archivedAt: new Date() }, { paymentStatus: "pending" }, { deliveryMethod: "collection" }, { status: "delivered" }].entries()) {
        const number = `MM-BLOCKED-${index}`, id = await seed(number);
        await database.update(schema.orders).set(change).where(require("drizzle-orm").eq(schema.orders.id, id));
        await assert.rejects(management.saveOrderDelivery(number, { action: "delivery", expectedRevision: 0, confirmed: true, plan }, "owner@example.invalid"));
        assert.equal((await postgres.query<{ delivery_revision: number }>("select delivery_revision from orders where id=$1", [id])).rows[0].delivery_revision, 0);
      }
    });
    await t.test("pickup search returns only active verified public points and requires a useful query", async () => {
      const points = load("app/api/admin/bobgo/pickup-points/route.ts");
      const before = calls.length;
      assert.equal((await points.GET(new Request("https://test.invalid?q=x"))).status, 400);
      assert.equal(calls.length, before);
      const response = await points.GET(new Request("https://test.invalid?q=verified"));
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.points.length, 1);
      assert.deepEqual(Object.keys(result.points[0]).sort(), ["description", "id", "name", "providerSlug", "type"]);
      assert.match(calls.at(-1)!.path, /min_lat=.*max_lat=.*min_lng=.*max_lng=/);
    });
    await t.test("both new admin endpoints reject unauthenticated requests before accessing provider data", async () => {
      authenticated = false;
      const route = load("app/api/admin/orders/[orderNumber]/delivery/route.ts");
      assert.equal((await route.PATCH(new Request("https://test.invalid", { method: "PATCH", body: "{}" }), { params: Promise.resolve({ orderNumber: "MM-DELIVERY-TEST" }) })).status, 401);
      const points = load("app/api/admin/bobgo/pickup-points/route.ts");
      assert.equal((await points.GET(new Request("https://test.invalid?q=Test"))).status, 401);
    });
  } finally {
    if (previousSecret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = previousSecret;
    await postgres.close();
  }
});
