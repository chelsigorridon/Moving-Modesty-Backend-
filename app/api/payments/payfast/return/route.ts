import { and, eq } from "drizzle-orm";
import { requireDatabase } from "@/lib/db";
import { orders, payments } from "@/lib/db/schema";
import { requirePayFastConfiguration } from "@/lib/integrations/payfast/configuration";

export const runtime = "nodejs";

type ReturnState = "processing" | "cancelled";

function storefrontUrl(storeUrl: string, state: ReturnState, orderNumber?: string) {
  const url = new URL("/checkout", `${storeUrl}/`);
  url.searchParams.set("payment", state);
  if (orderNumber) url.searchParams.set("order", orderNumber);
  return url;
}

export async function GET(request: Request) {
  const configuration = requirePayFastConfiguration();
  const url = new URL(request.url);
  const state: ReturnState = url.searchParams.get("state") === "cancelled" ? "cancelled" : "processing";
  const orderNumber = url.searchParams.get("order")?.trim() ?? "";
  const checkoutToken = url.searchParams.get("token")?.trim() ?? "";

  if (!orderNumber || !checkoutToken) {
    return Response.redirect(storefrontUrl(configuration.storeUrl, state), 302);
  }

  const database = requireDatabase();
  const [order] = await database
    .select({ id: orders.id, paymentStatus: orders.paymentStatus })
    .from(orders)
    .where(and(
      eq(orders.orderNumber, orderNumber),
      eq(orders.checkoutToken, checkoutToken),
    ))
    .limit(1);

  if (!order) {
    return Response.redirect(storefrontUrl(configuration.storeUrl, state), 302);
  }

  const now = new Date();
  if (state === "cancelled" && order.paymentStatus !== "paid") {
    await database.transaction(async (transaction) => {
      await transaction
        .update(payments)
        .set({
          status: "failed",
          providerStatus: "CANCELLED",
          failureReason: "Customer cancelled on the PayFast payment page.",
          updatedAt: now,
        })
        .where(eq(payments.orderId, order.id));
      await transaction
        .update(orders)
        .set({ paymentStatus: "failed", updatedAt: now })
        .where(eq(orders.id, order.id));
    });
  } else if (state === "processing" && order.paymentStatus === "pending") {
    await database
      .update(payments)
      .set({ providerStatus: "CUSTOMER_RETURNED", updatedAt: now })
      .where(and(eq(payments.orderId, order.id), eq(payments.status, "pending")));
  }

  return Response.redirect(storefrontUrl(configuration.storeUrl, state, orderNumber), 302);
}
