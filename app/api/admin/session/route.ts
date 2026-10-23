import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { adminCsrfToken, requestAdminCookie } from "@/lib/admin-cookie";

export function OPTIONS() { return apiOptions(); }
export async function GET(request: Request) {
  const admin = await getRequestAdmin(request);
  if (!admin) return apiJson({ error: "Please sign in again." }, { status: 401 });
  return apiJson({ authenticated: true, admin, csrfToken: adminCsrfToken(requestAdminCookie(request)) });
}
