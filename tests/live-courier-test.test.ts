/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated PostgreSQL, PayFast and Bob Go fixtures; no live network. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

test("one owner-only sandbox-payment/live-courier test stays isolated and explicitly cost-approved", async t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), require = createRequire(import.meta.url);
  const postgres = new PGlite(), database = require("drizzle-orm/pglite").drizzle(postgres), cache = new Map<string, any>();
  const keys = ["AUTH_SECRET", "LIVE_COURIER_TEST_ENABLED", "PAYFAST_TEST_MERCHANT_ID", "PAYFAST_TEST_MERCHANT_KEY", "PAYFAST_TEST_PASSPHRASE", "PAYFAST_MERCHANT_ID", "VERCEL_ENV"];
  const before = keys.map(key => process.env[key]), previousFetch = globalThis.fetch;
  Object.assign(process.env, { AUTH_SECRET: "offline-owner-test-signing-key", LIVE_COURIER_TEST_ENABLED: "true", PAYFAST_TEST_MERCHANT_ID: "10000123",
    PAYFAST_TEST_MERCHANT_KEY: "offline-sandbox-key", PAYFAST_TEST_PASSPHRASE: "offline-sandbox-passphrase", PAYFAST_MERCHANT_ID: "20000123" });
  delete process.env.VERCEL_ENV;
  let owner: any = { email: "owner@example.invalid", role: "owner" }, emailCalls = 0, stockCalls = 0, validationResult = "VALID", bookingTimeout = false;
  const calls: Array<{ path: string; body?: any }> = [], remote: any = { id: 101, tracking_reference: "OFFLINE-TEST-101", status: "awaiting-dropoff",
    submission_status: "success", collection_location_type: "locker", delivery_location_type: "door", provider_slug: "ie", service_level_code: "ECO", collected_date: null, delivered_date: null };
  const config = { enabled: true, apiTokenConfigured: true, environment: "production", senderName: "TEST Sender", senderEmail: "sender@example.invalid", senderPhone: "0821234567", pickupPointLocationId: "42", pickupPointProviderSlug: "ie" };
  async function provider(path: string, body?: any) {
    calls.push({ path, body });
    if (path.startsWith("/locations")) return [{ id: 42, provider_slug: "ie", active: true, type: "locker", name: "Manually chosen TEST point",
      address: { company: "TEST", street_address: "10 Test Road", local_area: "Test Suburb", city: "Cape Town", zone: "Western Cape", country: "ZA", code: "7800" } }];
    if (path === "/rates") return { id: 1234, provider_rate_requests: [{ provider_slug: "ie", provider_name: "TEST Courier", status: "success",
      responses: [{ status: "success", service_level_code: "ECO", rate_amount: 87.65 }] }] };
    if (path === "/shipments") { if (bookingTimeout) throw new Error("OFFLINE timeout"); return structuredClone(remote); }
    if (path.startsWith("/shipments?")) return { shipments: [structuredClone(remote)] };
    if (path === "/shipments/cancel") { remote.status = "cancelled"; return structuredClone(remote); }
    throw new Error(`Forbidden offline provider operation: ${path}`);
  }
  function load(file: string): any {
    const absolute = resolve(root, file);
    if (/lib[\\/]db(?:[\\/]index)?\.ts$/.test(absolute)) return { db: database, requireDatabase: () => database };
    if (/lib[\\/]auth\.ts$/.test(absolute)) return { getRequestAdmin: async () => owner };
    if (/lib[\\/]monitoring\.ts$/.test(absolute)) return { reportFailure: async () => ({ reference: "OFFLINE" }), resolveFailures: async () => {}, getOperationalIssues: async () => [] };
    if (/bobgo[\\/]client\.ts$/.test(absolute)) return { bobGoRequest: provider };
    if (/bobgo[\\/]configuration\.ts$/.test(absolute)) return { getBobGoConfiguration: () => config };
    if (/lib[\\/]email\.ts$/.test(absolute)) return { sendPaidOrderEmails: async () => { emailCalls++; throw new Error("TEST must not send order emails"); } };
    if (/lib[\\/]catalogue-storefront\.ts$/.test(absolute)) return { deductPaidStock: async () => { stockCalls++; throw new Error("TEST must not deduct stock"); } };
    if (/lib[\\/]admin-data\.ts$/.test(absolute)) return { getAdminSnapshot: async () => ({ orders: [] }) };
    if (cache.has(absolute)) return cache.get(absolute);
    const loaded = { exports: {} }; cache.set(absolute, loaded.exports);
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("require", "module", "exports", compiled)((name: string) => {
      if (name === "server-only") return {};
      if (name.startsWith("@/")) return load(name.slice(2) + ".ts");
      if (name.startsWith(".")) return load(resolve(dirname(absolute), name) + (name === "./db" ? "/index.ts" : name.endsWith(".ts") ? "" : ".ts"));
      return require(name);
    }, loaded, loaded.exports);
    return loaded.exports;
  }
  globalThis.fetch = async (url: any) => {
    assert.equal(String(url), "https://sandbox.payfast.co.za/eng/query/validate", "Only PayFast sandbox validation is allowed");
    return new Response(validationResult);
  };
  try {
    for (const { tag } of JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")).entries)
      for (const statement of readFileSync(resolve(root, `drizzle/${tag}.sql`), "utf8").split("--> statement-breakpoint")) if (statement.trim()) await postgres.exec(statement);
    const helper = load("lib/live-courier-test.ts"), service = helper.createLiveCourierTestService(database), schema = load("lib/db/schema.ts");
    const shipping = load("lib/integrations/bobgo/shipping.ts"), changes = load("lib/integrations/bobgo/waybill-change.ts").createWaybillChanges(database, config, provider);
    const notify = load("lib/integrations/payfast/notification.ts"), signature = load("lib/integrations/payfast/signature.ts");
    const route = load("app/api/admin/courier-test/route.ts"), notifyRoute = load("app/api/payments/payfast/notify/route.ts");
    const input = { confirm: true, contact: { name: "Test Test", email: "test-recipient@example.invalid", phone: "0821234567" },
      address: { line1: "87 Offline Test Road", line2: "", suburb: "Test Suburb", city: "Cape Town", province: "western cape", postalCode: "7764" } };
    let order: any;
    await t.test("unauthenticated and non-owner callers cannot create, inspect or approve", async () => {
      for (const session of [null, { email: "manager@example.invalid", role: "manager" }]) {
        owner = session;
        assert.equal((await route.GET(new Request("https://test.invalid"))).status, 401);
        assert.equal((await route.POST(new Request("https://test.invalid", { method: "POST", body: JSON.stringify({ action: "create", ...input }) }))).status, 401);
      }
      owner = { email: "owner@example.invalid", role: "owner" };
      assert.equal(calls.length, 0);
    });
    await t.test("creation requires a separate sandbox configuration and explicit enablement", async () => {
      process.env.LIVE_COURIER_TEST_ENABLED = "false";
      await assert.rejects(service.create(input, owner.email), /not enabled/);
      process.env.LIVE_COURIER_TEST_ENABLED = "true"; process.env.PAYFAST_TEST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
      await assert.rejects(service.create(input, owner.email), /Separate PayFast sandbox/);
      process.env.PAYFAST_TEST_MERCHANT_ID = "10000123";
      await assert.rejects(service.create({ ...input, contact: { ...input.contact, name: "Real Buyer" } }, owner.email));
      assert.equal(calls.length, 0);
    });
    await t.test("one durable TEST order, immutable existing profile, no stock, measurements or default collection", async () => {
      await database.insert(schema.customers).values({ email: input.contact.email, firstName: "Existing", lastName: "Customer", phone: "0837654321" });
      order = await service.create(input, owner.email);
      assert.equal((await service.create(input, owner.email)).id, order.id);
      assert.equal((await service.current()).id, order.id);
      assert.equal(order.courierPlan, null); assert.equal(order.total, "5.00");
      assert.equal(order.customerSnapshot.firstName, "Test"); assert.equal(order.customerSnapshot.lastName, "Test");
      assert.equal((await postgres.query<any>("select first_name from customers")).rows[0].first_name, "Existing");
      assert.equal((await postgres.query<any>("select count(*)::int as n from orders")).rows[0].n, 1);
      assert.equal((await postgres.query<any>("select count(*)::int as n from stock_reservations")).rows[0].n, 0);
      assert.equal((await postgres.query<any>("select count(*)::int as n from shipments")).rows[0].n, 0);
      const payment = await service.checkout(order.orderNumber, "https://test.invalid/api/admin/courier-test");
      assert.equal(payment.action, "https://sandbox.payfast.co.za/eng/process"); assert.equal(payment.fields.amount, "5.00");
      assert.equal(payment.fields.name_first, "Test"); assert.equal(payment.fields.name_last, "Test");
      assert.equal(payment.fields.notify_url, "https://test.invalid/api/payments/payfast/notify");
      assert.equal(process.env.PAYFAST_MERCHANT_ID, "20000123");
    });
    function notification(extra: Record<string, string> = {}) {
      const params = new URLSearchParams({ merchant_id: "10000123", m_payment_id: order.orderNumber, pf_payment_id: "OFFLINE-PF-1", payment_status: "COMPLETE", amount_gross: "5.00", ...extra });
      params.set("signature", signature.createPayFastNotificationSignature(params, process.env.PAYFAST_TEST_PASSPHRASE)); return params.toString();
    }
    await t.test("only a signed, merchant/amount-matched server-validated sandbox notification confirms payment", async () => {
      await assert.rejects(notify.processPayFastNotification(new Request("https://test.invalid"), notification().replace(/signature=.*/, "signature=forged")), /signature/);
      await assert.rejects(notify.processPayFastNotification(new Request("https://test.invalid"), notification({ amount_gross: "450.00" })), /amount/);
      await assert.rejects(notify.processPayFastNotification(new Request("https://test.invalid"), notification({ merchant_id: "20000123" })), /merchant/);
      validationResult = "INVALID";
      await assert.rejects(notify.processPayFastNotification(new Request("https://test.invalid"), notification()), /rejected/);
      validationResult = "VALID";
      const response = await notifyRoute.POST(new Request("https://test.invalid", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: notification() }));
      assert.equal(response.status, 200); assert.equal(emailCalls, 0); assert.equal(stockCalls, 0);
      const duplicate = await notify.processPayFastNotification(new Request("https://test.invalid"), notification());
      assert.equal(duplicate.duplicate, true);
      const [payment] = await database.select().from(schema.payments);
      assert.equal(payment.provider, "payfast-sandbox"); assert.equal(payment.status, "paid"); assert.ok(payment.verifiedAt);
      assert.equal((await postgres.query<any>("select count(*)::int as n from bobgo_order_sync")).rows[0].n, 0);
      await assert.rejects(service.checkout(order.orderNumber, "https://test.invalid"), /closed/);
    });
    const parcel = { weightGrams: 412, lengthCm: 25, widthCm: 20.5, heightCm: 3.5 };
    let rate: any;
    await t.test("manual saved collection and dimensions are required; quotes alone cannot book", async () => {
      await postgres.query("update orders set status='ready' where id=$1", [order.id]);
      await assert.rejects(shipping.getCourierQuotes(order.orderNumber, parcel, false), /Test payments/);
      const plan = { version: 1, collection: { kind: "pickup_point", contact: { name: "TEST Sender", email: "sender@example.invalid", phone: "0821234567" }, point: { id: "42", providerSlug: "ie", name: "Manually chosen TEST point" } },
        delivery: { kind: "door", contact: input.contact, address: { ...input.address, company: "", province: "Western Cape" } }, collectionInstructions: "", deliveryInstructions: "", customerApprovedPickup: false };
      await postgres.query("update orders set courier_plan=$1::jsonb where id=$2", [JSON.stringify(plan), order.id]);
      rate = (await shipping.getCourierQuotes(order.orderNumber, parcel, false)).rates[0];
      assert.equal(rate.amount, 87.65);
      await assert.rejects(shipping.bookCourierShipment(order.orderNumber, rate.quoteToken), /compare quotes only/);
      assert.equal(calls.filter(call => call.path === "/shipments").length, 0);
      await assert.rejects(service.approve(order.orderNumber, rate.quoteToken, 1, owner.email), /exact fresh quote/);
    });
    await t.test("only the exact explicitly approved quote can book once; Test Test reaches Bob Go", async () => {
      const approval = await service.approve(order.orderNumber, rate.quoteToken, rate.amount, owner.email);
      await assert.rejects(shipping.bookCourierShipment(order.orderNumber, rate.quoteToken, "forged"), /compare quotes only/);
      const booked = await shipping.bookCourierShipment(order.orderNumber, rate.quoteToken, approval.costApproval);
      assert.equal(booked.booked, true);
      const body = calls.find(call => call.path === "/shipments")!.body;
      assert.equal(body.delivery_contact_name, "Test"); assert.equal(body.delivery_contact_surname, "Test");
      assert.equal(body.collection_pickup_point_location_id, 42); assert.equal(body.selected_rate_request_id, 1234);
      assert.equal(body.parcels[0].submitted_width_cm, 20.5);
      await assert.rejects(shipping.bookCourierShipment(order.orderNumber, rate.quoteToken, approval.costApproval));
      assert.equal(calls.filter(call => call.path === "/shipments").length, 1);
      assert.equal(calls.filter(call => /^\/orders(?:\?|$)/.test(call.path)).length, 0);
    });
    await t.test("normal sandbox orders stay blocked even when the owner test is enabled", async () => {
      const previous = order.orderNumber;
      await postgres.query("update orders set order_number='MM-ORDINARY-SANDBOX' where id=$1", [order.id]);
      await assert.rejects(shipping.getCourierQuotes("MM-ORDINARY-SANDBOX", parcel, false), /Test payments/);
      await postgres.query("update orders set order_number=$1 where id=$2", [previous, order.id]);
    });
    await t.test("test cancellation remains available after disabling/expiry, but cannot rebook", async () => {
      await assert.rejects(service.archive(owner.email), /Confirm cancellation/);
      process.env.LIVE_COURIER_TEST_ENABLED = "false";
      await postgres.query(`update order_delivery_history set after=jsonb_set(after,'{expiresAt}','0') where action='live_courier_test_created'`);
      const [current] = await database.select().from(schema.orders);
      const input = { action: "cancel_waybill", expectedRevision: current.deliveryRevision, expectedWaybill: remote.tracking_reference, confirm: true };
      await changes.change(order.orderNumber, input, owner.email);
      assert.equal(calls.filter(call => call.path === "/shipments/cancel").length, 1);
      const [after] = await database.select().from(schema.orders);
      await assert.rejects(changes.change(order.orderNumber, { ...input, action: "prepare_replacement", expectedRevision: after.deliveryRevision }, owner.email), /cannot create a replacement/);
      assert.equal(emailCalls, 0); assert.equal(stockCalls, 0);
      await service.archive(owner.email);
      assert.ok((await service.current()).archivedAt);
      assert.equal((await service.create(input, owner.email).catch(() => null)), null, "Disabling prevents another TEST");
    });
    await t.test("an uncertain TEST booking consumes the one attempt and never retries", async () => {
      // Reset only this isolated fixture to exercise the alternative outcome.
      process.env.LIVE_COURIER_TEST_ENABLED = "true"; bookingTimeout = true;
      await postgres.query(`update order_delivery_history set after=jsonb_set(after,'{expiresAt}',to_jsonb($1::bigint)) where action='live_courier_test_created'`, [Date.now() + 3600000]);
      await postgres.query("delete from order_delivery_history where action='live_courier_test_booking_started'");
      await postgres.query("delete from shipments");
      await postgres.query("update orders set status='ready', archived_at=null, tracking_number=null, tracking_url=null, courier_name=null");
      const quote = (await shipping.getCourierQuotes(order.orderNumber, parcel, false)).rates[0];
      const approval = await service.approve(order.orderNumber, quote.quoteToken, quote.amount, owner.email);
      const count = calls.filter(call => call.path === "/shipments").length;
      await assert.rejects(shipping.bookCourierShipment(order.orderNumber, quote.quoteToken, approval.costApproval), /Do not book again/);
      await assert.rejects(shipping.bookCourierShipment(order.orderNumber, quote.quoteToken, approval.costApproval));
      assert.equal(calls.filter(call => call.path === "/shipments").length, count + 1);
      assert.equal((await postgres.query<any>("select status from shipments")).rows[0].status, "booking");
      await assert.rejects(service.archive(owner.email), /uncertain booking/);
    });
  } finally {
    globalThis.fetch = previousFetch;
    keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; });
    await postgres.close();
  }
});
