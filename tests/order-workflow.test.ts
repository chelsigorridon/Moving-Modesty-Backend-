import assert from "node:assert/strict";
import test from "node:test";
import { assertOrderTransition, getOrderWorkflow, OrderWorkflowConflict } from "../lib/order-workflow.ts";
import type { AdminOrder, OrderStatus, PaymentStatus } from "../lib/admin-types.ts";

const base = { status: "New" as OrderStatus, paymentStatus: "Paid" as PaymentStatus, deliveryMethod: "Collection" as AdminOrder["deliveryMethod"] };

test("paid collection orders follow each stage without skipping or reversing", () => {
  for (const [from, to] of [["New", "Confirmed"], ["Confirmed", "Preparing"], ["Preparing", "Ready"], ["Ready", "Collected"]] as const) {
    const order = { ...base, status: from };
    assert.equal(getOrderWorkflow(order).nextStatus, to);
    assert.doesNotThrow(() => assertOrderTransition(order, to));
    assert.throws(() => assertOrderTransition(order, from), OrderWorkflowConflict);
  }
  assert.throws(() => assertOrderTransition(base, "Collected"), OrderWorkflowConflict);
});

test("unpaid, failed and refunded orders cannot enter fulfilment", () => {
  for (const paymentStatus of ["Pending payment", "Failed", "Refunded"] as const) {
    const order = { ...base, paymentStatus };
    assert.equal(getOrderWorkflow(order).nextStatus, null);
    assert.throws(() => assertOrderTransition(order, "Confirmed"), OrderWorkflowConflict);
    assert.doesNotThrow(() => assertOrderTransition(order, "Cancelled"));
  }
});

test("completed or cancelled orders have no further actions", () => {
  for (const status of ["Collected", "Delivered", "Cancelled"] as const) {
    assert.deepEqual(getOrderWorkflow({ ...base, status }).nextStatus, null);
    assert.equal(getOrderWorkflow({ ...base, status }).canCancel, false);
    assert.throws(() => assertOrderTransition({ ...base, status }, "Confirmed"), OrderWorkflowConflict);
  }
});

test("courier handover requires a confirmed booking and cannot use collection action", () => {
  const order = { ...base, deliveryMethod: "Courier" as const, status: "Ready" as const };
  for (const shipmentStatus of [undefined, "Not ready", "Booking", "Failed", "Cancelled"]) {
    assert.equal(getOrderWorkflow({ ...order, shipmentStatus }).nextStatus, null);
  }
  assert.equal(getOrderWorkflow({ ...order, shipmentStatus: "Booked" }).nextStatus, "Dispatched");
  assert.throws(() => assertOrderTransition(order, "Collected"), OrderWorkflowConflict);
  assert.equal(getOrderWorkflow({ ...order, status: "Dispatched" }).nextStatus, "Delivered");
});

test("unknown fulfilment and committed shipments are protected", () => {
  assert.equal(getOrderWorkflow({ ...base, deliveryMethod: "To be confirmed" }).nextStatus, null);
  for (const shipmentStatus of ["Booking", "Booked"]) {
    assert.throws(() => assertOrderTransition({ ...base, shipmentStatus }, "Cancelled"), OrderWorkflowConflict);
  }
  assert.equal(getOrderWorkflow({ ...base, status: "Dispatched", deliveryMethod: "Courier" }).canCancel, false);
});
