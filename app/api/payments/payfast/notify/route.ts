import {
  processPayFastNotification,
  PayFastNotificationError,
} from "@/lib/integrations/payfast/notification";
import { sendPaidOrderEmails } from "@/lib/email";
import { reportFailure, resolveFailures } from "@/lib/monitoring";
import { after } from "next/server";
import { syncConfiguredPaidOrder } from "@/lib/integrations/bobgo/order-sync-runtime";
import { readLimitedText, RequestBodyError } from "@/lib/request-body";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return new Response("Invalid content type", { status: 415 });
  }

  let result: Awaited<ReturnType<typeof processPayFastNotification>>;
  try {
    const rawBody = await readLimitedText(request, 16_384);
    result = await processPayFastNotification(request, rawBody);
  } catch (error) {
    if (error instanceof RequestBodyError) return new Response("Invalid notification", { status: error.status });
    const status = error instanceof PayFastNotificationError ? error.status : 503;
    // Rejected input is not evidence about an order. Never write payment metadata
    // or attach an attacker-supplied reference to a customer's order/alert.
    await reportFailure(error, { operation: "payment_notify", severity: status < 500 ? "warning" : "error", alert: status >= 500 });
    return new Response(status === 503 ? "Temporary validation failure" : "Invalid notification", { status });
  }
  await resolveFailures("payment_notify", result.orderId);

  if (result.paymentStatus === "paid" && !result.courierTest) {
    after(async () => {
      try { await syncConfiguredPaidOrder(result.orderId); }
      catch { await reportFailure(null, { operation: "courier_sync", orderId: result.orderId, code: "provider_request", alert: false }); }
    });
    try {
      await sendPaidOrderEmails(result.orderId);
    } catch (error) {
      if (!(error && typeof error === "object" && "errorRef" in error)) {
        await reportFailure(error, { operation: "email_send", orderId: result.orderId, alert: false });
      }
      // Returning a temporary failure asks PayFast to retry the notification.
      // Both emails use stable idempotency keys, so a successful recipient is
      // never sent the same paid-order message twice.
      return new Response("Temporary email notification failure", { status: 503 });
    }
  }

  return new Response("OK", { status: 200 });
}
