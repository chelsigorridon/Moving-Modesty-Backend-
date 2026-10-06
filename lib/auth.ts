import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireDatabase } from "./db";
import { adminSessions, adminUsers, diagnosticRateLimits } from "./db/schema";
import { reportFailure } from "./monitoring";

const COOKIE_NAME = "moving_modesty_admin";
const SESSION_LENGTH_SECONDS = 60 * 60 * 12;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
type AdminSession = { email: string; role: "owner" | "manager" | "fulfilment" };

function config() {
  return { email: process.env.ADMIN_EMAIL?.trim().toLowerCase(), passwordHash: process.env.ADMIN_PASSWORD_HASH, secret: process.env.AUTH_SECRET };
}
export function isAuthConfigured() {
  const values = config();
  return Boolean(values.email && values.secret && values.passwordHash && /^[^:]+:[0-9a-f]{128}$/i.test(values.passwordHash));
}
async function verifyPassword(password: string, storedValue: string) {
  if (!/^[^:]+:[0-9a-f]{128}$/i.test(storedValue)) return false;
  const [salt, expectedHex] = storedValue.split(":");
  const expected = Buffer.from(expectedHex, "hex");
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key));
  });
  return timingSafeEqual(actual, expected);
}
export async function authenticateAdmin(email: string, password: string) {
  const values = config();
  if (!isAuthConfigured() || !values.passwordHash || password.length > 200) return false;
  // Perform the same password work for unknown emails to avoid account-enumeration timing.
  const passwordMatches = await verifyPassword(password, values.passwordHash);
  return email.trim().toLowerCase() === values.email && passwordMatches;
}
function sessionHash(token: string) {
  const values = config();
  if (!isAuthConfigured() || !/^mm2_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  // Bind sessions to the environment and credentials; credential changes invalidate them.
  return createHmac("sha256", values.secret!).update(JSON.stringify([
    "admin-session-v2", process.env.VERCEL_ENV || process.env.NODE_ENV || "local",
    values.email, values.passwordHash, token,
  ])).digest("hex");
}
export async function issueAdminApiToken(email: string) {
  const values = config();
  if (!isAuthConfigured() || email.trim().toLowerCase() !== values.email) throw new Error("Admin authentication is not configured.");
  const database = requireDatabase();
  await database.insert(adminUsers).values({ email: values.email!, name: "Moving Modesty", role: "owner" }).onConflictDoNothing({ target: adminUsers.email });
  const [owner] = await database.select().from(adminUsers).where(eq(adminUsers.email, values.email!)).limit(1);
  if (!owner?.active || owner.role !== "owner") throw new Error("Admin account is disabled.");
  const token = `mm2_${randomBytes(32).toString("base64url")}`;
  await database.insert(adminSessions).values({ adminUserId: owner.id, tokenHash: sessionHash(token)!, expiresAt: new Date(Date.now() + SESSION_LENGTH_SECONDS * 1000) });
  return token;
}
export async function verifyAdminApiToken(token: string): Promise<AdminSession | null> {
  const hash = sessionHash(token);
  if (!hash) return null; // Old stateless tokens are deliberately no longer accepted.
  const [session] = await requireDatabase().select({ email: adminUsers.email, role: adminUsers.role, active: adminUsers.active })
    .from(adminSessions).innerJoin(adminUsers, eq(adminSessions.adminUserId, adminUsers.id))
    .where(and(eq(adminSessions.tokenHash, hash), gt(adminSessions.expiresAt, new Date()))).limit(1);
  return session?.active && session.email === config().email && session.role === "owner" ? { email: session.email, role: session.role } : null;
}
function requestToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}
export async function getRequestAdmin(request: Request): Promise<AdminSession | null> {
  try { return await verifyAdminApiToken(requestToken(request)); }
  catch (error) { await reportFailure(error, { operation: "admin_auth" }); return null; }
}
export async function revokeAdminApiToken(token: string) {
  const hash = sessionHash(token);
  if (hash) await requireDatabase().delete(adminSessions).where(eq(adminSessions.tokenHash, hash));
}
export async function revokeRequestAdmin(request: Request) { await revokeAdminApiToken(requestToken(request)); }
export async function consumeAdminLoginAttempt(request: Request, email: string) {
  const values = config();
  if (!values.secret) throw new Error("AUTH_SECRET is not configured.");
  // Vercel overwrites this header. Never trust client-supplied x-forwarded-for.
  const clientIp = process.env.VERCEL_ENV
    ? request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || "unknown"
    : "local";
  const key = (scope: string, value: string) => "admin-login:" + createHmac("sha256", values.secret!).update(`${scope}:${value}`).digest("hex");
  const buckets = [
    { key: key("client-account", `${clientIp}:${email.toLowerCase()}`), limit: 8 },
    { key: key("client", clientIp), limit: 30 },
    { key: key("account", email.toLowerCase()), limit: 30 },
    { key: key("global", process.env.VERCEL_ENV || "local"), limit: 200 },
  ];
  const now = new Date();
  return requireDatabase().transaction(async transaction => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended('mm-admin-login', 0))`);
    await transaction.delete(diagnosticRateLimits).where(lt(diagnosticRateLimits.expiresAt, now));
    for (const bucket of buckets) {
      const [row] = await transaction.select().from(diagnosticRateLimits).where(eq(diagnosticRateLimits.key, bucket.key));
      if (row && row.count >= bucket.limit) return { allowed: false, retryAfter: Math.max(1, Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000)) };
    }
    for (const bucket of buckets) await transaction.insert(diagnosticRateLimits)
      .values({ key: bucket.key, expiresAt: new Date(now.getTime() + LOGIN_WINDOW_MS) })
      .onConflictDoUpdate({ target: diagnosticRateLimits.key, set: { count: sql`${diagnosticRateLimits.count} + 1` } });
    return { allowed: true, retryAfter: 0 };
  });
}
export async function createAdminSession(email: string) {
  const token = await issueAdminApiToken(email);
  (await cookies()).set(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_LENGTH_SECONDS });
}
export async function destroyAdminSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (token) await revokeAdminApiToken(token);
  cookieStore.delete(COOKIE_NAME);
}
export async function getCurrentAdmin(): Promise<AdminSession | null> {
  if (!isAuthConfigured()) return process.env.NODE_ENV === "development" ? { email: "local@movingmodesty.test", role: "owner" } : null;
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  return token ? verifyAdminApiToken(token) : null;
}
export async function requireAdmin() {
  const session = await getCurrentAdmin();
  if (!session) redirect("/login");
  return session;
}
