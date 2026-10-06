import { apiJson, apiOptions } from "@/lib/api-response";
import { revokeRequestAdmin } from "@/lib/auth";
import { reportFailure } from "@/lib/monitoring";

export function OPTIONS() { return apiOptions(); }
export async function POST(request: Request) {
  try {
    await revokeRequestAdmin(request);
    return apiJson({ revoked: true });
  } catch (error) {
    const incident = await reportFailure(error, { operation: "admin_logout" });
    return apiJson({ error: "Sign-out could not be confirmed. Please try again.", errorRef: incident.reference }, { status: 503 });
  }
}
