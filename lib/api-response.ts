import { securityHeaders } from "./api-security";

export function apiJson(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...securityHeaders,
      ...init.headers,
    },
  });
}

export function apiOptions() {
  return new Response(null, { status: 204, headers: securityHeaders });
}
