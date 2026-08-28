import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const COOKIE_NAME = "moving_modesty_admin";
const SESSION_LENGTH_SECONDS = 60 * 60 * 12;

type AdminSession = { email: string; role: "owner" | "manager" | "fulfilment" };
type SignedAdminPayload = { email: string; expires: number };

function config() {
  return {
    email: process.env.ADMIN_EMAIL?.trim().toLowerCase(),
    passwordHash: process.env.ADMIN_PASSWORD_HASH,
    secret: process.env.AUTH_SECRET,
  };
}

export function isAuthConfigured() {
  const values = config();
  return Boolean(values.email && values.passwordHash && values.secret);
}

function signature(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function createSignedToken(email: string, secret: string) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_LENGTH_SECONDS;
  const payload = Buffer.from(JSON.stringify({ email: email.toLowerCase(), expires })).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

function parseSignedToken(token: string, secret: string, expectedEmail: string): SignedAdminPayload | null {
  const [payload, suppliedSignature] = token.split(".");
  if (!payload || !suppliedSignature) return null;
  const expectedSignature = signature(payload, secret);
  const suppliedBuffer = Buffer.from(suppliedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as SignedAdminPayload;
    if (parsed.email !== expectedEmail || parsed.expires <= Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function verifyPassword(password: string, storedValue: string) {
  const [salt, expectedHex] = storedValue.split(":");
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function authenticateAdmin(email: string, password: string) {
  const values = config();
  if (!values.email || !values.passwordHash || !values.secret) return false;
  const emailMatches = email.trim().toLowerCase() === values.email;
  return emailMatches && verifyPassword(password, values.passwordHash);
}

export async function createAdminSession(email: string) {
  const secret = config().secret;
  if (!secret) throw new Error("AUTH_SECRET is not configured.");
  const token = createSignedToken(email, secret);
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_LENGTH_SECONDS,
  });
}

export function issueAdminApiToken(email: string) {
  const secret = config().secret;
  if (!secret) throw new Error("AUTH_SECRET is not configured.");
  return createSignedToken(email, secret);
}

export function verifyAdminApiToken(token: string): AdminSession | null {
  const values = config();
  if (!values.secret || !values.email) return null;
  const parsed = parseSignedToken(token, values.secret, values.email);
  return parsed ? { email: parsed.email, role: "owner" } : null;
}

export function getRequestAdmin(request: Request): AdminSession | null {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return token ? verifyAdminApiToken(token) : null;
}

export async function destroyAdminSession() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export async function getCurrentAdmin(): Promise<AdminSession | null> {
  const values = config();
  if (!isAuthConfigured()) {
    return process.env.NODE_ENV === "development" ? { email: "local@movingmodesty.test", role: "owner" } : null;
  }
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token || !values.secret || !values.email) return null;
  const parsed = parseSignedToken(token, values.secret, values.email);
  return parsed ? { email: parsed.email, role: "owner" } : null;
}

export async function requireAdmin() {
  const session = await getCurrentAdmin();
  if (!session) redirect("/login");
  return session;
}
