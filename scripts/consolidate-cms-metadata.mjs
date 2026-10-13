// Explicit, scoped operational migration. No order/payment/email/courier writes.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import ts from "typescript";
import nextEnvironment from "@next/env";
import * as framerApi from "framer-api";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq, sql } from "drizzle-orm";

const root = process.cwd();
const backupDirectory = resolve(root, ".tmp/cms-consolidation-20261012");
if (!existsSync(resolve(backupDirectory, "framer-before.json"))) throw new Error("The native CMS/page backup is required first.");
nextEnvironment.loadEnvConfig(root, true, { info() {}, error() {} });
const production = parseEnv(readFileSync(resolve(root, ".env.production.local"), "utf8"));
const connectionString = [production.DATABASE_URL, production.DATABASE_URL_DATABASE_URL, production.DATABASE_URL_POSTGRES_URL].find(value => value && value !== "[SENSITIVE]");
if (!connectionString) throw new Error("The linked production database configuration is unavailable.");
const pool = new Pool({ connectionString });
const database = drizzle(pool), require = createRequire(import.meta.url), cache = new Map();
function load(file) {
  const absolute = resolve(root, file);
  if (cache.has(absolute)) return cache.get(absolute);
  const compiledModule = { exports: {} }; cache.set(absolute, compiledModule.exports);
  const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const localRequire = name => {
    if (name === "server-only") return {};
    if (name === "framer-api") return framerApi;
    if (name.startsWith("@/")) return load(name.slice(2) + ".ts");
    if (name.startsWith(".")) return load(resolve(dirname(absolute), name) + (name === "./db" ? "/index.ts" : name.endsWith(".ts") ? "" : ".ts"));
    return require(name);
  };
  new Function("require", "module", "exports", compiled)(localRequire, compiledModule, compiledModule.exports);
  return compiledModule.exports;
}
function stable(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]));
  return value;
}
const encoded = value => JSON.stringify(stable(value));
const hash = value => createHash("sha256").update(encoded(value)).digest("hex");
function ready(rows) {
  if (rows.length !== 2 || rows.some(row => !["amina", "hawa"].includes(row.slug) || row.publicationState !== "idle" || row.revision !== row.publishedRevision)) throw new Error("Products changed or have an unpublished draft. Stop and review before migrating.");
}
try {
  const schema = load("lib/db/schema.ts"), cms = load("lib/framer-catalogue-live.ts");
  const rows = await database.select().from(schema.catalogueProducts); ready(rows);
  const stock = await database.select().from(schema.productVariants);
  const products = await database.select().from(schema.products);
  if (process.argv.includes("--backup")) {
    const snapshot = await cms.withCatalogueFramer(async client => Promise.all((await client.getCollections()).map(async collection => ({
      id: collection.id, name: collection.name,
      fields: (await collection.getFields()).map(field => ({ id: field.id, name: field.name, type: field.type })),
      items: (await collection.getItems()).map(item => ({ id: item.id, slug: item.slug, draft: item.draft, fieldData: item.fieldData })),
    }))));
    writeFileSync(resolve(backupDirectory, "backend-before.json"), JSON.stringify({ createdAt: new Date().toISOString(), rows, products, stock, stockHash: hash(stock), productsHash: hash(products), collections: snapshot }, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ backedUp: true, products: rows.map(row => ({ slug: row.slug, revision: row.revision })), variants: stock.length, collections: snapshot.map(c => ({ name: c.name, count: c.items.length })) }, null, 2));
  } else {
    const before = JSON.parse(readFileSync(resolve(backupDirectory, "backend-before.json"), "utf8"));
    if (hash(stock) !== before.stockHash || hash(products) !== before.productsHash) throw new Error("Stock or product data changed during migration; reconciliation stopped.");
    for (const row of rows) {
      const old = before.rows.find(old => old.id === row.id);
      if (!old || encoded(row.document) !== encoded(old.document) || encoded(row.publishedDocument) !== encoded(old.publishedDocument) || row.revision !== old.revision) throw new Error("A product draft changed during migration; reconciliation stopped.");
    }
    const current = await cms.withCatalogueFramer(async client => {
      const collection = (await client.getCollections()).find(c => c.id === "m15OMOfwH" && c.name === "Products");
      if (!collection) throw new Error("Unified Products collection is missing.");
      return (await collection.getItems()).map(item => ({ id: item.id, slug: item.slug, draft: item.draft, fieldData: item.fieldData }));
    });
    const original = before.collections.find(c => c.id === "m15OMOfwH");
    const originalFields = new Set(original.fields.map(field => field.id));
    const originalData = item => ({ id: item.id, slug: item.slug, draft: item.draft, fieldData: Object.fromEntries(Object.entries(item.fieldData).filter(([id]) => originalFields.has(id))) });
    for (const item of original.items) {
      const found = current.find(c => c.id === item.id);
      if (!found || encoded(originalData(found)) !== encoded(originalData(item))) throw new Error("An original colour, photo, price or SKU changed. Reconciliation stopped.");
    }
    const mappings = await Promise.all(rows.map(async row => ({ row, metadata: await cms.readConsolidatedCmsMapping(row.publishedDocument, row.metadata) })));
    if (process.argv.includes("--reconcile")) {
      await database.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('mm-catalogue-management', 0))`);
        const locked = await tx.select().from(schema.catalogueProducts).for("update"); ready(locked);
        const lockedStock = await tx.select().from(schema.productVariants).for("update");
        if (hash(lockedStock) !== before.stockHash) throw new Error("Stock changed before reconciliation; no mapping updated.");
        for (const { row, metadata } of mappings) {
          const now = locked.find(item => item.id === row.id);
          if (!now || encoded(now) !== encoded(row)) throw new Error("Another editor changed a product; no mapping updated.");
          await tx.update(schema.catalogueProducts).set({ metadata }).where(eq(schema.catalogueProducts.id, row.id));
        }
      });
      writeFileSync(resolve(backupDirectory, "backend-after.json"), JSON.stringify({ checkedAt: new Date().toISOString(), mappings: mappings.map(({ row, metadata }) => ({ id: row.id, slug: row.slug, metadata })) }, null, 2), { flag: "wx" });
    }
    console.log(JSON.stringify({ reconciled: process.argv.includes("--reconcile"), checked: true, colourRecordsUnchanged: original.items.length, stockUnchanged: true, products: mappings.map(({ row, metadata }) => ({ slug: row.slug, revision: row.revision, layout: metadata.cmsLayout, colourCount: Object.keys(metadata.colours).length })) }, null, 2));
  }
} finally { await pool.end(); }
