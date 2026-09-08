import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// Vercel's Neon integration prefixes generated variables with the integration
// name. Accept both the conventional key and the names produced when the
// integration itself is named "DATABASE_URL".
const connectionString =
  process.env.DATABASE_URL ??
  process.env.DATABASE_URL_DATABASE_URL ??
  process.env.DATABASE_URL_POSTGRES_URL ??
  process.env.DATABASE_URL_POSTGRES_PRISMA_URL;

export const db = connectionString
  ? drizzle(neon(connectionString), { schema })
  : null;

export function requireDatabase() {
  if (!db) throw new Error("DATABASE_URL is not configured.");
  return db;
}
