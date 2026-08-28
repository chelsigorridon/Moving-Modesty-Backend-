import { getAdminSnapshot } from "@/lib/admin-data";
import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return apiOptions();
}

export async function GET(request: Request) {
  if (!getRequestAdmin(request)) return apiJson({ error: "Unauthorized" }, { status: 401 });
  try {
    return apiJson(await getAdminSnapshot());
  } catch (error) {
    return apiJson(
      { error: error instanceof Error ? error.message : "Admin data could not be loaded." },
      { status: 503 }
    );
  }
}
