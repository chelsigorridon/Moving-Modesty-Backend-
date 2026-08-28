import { z } from "zod";
import { apiJson, apiOptions } from "@/lib/api-response";
import { authenticateAdmin, isAuthConfigured, issueAdminApiToken } from "@/lib/auth";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

export function OPTIONS() {
  return apiOptions();
}

export async function POST(request: Request) {
  if (!isAuthConfigured()) {
    return apiJson({ error: "Admin authentication is not configured on Vercel." }, { status: 503 });
  }
  const parsed = credentialsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: "Enter a valid email address and password." }, { status: 400 });
  const authenticated = await authenticateAdmin(parsed.data.email, parsed.data.password);
  if (!authenticated) return apiJson({ error: "The email address or password is incorrect." }, { status: 401 });
  return apiJson({
    token: issueAdminApiToken(parsed.data.email),
    admin: { email: parsed.data.email.toLowerCase(), role: "owner" },
  });
}
