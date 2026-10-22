import { apiJson, apiOptions } from "@/lib/api-response";
import { getPayFastCheckoutReadiness } from "@/lib/integrations/payfast/configuration";
import { reportFailure, resolveFailures } from "@/lib/monitoring";
import { readLimitedJson, RequestBodyError } from "@/lib/request-body";
import { consumeCheckoutAttempt } from "@/lib/checkout-rate-limit";
import {
  createPayFastCheckout,
  PayFastCheckoutError,
  payFastCheckoutSchema,
  recordPayFastCheckoutFailure,
} from "@/lib/integrations/payfast/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only preflight: no order, payment attempt, email or PayFast call is made.
export function GET() {
  return apiJson(getPayFastCheckoutReadiness());
}

export function OPTIONS() {
  return apiOptions();
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await readLimitedJson(request, 2_048);
    const limit = await consumeCheckoutAttempt(request, "payment");
    if (!limit.allowed) return apiJson({ error: "Please wait a few minutes before trying payment again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
  } catch (error) {
    if (error instanceof RequestBodyError) return apiJson({ error: error.message }, { status: error.status });
    const incident = await reportFailure(error, { operation: "payment_start" });
    return apiJson({ error: "Payment is temporarily unavailable. Please try again shortly.", errorRef: incident.reference }, { status: 503 });
  }
  const parsed = payFastCheckoutSchema.safeParse(body);
  if (!parsed.success) {
    return apiJson({ error: "The payment request is invalid." }, { status: 400 });
  }

  try {
    const payment = await createPayFastCheckout(parsed.data, request.url);
    await resolveFailures("payment_start", parsed.data.orderNumber);
    return apiJson({ payment });
  } catch (error) {
    const message = error instanceof Error ? error.message : "PayFast checkout could not be started.";
    try {
      // A validation/closed-order conflict isn't a failed payment attempt.
      if (!(error instanceof PayFastCheckoutError) || error.status >= 500) {
        await recordPayFastCheckoutFailure(parsed.data, message);
      }
    } catch (diagnosticError) {
      await reportFailure(diagnosticError, { operation: "payment_start" });
    }
    const expected = error instanceof PayFastCheckoutError && error.status < 500;
    const incident = expected ? null : await reportFailure(error, { operation: "payment_start", orderNumber: parsed.data.orderNumber });
    return apiJson(
      { error: error instanceof PayFastCheckoutError ? message : "Payment could not be started. Please try again shortly.", errorRef: incident?.reference },
      { status: error instanceof PayFastCheckoutError ? error.status : 503 },
    );
  }
}
