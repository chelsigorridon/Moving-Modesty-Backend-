/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated cookie fixtures with synthetic secrets only. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { adminClientFixture } from "./helpers/admin-client.ts";

const require = createRequire(import.meta.url);
function cookieModule(env: Record<string, string>) {
  const loaded = { exports: {} as any };
  const code = ts.transpileModule(readFileSync(new URL("../lib/admin-cookie.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", "process", code)(require, loaded, loaded.exports, { env });
  return loaded.exports;
}

test("secure admin hosting requires the exact HTTPS API domain, trusted origins and an unambiguous host-only cookie", () => {
  const env = { NODE_ENV: "production", STORE_URL: "https://movingmodesty.com", ADMIN_API_URL: "https://api.movingmodesty.com", AUTH_SECRET: "TEST-ONLY-NOT-A-REAL-SECRET" };
  const cookie = cookieModule(env);
  const request = () => new Request("https://api.movingmodesty.com/api/admin/login", { method: "POST", headers: { origin: "https://movingmodesty.com", "Sec-Fetch-Site": "same-site" } });
  assert.equal(cookie.adminCookieHostingReady(request()), true);
  for (const url of ["", "https://movingmodesty.vercel.app", "http://api.movingmodesty.com", "https://api.movingmodesty.com.evil.test", "https://api.movingmodesty.com/path"]) {
    env.ADMIN_API_URL = url;
    assert.equal(cookie.adminCookieHostingReady(request()), false, url);
  }
  env.ADMIN_API_URL = "https://api.movingmodesty.com";
  assert.equal(cookie.adminCookieHostingReady(new Request("https://movingmodesty.vercel.app/api/admin/login")), false);
  const token = "mm2_" + "A".repeat(43), csrf = cookie.adminCsrfToken(token);
  const change = (headers: Record<string, string>) => new Request(request().url, { method: "PATCH", headers });
  assert.equal(cookie.adminMutationAllowed(change({ origin: "https://movingmodesty.com", "X-MM-CSRF": csrf }), token), true);
  for (const headers of [{ origin: "https://evil.test", "X-MM-CSRF": csrf }, { origin: "https://movingmodesty.com" }, { "X-MM-CSRF": csrf },
    { origin: "https://movingmodesty.com", "X-MM-CSRF": csrf, "Sec-Fetch-Site": "cross-site" }]) {
    assert.equal(cookie.adminMutationAllowed(change(headers as Record<string, string>), token), false);
  }
  assert.equal(cookie.requestAdminCookie(new Request(request().url, { headers: { cookie: `${cookie.adminCookieName()}=${token}; ${cookie.adminCookieName()}=other` } })), "");
  assert.match(cookie.adminSessionCookie(token), /; HttpOnly; SameSite=Lax; Secure$/);
  assert.doesNotMatch(cookie.adminSessionCookie(token), /Domain=/);
});

test("the shared admin transport never exposes a session token and does not submit after authentication failure", async () => {
  const dom = new JSDOM("", { url: "https://movingmodesty.com/admin" });
  dom.window.sessionStorage.setItem("moving_modesty_admin_token", "RETIRED-TEST-TOKEN");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let authenticated = true;
  const client = adminClientFixture((async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return url.endsWith("/session") ? Response.json(authenticated ? { csrfToken: "A".repeat(43) } : {}, { status: authenticated ? 200 : 401 }) : Response.json({ authenticated: true });
  }) as typeof fetch, dom.window);
  try {
    const base = "https://api.movingmodesty.com/api/admin";
    await client.adminRequest(`${base}/data`, { headers: { Authorization: "Bearer RETIRED-TEST-TOKEN" } });
    await Promise.all([client.adminRequest(`${base}/TEST`, { method: "POST" }), client.adminRequest(`${base}/TEST`, { method: "PATCH" })]);
    assert.equal(calls.filter(call => call.url.endsWith("/session")).length, 1);
    for (const call of calls) {
      assert.equal(call.init.credentials, "include");
      assert.equal(new Headers(call.init.headers).has("Authorization"), false);
      if (["POST", "PATCH"].includes(call.init.method || "")) assert.equal(new Headers(call.init.headers).get("X-MM-CSRF"), "A".repeat(43));
    }
    assert.equal(dom.window.sessionStorage.getItem("moving_modesty_admin_token"), null);
    await client.adminRequest(`${base}/logout`, { method: "POST" });
    authenticated = false;
    const count = calls.length;
    assert.equal((await client.adminRequest(`${base}/TEST`, { method: "POST" })).status, 401);
    assert.equal(calls.length, count + 1);
    assert.ok(calls.at(-1)!.url.endsWith("/session"));
    const portal = readFileSync(new URL("../framer/AdminPortal.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(portal, /Bearer|data\.token|sessionStorage\.setItem\("moving_modesty_admin_token"/);
    const block = portal.split("// BEGIN GENERATED ADMIN CLIENT\n")[1].split("// END GENERATED ADMIN CLIENT")[0].trim();
    assert.equal(block, readFileSync(new URL("../lib/admin-client.ts", import.meta.url), "utf8").replace(/^export /gm, "").trim());
  } finally { dom.window.close(); }
});
