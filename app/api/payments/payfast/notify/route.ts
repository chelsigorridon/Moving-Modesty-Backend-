import {
  processPayFastNotification,
  PayFastNotificationError,
  recordPayFastNotificationFailure,
} from "@/lib/integrations/payfast/notification";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return new Response("Invalid content type", { status: 415 });
  }

  const rawBody = await request.text();
  try {
    await processPayFastNotification(request, rawBody);
    return new Response("OK", { status: 200 });
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
}
