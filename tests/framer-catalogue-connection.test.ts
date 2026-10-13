import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  checkFramerCatalogueConnection, framerCatalogueProbeConfig, framerCatalogueProbeEnabled,
  framerCatalogueTrial, FramerCatalogueConnectionError, type FramerReadClient,
} from "../lib/framer-catalogue-connection.ts";

const environment = { FRAMER_CATALOGUE_PROBE_ENABLED: "true", FRAMER_API_KEY: "unit-test-key-not-a-real-credential", NODE_ENV: "development" };
function fakeClient() {
  const calls: string[] = [];
  const families = [{ id: framerCatalogueTrial.family.itemId, slug: framerCatalogueTrial.family.slug, draft: true, fieldData: {} }];
  const colours = framerCatalogueTrial.colours.itemIds.map(id => ({ id, slug: `test-${id.toLowerCase()}`, draft: true, fieldData: { pYtPN6BbP: { type: "collectionReference", value: String(framerCatalogueTrial.family.slug) } } }));
  const familyFields = Object.entries({ IfyAamPkQ: "string", FwwB_jdGf: "string", QCD37mBss: "image", JwOrGbD1G: "string", PG6hyVIXQ: "string", nfm6rxF_n: "boolean" }).map(([id, type]) => ({ id, name: id, type }));
  const colourFields = Object.entries({ di_ZSgtJG: "string", yKyjhVbqc: "image", Q88VSOk0y: "string", jOEelNszs: "string", MGJsDjY4H: "string", pYtPN6BbP: "collectionReference" }).map(([id, type]) => ({ id, name: id, type, ...(id === "pYtPN6BbP" ? { collectionId: String(framerCatalogueTrial.family.id) } : {}) }));
  const client: FramerReadClient = {
    getProjectInfo: async () => { calls.push("project.read"); return { id: framerCatalogueTrial.projectId, name: "Moving Modesty" }; },
    getCollection: async id => {
      calls.push(`collection.read:${id}`);
      assert.ok([framerCatalogueTrial.family.id, framerCatalogueTrial.colours.id].some(target => target === id), "Only isolated TEST collections may be read");
      const family = id === framerCatalogueTrial.family.id;
      return {
        id, name: family ? framerCatalogueTrial.family.name : framerCatalogueTrial.colours.name,
        getFields: async () => { calls.push("fields.read"); return family ? familyFields : colourFields; },
        getItems: async () => { calls.push("items.read"); return family ? families : colours; },
      };
    },
    disconnect: async () => { calls.push("disconnect"); },
  };
  return { client, calls, families, colours, familyFields, colourFields };
}

test("read-only probe is opt-in, server-only and blocked in Production", () => {
  assert.equal(framerCatalogueProbeEnabled({}), false);
  assert.equal(framerCatalogueProbeEnabled(environment), true);
  assert.equal(framerCatalogueProbeEnabled({ ...environment, VERCEL_ENV: "production" }), false);
  assert.equal(framerCatalogueProbeEnabled({ ...environment, NODE_ENV: "production" }), false);
  assert.equal(framerCatalogueProbeEnabled({ ...environment, NODE_ENV: "production", VERCEL_ENV: "preview" }), true);
});

test("missing keys and wrong project configuration stop before a network connection", async () => {
  let connected = false;
  const connector = async () => { connected = true; return fakeClient().client; };
  await assert.rejects(checkFramerCatalogueConnection({}, { connector }), error => error instanceof FramerCatalogueConnectionError && error.code === "DISABLED");
  await assert.rejects(checkFramerCatalogueConnection({ ...environment, FRAMER_API_KEY: " " }, { connector }), /FRAMER_API_KEY/);
  await assert.rejects(checkFramerCatalogueConnection({ ...environment, FRAMER_PROJECT_URL: "https://evil.example/projects/other" }, { connector }), /restricted/);
  await assert.rejects(checkFramerCatalogueConnection({ ...environment, FRAMER_PROJECT_URL: `${framerCatalogueTrial.projectUrl}?branch=other` }, { connector }), /restricted/);
  assert.equal(connected, false);
  assert.equal(framerCatalogueProbeConfig({ ...environment, FRAMER_PROJECT_URL: framerCatalogueTrial.projectId }).project, framerCatalogueTrial.projectId);
});

test("successful read verifies one family, two referenced colours and drafts without mutation", async () => {
  const fake = fakeClient();
  const before = JSON.stringify([fake.families, fake.colours]);
  const result = await checkFramerCatalogueConnection(environment, { connector: async (project, key) => {
    assert.equal(project, framerCatalogueTrial.projectUrl);
    assert.equal(key, environment.FRAMER_API_KEY);
    return fake.client;
  } });
  assert.equal(result.connected, true);
  assert.equal(result.trialReady, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.publishingEnabled, false);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.collections.map(collection => [collection.itemCount, collection.draftCount]), [[1, 1], [2, 2]]);
  assert.equal(JSON.stringify([fake.families, fake.colours]), before);
  assert.equal(fake.calls.at(-1), "disconnect");
  assert.equal(fake.calls.filter(call => call === "disconnect").length, 1);
  assert.ok(!JSON.stringify(result).includes(environment.FRAMER_API_KEY));
});

test("an enabled CMS record is flagged rather than changing its publishing status", async () => {
  const fake = fakeClient();
  fake.families[0].draft = false;
  const result = await checkFramerCatalogueConnection(environment, { connector: async () => fake.client });
  assert.equal(result.connected, true);
  assert.equal(result.trialReady, false);
  assert.match(result.issues.join(" "), /not a draft/);
  assert.equal(fake.families[0].draft, false);
  assert.equal(fake.calls.at(-1), "disconnect");
});

test("SDK references use the verified family slug, not a node ID or unrelated slug", async () => {
  for (const reference of [framerCatalogueTrial.family.itemId, "unrelated-product", ""]) {
    const fake = fakeClient();
    fake.colours[0].fieldData.pYtPN6BbP.value = reference;
    const result = await checkFramerCatalogueConnection(environment, { connector: async () => fake.client });
    assert.equal(result.trialReady, false);
    assert.match(result.issues.join(" "), /not linked/);
    assert.equal(fake.calls.at(-1), "disconnect");
  }
});

test("a plain string cannot masquerade as a collection reference", async () => {
  const fake = fakeClient();
  fake.colours[0].fieldData.pYtPN6BbP.type = "string";
  const result = await checkFramerCatalogueConnection(environment, { connector: async () => fake.client });
  assert.equal(result.trialReady, false);
  assert.match(result.issues.join(" "), /not linked/);
});

test("changed field types and incorrect product references stop the next sync stage", async () => {
  const fake = fakeClient();
  fake.familyFields[0].type = "number";
  fake.colourFields.at(-1)!.collectionId = "live-products";
  fake.colours[0].fieldData.pYtPN6BbP.value = "live-item";
  const result = await checkFramerCatalogueConnection(environment, { connector: async () => fake.client });
  assert.equal(result.trialReady, false);
  assert.match(result.issues.join(" "), /changed trial fields/);
  assert.match(result.issues.join(" "), /isolated trial collection/);
  assert.match(result.issues.join(" "), /not linked/);
});

test("missing collections and missing TEST colours are reported honestly", async () => {
  const fake = fakeClient();
  fake.client.getCollection = async () => null;
  const result = await checkFramerCatalogueConnection(environment, { connector: async () => fake.client });
  assert.equal(result.connected, true);
  assert.equal(result.trialReady, false);
  assert.equal(result.collections.length, 0);
  assert.match(result.issues.join(" "), /not found/);
  assert.equal(fake.calls.at(-1), "disconnect");
});

test("SDK failures cannot leak keys or raw error messages and always close an established session", async () => {
  const fake = fakeClient();
  fake.client.getProjectInfo = async () => { throw new Error(`sensitive ${environment.FRAMER_API_KEY}`); };
  await assert.rejects(checkFramerCatalogueConnection(environment, { connector: async () => fake.client }), error => {
    assert.ok(error instanceof FramerCatalogueConnectionError);
    assert.equal(error.code, "CONNECTION_FAILED");
    assert.ok(!error.message.includes(environment.FRAMER_API_KEY));
    return true;
  });
  assert.equal(fake.calls.at(-1), "disconnect");
});

test("a failed handshake is sanitized", async () => {
  await assert.rejects(checkFramerCatalogueConnection(environment, { connector: async () => { throw { code: "UNAUTHORIZED", message: environment.FRAMER_API_KEY }; } }), error => error instanceof FramerCatalogueConnectionError && error.code === "ACCESS_DENIED" && !error.message.includes(environment.FRAMER_API_KEY));
});

test("late handshakes time out and disconnect without reading the project", async () => {
  const fake = fakeClient();
  await assert.rejects(checkFramerCatalogueConnection(environment, {
    timeoutMs: 5,
    connector: () => new Promise(resolve => setTimeout(() => resolve(fake.client), 25)),
  }), error => error instanceof FramerCatalogueConnectionError && error.code === "TIMEOUT");
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.deepEqual(fake.calls, ["disconnect"]);
});

test("slow reads time out and close the session", async () => {
  const fake = fakeClient();
  fake.client.getProjectInfo = () => new Promise(() => undefined);
  await assert.rejects(checkFramerCatalogueConnection(environment, { timeoutMs: 5, connector: async () => fake.client }), error => error instanceof FramerCatalogueConnectionError && error.code === "TIMEOUT");
  assert.deepEqual(fake.calls, ["disconnect"]);
});

test("cleanup failure is not reported as a clean success", async () => {
  const fake = fakeClient();
  fake.client.disconnect = async () => { throw new Error(environment.FRAMER_API_KEY); };
  await assert.rejects(checkFramerCatalogueConnection(environment, { connector: async () => fake.client }), error => error instanceof FramerCatalogueConnectionError && error.code === "CLEANUP_FAILED" && !error.message.includes(environment.FRAMER_API_KEY));
});

test("probe code and standalone runner have no publishing, CMS writes, database or mail operations", () => {
  const source = readFileSync(new URL("../lib/framer-catalogue-connection.ts", import.meta.url), "utf8");
  const runner = readFileSync(new URL("../scripts/check-framer-catalogue.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source + runner, /\.(?:publish|deploy|addItems|removeItems|setAttributes|applyChanges|createCollection)\s*\(/);
  assert.doesNotMatch(source + runner, /(?:from|import\()\s*["'][^"']*(?:\/db|\/email|resend|payfast|bobgo)/i);
});

test("standalone runner starts correctly and reports disabled without contacting Framer", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/check-framer-catalogue.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, FRAMER_CATALOGUE_PROBE_ENABLED: "false", NODE_OPTIONS: "--no-warnings" }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 1, result.stderr);
  const diagnostic = JSON.parse(result.stderr.trim());
  assert.equal(diagnostic.code, "DISABLED");
  assert.equal(diagnostic.connected, false);
  assert.equal(result.stdout.trim(), "");
});
