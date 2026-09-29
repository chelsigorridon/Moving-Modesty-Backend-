import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

// Vercel's Neon integration prefixes generated variables with the integration
// name. Accept both the conventional key and the names produced when the
// integration itself is named "DATABASE_URL".
const connectionString =
  process.env.DATABASE_URL ??
  process.env.DATABASE_URL_DATABASE_URL ??
  process.env.DATABASE_URL_POSTGRES_URL ??
  process.env.DATABASE_URL_POSTGRES_PRISMA_URL;

// Checkout, payment notifications, and admin status updates all need real
// multi-statement transactions. Neon's HTTP driver only supports atomic batch
// queries, so use the WebSocket-backed Pool driver for these interactive flows.
const pool = connectionString ? new Pool({ connectionString }) : null;

export const db = pool ? drizzle(pool, { schema }) : null;

export function requireDatabase() {
  if (!db) throw new Error("DATABASE_URL is not configured.");
  return db;
}
