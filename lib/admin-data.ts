import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import {
  addresses,
  customers,
  emailEvents,
  inventoryMovements,
  orderItems,
  orders as ordersTable,
  orderStatusHistory,
  payments,
  products as productsTable,
  productVariants,
  shipments,
} from "./db/schema";
import type { AdminOrder, OrderStatus, PaymentStatus } from "./admin-types";
import { getBobGoConfiguration } from "./integrations/bobgo/configuration";
import { shipmentBookingBlockers } from "./shipping/readiness";
import { orders as demoOrders, products as demoProducts } from "./store-data";
import type { ProductInput } from "./product-input";
import { assertOrderTransition, getOrderWorkflow } from "./order-workflow";
import { paymentEnvironmentFromProvider } from "./payment-environment";
import { readOrderCustomer } from "./checkout-safety";
import { canRetryNotification, notificationTitle } from "./order-notifications";
import { getOperationalIssues } from "./monitoring";
import { incidentAction, notificationDeliveryMessage } from "./monitoring-policy";

export type { AdminOrder } from "./admin-types";
export type AdminProduct = {
  id: string;
  name: string;
  category: string;
  description: string;
  price: number;
  image: string;
  status: "Active" | "Draft";
  variants: Array<{
    id?: string;
    size: string;
    colour: string;
    sku: string;
    stock: number;
    price: number;
    lowStockThreshold: number;
  }>;
};

export type AdminSnapshot = {
  orders: AdminOrder[];
  products: AdminProduct[];
  operationalNotice?: string;
};

const statusLabels: Record<string, OrderStatus> = {
  new: "New",
  confirmed: "Confirmed",
  processing: "Preparing",
  ready: "Ready",
  dispatched: "Dispatched",
  collected: "Collected",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

const paymentLabels: Record<string, PaymentStatus> = {
  pending: "Pending payment",
  paid: "Paid",
  failed: "Failed",
  refunded: "Refunded",
};

const deliveryLabels = {
  courier: "Courier",
  collection: "Collection",
  to_be_confirmed: "To be confirmed",
} as const;

const shipmentStatusLabels = {
  not_ready: "Not ready",
  ready_to_book: "Ready to book",
  booking: "Booking",
  booked: "Booked",
  failed: "Failed",
  cancelled: "Cancelled",
} as const;

const dateFormatter = new Intl.DateTimeFormat("en-ZA", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatAddress(parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(", ");
}

function snapshotImage(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const image = (value as Record<string, unknown>).image;
  return typeof image === "string" ? image : "";
}

export function getDemoAdminSnapshot(): AdminSnapshot {
  return {
    orders: demoOrders,
    products: demoProducts.map((product) => ({
      ...product,
      description: "",
      variants: product.variants.map((variant) => ({
        ...variant,
        price: product.price,
        lowStockThreshold: 3,
      })),
    })),
  };
}

export async function getAdminSnapshot(): Promise<AdminSnapshot> {
  if (!db) {
    if (process.env.NODE_ENV === "development") return getDemoAdminSnapshot();
    throw new Error("DATABASE_URL is not configured.");
  }

  const [orderRows, itemRows, productRows, variantRows, shipmentRows, notificationRows, incidents] = await Promise.all([
    db
      .select({
        id: ordersTable.id,
        orderNumber: ordersTable.orderNumber,
        status: ordersTable.status,
        paymentStatus: ordersTable.paymentStatus,
        deliveryMethod: ordersTable.deliveryMethod,
        subtotal: ordersTable.subtotal,
        deliveryFee: ordersTable.deliveryFee,
        total: ordersTable.total,
        createdAt: ordersTable.createdAt,
        providerPaymentId: payments.providerPaymentId,
        paymentProvider: payments.provider,
        providerStatus: payments.providerStatus,
        paymentFailureReason: payments.failureReason,
        paymentUpdatedAt: payments.updatedAt,
        customerFirstName: customers.firstName,
        customerLastName: customers.lastName,
        customerEmail: customers.email,
        customerPhone: customers.phone,
        customerSnapshot: ordersTable.customerSnapshot,
        recipientName: addresses.recipientName,
        line1: addresses.line1,
        line2: addresses.line2,
        suburb: addresses.suburb,
        city: addresses.city,
        province: addresses.province,
        postalCode: addresses.postalCode,
      })
      .from(ordersTable)
      .leftJoin(customers, eq(ordersTable.customerId, customers.id))
      .leftJoin(addresses, eq(ordersTable.deliveryAddressId, addresses.id))
      .leftJoin(payments, eq(ordersTable.id, payments.orderId))
      .orderBy(desc(ordersTable.createdAt)),
    db
      .select({
        orderId: orderItems.orderId,
        name: orderItems.productName,
        variant: orderItems.variantName,
        quantity: orderItems.quantity,
        price: orderItems.unitPrice,
        productSnapshot: orderItems.productSnapshot,
      })
      .from(orderItems),
    db
      .select({
        id: productsTable.id,
        slug: productsTable.slug,
        name: productsTable.name,
        category: productsTable.category,
        description: productsTable.description,
        status: productsTable.status,
        image: productsTable.primaryImageUrl,
      })
      .from(productsTable)
      .orderBy(desc(productsTable.createdAt)),
    db
      .select({
        id: productVariants.id,
        productId: productVariants.productId,
        size: productVariants.size,
        colour: productVariants.colour,
        sku: productVariants.sku,
        stock: productVariants.stockOnHand,
        price: productVariants.price,
        lowStockThreshold: productVariants.lowStockThreshold,
      })
      .from(productVariants),
    db
      .select({
        orderId: shipments.orderId,
        status: shipments.status,
        senderLocationName: shipments.senderLocationName,
        pickupPointLocationId: shipments.pickupPointLocationId,
        weightGrams: shipments.weightGrams,
        lengthCm: shipments.lengthCm,
        widthCm: shipments.widthCm,
        heightCm: shipments.heightCm,
        waybillReference: shipments.waybillReference,
        trackingNumber: shipments.trackingNumber,
        trackingUrl: shipments.trackingUrl,
        lastError: shipments.lastError,
        serviceLevelCode: shipments.serviceLevelCode,
        providerShipmentId: shipments.providerShipmentId,
        shipmentProvider: shipments.provider,
      })
      .from(shipments),
    db.select().from(emailEvents).orderBy(desc(emailEvents.createdAt)),
    getOperationalIssues().catch(() => null),
  ]);

  const bobGo = getBobGoConfiguration();
  const shipmentByOrder = new Map(shipmentRows.map((shipment) => [shipment.orderId, shipment]));

  const itemsByOrder = new Map<string, AdminOrder["items"]>();
  for (const item of itemRows) {
    const items = itemsByOrder.get(item.orderId) ?? [];
    items.push({
      name: item.name,
      variant: item.variant,
      quantity: item.quantity,
      price: Number(item.price),
      image: snapshotImage(item.productSnapshot),
    });
    itemsByOrder.set(item.orderId, items);
  }

  const variantsByProduct = new Map<string, AdminProduct["variants"]>();
  for (const variant of variantRows) {
    const variants = variantsByProduct.get(variant.productId) ?? [];
    variants.push({
      id: variant.id,
      size: variant.size,
      colour: variant.colour,
      sku: variant.sku,
      stock: variant.stock,
      price: Number(variant.price),
      lowStockThreshold: variant.lowStockThreshold,
    });
    variantsByProduct.set(variant.productId, variants);
  }

  return {
    operationalNotice: incidents === null ? "Error monitoring is temporarily unavailable. Orders are still shown; ask website support to check it."
      : incidents.some(incident => !incident.orderId && incident.severity === "error") ? "A website service needs attention. Please ask website support to check the technical alerts." : undefined,
    orders: orderRows.map((order) => {
      const customer = readOrderCustomer(order.customerSnapshot, { firstName: order.customerFirstName ?? "", lastName: order.customerLastName ?? "", email: order.customerEmail ?? "", phone: order.customerPhone });
      const shipment = shipmentByOrder.get(order.id);
      const blockers = shipmentBookingBlockers({
        deliveryMethod: order.deliveryMethod,
        paymentStatus: order.paymentStatus,
        hasDeliveryAddress: Boolean(order.line1 && order.city && order.province && order.postalCode),
        weightGrams: shipment?.weightGrams,
        lengthCm: shipment?.lengthCm ? Number(shipment.lengthCm) : null,
        widthCm: shipment?.widthCm ? Number(shipment.widthCm) : null,
        heightCm: shipment?.heightCm ? Number(shipment.heightCm) : null,
        integrationEnabled: bobGo.enabled,
        apiTokenConfigured: bobGo.apiTokenConfigured,
        senderContactConfigured: Boolean(bobGo.senderEmail && bobGo.senderPhone),
        pickupPointLocationId: shipment?.pickupPointLocationId || bobGo.pickupPointLocationId,
      });
      if (!bobGo.pickupPointProviderSlug) blockers.push("The pickup-point courier provider still needs to be configured.");
      if (bobGo.environment === "production" && paymentEnvironmentFromProvider(order.paymentProvider) === "sandbox") blockers.push("Test payments cannot create live courier bookings.");
      if (!customer.phone || !customer.email) blockers.push("Customer phone and email are required.");
      if (order.status !== "ready") blockers.push("Mark the packed order ready for courier first.");
      if (shipment && (["booking", "booked", "cancelled"].includes(shipment.status) || shipment.providerShipmentId)) blockers.push("A shipment already exists or may still be processing. Do not book a duplicate.");

      return {
      id: order.orderNumber,
      customer:
        `${customer.firstName} ${customer.lastName}`.trim() ||
        order.recipientName ||
        "Guest customer",
      email: customer.email,
      phone: customer.phone ?? "",
      placedAt: dateFormatter.format(order.createdAt),
      placedDate: order.createdAt.toISOString(),
      subtotal: Number(order.subtotal),
      deliveryFee: Number(order.deliveryFee ?? 0),
      total: Number(order.total),
      paymentStatus: paymentLabels[order.paymentStatus] ?? "Pending payment",
      payment: {
        provider: "PayFast" as const,
        environment: paymentEnvironmentFromProvider(order.paymentProvider),
        providerStatus: order.providerStatus ?? undefined,
        providerPaymentId: order.providerPaymentId ?? undefined,
        failureReason: order.paymentFailureReason ?? undefined,
        updatedAt: order.paymentUpdatedAt?.toISOString(),
      },
      status: statusLabels[order.status] ?? "New",
      deliveryMethod: deliveryLabels[order.deliveryMethod],
      workflow: getOrderWorkflow({
        status: statusLabels[order.status] ?? "New",
        paymentStatus: paymentLabels[order.paymentStatus] ?? "Pending payment",
        deliveryMethod: deliveryLabels[order.deliveryMethod],
        shipmentStatus: shipment ? shipmentStatusLabels[shipment.status] : undefined,
        shipmentTrackingNumber: shipment?.trackingNumber,
      }),
      address: formatAddress([
        order.line1,
        order.line2,
        order.suburb,
        order.city,
        order.province,
        order.postalCode,
      ]),
      items: itemsByOrder.get(order.id) ?? [],
      actionNeeded: [
        ...(notificationRows.some(event => event.orderId === order.id && event.status === "failed") ? [{ message: "An email notification needs attention. Open Email notifications below to see what to do." }] : []),
        ...(incidents || []).filter(incident => incident.orderId === order.id && incident.severity === "error" && incident.source !== "email"
          && !(incident.source === "payment" && order.paymentStatus === "paid"))
          .map(incident => ({ message: incidentAction(incident.source, incident.code), reference: incident.reference })),
      ],
      notifications: notificationRows.filter(event => event.orderId === order.id).map(event => ({
        id: event.id,
        title: notificationTitle(event.template),
        recipient: event.recipient,
        status: event.status,
        createdAt: event.createdAt.toISOString(),
        retryable: event.status === "failed" && !event.resendEmailId && canRetryNotification(event.template, {
          status: statusLabels[order.status], paymentStatus: paymentLabels[order.paymentStatus], deliveryMethod: deliveryLabels[order.deliveryMethod],
        }),
        deliveryMessage: notificationDeliveryMessage(event.deliveryEvent, event.template),
        deliveryEvent: event.deliveryEvent || undefined,
      })),
      shipping: order.deliveryMethod === "courier" ? {
        provider: "Bob Go" as const,
        status: shipment ? shipmentStatusLabels[shipment.status] : "Not ready" as const,
        senderLocationName: shipment?.senderLocationName || bobGo.senderLocationName,
        pickupPointLocationId: shipment?.pickupPointLocationId || bobGo.pickupPointLocationId,
        weightGrams: shipment?.weightGrams ?? undefined,
        lengthCm: shipment?.lengthCm ? Number(shipment.lengthCm) : undefined,
        widthCm: shipment?.widthCm ? Number(shipment.widthCm) : undefined,
        heightCm: shipment?.heightCm ? Number(shipment.heightCm) : undefined,
        waybillReference: shipment?.waybillReference ?? undefined,
        trackingNumber: shipment?.trackingNumber ?? undefined,
        trackingUrl: shipment?.trackingUrl ?? undefined,
        lastError: shipment?.lastError ?? undefined,
        serviceLevelCode: shipment?.serviceLevelCode ?? undefined,
        environment: shipment?.shipmentProvider === "bobgo-sandbox" ? "sandbox" as const : shipment?.shipmentProvider === "bobgo-production" ? "production" as const : bobGo.environment,
        bookingEnabled: blockers.length === 0,
        blockers,
      } : undefined,
    };
    }),
    products: productRows.map((product) => {
      const variants = variantsByProduct.get(product.id) ?? [];
      const firstPrice = variantRows.find((variant) => variant.productId === product.id)?.price;
      return {
        id: product.slug,
        name: product.name,
        category: product.category,
        description: product.description ?? "",
        price: Number(firstPrice ?? 0),
        image: product.image ?? "",
        status: product.status === "active" ? "Active" : "Draft",
        variants,
      };
    }),
  };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function saveProduct(input: ProductInput, existingSlug?: string) {
  if (!db) throw new Error("DATABASE_URL is not configured.");
  const status = input.status === "Active" ? "active" : "draft";
  let productId: string;
  let slug = existingSlug;

  if (existingSlug) {
    const [existing] = await db
      .select({ id: productsTable.id })
      .from(productsTable)
      .where(eq(productsTable.slug, existingSlug))
      .limit(1);
    if (!existing) return null;
    productId = existing.id;
    await db
      .update(productsTable)
      .set({
        name: input.name,
        category: input.category,
        description: input.description || null,
        primaryImageUrl: input.image || null,
        status,
        updatedAt: new Date(),
      })
      .where(eq(productsTable.id, productId));
  } else {
    const baseSlug = slugify(input.name) || "product";
    const [slugMatch] = await db
      .select({ id: productsTable.id })
      .from(productsTable)
      .where(eq(productsTable.slug, baseSlug))
      .limit(1);
    slug = slugMatch ? `${baseSlug}-${Date.now().toString(36)}` : baseSlug;
    const [created] = await db
      .insert(productsTable)
      .values({
        name: input.name,
        slug,
        category: input.category,
        description: input.description || null,
        primaryImageUrl: input.image || null,
        status,
      })
      .returning({ id: productsTable.id });
    productId = created.id;
  }

  const existingVariants = await db
    .select({ id: productVariants.id, stock: productVariants.stockOnHand })
    .from(productVariants)
    .where(eq(productVariants.productId, productId));
  const existingById = new Map(existingVariants.map((variant) => [variant.id, variant]));

  for (const variant of input.variants) {
    const existingVariant = variant.id ? existingById.get(variant.id) : undefined;
    if (existingVariant) {
      await db
        .update(productVariants)
        .set({
          size: variant.size,
          colour: variant.colour,
          sku: variant.sku,
          price: variant.price.toFixed(2),
          stockOnHand: variant.stock,
          lowStockThreshold: variant.lowStockThreshold,
          updatedAt: new Date(),
        })
        .where(eq(productVariants.id, existingVariant.id));
      const difference = variant.stock - existingVariant.stock;
      if (difference !== 0) {
        await db.insert(inventoryMovements).values({
          variantId: existingVariant.id,
          type: "correction",
          quantity: difference,
          note: "Adjusted from the Framer inventory editor.",
        });
      }
    } else {
      const [createdVariant] = await db
        .insert(productVariants)
        .values({
          productId,
          size: variant.size,
          colour: variant.colour,
          sku: variant.sku,
          price: variant.price.toFixed(2),
          stockOnHand: variant.stock,
          lowStockThreshold: variant.lowStockThreshold,
        })
        .returning({ id: productVariants.id });
      if (variant.stock > 0) {
        await db.insert(inventoryMovements).values({
          variantId: createdVariant.id,
          type: "stock_received",
          quantity: variant.stock,
          note: "Opening stock from the Framer inventory editor.",
        });
      }
    }
  }

  const snapshot = await getAdminSnapshot();
  return snapshot.products.find((product) => product.id === slug) ?? null;
}

export async function updateOrderStatus(orderNumber: string, nextStatus: OrderStatus) {
  if (!db) throw new Error("DATABASE_URL is not configured.");
  const statusValues = {
    New: "new",
    Confirmed: "confirmed",
    Preparing: "processing",
    Ready: "ready",
    Dispatched: "dispatched",
    Collected: "collected",
    Delivered: "delivered",
    Cancelled: "cancelled",
  } as const;
  const databaseStatus = statusValues[nextStatus];
  const found = await db.transaction(async (transaction) => {
    // Serialize status changes, including double clicks from separate sessions.
    const [existing] = await transaction.select({ id: ordersTable.id, status: ordersTable.status,
      paymentStatus: ordersTable.paymentStatus, deliveryMethod: ordersTable.deliveryMethod }).from(ordersTable)
      .where(eq(ordersTable.orderNumber, orderNumber)).limit(1).for("update");
    if (!existing) return false;
    const [shipment] = await transaction.select({ status: shipments.status, trackingNumber: shipments.trackingNumber }).from(shipments)
      .where(eq(shipments.orderId, existing.id)).limit(1).for("update");
    assertOrderTransition({
      status: statusLabels[existing.status],
      paymentStatus: paymentLabels[existing.paymentStatus],
      deliveryMethod: deliveryLabels[existing.deliveryMethod],
      shipmentStatus: shipment ? shipmentStatusLabels[shipment.status] : undefined,
      shipmentTrackingNumber: shipment?.trackingNumber,
    }, nextStatus);
    await transaction
      .update(ordersTable)
      .set({ status: databaseStatus, updatedAt: new Date() })
      .where(eq(ordersTable.id, existing.id));
    await transaction.insert(orderStatusHistory).values({
      orderId: existing.id,
      fromStatus: existing.status,
      toStatus: databaseStatus,
      note: "Updated from the Framer admin portal.",
    });
    return true;
  });
  if (!found) return null;

  const snapshot = await getAdminSnapshot();
  return snapshot.orders.find((order) => order.id === orderNumber) ?? null;
}
