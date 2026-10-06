// One-off, human-confirmed cleanup. No wildcards, deletes, provider calls or emails.
import { Pool } from "@neondatabase/serverless";

export const confirmedTestOrders = [
  "MM-20261005-D69A34",
  "MM-20261002-F6586B",
  "MM-20260929-E2EF8B",
  "MM-20260929-19E27B",
  "MM-20260929-133717",
  "MM-20260929-47BC44",
];
const reason = "Owner confirmed all six existing orders were tests on 2026-10-06.";
class ArchiveGuardError extends Error {}
const mode = process.argv[2] || "--inspect";
if (!["--inspect", "--apply", "--restore"].includes(mode)) throw new Error("Use --inspect, --apply or --restore.");
const databaseUrl = [process.env.DATABASE_URL, process.env.DATABASE_URL_DATABASE_URL,
  process.env.DATABASE_URL_POSTGRES_URL, process.env.DATABASE_URL_POSTGRES_PRISMA_URL]
  .find(value => typeof value === "string" && /^postgres(?:ql)?:\/\//.test(value));
if (!databaseUrl) throw new Error("A secure production database connection is required.");
const pool = new Pool({ connectionString: databaseUrl });
let connection;
try {
  connection = await pool.connect();
  await connection.query("BEGIN");
  const result = await connection.query(`SELECT order_number, status, payment_status, archived_at,
      archive_reason, created_at FROM orders WHERE order_number = ANY($1::text[])
      ORDER BY order_number FOR UPDATE`, [confirmedTestOrders]);
  if (result.rows.length !== confirmedTestOrders.length) throw new ArchiveGuardError("The exact confirmed six orders were not found; nothing was changed.");
  if (result.rows.some(row => new Date(row.created_at) >= new Date("2026-10-06T00:00:00Z"))) {
    throw new ArchiveGuardError("An order is newer than the approved test set; nothing was changed.");
  }
  const submitted = await connection.query(`SELECT count(*)::int AS count FROM shipments s
    JOIN orders o ON o.id = s.order_id WHERE o.order_number = ANY($1::text[])
    AND (s.provider_shipment_id IS NOT NULL OR s.booked_at IS NOT NULL OR s.status IN ('booking','booked'))`, [confirmedTestOrders]);
  const reserved = await connection.query(`SELECT count(*)::int AS count FROM stock_reservations r
    JOIN orders o ON o.id = r.order_id WHERE o.order_number = ANY($1::text[])
    AND r.released_at IS NULL AND r.consumed_at IS NULL AND r.expires_at > now()`, [confirmedTestOrders]);
  if (submitted.rows[0].count || reserved.rows[0].count) throw new ArchiveGuardError("A booking or active stock reservation needs review before cleanup; nothing was changed.");
  if (result.rows.some(row => row.archived_at && row.archive_reason !== reason)) throw new ArchiveGuardError("An existing archive reason differs; nothing was changed.");
  if (mode === "--apply") {
    await connection.query(`UPDATE orders SET archived_at = COALESCE(archived_at, now()), archive_reason = $2
      WHERE order_number = ANY($1::text[])`, [confirmedTestOrders, reason]);
  } else if (mode === "--restore") {
    await connection.query(`UPDATE orders SET archived_at = NULL, archive_reason = NULL
      WHERE order_number = ANY($1::text[]) AND archive_reason = $2`, [confirmedTestOrders, reason]);
  }
  const final = await connection.query(`SELECT order_number, status, payment_status, archived_at
    FROM orders WHERE order_number = ANY($1::text[]) ORDER BY order_number`, [confirmedTestOrders]);
  const count = await connection.query("SELECT count(*)::int AS count FROM orders WHERE archived_at IS NULL");
  await connection.query("COMMIT");
  console.log(JSON.stringify({ mode, orders: final.rows, activeOrderCount: count.rows[0].count,
    retainedOrderCount: final.rows.length, providerCalls: 0, emailsSent: 0 }));
} catch (error) {
  await connection?.query("ROLLBACK").catch(() => undefined);
  // Never print connection strings or raw database/network diagnostics.
  console.error(error instanceof ArchiveGuardError ? error.message : "Database operation failed; no cleanup was committed.");
  process.exitCode = 1;
} finally {
  connection?.release();
  await pool.end();
}
