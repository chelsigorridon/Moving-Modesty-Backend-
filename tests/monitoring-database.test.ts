/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated PostgreSQL/provider test harness; never calls live services. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
import { classifyError, notificationDeliveryMessage } from "../lib/monitoring-policy.ts";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("error classification never returns raw SQL, credentials or customer details", () => {
  assert.equal(classifyError({ cause: { code: "42703", message: "SECRET sql params" } }), "database_query");
  assert.equal(classifyError({ code: "ECONNRESET" }), "database_unavailable");
  assert.equal(classifyError({ name: "TimeoutError" }), "timeout");
  assert.equal(classifyError({ status: 403, message: "SECRET token" }), "provider_auth");
  assert.equal(classifyError({ name: "PayFastNotificationError", stage: "signature" }), "payment_signature");
  assert.equal(classifyError(new Error("TEST customer test@example.com API SECRET")), "unexpected");
  assert.match(notificationDeliveryMessage("email.bounced", "paid-order-owner")!, /store notification email address/);
  assert.match(notificationDeliveryMessage("email.bounced", "paid-order-customer")!, /Contact the customer/);
});

test("durable incidents, capped alerts, signed delivery webhooks and browser telemetry fail safely", async () => {
  const postgres = new PGlite();
  const database = require("drizzle-orm/pglite").drizzle(postgres);
  const cache = new Map<string, any>();
  const sent: any[] = [], logs: string[] = [];
  let authorized = true, databaseAvailable = true, rejectAlert = false;
  const secret = "whsec_" + Buffer.from("TEST-WEBHOOK-SIGNING-SECRET").toString("base64");
  const fakeProcess = { env: { NODE_ENV: "test", VERCEL_ENV: "production", AUTH_SECRET: "TEST-NOT-A-REAL-SECRET", RESEND_API_KEY: "TEST-NOT-A-REAL-KEY", RESEND_WEBHOOK_SECRET: secret, ERROR_ALERT_EMAIL: "moody.tech@gmail.com", STORE_URL: "https://store.test" } };
  const verification = new (require("resend").Resend)("TEST-NOT-A-REAL-KEY").webhooks;
  function load(file: string): any {
    const absolute = resolve(root, file);
    if (/lib[\\/]db(?:[\\/]index)?\.ts$/.test(absolute)) return { db: database, requireDatabase: () => { if (!databaseAvailable) throw new Error("TEST database outage SECRET"); return database; } };
    if (/lib[\\/]auth\.ts$/.test(absolute)) return { getRequestAdmin: () => authorized };
    if (cache.has(absolute)) return cache.get(absolute);
    const compiledModule = { exports: {} };
    cache.set(absolute, compiledModule.exports);
    const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = (name: string) => {
      if (name === "server-only") return {};
      if (name === "resend") return { Resend: class { webhooks = verification; emails = { send: async (email: any, options: any) => { sent.push({ email, options }); return rejectAlert ? { error: { statusCode: 503 } } : { data: { id: `TEST-EMAIL-${sent.length}` } }; } }; } };
      if (name.startsWith("@/")) return load(name.slice(2) + ".ts");
      if (name.startsWith(".")) return load(resolve(dirname(absolute), name) + (name.endsWith(".ts") ? "" : name === "./db" ? "/index.ts" : ".ts"));
      return require(name);
    };
    new Function("require", "module", "exports", "process", "console", compiled)(localRequire, compiledModule, compiledModule.exports, fakeProcess, { error: (...values: unknown[]) => logs.push(values.join(" ")), warn: (...values: unknown[]) => logs.push(values.join(" ")) });
    return compiledModule.exports;
  }
  try {
    for (const migration of ["0000_amusing_wallop", "0001_ordinary_lord_tyger", "0002_past_lester", "0003_slippery_pet_avengers", "0004_checkout_customer_snapshot", "0005_nostalgic_wallow", "0006_clever_titania", "0007_archive_test_orders"]) {
      for (const statement of readFileSync(resolve(root, `drizzle/${migration}.sql`), "utf8").split("--> statement-breakpoint")) if (statement.trim()) await postgres.exec(statement);
    }
    const { orders, emailEvents, systemErrors, errorAlerts } = load("lib/db/schema.ts");
    const { eq } = require("drizzle-orm");
    const [order] = await database.insert(orders).values({ orderNumber: "MM-TEST-MONITORING", subtotal: "420", total: "420", paymentStatus: "paid", status: "ready", deliveryMethod: "collection" }).returning();
    const monitoring = load("lib/monitoring.ts");
    const first = await monitoring.reportFailure({ status: 403, message: "SECRET test@example.com 10 Private Street" }, { operation: "courier_quote", orderId: order.id });
    const second = await monitoring.reportFailure({ status: 403, message: "SECRET duplicate" }, { operation: "courier_quote", orderId: order.id });
    assert.equal(first.reference, second.reference);
    const [incident] = await database.select().from(systemErrors);
    assert.equal(incident.occurrences, 2);
    assert.equal(incident.orderId, order.id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].email.to, "moody.tech@gmail.com");
    assert.doesNotMatch(JSON.stringify(incident) + logs.join(" ") + JSON.stringify(sent), /SECRET|test@example\.com|Private Street/);
    const simultaneous = await Promise.all(Array.from({ length: 6 }, () => monitoring.reportFailure({ status: 403 }, { operation: "courier_quote", orderId: order.id })));
    assert.ok(simultaneous.every(result => result.reference === first.reference));
    assert.equal((await database.select().from(systemErrors))[0].occurrences, 8);
    assert.equal(sent.length, 1, "concurrent failures reserve only one alert");
    await monitoring.resolveFailures("courier_quote", order.id);
    assert.ok((await database.select().from(systemErrors))[0].resolvedAt);
    const diagnostics = load("app/api/admin/diagnostics/route.ts");
    authorized = false;
    assert.equal((await diagnostics.GET(new Request("https://api.test/api/admin/diagnostics"))).status, 401);
    authorized = true;
    const diagnosticResponse = await diagnostics.GET(new Request("https://api.test/api/admin/diagnostics"));
    assert.equal(diagnosticResponse.status, 200);
    assert.equal((await diagnosticResponse.json()).incidents[0].orderNumber, order.orderNumber);

    const [email] = await database.insert(emailEvents).values({ orderId: order.id, recipient: "test@example.com", template: "order-status:Ready", idempotencyKey: "TEST-email", resendEmailId: "TEST-PROVIDER-ID", status: "sent" }).returning();
    const webhook = load("app/api/webhooks/resend/route.ts");
    const payload = (type: string, date: string, emailId = "TEST-PROVIDER-ID", tags?: Record<string, string>) => ({ type, created_at: date, data: { email_id: emailId, to: ["SECRET-recipient@example.com"], failed: { reason: "SECRET provider details" }, tags } });
    function signed(value: unknown, valid = true) {
      const body = JSON.stringify(value), id = "msg_TEST", timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
      return new Request("https://api.test/api/webhooks/resend", { method: "POST", headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${valid ? signature : "INVALID"}` }, body });
    }
    const t0 = new Date().toISOString(), t1 = new Date(Date.now() + 1000).toISOString(), t2 = new Date(Date.now() + 2000).toISOString();
    assert.equal((await webhook.POST(signed(payload("email.bounced", t1), false))).status, 401);
    assert.equal((await database.select().from(emailEvents))[0].status, "sent");
    assert.equal((await webhook.POST(signed(payload("email.delivered", t0)))).status, 200);
    assert.equal((await database.select().from(emailEvents))[0].status, "delivered");
    assert.equal((await webhook.POST(signed(payload("email.bounced", t1)))).status, 200);
    const bounce = (await database.select().from(emailEvents))[0];
    assert.equal(bounce.status, "failed");
    assert.equal(bounce.deliveryEvent, "email.bounced");
    const alertCount = sent.length;
    assert.equal((await (await webhook.POST(signed(payload("email.bounced", t1)))).json()).ignored, true);
    assert.equal((await (await webhook.POST(signed(payload("email.delivered", t2)))).json()).ignored, true);
    assert.equal((await (await webhook.POST(signed(payload("email.failed", t0)))).json()).ignored, true);
    assert.equal(sent.length, alertCount);
    const snapshot = await load("lib/admin-data.ts").getAdminSnapshot();
    const current = snapshot.orders[0];
    assert.equal(current.notifications[0].retryable, false);
    assert.match(current.notifications[0].deliveryMessage, /Contact the customer/);
    assert.ok(current.actionNeeded.length);
    await assert.rejects(load("lib/email.ts").retryOrderNotification(current, email.id), /current stage/);
    const [queued] = await database.insert(emailEvents).values({ orderId: order.id, recipient: "test@example.com", template: "order-status:Ready", idempotencyKey: "TEST-early", status: "queued" }).returning();
    assert.equal((await webhook.POST(signed(payload("email.failed", t1, "TEST-EARLY-ID", { mm_event_id: queued.id })))).status, 200);
    assert.equal((await database.select().from(emailEvents).where(eq(emailEvents.id, queued.id)))[0].resendEmailId, "TEST-EARLY-ID");
    assert.equal((await (await webhook.POST(signed(payload("email.bounced", t1, "UNKNOWN-ID")))).json()).ignored, true);

    const browser = load("app/api/diagnostics/browser/route.ts");
    const browserRequest = (body: unknown, origin = "https://store.test") => new Request("https://api.test/api/diagnostics/browser", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await browser.POST(browserRequest({ surface: "checkout", code: "browser_network" }, "https://evil.test"))).status, 403);
    assert.equal((await browser.POST(browserRequest({ surface: "checkout", code: "browser_network", email: "SECRET", orderNumber: order.orderNumber }))).status, 400);
    const beforeBrowserAlerts = sent.length;
    for (let i = 0; i < 12; i++) assert.equal((await browser.POST(browserRequest({ surface: "checkout", code: "browser_network" }))).status, 202);
    assert.equal((await browser.POST(browserRequest({ surface: "checkout", code: "browser_network" }))).status, 429);
    assert.equal(sent.length, beforeBrowserAlerts);
    const [clientIncident] = await database.select().from(systemErrors).where(eq(systemErrors.source, "browser"));
    assert.equal(clientIncident.orderId, null);
    assert.equal(clientIncident.severity, "warning");
    rejectAlert = true;
    await monitoring.reportFailure({ status: 503 }, { operation: "admin_load" });
    assert.ok((await database.select().from(errorAlerts)).some((record: any) => record.status === "failed"));
    rejectAlert = false;
    for (const operation of ["contact_send", "checkout_save", "payment_start", "server_request"]) await monitoring.reportFailure(null, { operation });
    assert.ok((await database.select().from(errorAlerts)).length <= 5);
    assert.doesNotMatch(logs.join(" ") + JSON.stringify(await database.select().from(systemErrors)), /SECRET|recipient@example/);
    fakeProcess.env.VERCEL_ENV = "preview";
    const contact = { submissionId: "aef2aab4-2212-425f-a3bc-65203d14908e", name: "TEST Customer", email: "test@example.com", message: "TEST local enquiry" };
    rejectAlert = true;
    await assert.rejects(load("lib/email.ts").sendContactMessage(contact, "127.0.0.1"), /could not be submitted/);
    rejectAlert = false;
    await load("lib/email.ts").sendContactMessage(contact, "127.0.0.1");
    const generalEmailIncidents = await database.select().from(systemErrors).where(eq(systemErrors.operation, "email_send"));
    assert.ok(generalEmailIncidents.some((record: any) => record.orderId === null && record.resolvedAt));
    databaseAvailable = false;
    assert.equal((await monitoring.reportFailure(new Error("SECRET database failure"), { operation: "admin_load" })).persisted, false);
    assert.match(logs.join(" "), /incident_storage_unavailable/);
    assert.equal((await webhook.POST(signed(payload("email.delivered", t2)))).status, 503);
  } finally { await postgres.close(); }
});
