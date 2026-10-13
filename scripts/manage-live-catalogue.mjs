// Scoped operational setup; never prints credentials or submits payments/email/courier requests.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { parseEnv } from "node:util";
import ts from "typescript";
import nextEnvironment from "@next/env";
import * as framerApi from "framer-api";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";

nextEnvironment.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
const production = parseEnv(readFileSync(".env.production.local", "utf8"));
const connectionString = [production.DATABASE_URL, production.DATABASE_URL_DATABASE_URL, production.DATABASE_URL_POSTGRES_URL].find(value => value && value !== "[SENSITIVE]");
if (!connectionString) throw new Error("The linked production database configuration is unavailable.");
const pool = new Pool({ connectionString });
const database = drizzle(pool);
const root = process.cwd(), require = createRequire(import.meta.url), cache = new Map();
function load(file) {
  const absolute = resolve(root, file);
  if (/lib[\\/]db[\\/]index\.ts$/.test(absolute)) return { db: database, requireDatabase: () => database };
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
try {
  if (process.argv.includes("--migrate")) { await migrate(database, { migrationsFolder: "drizzle" }); console.log("Additive database migrations applied."); }
  const catalogue = load("lib/catalogue-live.ts");
  if (process.argv.includes("--import")) { await catalogue.initializeLiveCatalogue(database); console.log("Existing products imported; no public product created."); }
  const records = await catalogue.listLiveCatalogue(database);
  console.log(JSON.stringify(records.map(row => ({ id: row.id, name: row.document.name, revision: row.revision, state: row.publicationState,
    colours: row.document.colours.length, variants: row.document.colours.reduce((sum, colour) => sum + colour.variants.length, 0), page: row.pageUrl })), null, 2));
} finally { await pool.end(); }
