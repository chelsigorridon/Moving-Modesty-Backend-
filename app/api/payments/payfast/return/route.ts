import { and, eq } from "drizzle-orm";
import { requireDatabase } from "@/lib/db";
import { orders, payments } from "@/lib/db/schema";
import { requirePayFastConfiguration } from "@/lib/integrations/payfast/configuration";
import { isPaymentFinal } from "@/lib/checkout-safety";

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
  const order = await database.transaction(async (transaction) => {
  const [order] = await transaction
    .select({ id: orders.id, paymentStatus: orders.paymentStatus })
    .from(orders)
    .where(and(
      eq(orders.orderNumber, orderNumber),
      eq(orders.checkoutToken, checkoutToken),
    ))
    .for("update").limit(1);

  if (!order) {
    return null;
  }

  const now = new Date();
  if (state === "cancelled" && !isPaymentFinal(order.paymentStatus)) {
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
  } else if (state === "processing" && order.paymentStatus === "pending") {
    await transaction
      .update(payments)
      .set({ providerStatus: "CUSTOMER_RETURNED", updatedAt: now })
      .where(and(eq(payments.orderId, order.id), eq(payments.status, "pending")));
  }
  return order;
  });

  return Response.redirect(storefrontUrl(configuration.storeUrl, state, order ? orderNumber : undefined), 302);
}
