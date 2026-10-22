export type PaymentStatus = "Pending payment" | "Paid" | "Failed" | "Refunded";

export type OrderStatus =
  | "New"
  | "Confirmed"
  | "Preparing"
  | "Ready"
  | "Dispatched"
  | "Collected"
  | "Delivered"
  | "Cancelled";

export type AdminOrderItem = {
  id?: string;
  returnableQuantity?: number;
  restockableQuantity?: number;
  name: string;
  variant: string;
  quantity: number;
  price: number;
  image: string;
};

export type AdminShipment = {
  provider: "Bob Go";
  status: "Not ready" | "Ready to book" | "Booking" | "Booked" | "Failed" | "Cancelled";
  senderLocationName: string;
  pickupPointLocationId?: string;
  weightGrams?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  waybillReference?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  lastError?: string;
  serviceLevelCode?: string;
  courierName?: string;
  serviceName?: string;
  courierStatus?: string;
  environment?: "sandbox" | "production";
  bookingEnabled: boolean;
  blockers: string[];
};

export type AdminOrder = {
  detailsLoaded?: boolean;
  listNeedsAttention?: boolean;
  listInProgress?: boolean;
  id: string;
  customer: string;
  email: string;
  phone: string;
  placedAt: string;
  placedDate: string;
  subtotal?: number;
  discountAmount?: number;
  discountCode?: string;
  deliveryFee?: number;
  total: number;
  paymentStatus: PaymentStatus;
  payment?: {
    provider: "PayFast";
    environment?: "sandbox" | "production" | "unknown";
    providerStatus?: string;
    providerPaymentId?: string;
    failureReason?: string;
    updatedAt?: string;
  };
  status: OrderStatus;
  deliveryMethod: "Courier" | "Collection" | "To be confirmed";
  address?: string;
  deliveryDetails?: {
    revision: number;
    plan: import("./delivery-input").CourierPlan | null;
    draftPlan: import("./delivery-input").CourierPlan;
    privateNote: string;
    canEdit: boolean;
    blockedReason?: string;
    collectionTimeMode?: "preferred_instructions";
    waybillChange?: { action: "cancel_waybill" | "check_cancellation" | "prepare_replacement"; trackingNumber: string };
    previousWaybills?: Array<{ trackingNumber: string; courierName: string; status: string; replacedAt: string }>;
  };
  bobGoSync?: { status: string; message?: string; remoteOrderId?: string };
  items: AdminOrderItem[];
  actionNeeded?: Array<{ message: string; reference?: string }>;
  notifications?: Array<{
    id: string;
    title: string;
    recipient: string;
    status: "queued" | "sent" | "delivered" | "failed";
    createdAt: string;
    retryable: boolean;
    deliveryMessage?: string;
    deliveryEvent?: string;
  }>;
  shipping?: AdminShipment;
  aftersales?: {
    canStartReturn: boolean;
    canRecordRefund: boolean;
    refundedTotal: number;
    remainingRefundable: number;
    returns: Array<{ id: string; status: string; reason: string; waybillReference?: string;
      receivedAt?: string; items: Array<{ itemId: string; quantity: number; restocked: number }> }>;
    refunds: Array<{ id: string; amount: number; reference: string; reason: string; refundedAt: string; recordedBy: string }>;
  };
  workflow?: {
    nextStatus: OrderStatus | null;
    actionLabel: string;
    guidance: string;
    canCancel: boolean;
  };
};
