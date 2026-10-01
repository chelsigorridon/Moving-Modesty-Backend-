import type { AdminOrder, OrderStatus } from "./admin-types.ts";

export type OrderWorkflow = {
  nextStatus: OrderStatus | null;
  actionLabel: string;
  guidance: string;
  canCancel: boolean;
};

type WorkflowOrder = Pick<AdminOrder, "status" | "paymentStatus" | "deliveryMethod"> & {
  shipmentStatus?: string;
};

export class OrderWorkflowConflict extends Error {}

export function getOrderWorkflow(order: WorkflowOrder): OrderWorkflow {
  const terminal = ["Collected", "Delivered", "Cancelled"].includes(order.status);
  const shipmentCommitted = ["Booked", "Booking"].includes(order.shipmentStatus ?? "");
  const canCancel = !terminal && order.status !== "Dispatched" && !shipmentCommitted;
  const result = (guidance: string, nextStatus: OrderStatus | null = null, actionLabel = "") =>
    ({ nextStatus, actionLabel, guidance, canCancel });

  if (terminal) return result(order.status === "Cancelled"
    ? "This order is cancelled. Any payment refund must be handled separately in PayFast."
    : "This order is complete. No further fulfilment action is needed.");
  if (order.paymentStatus !== "Paid") return result(order.paymentStatus === "Pending payment"
    ? "Wait for PayFast to confirm payment before preparing this order."
    : "Resolve the payment before preparing this order. Payment and order status are separate.");
  if (order.deliveryMethod === "To be confirmed") return result("Confirm delivery or collection with the customer before continuing. Contact your website administrator to correct the order.");
  if (order.status === "New") return result("Check the items and customer details, then accept this paid order.", "Confirmed", "Confirm order");
  if (order.status === "Confirmed") return result("Start packing the items for this customer.", "Preparing", "Start preparing");
  if (order.status === "Preparing") return result(order.deliveryMethod === "Collection"
    ? "Once packed, mark ready and message the customer privately to arrange collection."
    : "Once packed, mark ready for courier handover.", "Ready", order.deliveryMethod === "Collection" ? "Ready for collection" : "Ready for courier");
  if (order.status === "Ready" && order.deliveryMethod === "Collection") return result("Arrange collection privately. Only mark collected after handing the parcel to the customer.", "Collected", "Mark collected");
  if (order.status === "Ready" && order.deliveryMethod === "Courier") return shipmentCommitted && order.shipmentStatus === "Booked"
    ? result("Use the booked waybill. Mark dispatched only after handing the parcel to the courier or locker.", "Dispatched", "Mark dispatched")
    : result(order.shipmentStatus === "Booking"
      ? "Bob Go is checking this shipment. Use Check shipment status; do not book another waybill."
      : "Confirm the packed weight and dimensions below, get a courier quote, then approve the booking. Mark dispatched only after dropping off the parcel.");
  if (order.status === "Dispatched" && order.deliveryMethod === "Courier") return result("Check the courier tracking. Only mark delivered after delivery is confirmed.", "Delivered", "Mark delivered");
  return result("This order needs review. Contact your website administrator before changing its status.");
}

export function assertOrderTransition(order: WorkflowOrder, nextStatus: OrderStatus) {
  const workflow = getOrderWorkflow(order);
  if (nextStatus === "Cancelled" ? workflow.canCancel : workflow.nextStatus === nextStatus) return;
  throw new OrderWorkflowConflict(`This order cannot be changed to ${nextStatus.toLowerCase()} from its current stage. Refresh the order and follow its next step.`);
}
