import { apiJson } from "@/lib/api-response";
import { contactInputSchema, contactOriginAllowed } from "@/lib/contact-input";
import { db } from "@/lib/db";
import { ContactRateLimitError, sendContactMessage } from "@/lib/email";
import { reportFailure, resolveFailures } from "@/lib/monitoring";

const storeUrl = process.env.STORE_URL || "https://holistic-brand-492217.framer.app";

function headers(request: Request) {
  return {
    "Access-Control-Allow-Origin": request.headers.get("origin") || "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function allowed(request: Request) {
  return contactOriginAllowed(request.headers.get("origin"), request.url, storeUrl);
}

export function OPTIONS(request: Request) {
  return new Response(null, { status: allowed(request) ? 204 : 403, headers: allowed(request) ? headers(request) : {} });
}

export function GET(request: Request) {
  return apiJson({ available: Boolean(db && process.env.RESEND_API_KEY && process.env.AUTH_SECRET) },
    { headers: { ...headers(request), "Access-Control-Allow-Origin": allowed(request) ? request.headers.get("origin")! : "null" } });
}

export async function POST(request: Request) {
  if (!allowed(request)) return Response.json({ error: "This origin is not allowed." }, { status: 403 });
  const response = (data: unknown, status = 200) => apiJson(data, { status, headers: headers(request) });
  if (!request.headers.get("content-type")?.includes("application/json")) return response({ error: "Expected JSON." }, 415);
  if (Number(request.headers.get("content-length")) > 20000) return response({ error: "Message too long." }, 413);
  const raw = await request.text();
  if (raw.length > 20000) return response({ error: "Message too long." }, 413);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return response({ error: "Please check your message." }, 400); }
  const parsed = contactInputSchema.safeParse(value);
  if (!parsed.success) return response({ error: parsed.error.issues[0]?.message || "Please check your message." }, 400);
  if (parsed.data.website) return response({ error: "Please contact us on WhatsApp." }, 400);
  try {
    const sourceIp = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()
      || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    await sendContactMessage(parsed.data, sourceIp);
    await resolveFailures("contact_send");
    return response({ accepted: true });
  } catch (error) {
    if (error instanceof ContactRateLimitError) return response({ error: error.message }, 429);
    const recorded = error && typeof error === "object" && "errorRef" in error ? error.errorRef : null;
    const incident = recorded ? null : await reportFailure(error, { operation: "contact_send" });
    return response({ error: "We couldn’t send your message. Please try again or contact us on WhatsApp.", errorRef: recorded || incident?.reference }, 503);
  }
}
