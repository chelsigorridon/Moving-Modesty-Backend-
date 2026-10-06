import type { AdminOrder, OrderStatus } from "./admin-types.ts";

export const bobGoTrackingUrl = "https://track.bobgo.co.za/";

export function hasShipmentTracking(value?: string | null) {
  return Boolean(value?.trim() && !/^(demo|test)(?:\b|[-_])/i.test(value.trim()));
}

export function dispatchTracking(order: Pick<AdminOrder, "deliveryMethod" | "shipping">) {
  if (order.deliveryMethod !== "Courier" || order.shipping?.status !== "Booked" || !hasShipmentTracking(order.shipping.trackingNumber)) {
    throw new Error("A confirmed Bob Go booking with a tracking number is required before sending a dispatch notification. Check shipment status first.");
  }
  return { number: order.shipping.trackingNumber!.trim(), url: bobGoTrackingUrl, sandbox: order.shipping.environment === "sandbox" };
}

export function shouldNotifyOrderStatus(deliveryMethod: AdminOrder["deliveryMethod"], status: OrderStatus) {
  // Preparation is internal. Notify customers only at meaningful handover stages.
  return status === "Ready" ? deliveryMethod === "Collection"
    : ["Dispatched", "Collected", "Delivered", "Cancelled"].includes(status);
}

export function notificationStatus(template: string): OrderStatus | undefined {
  const statuses: OrderStatus[] = ["Ready", "Dispatched", "Collected", "Delivered", "Cancelled"];
  return statuses.find(status => template === `order-status-${status.toLowerCase()}`);
}

export function notificationTitle(template: string) {
  if (template.startsWith("order-refund-")) return "Customer refund confirmation";
  if (template === "paid-order-customer") return "Customer payment confirmation";
  if (template === "paid-order-owner") return "New order notification to Zarina";
  const status = notificationStatus(template);
  return status ? `${status === "Ready" ? "Ready for collection" : status} notification` : "Order notification";
}

export function canRetryNotification(template: string, order: Pick<AdminOrder, "status" | "paymentStatus" | "deliveryMethod">) {
  if (/^order-refund-[0-9a-f-]{36}$/i.test(template)) return ["Paid", "Refunded"].includes(order.paymentStatus);
  if (template === "paid-order-customer" || template === "paid-order-owner") return order.paymentStatus === "Paid";
  const status = notificationStatus(template);
  return Boolean(status && status === order.status && shouldNotifyOrderStatus(order.deliveryMethod, status));
}
