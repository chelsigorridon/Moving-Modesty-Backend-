import { and, desc, eq, isNull } from "drizzle-orm";
import { requireDatabase } from "./db";
import { emailEvents, orders, orderStatusHistory, payments, shipments, systemErrors } from "./db/schema";

export async function getOrderTrace(orderNumber: string) {
  const database = requireDatabase();
  const [order] = await database.select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status,
    paymentStatus: orders.paymentStatus, createdAt: orders.createdAt, updatedAt: orders.updatedAt })
    .from(orders).where(and(eq(orders.orderNumber, orderNumber), isNull(orders.archivedAt))).limit(1);
  if (!order) return null;
  // Select fields explicitly: customer data, checkout tokens, API secrets and raw provider bodies never belong in support traces.
  const [payment, shipment, notifications, incidents, history] = await Promise.all([
    database.select({ provider: payments.provider, status: payments.status, providerStatus: payments.providerStatus,
      merchantPaymentId: payments.merchantPaymentId, providerPaymentId: payments.providerPaymentId,
      verifiedAt: payments.verifiedAt, updatedAt: payments.updatedAt }).from(payments).where(eq(payments.orderId, order.id)).limit(1),
    database.select({ provider: shipments.provider, status: shipments.status, providerShipmentId: shipments.providerShipmentId,
      waybillReference: shipments.waybillReference, trackingNumber: shipments.trackingNumber,
      bookedAt: shipments.bookedAt, updatedAt: shipments.updatedAt }).from(shipments).where(eq(shipments.orderId, order.id)).limit(1),
    database.select({ template: emailEvents.template, status: emailEvents.status, providerEmailId: emailEvents.resendEmailId,
      deliveryEvent: emailEvents.deliveryEvent, deliveryEventAt: emailEvents.deliveryEventAt, createdAt: emailEvents.createdAt })
      .from(emailEvents).where(eq(emailEvents.orderId, order.id)).orderBy(desc(emailEvents.createdAt)).limit(50),
    database.select({ reference: systemErrors.reference, source: systemErrors.source, operation: systemErrors.operation,
      code: systemErrors.code, summary: systemErrors.summary, httpStatus: systemErrors.httpStatus, occurrences: systemErrors.occurrences,
      firstSeenAt: systemErrors.firstSeenAt, lastSeenAt: systemErrors.lastSeenAt, resolvedAt: systemErrors.resolvedAt })
      .from(systemErrors).where(eq(systemErrors.orderId, order.id)).orderBy(desc(systemErrors.lastSeenAt)).limit(50),
    database.select({ from: orderStatusHistory.fromStatus, to: orderStatusHistory.toStatus, at: orderStatusHistory.createdAt })
      .from(orderStatusHistory).where(eq(orderStatusHistory.orderId, order.id)).orderBy(desc(orderStatusHistory.createdAt)).limit(50),
  ]);
  return { order, payment: payment[0] || null, shipment: shipment[0] || null, notifications, incidents, history,
    limitations: "Provider status is the latest recorded status, not a complete history of every gateway screen. No callback does not mean paid. Courier status refresh is manual." };
}
