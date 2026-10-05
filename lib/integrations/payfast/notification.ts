import "server-only";

import { and, eq } from "drizzle-orm";
import { requireDatabase } from "@/lib/db";
import { orderStatusHistory, orders, payments } from "@/lib/db/schema";
import { isPaymentFinal } from "@/lib/checkout-safety";
import { requirePayFastConfiguration } from "./configuration";
import {
  createPayFastNotificationSignature,
  payFastNotificationParameterString,
  signaturesMatch,
} from "./signature";
import { isPayFastSourceIp, requestSourceIp } from "./source";

export class PayFastNotificationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly stage = "notification",
    readonly merchantPaymentId = "",
  ) {
    super(message);
    this.name = "PayFastNotificationError";
  }
}

function cents(value: string | null | undefined, merchantPaymentId: string) {
  const amount = Number(value ?? Number.NaN);
  if (!Number.isFinite(amount)) {
    throw new PayFastNotificationError("Invalid payment amount.", 400, "amount", merchantPaymentId);
  }
  return Math.round(amount * 100);
}

async function validateWithPayFast(
  validationUrl: string,
  parameterString: string,
  merchantPaymentId: string,
) {
  let response: Response;
  try {
    response = await fetch(validationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: parameterString,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new PayFastNotificationError(
      "PayFast validation is temporarily unavailable.",
      503,
      "server validation",
      merchantPaymentId,
    );
  }
  const result = (await response.text()).trim();
  if (!response.ok || result !== "VALID") {
    throw new PayFastNotificationError(
      "PayFast rejected the notification.",
      400,
      "server validation",
      merchantPaymentId,
    );
  }
}

export async function recordPayFastNotificationFailure(error: PayFastNotificationError) {
  if (!error.merchantPaymentId) return;
  const database = requireDatabase();
  const [payment] = await database
    .select({ id: payments.id, status: payments.status })
    .from(payments)
    .where(eq(payments.merchantPaymentId, error.merchantPaymentId))
    .limit(1);

  if (!payment || payment.status === "paid") return;
  await database
    .update(payments)
    .set({
      providerStatus: "ITN_REJECTED",
      failureReason: `PayFast ${error.stage} check failed: ${error.message}`.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(and(eq(payments.id, payment.id), eq(payments.status, payment.status)));
}

export async function processPayFastNotification(request: Request, rawBody: string) {
  const configuration = requirePayFastConfiguration();
  const params = new URLSearchParams(rawBody);
  const merchantPaymentId = params.get("m_payment_id")?.trim() ?? "";
  const receivedSignature = params.get("signature") ?? "";
  const expectedSignature = createPayFastNotificationSignature(params, configuration.passphrase);
  if (!receivedSignature || !signaturesMatch(receivedSignature, expectedSignature)) {
    throw new PayFastNotificationError("Invalid PayFast signature.", 400, "signature", merchantPaymentId);
  }
  if (params.get("merchant_id") !== configuration.merchantId) {
    throw new PayFastNotificationError("Invalid PayFast merchant.", 400, "merchant", merchantPaymentId);
  }

  if (configuration.enforceSourceIp) {
    const sourceIp = requestSourceIp(request);
    if (!sourceIp) {
      throw new PayFastNotificationError("Invalid PayFast source.", 400, "source", merchantPaymentId);
    }
    const validSource = await isPayFastSourceIp(sourceIp);
    if (validSource === null) {
      throw new PayFastNotificationError(
        "PayFast source validation is temporarily unavailable.",
        503,
        "source",
        merchantPaymentId,
      );
    }
    if (!validSource) {
      throw new PayFastNotificationError("Invalid PayFast source.", 400, "source", merchantPaymentId);
    }
  }

  const providerPaymentId = params.get("pf_payment_id")?.trim() ?? "";
  const providerStatus = params.get("payment_status")?.trim().toUpperCase() ?? "";
  if (!merchantPaymentId || !providerPaymentId || !providerStatus) {
    throw new PayFastNotificationError(
      "The PayFast notification is incomplete.",
      400,
      "payload",
      merchantPaymentId,
    );
  }

  const database = requireDatabase();
  const [payment] = await database
    .select({
      id: payments.id,
      orderId: payments.orderId,
      provider: payments.provider,
      amount: payments.amount,
      status: payments.status,
      providerPaymentId: payments.providerPaymentId,
      orderStatus: orders.status,
      orderPaymentStatus: orders.paymentStatus,
      orderTotal: orders.total,
    })
    .from(payments)
    .innerJoin(orders, eq(payments.orderId, orders.id))
    .where(eq(payments.merchantPaymentId, merchantPaymentId))
    .limit(1);
  if (!payment) {
    throw new PayFastNotificationError("Unknown payment reference.", 404, "reference", merchantPaymentId);
  }
  if (["payfast-production", "payfast-sandbox"].includes(payment.provider) && payment.provider !== `payfast-${configuration.environment}`) {
    throw new PayFastNotificationError("The payment environment does not match this checkout.", 400, "environment", merchantPaymentId);
  }
  if (
    cents(params.get("amount_gross"), merchantPaymentId) !== cents(payment.amount, merchantPaymentId) ||
    cents(payment.orderTotal, merchantPaymentId) !== cents(payment.amount, merchantPaymentId)
  ) {
    throw new PayFastNotificationError(
      "The payment amount does not match the order.",
      400,
      "amount",
      merchantPaymentId,
    );
  }
  if (payment.status === "paid" && payment.providerPaymentId !== providerPaymentId) {
    throw new PayFastNotificationError(
      "The PayFast transaction reference does not match.",
      400,
      "transaction reference",
      merchantPaymentId,
    );
  }

  await validateWithPayFast(
    configuration.validationUrl,
    payFastNotificationParameterString(params),
    merchantPaymentId,
  );

  const nextStatus = providerStatus === "COMPLETE"
    ? "paid"
    : providerStatus === "PENDING"
      ? "pending"
      : "failed";
  const verifiedAt = new Date();

  return database.transaction(async (transaction) => {
    const [lockedOrder] = await transaction.select({ status: orders.status, paymentStatus: orders.paymentStatus, total: orders.total })
      .from(orders).where(eq(orders.id, payment.orderId)).for("update").limit(1);
    const [lockedPayment] = await transaction.select({ status: payments.status, amount: payments.amount, providerPaymentId: payments.providerPaymentId })
      .from(payments).where(eq(payments.id, payment.id)).limit(1);
    if (!lockedOrder || !lockedPayment || cents(lockedOrder.total, merchantPaymentId) !== cents(lockedPayment.amount, merchantPaymentId)
      || cents(params.get("amount_gross"), merchantPaymentId) !== cents(lockedPayment.amount, merchantPaymentId)) {
      throw new PayFastNotificationError("The payment amount does not match the order.", 400, "amount", merchantPaymentId);
    }
    if (isPaymentFinal(lockedOrder.paymentStatus) || isPaymentFinal(lockedPayment.status)) {
      if (lockedPayment.providerPaymentId && lockedPayment.providerPaymentId !== providerPaymentId) {
        throw new PayFastNotificationError("The PayFast transaction reference does not match.", 400, "transaction reference", merchantPaymentId);
      }
      // Delayed FAILED/PENDING callbacks can never undo a verified payment.
      return { duplicate: true, paymentStatus: lockedOrder.paymentStatus, orderId: payment.orderId };
    }
    await transaction
      .update(payments)
      .set({
        providerPaymentId,
        provider: `payfast-${configuration.environment}`,
        providerStatus,
        status: nextStatus,
        verifiedAt,
        failureReason: nextStatus === "failed" ? `PayFast status: ${providerStatus}` : null,
        updatedAt: verifiedAt,
      })
      .where(eq(payments.id, payment.id));

    await transaction
      .update(orders)
      .set({
        paymentStatus: nextStatus,
        paymentReference: providerPaymentId,
        updatedAt: verifiedAt,
      })
      .where(eq(orders.id, payment.orderId));

    if (nextStatus === "paid" && lockedOrder.status === "new") {
      const [confirmed] = await transaction
        .update(orders)
        .set({ status: "confirmed", updatedAt: verifiedAt })
        .where(and(eq(orders.id, payment.orderId), eq(orders.status, "new")))
        .returning({ id: orders.id });
      if (confirmed) {
        await transaction.insert(orderStatusHistory).values({
          orderId: payment.orderId,
          fromStatus: "new",
          toStatus: "confirmed",
          note: "Payment confirmed by a verified PayFast notification.",
        });
      }
    }
    return { duplicate: false, paymentStatus: nextStatus, orderId: payment.orderId };
  });
}
