// Browser-only session transport. The session secret is never exposed to JS.
// This file is mechanically embedded in the Framer single-file portal.
const adminCsrfSessions = new Map<string, { token: string; until: number }>();
const adminCsrfPending = new Map<string, Promise<Response>>();

export async function adminRequest(url: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url, typeof window === "undefined" ? "http://localhost" : window.location.origin);
  if (!target.pathname.startsWith("/api/admin/")) return fetch(url, init);
  const headers = new Headers(init.headers);
  headers.delete("Authorization");
  const method = (init.method || "GET").toUpperCase();
  const base = target.origin;
  if (typeof window !== "undefined") {
    try { window.sessionStorage.removeItem("moving_modesty_admin_token"); } catch { /* Storage is not required for sign-in. */ }
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && target.pathname !== "/api/admin/login") {
    let csrf = adminCsrfSessions.get(base);
    if (!csrf || csrf.until <= Date.now()) {
      let pending = adminCsrfPending.get(base);
      if (!pending) {
        pending = fetch(`${base}/api/admin/session`, { credentials: "include", cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(10000) });
        adminCsrfPending.set(base, pending);
      }
      let response: Response;
      try { response = await pending; } finally { adminCsrfPending.delete(base); }
      if (!response.ok) return response.clone(); // Never send the mutation after failed authentication.
      const data = await response.clone().json();
      if (typeof data.csrfToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.csrfToken)) throw new Error("Please sign in again.");
      csrf = { token: data.csrfToken, until: Date.now() + 10 * 60 * 1000 };
      adminCsrfSessions.set(base, csrf);
    }
    headers.set("X-MM-CSRF", csrf.token);
  }
  const response = await fetch(url, { ...init, headers, credentials: "include", cache: "no-store", referrerPolicy: "no-referrer" });
  if (response.status === 401 || target.pathname === "/api/admin/login" || target.pathname === "/api/admin/logout") adminCsrfSessions.delete(base);
  return response;
}
