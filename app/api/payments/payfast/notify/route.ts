import {
  processPayFastNotification,
  PayFastNotificationError,
  recordPayFastNotificationFailure,
} from "@/lib/integrations/payfast/notification";
import { sendPaidOrderEmails } from "@/lib/email";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return new Response("Invalid content type", { status: 415 });
  }

  const rawBody = await request.text();
  let result: Awaited<ReturnType<typeof processPayFastNotification>>;
  try {
    result = await processPayFastNotification(request, rawBody);
  } catch (error) {
    const status = error instanceof PayFastNotificationError ? error.status : 503;
    if (error instanceof PayFastNotificationError) {
      try {
        await recordPayFastNotificationFailure(error);
      } catch (diagnosticError) {
        console.error(
          "Could not save the PayFast notification failure:",
          diagnosticError instanceof Error ? diagnosticError.message : "Unknown diagnostic error",
        );
      }
    }
    console.error(
      "PayFast notification rejected:",
      error instanceof Error ? error.message : "Unknown notification error",
    );
    return new Response(status === 503 ? "Temporary validation failure" : "Invalid notification", { status });
  }

  if (result.paymentStatus === "paid") {
    try {
      await sendPaidOrderEmails(result.orderId);
    } catch (error) {
      console.error(
        "Paid-order email notification failed:",
        error instanceof Error ? error.message : "Unknown email error",
      );
      // Returning a temporary failure asks PayFast to retry the notification.
      // Both emails use stable idempotency keys, so a successful recipient is
      // never sent the same paid-order message twice.
      return new Response("Temporary email notification failure", { status: 503 });
    }
  }

  return new Response("OK", { status: 200 });
}
