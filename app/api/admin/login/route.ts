import { z } from "zod";
import { apiJson, apiOptions } from "@/lib/api-response";
import { authenticateAdmin, consumeAdminLoginAttempt, isAuthConfigured, issueAdminApiToken } from "@/lib/auth";
import { reportFailure } from "@/lib/monitoring";
import { readLimitedJson, RequestBodyError } from "@/lib/request-body";

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

export function OPTIONS() {
  return apiOptions();
}

export async function POST(request: Request) {
  if (!isAuthConfigured()) {
    return apiJson({ error: "Admin authentication is not configured on Vercel." }, { status: 503 });
  }
  let credentials: unknown;
  try { credentials = await readLimitedJson(request, 4096); }
  catch (error) { return apiJson({ error: error instanceof RequestBodyError ? error.message : "The sign-in request could not be read. Please try again." }, { status: error instanceof RequestBodyError ? error.status : 400 }); }
  const parsed = credentialsSchema.safeParse(credentials);
  if (!parsed.success) return apiJson({ error: "Enter a valid email address and password." }, { status: 400 });
  try {
    const limit = await consumeAdminLoginAttempt(request, parsed.data.email);
    if (!limit.allowed) return apiJson({ error: "Too many sign-in attempts. Please wait a few minutes before trying again.", retryAfter: limit.retryAfter }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
    const authenticated = await authenticateAdmin(parsed.data.email, parsed.data.password);
    if (!authenticated) return apiJson({ error: "The email address or password is incorrect." }, { status: 401 });
    return apiJson({ token: await issueAdminApiToken(parsed.data.email), admin: { email: parsed.data.email, role: "owner" } });
  } catch (error) {
    const incident = await reportFailure(error, { operation: "admin_login" });
    return apiJson({ error: "Sign-in is temporarily unavailable. Please try again shortly.", errorRef: incident.reference }, { status: 503 });
  }
}
