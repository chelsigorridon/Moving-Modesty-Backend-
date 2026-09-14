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

export type AdminOrder = {
  id: string;
  customer: string;
  email: string;
  phone: string;
  placedAt: string;
  placedDate: string;
  total: number;
  paymentStatus: PaymentStatus;
  status: OrderStatus;
  deliveryMethod: "Courier" | "Collection" | "To be confirmed";
  address?: string;
  items: AdminOrderItem[];
};
