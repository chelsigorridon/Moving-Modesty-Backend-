/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated PostgreSQL and authenticated-route fixtures; no live services. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

const require = createRequire(import.meta.url), root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("technical alerts are private, paginated, explicitly reviewed and recurrence-safe without modifying orders or waybills", async t => {
  const postgres = new PGlite(), database = require("drizzle-orm/pglite").drizzle(postgres);
  let authorized = true, databaseAvailable = true;
  const cache = new Map<string, any>();
  function load(file: string): any {
    const absolute = resolve(root, file);
    if (/lib[\\/]db(?:[\\/]index)?\.ts$/.test(absolute)) return { requireDatabase: () => { if (!databaseAvailable) throw new Error("TEST private SQL outage"); return database; } };
    if (/lib[\\/]auth\.ts$/.test(absolute)) return { getRequestAdmin: async () => authorized };
    if (cache.has(absolute)) return cache.get(absolute);
    const compiledModule = { exports: {} }; cache.set(absolute, compiledModule.exports);
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = (name: string) => name.startsWith("@/") ? load(name.slice(2) + ".ts")
      : name.startsWith(".") ? load(resolve(dirname(absolute), name) + ".ts") : require(name);
    new Function("require", "module", "exports", "process", compiled)(localRequire, compiledModule, compiledModule.exports, { env: {} });
    return compiledModule.exports;
  }
  const getRequest = (query = "") => new Request("https://api.test.invalid/api/admin/diagnostics" + query);
  const patchRequest = (body: unknown) => new Request("https://api.test.invalid/api/admin/diagnostics", { method: "PATCH", body: JSON.stringify(body) });
  try {
    for (const { tag } of JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")).entries) {
      for (const statement of readFileSync(resolve(root, `drizzle/${tag}.sql`), "utf8").split("--> statement-breakpoint")) if (statement.trim()) await postgres.exec(statement);
    }
    const schema = load("lib/db/schema.ts"), { orders, shipments, systemErrors } = schema;
    const { eq } = require("drizzle-orm");
    const [order] = await database.insert(orders).values({ orderNumber: "MM-ALERT-TEST", subtotal: "450", total: "549", deliveryFee: "99", paymentStatus: "paid", status: "ready", deliveryMethod: "courier", trackingNumber: "TEST-DO-NOT-CHANGE" }).returning();
    await database.insert(shipments).values({ orderId: order.id, status: "booked", trackingNumber: "TEST-DO-NOT-CHANGE", waybillReference: "TEST-DO-NOT-CHANGE" });
    const before = JSON.stringify({ orders: await database.select().from(orders), shipments: await database.select().from(shipments) });
    const [general] = await database.insert(systemErrors).values({ fingerprint: "TEST-admin-login", reference: randomUUID(), source: "admin", operation: "admin_login", code: "unexpected", summary: "An unexpected application error interrupted the operation.", severity: "error", environment: "production", occurrences: 1 }).returning();
    const [related] = await database.insert(systemErrors).values({ fingerprint: "TEST-courier", reference: randomUUID(), orderId: order.id, source: "courier", operation: "courier_quote", code: "provider_auth", summary: "The connection was rejected.", severity: "error", environment: "production", occurrences: 2 }).returning();
    const route = load("app/api/admin/diagnostics/route.ts");
    const resolution = { id: general.id, confirmed: true, expectedOccurrences: 1 };
    await t.test("GET and PATCH reject missing sessions before database access", async () => {
      authorized = false; databaseAvailable = false;
      assert.equal((await route.GET(getRequest())).status, 401);
      assert.equal((await route.PATCH(patchRequest(resolution))).status, 401);
      authorized = true; databaseAvailable = true;
    });
    await t.test("safe detail includes general and order-specific alerts, not customer data or provider secrets", async () => {
      const response = await route.GET(getRequest("?status=open&page=0"));
      assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
      const data = await response.json(); assert.equal(data.incidents.length, 2);
      assert.deepEqual(data.counts, { open: 2, resolved: 0 });
      assert.equal(data.incidents.find((item: any) => item.id === general.id).orderNumber, null);
      assert.equal(data.incidents.find((item: any) => item.id === related.id).orderNumber, order.orderNumber);
      assert.doesNotMatch(JSON.stringify(data), /customerSnapshot|checkoutToken|fingerprint|API_TOKEN|recipient/);
    });
    await t.test("review confirmation and a positive version are required, with no extra mutation fields", async () => {
      for (const body of [null, {}, { id: general.id }, { ...resolution, confirmed: false }, { ...resolution, expectedOccurrences: 0 }, { ...resolution, expectedOccurrences: 1.2 }, { ...resolution, status: "cancelled" }]) {
        assert.equal((await route.PATCH(patchRequest(body))).status, 400);
      }
      assert.equal((await database.select().from(systemErrors).where(eq(systemErrors.id, general.id)))[0].resolvedAt, null);
      assert.equal((await route.PATCH(new Request("https://api.test.invalid/api/admin/diagnostics", { method: "PATCH", body: "not JSON" }))).status, 400);
    });
    await t.test("resolution preserves the incident and moves it into resolved history; repeat submissions are idempotent", async () => {
      assert.deepEqual(await (await route.PATCH(patchRequest(resolution))).json(), { resolved: true });
      const [record] = await database.select().from(systemErrors).where(eq(systemErrors.id, general.id));
      assert.ok(record.resolvedAt); assert.equal(record.occurrences, 1); assert.equal(record.reference, general.reference);
      assert.equal((await (await route.GET(getRequest("?status=open"))).json()).incidents.length, 1);
      const history = await (await route.GET(getRequest("?status=resolved"))).json();
      assert.equal(history.incidents[0].id, general.id); assert.deepEqual(history.counts, { open: 1, resolved: 1 });
      assert.deepEqual(await (await route.PATCH(patchRequest(resolution))).json(), { resolved: true, alreadyResolved: true });
      assert.equal((await database.select().from(systemErrors).where(eq(systemErrors.id, general.id)))[0].resolvedAt.getTime(), record.resolvedAt.getTime());
    });
    await t.test("a recurrence rejects stale review, remains open, and requires another checked version", async () => {
      await database.update(systemErrors).set({ occurrences: 2, lastSeenAt: new Date(), resolvedAt: null }).where(eq(systemErrors.id, general.id));
      assert.equal((await route.PATCH(patchRequest(resolution))).status, 409);
      assert.equal((await database.select().from(systemErrors).where(eq(systemErrors.id, general.id)))[0].resolvedAt, null);
      assert.equal((await route.PATCH(patchRequest({ ...resolution, expectedOccurrences: 2 }))).status, 200);
      assert.equal((await route.PATCH(patchRequest({ ...resolution, id: randomUUID() }))).status, 404);
    });
    await t.test("pagination reaches all older alerts and validates query parameters", async () => {
      await database.insert(systemErrors).values(Array.from({ length: 55 }, (_, index) => ({ fingerprint: `TEST-history-${index}`, reference: randomUUID(), source: "admin", operation: "admin_load", code: "unexpected", summary: "TEST historical event", severity: "warning", environment: "preview", resolvedAt: new Date(), lastSeenAt: new Date("2026-01-01") })));
      const first = await (await route.GET(getRequest("?status=resolved&page=0"))).json();
      const second = await (await route.GET(getRequest("?status=resolved&page=1"))).json();
      assert.equal(first.incidents.length, 50); assert.equal(first.pagination.hasMore, true);
      assert.equal(second.incidents.length, 6); assert.equal(second.pagination.hasMore, false);
      assert.equal(new Set([...first.incidents, ...second.incidents].map(item => item.id)).size, 56);
      assert.deepEqual(first.counts, { open: 1, resolved: 56 });
      for (const query of ["?status=unknown", "?page=-1", "?page=0.5", "?page=1000000", "?page=Infinity"]) assert.equal((await route.GET(getRequest(query))).status, 400);
    });
    await t.test("database failure is not false success and never exposes internals", async () => {
      databaseAvailable = false;
      for (const response of [await route.GET(getRequest()), await route.PATCH(patchRequest(resolution))]) {
        assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private SQL/);
      }
      databaseAvailable = true;
    });
    assert.equal(JSON.stringify({ orders: await database.select().from(orders), shipments: await database.select().from(shipments) }), before);
    assert.equal((await database.select().from(schema.bobgoOrderSync)).length, 0);
  } finally { await postgres.close(); }
});
