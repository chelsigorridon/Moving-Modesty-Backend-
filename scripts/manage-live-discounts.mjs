// Scoped rollout verification. No credentials, customer data or provider calls are logged.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseEnv } from "node:util";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";

const production = parseEnv(readFileSync(".env.production.local", "utf8"));
const connectionString = [production.DATABASE_URL, production.DATABASE_URL_DATABASE_URL,
  production.DATABASE_URL_POSTGRES_URL].find(value => value && value !== "[SENSITIVE]");
if (!connectionString) throw new Error("Linked production database configuration is unavailable.");
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")).entries;
const pool = new Pool({ connectionString });
let connection;
try {
  connection = await pool.connect();
  const ledger = (await connection.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
  for (const row of ledger) {
    const entry = journal.find(entry => String(entry.when) === String(row.created_at));
    if (!entry || createHash("sha256").update(readFileSync(`drizzle/${entry.tag}.sql`, "utf8")).digest("hex") !== row.hash) {
      throw new Error("Production migration history does not match the reviewed source.");
    }
  }
  const pending = journal.filter(entry => !ledger.some(row => String(row.created_at) === String(entry.when)));
  console.log(JSON.stringify({ appliedMigrationCount: ledger.length, pending: pending.map(entry => entry.tag) }));
  if (process.argv.includes("--migrate")) {
    if (pending.length !== 1 || pending[0].tag !== "0010_glamorous_cargill") throw new Error("Only the reviewed Discounts migration may be applied by this command.");
    await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
    console.log("The additive Discounts migration was applied. No codes were created.");
  }
  const ready = (await connection.query("SELECT to_regclass('public.discounts') IS NOT NULL AS discounts, to_regclass('public.discount_history') IS NOT NULL AS history")).rows[0];
  if (ready.discounts && ready.history) {
    const rows = (await connection.query("SELECT count(*)::int AS total, count(*) FILTER (WHERE active)::int AS active FROM discounts")).rows[0];
    const columns = (await connection.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name IN ('discount_amount','discount_snapshot')")).rows;
    const historical = (await connection.query("SELECT count(*)::int AS orders, count(*) FILTER (WHERE discount_amount IS NULL)::int AS missing_discount FROM orders")).rows[0];
    console.log(JSON.stringify({ tablesReady: true, discountColumnsReady: columns.length === 2, codes: rows.total, activeCodes: rows.active,
      existingOrders: historical.orders, missingDiscountDefaults: historical.missing_discount }));
  } else console.log(JSON.stringify({ tablesReady: false }));
} catch {
  console.error("Discount rollout check failed. No private details were printed; inspect configuration and migration history securely.");
  process.exitCode = 1;
} finally { connection?.release(); await pool.end(); }
