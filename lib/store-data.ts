export type OrderStatus = "New" | "Confirmed" | "Processing" | "Ready" | "Dispatched" | "Delivered";

export type Order = {
  id: string;
  customer: string;
  email: string;
  phone: string;
  placedAt: string;
  placedDate: string;
  total: number;
  paymentStatus: "Paid" | "Pending";
  status: OrderStatus;
  deliveryMethod: "Courier" | "Collection" | "To be confirmed";
  address?: string;
  items: Array<{ name: string; variant: string; quantity: number; price: number; image: string }>;
};

export type Product = {
  id: string;
  name: string;
  category: string;
  price: number;
  image: string;
  status: "Active" | "Draft";
  variants: Array<{ size: string; colour: string; sku: string; stock: number }>;
};

export const orders: Order[] = [
  {
    id: "MM-1048", customer: "Naledi Mokoena", email: "naledi@example.com", phone: "+27 72 555 0148",
    placedAt: "28 Aug, 10:42", placedDate: "28 August 2026 at 10:42", total: 1498, paymentStatus: "Paid", status: "New",
    deliveryMethod: "To be confirmed", address: "18 Acacia Avenue, Midrand, Gauteng, 1685",
    items: [
      { name: "Amina Abaya", variant: "Black · Size 54", quantity: 1, price: 749, image: "/products/amina-black.jpeg" },
      { name: "Amina Abaya", variant: "Lilac · Size 54", quantity: 1, price: 749, image: "/products/amina-lilac.jpeg" },
    ],
  },
  {
    id: "MM-1047", customer: "Aisha Khan", email: "aisha@example.com", phone: "+27 82 555 0112",
    placedAt: "28 Aug, 09:16", placedDate: "28 August 2026 at 09:16", total: 899, paymentStatus: "Paid", status: "Processing",
    deliveryMethod: "Courier", address: "42 Rosebank Road, Cape Town, Western Cape, 7700",
    items: [{ name: "Hawa Dress", variant: "Soft Pink · Size 52", quantity: 1, price: 899, image: "/products/hawa-soft-pink.jpeg" }],
  },
  {
    id: "MM-1046", customer: "Zanele Dlamini", email: "zanele@example.com", phone: "+27 71 555 0166",
    placedAt: "27 Aug, 16:03", placedDate: "27 August 2026 at 16:03", total: 2147, paymentStatus: "Paid", status: "Ready",
    deliveryMethod: "Collection", items: [
      { name: "Amina Abaya", variant: "Black · Size 56", quantity: 1, price: 749, image: "/products/amina-black.jpeg" },
      { name: "Hawa Dress", variant: "Soft Pink · Size 54", quantity: 1, price: 899, image: "/products/hawa-soft-pink.jpeg" },
      { name: "Essential Hijab", variant: "Taupe · One size", quantity: 1, price: 499, image: "/products/amina-lilac.jpeg" },
    ],
  },
  {
    id: "MM-1045", customer: "Samira Jacobs", email: "samira@example.com", phone: "+27 79 555 0132",
    placedAt: "27 Aug, 12:38", placedDate: "27 August 2026 at 12:38", total: 749, paymentStatus: "Paid", status: "Delivered",
    deliveryMethod: "Courier", address: "9 Kloof Street, Johannesburg, Gauteng, 2198",
    items: [{ name: "Amina Abaya", variant: "Lilac · Size 52", quantity: 1, price: 749, image: "/products/amina-lilac.jpeg" }],
  },
  {
    id: "MM-1044", customer: "Fatima Essop", email: "fatima@example.com", phone: "+27 83 555 0188",
    placedAt: "26 Aug, 14:21", placedDate: "26 August 2026 at 14:21", total: 1648, paymentStatus: "Pending", status: "Confirmed",
    deliveryMethod: "To be confirmed", address: "74 Musgrave Road, Durban, KwaZulu-Natal, 4001",
    items: [
      { name: "Hawa Dress", variant: "Soft Pink · Size 56", quantity: 1, price: 899, image: "/products/hawa-soft-pink.jpeg" },
      { name: "Amina Abaya", variant: "Black · Size 58", quantity: 1, price: 749, image: "/products/amina-black.jpeg" },
    ],
  },
];

export const products: Product[] = [
  {
    id: "amina-abaya", name: "Amina Abaya", category: "Abayas", price: 749, image: "/products/amina-black.jpeg", status: "Active",
    variants: [
      { size: "52", colour: "Black", sku: "AMN-BLK-52", stock: 6 },
      { size: "54", colour: "Black", sku: "AMN-BLK-54", stock: 1 },
      { size: "56", colour: "Black", sku: "AMN-BLK-56", stock: 4 },
      { size: "52", colour: "Lilac", sku: "AMN-LIL-52", stock: 5 },
      { size: "54", colour: "Lilac", sku: "AMN-LIL-54", stock: 7 },
      { size: "56", colour: "Lilac", sku: "AMN-LIL-56", stock: 2 },
    ],
  },
  {
    id: "hawa-dress", name: "Hawa Dress", category: "Dresses", price: 899, image: "/products/hawa-soft-pink.jpeg", status: "Active",
    variants: [
      { size: "52", colour: "Soft Pink", sku: "HAW-PNK-52", stock: 0 },
      { size: "54", colour: "Soft Pink", sku: "HAW-PNK-54", stock: 8 },
      { size: "56", colour: "Soft Pink", sku: "HAW-PNK-56", stock: 3 },
    ],
  },
  {
    id: "essential-hijab", name: "Essential Hijab", category: "Accessories", price: 499, image: "/products/amina-lilac.jpeg", status: "Draft",
    variants: [{ size: "One size", colour: "Taupe", sku: "HIJ-TAU-OS", stock: 12 }],
  },
];

export const currency = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 });

export function statusTone(status: OrderStatus) {
  return status.toLowerCase().replaceAll(" ", "-");
}
