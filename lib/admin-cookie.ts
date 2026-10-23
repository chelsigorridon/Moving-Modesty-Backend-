import { createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_SECONDS = 12 * 60 * 60;
export const ADMIN_CSRF_HEADER = "X-MM-CSRF";

export function adminCookieName() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV
    ? "__Host-moving_modesty_admin" : "moving_modesty_admin";
}

export function adminCookieOptions() {
  return { httpOnly: true, secure: adminCookieName().startsWith("__Host-"), sameSite: "lax" as const,
    path: "/", maxAge: ADMIN_SESSION_SECONDS };
}

export function adminSessionCookie(token: string, clear = false) {
  const options = adminCookieOptions();
  return `${adminCookieName()}=${clear ? "" : token}; Path=/; Max-Age=${clear ? 0 : options.maxAge}; HttpOnly; SameSite=Lax${options.secure ? "; Secure" : ""}`;
}

export function requestAdminCookie(request: Request) {
  const matches = (request.headers.get("cookie") || "").split(";").map(part => part.trim())
    .filter(part => part.startsWith(`${adminCookieName()}=`));
  // Ambiguous duplicate cookies are not accepted.
  return matches.length === 1 ? matches[0].slice(adminCookieName().length + 1) : "";
}

export function adminCsrfToken(token: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret || !/^mm2_[A-Za-z0-9_-]{43}$/.test(token)) return "";
  return createHmac("sha256", secret).update(`admin-csrf-v1:${process.env.VERCEL_ENV || process.env.NODE_ENV || "local"}:${token}`).digest("base64url");
}

export function adminRequestOriginAllowed(request: Request, requireOrigin = false) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return !requireOrigin;
  try {
    if (new URL(origin).origin !== origin) return false;
    // Public API CORS exceptions are deliberately NOT admin sign-in origins.
    return [process.env.STORE_URL, process.env.FRAMER_ADMIN_URL, request.url]
      .filter(Boolean).some(value => new URL(value!).origin === origin);
  } catch { return false; }
}

export function adminMutationAllowed(request: Request, token: string) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return adminRequestOriginAllowed(request);
  if (!adminRequestOriginAllowed(request, true)) return false;
  const actual = request.headers.get(ADMIN_CSRF_HEADER) || "";
  const expected = adminCsrfToken(token);
  return Boolean(expected && /^[A-Za-z0-9_-]{43}$/.test(actual)
    && timingSafeEqual(Buffer.from(actual), Buffer.from(expected)));
}

// Cross-site Vercel cookies are unreliable and must never trigger a bearer-token
// fallback. A release needs either a same-origin proxy or api.<store domain>.
export function adminCookieHostingReady(request: Request) {
  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL_ENV) return true;
  try {
    const store = new URL(process.env.STORE_URL || "");
    const api = new URL(process.env.ADMIN_API_URL || "");
    const storeHost = store.hostname.replace(/^www\./, "");
    return store.protocol === "https:" && api.protocol === "https:"
      && [store.hostname, `api.${storeHost}`].includes(api.hostname)
      && !api.port && !store.port && !api.username && !api.password
      && api.pathname === "/" && !api.search && !api.hash
      && new URL(request.url).origin === api.origin;
  } catch { return false; }
}
