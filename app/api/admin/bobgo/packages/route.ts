import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { bobGoRequest } from "@/lib/integrations/bobgo/client";
import { parseBobGoPackages } from "@/lib/integrations/bobgo/packages";

export function OPTIONS() { return apiOptions(); }
export async function GET(request: Request) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  try {
    return apiJson({ packages: parseBobGoPackages(await bobGoRequest("/packages")) });
  } catch {
    return apiJson({ error: "Saved packages could not be loaded. Retry or enter the packed dimensions yourself." }, { status: 502 });
  }
}
