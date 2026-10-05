import { z } from "zod";
import { apiJson } from "@/lib/api-response";
import { resendPaidOrderEmails } from "@/lib/email";

const bodySchema = z.object({ orderNumber: z.string().trim().min(6).max(80) });

export async function POST(request: Request) {
  const expectedToken = process.env.EMAIL_RETRY_TOKEN;
  const suppliedToken = request.headers.get("x-email-retry-token");
  if (!expectedToken || suppliedToken !== expectedToken) {
    return apiJson({ error: "Not found" }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: "A valid order number is required." }, { status: 400 });

  try {
    const email = await resendPaidOrderEmails(parsed.data.orderNumber);
    return apiJson({ email });
  } catch (error) {
    return apiJson(
      { error: error instanceof Error ? error.message : "The payment email could not be retried." },
      { status: 503 },
    );
  }
}
