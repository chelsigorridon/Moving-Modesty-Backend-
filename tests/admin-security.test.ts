/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated authentication tests; no production keys or live provider requests. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, scryptSync } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
import { apiOriginAllowed, apiSecurityHeaders } from "../lib/api-security.ts";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("browser API access is exact-origin, not a wildcard, and provider requests remain supported", () => {
  const request = (origin?: string) => new Request("https://movingmodesty.vercel.app/api/admin/data", { headers: origin ? { origin } : {} });
  const origin = process.env.STORE_URL || "https://holistic-brand-492217.framer.app";
  assert.equal(apiOriginAllowed(request(new URL(origin).origin)), true);
  for (const hostile of ["https://evil.example", "null", new URL(origin).origin + ".evil.example", new URL(origin).origin + "/path"]) {
    assert.equal(apiOriginAllowed(request(hostile)), false);
    assert.equal(apiSecurityHeaders(request(hostile)).has("Access-Control-Allow-Origin"), false);
  }
  assert.equal(apiOriginAllowed(request()), true);
  assert.equal(apiSecurityHeaders(request()).has("Access-Control-Allow-Origin"), false);
  assert.equal(apiSecurityHeaders(request(new URL(origin).origin)).get("Access-Control-Allow-Origin"), new URL(origin).origin);
  assert.equal(apiSecurityHeaders(request()).get("X-Content-Type-Options"), "nosniff");
  assert.equal(apiSecurityHeaders(request()).get("Referrer-Policy"), "no-referrer");
  assert.match(apiSecurityHeaders(request()).get("Content-Security-Policy")!, /frame-ancestors 'none'/);
});

test("every admin route awaits the durable session check", () => {
  function walk(directory: string) {
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, file.name);
      if (file.isDirectory()) walk(path);
      else if (file.name === "route.ts") {
        const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
        function check(node: ts.Node) {
          if (ts.isCallExpression(node) && node.expression.getText(source) === "getRequestAdmin") assert.ok(ts.isAwaitExpression(node.parent), path + " must await authentication");
          ts.forEachChild(node, check);
        }
        check(source);
      }
    }
  }
  walk(resolve(root, "app/api/admin"));
});

test("sessions are revocable, environment-bound and fail closed; login limits persist across instances", async () => {
  const postgres = new PGlite();
  const database = require("drizzle-orm/pglite").drizzle(postgres);
  const cache = new Map<string, any>();
  const fakeProcess = { env: { NODE_ENV: "test", VERCEL_ENV: "production", ADMIN_EMAIL: "owner@example.test",
    STORE_URL: "https://store.example.test", ADMIN_API_URL: "https://api.store.example.test",
    AUTH_SECRET: "TEST-ONLY-NOT-A-REAL-KEY", ADMIN_PASSWORD_HASH: "test-salt:" + scryptSync("TEST-ONLY-PASSWORD", "test-salt", 64).toString("hex") } };
  let databaseAvailable = true;
  function load(file: string): any {
    const absolute = resolve(root, file);
    if (/lib[\\/]db(?:[\\/]index)?\.ts$/.test(absolute)) return { requireDatabase: () => { if (!databaseAvailable) throw new Error("TEST database outage"); return database; } };
    if (/lib[\\/]monitoring\.ts$/.test(absolute)) return { reportFailure: async () => ({ reference: "TEST-REF" }) };
    if (cache.has(absolute)) return cache.get(absolute);
    const testModule = { exports: {} };
    cache.set(absolute, testModule.exports);
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = (name: string) => {
      if (name === "next/headers") return { cookies: async () => ({ get: () => null, set() {} }), headers: async () => new Headers({ "x-vercel-forwarded-for": "TEST-CONCURRENT" }) };
      if (name === "next/navigation") return { redirect: () => { throw new Error("TEST redirect"); } };
      if (name.startsWith("@/")) return load(name.slice(2) + ".ts");
      if (name.startsWith(".")) return load(resolve(dirname(absolute), name) + ".ts");
      return require(name);
    };
    new Function("require", "module", "exports", "process", compiled)(localRequire, testModule, testModule.exports, fakeProcess);
    return testModule.exports;
  }
  try {
    for (const file of readdirSync(resolve(root, "drizzle")).filter(file => /^\d{4}_.*\.sql$/.test(file)).sort()) {
      for (const statement of readFileSync(resolve(root, "drizzle", file), "utf8").split("--> statement-breakpoint")) if (statement.trim()) await postgres.exec(statement);
    }
    const auth = load("lib/auth.ts");
    const schema = load("lib/db/schema.ts");
    const { eq, sql } = require("drizzle-orm");
    assert.equal(await auth.authenticateAdmin("OWNER@example.test", "TEST-ONLY-PASSWORD"), true);
    assert.equal(await auth.authenticateAdmin("other@example.test", "TEST-ONLY-PASSWORD"), false);
    assert.equal(await auth.authenticateAdmin("owner@example.test", "wrong"), false);
    const token = await auth.issueAdminApiToken("owner@example.test");
    assert.match(token, /^mm2_[A-Za-z0-9_-]{43}$/);
    assert.equal((await auth.verifyAdminApiToken(token)).role, "owner");
    const [ownerRow] = await database.select().from(schema.adminUsers);
    const retiredToken = "mm2_" + "X".repeat(43);
    const retiredHash = createHmac("sha256", fakeProcess.env.AUTH_SECRET).update(JSON.stringify([
      "admin-session-v2", "production", fakeProcess.env.ADMIN_EMAIL, fakeProcess.env.ADMIN_PASSWORD_HASH, retiredToken,
    ])).digest("hex");
    await database.insert(schema.adminSessions).values({ adminUserId: ownerRow.id, tokenHash: retiredHash, expiresAt: new Date(Date.now() + 3600000) });
    assert.equal(await auth.verifyAdminApiToken(retiredToken), null, "Retired browser-readable sessions cannot be repurposed as cookies");
    assert.doesNotMatch(JSON.stringify(await database.select().from(schema.adminSessions)), new RegExp(token));
    assert.equal(await auth.verifyAdminApiToken(token + ".extra"), null);
    assert.equal(await auth.verifyAdminApiToken("old.signed-token"), null);
    fakeProcess.env.VERCEL_ENV = "preview";
    assert.equal(await auth.verifyAdminApiToken(token), null);
    fakeProcess.env.VERCEL_ENV = "production";
    const originalHash = fakeProcess.env.ADMIN_PASSWORD_HASH;
    fakeProcess.env.ADMIN_PASSWORD_HASH = "different:" + "ab".repeat(64);
    assert.equal(await auth.verifyAdminApiToken(token), null);
    fakeProcess.env.ADMIN_PASSWORD_HASH = originalHash;
    await auth.revokeAdminApiToken(token);
    assert.equal(await auth.verifyAdminApiToken(token), null);
    const token2 = await auth.issueAdminApiToken("owner@example.test");
    await database.update(schema.adminSessions).set({ expiresAt: new Date(0) });
    assert.equal(await auth.verifyAdminApiToken(token2), null);
    const token3 = await auth.issueAdminApiToken("owner@example.test");
    await database.update(schema.adminUsers).set({ active: false });
    assert.equal(await auth.verifyAdminApiToken(token3), null);
    // Checkout shares durable storage, but not the login counters. Spoofable
    // forwarded headers cannot bypass a trusted client bucket.
    const checkoutLimit = load("lib/checkout-rate-limit.ts");
    const checkoutRequest = () => new Request("https://api.test", { headers: { "x-vercel-forwarded-for": "CHECKOUT-CLIENT", "x-forwarded-for": Math.random().toString() } });
    const attempts = await Promise.all(Array.from({ length: 65 }, () => checkoutLimit.consumeCheckoutAttempt(checkoutRequest(), "save")));
    assert.equal(attempts.filter(value => value.allowed).length, 60);
    assert.ok(attempts.filter(value => !value.allowed).every(value => value.retryAfter > 0 && value.retryAfter <= 900));
    cache.delete(resolve(root, "lib/checkout-rate-limit.ts"));
    assert.equal((await load("lib/checkout-rate-limit.ts").consumeCheckoutAttempt(checkoutRequest(), "save")).allowed, false);
    assert.equal((await checkoutLimit.consumeCheckoutAttempt(checkoutRequest(), "recover")).allowed, true);
    assert.doesNotMatch(JSON.stringify(await database.select().from(schema.diagnosticRateLimits)), /CHECKOUT-CLIENT/);
    await database.update(schema.diagnosticRateLimits).set({ expiresAt: new Date(0) });
    assert.equal((await checkoutLimit.consumeCheckoutAttempt(checkoutRequest(), "save")).allowed, true);
    databaseAvailable = false;
    await assert.rejects(checkoutLimit.consumeCheckoutAttempt(checkoutRequest(), "save"), /outage/);
    databaseAvailable = true;
    await assert.rejects(auth.issueAdminApiToken("owner@example.test"), /disabled/);
    await database.update(schema.adminUsers).set({ active: true });
    databaseAvailable = false;
    assert.equal(await auth.getRequestAdmin(new Request("https://api.test", { headers: { authorization: `Bearer ${token3}` } })), null);
    databaseAvailable = true;
    const loginRequest = (ip: string) => new Request("https://api.test", { headers: { "x-vercel-forwarded-for": ip } });
    for (let index = 0; index < 8; index++) assert.equal((await auth.consumeAdminLoginAttempt(loginRequest("TEST-IP"), "owner@example.test")).allowed, true);
    cache.delete(resolve(root, "lib/auth.ts"));
    const otherInstance = load("lib/auth.ts");
    const blocked = await otherInstance.consumeAdminLoginAttempt(loginRequest("TEST-IP"), "owner@example.test");
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= 900);
    assert.doesNotMatch(JSON.stringify(await database.select().from(schema.diagnosticRateLimits)), /TEST-IP|owner@example/);
    await database.update(schema.diagnosticRateLimits).set({ expiresAt: new Date(0) });
    assert.equal((await otherInstance.consumeAdminLoginAttempt(loginRequest("TEST-IP"), "owner@example.test")).allowed, true);
    await database.delete(schema.diagnosticRateLimits);
    const results = await Promise.all(Array.from({ length: 15 }, () => auth.consumeAdminLoginAttempt(loginRequest("TEST-CONCURRENT"), "owner@example.test")));
    assert.equal(results.filter(result => result.allowed).length, 8);
    const login = load("app/api/admin/login/route.ts");
    const loginBody = JSON.stringify({ email: "owner@example.test", password: "TEST-ONLY-PASSWORD" });
    const makeLogin = (body = loginBody, ip = "TEST-CONCURRENT") => new Request("https://api.store.example.test/api/admin/login", { method: "POST", headers: { origin: "https://store.example.test", "content-type": "application/json", "x-vercel-forwarded-for": ip }, body });
    const limited = await login.POST(makeLogin());
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("Retry-After")) > 0);
    const legacyForm = new FormData();
    legacyForm.set("email", "owner@example.test"); legacyForm.set("password", "TEST-ONLY-PASSWORD");
    assert.match((await load("app/login/actions.ts").loginAction({}, legacyForm)).error, /Too many/);
    assert.equal((await login.POST(makeLogin("{"))).status, 400);
    assert.equal((await login.POST(makeLogin("x".repeat(5000)))).status, 413);
    await database.delete(schema.diagnosticRateLimits);
    const signedIn = await login.POST(makeLogin());
    assert.equal(signedIn.status, 200);
    const signedInData = await signedIn.json();
    assert.equal(signedInData.authenticated, true);
    assert.equal(signedInData.token, undefined);
    const cookie = signedIn.headers.get("set-cookie")!;
    assert.match(cookie, /^__Host-moving_modesty_admin=mm2_/);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=43200", "Path=/"]) assert.ok(cookie.includes(flag));
    assert.doesNotMatch(cookie, /Domain=/i);
    const cookiePair = cookie.split(";")[0], cookieToken = cookiePair.split("=")[1];
    assert.equal((await auth.verifyAdminApiToken(cookieToken)).role, "owner");
    const session = load("app/api/admin/session/route.ts");
    const read = new Request("https://api.store.example.test/api/admin/session", { headers: { cookie: cookiePair, origin: "https://store.example.test" } });
    const sessionData = await (await session.GET(read)).json();
    assert.match(sessionData.csrfToken, /^[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(JSON.stringify(sessionData), new RegExp(cookieToken));
    assert.equal((await auth.getRequestAdmin(read)).role, "owner");
    assert.equal(await auth.getRequestAdmin(new Request(read.url, { headers: { authorization: `Bearer ${cookieToken}` } })), null);
    for (const origin of ["https://evil.test", "https://store.example.test.evil.test", "null"]) {
      assert.equal((await login.POST(new Request(read.url, { method: "POST", headers: { origin }, body: loginBody }))).status, 403);
      assert.equal(await auth.getRequestAdmin(new Request(read.url, { headers: { cookie: cookiePair, origin } })), null);
    }
    assert.equal((await login.POST(new Request(read.url, { method: "POST", body: loginBody }))).status, 403);
    const unsafe = (extra: Record<string, string> = {}) => new Request(read.url, { method: "POST", headers: { cookie: cookiePair, origin: "https://store.example.test", ...extra } });
    assert.equal(await auth.getRequestAdmin(unsafe()), null);
    assert.equal(await auth.getRequestAdmin(unsafe({ "X-MM-CSRF": "A".repeat(43) })), null);
    assert.equal(await auth.getRequestAdmin(unsafe({ "X-MM-CSRF": sessionData.csrfToken, "Sec-Fetch-Site": "cross-site" })), null);
    databaseAvailable = false;
    const unavailable = await login.POST(makeLogin());
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).errorRef, "TEST-REF");
    databaseAvailable = true;
    const logout = load("app/api/admin/logout/route.ts");
    assert.equal((await logout.POST(unsafe())).status, 401);
    assert.equal((await auth.verifyAdminApiToken(cookieToken)).role, "owner");
    const response = await logout.POST(unsafe({ "X-MM-CSRF": sessionData.csrfToken }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal(await auth.verifyAdminApiToken(cookieToken), null);
    fakeProcess.env.ADMIN_API_URL = "https://movingmodesty.vercel.app";
    assert.equal((await login.POST(makeLogin())).status, 503);
    fakeProcess.env.ADMIN_API_URL = "https://api.store.example.test";
    assert.equal((await load("app/api/admin/orders/[orderNumber]/trace/route.ts").GET(new Request("https://api.test"), { params: Promise.resolve({ orderNumber: "TEST" }) })).status, 401);
    // Unrelated private fields never appear in a per-order support trace.
    const [order] = await database.insert(schema.orders).values({ orderNumber: "MM-TEST-TRACE", subtotal: "420", total: "519", checkoutToken: "PRIVATE-CHECKOUT-TOKEN",
      customerSnapshot: { firstName: "SECRET", lastName: "SECRET", email: "PRIVATE-EMAIL", phone: "PRIVATE-PHONE" } }).returning();
    await database.insert(schema.payments).values({ orderId: order.id, merchantPaymentId: order.orderNumber, amount: "519", providerStatus: "CUSTOMER_RETURNED" });
    const trace = await load("lib/order-trace.ts").getOrderTrace(order.orderNumber);
    assert.equal(trace.payment.merchantPaymentId, order.orderNumber);
    assert.doesNotMatch(JSON.stringify(trace), /PRIVATE-|SECRET|checkoutToken|customerSnapshot/);
    await database.update(schema.orders).set({ archivedAt: new Date() }).where(eq(schema.orders.id, order.id));
    assert.equal(await load("lib/order-trace.ts").getOrderTrace(order.orderNumber), null);
    assert.ok(sql); // This harness uses PostgreSQL's real advisory-lock and upsert operations.
  } finally { await postgres.close(); }
});
