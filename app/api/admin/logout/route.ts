import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin, revokeRequestAdmin } from "@/lib/auth";
import { reportFailure } from "@/lib/monitoring";
import { adminSessionCookie } from "@/lib/admin-cookie";

export function OPTIONS() { return apiOptions(); }
export async function POST(request: Request) {
  try {
    if (!await getRequestAdmin(request)) return apiJson({ error: "Please sign in again." }, { status: 401 });
    await revokeRequestAdmin(request);
    return apiJson({ revoked: true }, { headers: { "Set-Cookie": adminSessionCookie("", true) } });
  } catch (error) {
    const incident = await reportFailure(error, { operation: "admin_logout" });
    return apiJson({ error: "Sign-out could not be confirmed. Please try again.", errorRef: incident.reference }, { status: 503 });
  }
}
