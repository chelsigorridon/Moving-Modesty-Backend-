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
  environment?: "sandbox" | "production";
  bookingEnabled: boolean;
  blockers: string[];
};

export type AdminOrder = {
  id: string;
  customer: string;
  email: string;
  phone: string;
  placedAt: string;
  placedDate: string;
  subtotal?: number;
  deliveryFee?: number;
  total: number;
  paymentStatus: PaymentStatus;
  payment?: {
    provider: "PayFast";
    providerStatus?: string;
    providerPaymentId?: string;
    failureReason?: string;
    updatedAt?: string;
  };
  status: OrderStatus;
  deliveryMethod: "Courier" | "Collection" | "To be confirmed";
  address?: string;
  items: AdminOrderItem[];
  shipping?: AdminShipment;
  workflow?: {
    nextStatus: OrderStatus | null;
    actionLabel: string;
    guidance: string;
    canCancel: boolean;
  };
};
