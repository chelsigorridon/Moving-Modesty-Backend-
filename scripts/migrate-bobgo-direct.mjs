// Defaults to a read-only preflight. --apply runs only migration 0016, in one
// transaction, against an already migrated 0015 database. Never imports the app.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Pool } from "@neondatabase/serverless";

const apply = process.argv.includes("--apply");
// Exported local config can contain a masked placeholder for a sensitive value.
// Prefer a valid configured integration URL; never print rejected candidates.
const url = ["DATABASE_URL", "DATABASE_URL_DATABASE_URL", "DATABASE_URL_POSTGRES_URL", "DATABASE_URL_POSTGRES_PRISMA_URL"]
  .map(key => process.env[key]).find(value => {
    try { const parsed = new URL(value); return ["postgres:", "postgresql:"].includes(parsed.protocol) && parsed.hostname.endsWith(".neon.tech"); }
    catch { return false; }
  });
if (!url) { console.error("The expected Neon connection is not configured."); process.exit(1); }
const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
const previous = journal.entries.find(row => row.tag === "0015_bobgo_waybill_link");
const next = journal.entries.find(row => row.tag === "0016_bobgo_direct_delivery");
if (!previous || !next || journal.entries.at(-1).tag !== next.tag) throw new Error("Unexpected migration journal.");
const sql = readFileSync(new URL(`../drizzle/${next.tag}.sql`, import.meta.url), "utf8");
const hash = createHash("sha256").update(sql).digest("hex");
const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 15000 });
let client;
try {
  client = await pool.connect();
  if (apply) {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query("SELECT pg_advisory_xact_lock(6610761616)");
  }
  const history = await client.query("SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1");
  const last = Number(history.rows[0]?.created_at);
  const shape = await client.query("SELECT to_regclass('public.bobgo_delivery_events') IS NOT NULL AS inbox, EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='shipments' AND column_name='courier_charged_amount') AS charged_amount");
  if (last === next.when) {
    if (!shape.rows[0].inbox || !shape.rows[0].charged_amount) throw new Error("Migration history and schema do not agree.");
    if (apply) await client.query("COMMIT");
    console.log(JSON.stringify({ migration: next.tag, alreadyApplied: true, ordersCreated: 0, waybillsCreated: 0 }));
  } else {
    if (last !== previous.when || shape.rows[0].inbox || shape.rows[0].charged_amount) throw new Error("The production schema is not the expected 0015 baseline.");
    if (apply) {
      for (const statement of sql.split("--> statement-breakpoint")) if (statement.trim()) await client.query(statement);
      await client.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", [hash, next.when]);
      await client.query("COMMIT");
    }
    console.log(JSON.stringify({ migration: next.tag, baselineVerified: true, applied: apply, ordersCreated: 0, waybillsCreated: 0 }));
  }
} catch {
  if (apply && client) await client.query("ROLLBACK").catch(() => undefined);
  console.error("Bob Go migration did not complete. No customer data or credentials are logged; check the migration baseline and database access.");
  process.exitCode = 1;
} finally { client?.release(); await pool.end(); }
