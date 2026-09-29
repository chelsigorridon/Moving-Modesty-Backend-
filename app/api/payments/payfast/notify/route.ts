import { processPayFastNotification, PayFastNotificationError } from "@/lib/integrations/payfast/notification";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return new Response("Invalid content type", { status: 415 });
  }

  try {
    await processPayFastNotification(request, await request.text());
    return new Response("OK", { status: 200 });
  } catch (error) {
    const status = error instanceof PayFastNotificationError ? error.status : 503;
    console.error(
      "PayFast notification rejected:",
      error instanceof Error ? error.message : "Unknown notification error",
    );
    return new Response(status === 503 ? "Temporary validation failure" : "Invalid notification", { status });
  }
}
