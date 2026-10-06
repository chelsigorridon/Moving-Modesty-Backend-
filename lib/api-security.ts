const STORE_ORIGIN = "https://holistic-brand-492217.framer.app";

export const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export function apiOriginAllowed(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // Provider callbacks/server requests still require their own signatures/authentication.
  const values = [process.env.STORE_URL || STORE_ORIGIN, process.env.FRAMER_ADMIN_URL || STORE_ORIGIN, request.url,
    ...(process.env.API_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean)];
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !["https:", "http:"].includes(parsed.protocol)) return false;
    return values.some(value => {
      try { return new URL(value).origin === origin; } catch { return false; }
    });
  } catch { return false; }
}

export function apiSecurityHeaders(request: Request) {
  const headers = new Headers({ ...securityHeaders, Vary: "Origin",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
  const origin = request.headers.get("origin");
  if (origin && apiOriginAllowed(request)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  return headers;
}
