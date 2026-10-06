import { apiJson, apiOptions } from "@/lib/api-response";
import { getRequestAdmin } from "@/lib/auth";
import { resendPaidOrderEmails } from "@/lib/email";

export function OPTIONS() {
  return apiOptions();
}

export async function POST(request: Request, context: RouteContext<"/api/admin/orders/[orderNumber]/resend-paid-email">) {
  if (!(await getRequestAdmin(request))) return apiJson({ error: "Unauthorized" }, { status: 401 });
  const { orderNumber } = await context.params;

  try {
    const email = await resendPaidOrderEmails(orderNumber);
    return apiJson({ email });
  } catch (error) {
    return apiJson(
      { error: error instanceof Error ? error.message : "The payment confirmation email could not be sent." },
      { status: 503 },
    );
  }
}
