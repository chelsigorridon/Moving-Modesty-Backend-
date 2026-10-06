// Read-only deployment preflight. Never print credentials, customer details or raw database errors.
import { Pool } from "@neondatabase/serverless";

const connectionString = process.env.DATABASE_URL || process.env.DATABASE_URL_DATABASE_URL || process.env.DATABASE_URL_POSTGRES_URL || process.env.DATABASE_URL_POSTGRES_PRISMA_URL;
if (!connectionString) throw new Error("Database configuration is missing.");
const pool = new Pool({ connectionString });
let connection;
try {
  connection = await pool.connect();
  await connection.query("BEGIN READ ONLY");
  const tables = await connection.query("SELECT to_regclass('public.admin_sessions') IS NOT NULL AS sessions, to_regclass('public.diagnostic_rate_limits') IS NOT NULL AS rate_limits");
  const owner = await connection.query("SELECT role, active FROM admin_users WHERE email = $1", [process.env.ADMIN_EMAIL?.trim().toLowerCase()]);
  const orders = await connection.query("SELECT count(*) FILTER (WHERE archived_at IS NULL)::int AS active, count(*) FILTER (WHERE archived_at IS NOT NULL)::int AS archived FROM orders");
  await connection.query("COMMIT");
  console.log(JSON.stringify({ sessionStorageReady: tables.rows[0].sessions, loginThrottleStorageReady: tables.rows[0].rate_limits,
    owner: owner.rows[0] ? { exists: true, role: owner.rows[0].role, active: owner.rows[0].active } : { exists: false, createdOnFirstSignIn: true },
    passwordHashValid: /^[^:]+:[0-9a-f]{128}$/i.test(process.env.ADMIN_PASSWORD_HASH || ""), authSecretStrong: (process.env.AUTH_SECRET || "").length >= 32,
    resendWebhookConfigured: Boolean(process.env.RESEND_WEBHOOK_SECRET), technicalAlertRecipientCorrect: (process.env.ERROR_ALERT_EMAIL || "moody.tech@gmail.com").trim() === "moody.tech@gmail.com",
    payfastLive: process.env.PAYFAST_ENVIRONMENT === "production", payfastSourceValidationEnabled: process.env.PAYFAST_SOURCE_IP_VALIDATION !== "false",
    bobGoLive: process.env.BOBGO_ENVIRONMENT === "production", activeOrders: orders.rows[0].active, archivedOrders: orders.rows[0].archived }));
} catch {
  await connection?.query("ROLLBACK").catch(() => undefined);
  console.error("Security setup check failed. No data was changed; check private deployment logs.");
  process.exitCode = 1;
} finally { connection?.release(); await pool.end(); }
