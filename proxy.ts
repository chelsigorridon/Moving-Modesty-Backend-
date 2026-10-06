import { NextResponse, type NextRequest } from "next/server";
import { apiOriginAllowed, apiSecurityHeaders } from "./lib/api-security";

// Browser origin filtering is not authentication. Admin sessions and provider signatures are checked in the routes.
export function proxy(request: NextRequest) {
  const headers = apiSecurityHeaders(request);
  if (!apiOriginAllowed(request)) return NextResponse.json({ error: "This website origin is not allowed." }, { status: 403, headers });
  if (request.method === "OPTIONS") return new NextResponse(null, { status: 204, headers });
  const response = NextResponse.next();
  headers.forEach((value, key) => response.headers.set(key, value));
  return response;
}
export const config = { matcher: "/api/:path*" };
