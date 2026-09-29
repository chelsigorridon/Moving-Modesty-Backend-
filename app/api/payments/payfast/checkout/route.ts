import { apiJson, apiOptions } from "@/lib/api-response";
import {
  createPayFastCheckout,
  PayFastCheckoutError,
  payFastCheckoutSchema,
  recordPayFastCheckoutFailure,
} from "@/lib/integrations/payfast/checkout";

export const runtime = "nodejs";

export function OPTIONS() {
  return apiOptions();
}

export async function POST(request: Request) {
  const parsed = payFastCheckoutSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiJson({ error: "The payment request is invalid." }, { status: 400 });
  }

  try {
    return apiJson({ payment: await createPayFastCheckout(parsed.data, request.url) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "PayFast checkout could not be started.";
    try {
      await recordPayFastCheckoutFailure(parsed.data, message);
    } catch (diagnosticError) {
      console.error(
        "Could not save the PayFast checkout failure:",
        diagnosticError instanceof Error ? diagnosticError.message : "Unknown diagnostic error",
      );
    }
    return apiJson(
      { error: message },
      { status: error instanceof PayFastCheckoutError ? error.status : 503 },
    );
  }
}
