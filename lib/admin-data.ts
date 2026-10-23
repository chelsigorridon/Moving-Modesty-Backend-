import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import {
  addresses,
  customers,
  courierSettings,
  bobgoOrderSync,
  emailEvents,
  inventoryMovements,
  orderItems,
  orderReturns,
  orderRefunds,
  orders as ordersTable,
  orderStatusHistory,
  orderDeliveryHistory,
  payments,
  products as productsTable,
  productVariants,
  shipments,
} from "./db/schema";
import type { AdminOrder, OrderStatus, PaymentStatus } from "./admin-types";
import { getBobGoConfiguration } from "./integrations/bobgo/configuration";
import { isOrderInSyncScope } from "./integrations/bobgo/activation-policy";
import { shipmentBookingBlockers } from "./shipping/readiness";
import { orders as demoOrders, products as demoProducts } from "./store-data";
import type { ProductInput } from "./product-input";
import { assertOrderTransition, getOrderWorkflow } from "./order-workflow";
import { paymentEnvironmentFromProvider } from "./payment-environment";
import { readOrderCustomer } from "./checkout-safety";
import { canRetryNotification, notificationTitle } from "./order-notifications";
import { getOperationalIssues } from "./monitoring";
import { incidentAction, notificationDeliveryMessage } from "./monitoring-policy";
import { deliveryEditBlocker, type CourierEndpoint, type CourierPlan } from "./delivery-input";
import { getOrderSyncConfiguration, orderSyncView } from "./integrations/bobgo/order-sync-policy";
import { getLinkedBookingConfiguration } from "./integrations/bobgo/linked-booking-policy";
import { cancellationRequested, handedOverStatuses, previousWaybills } from "./integrations/bobgo/waybill-change-policy";
import { withCollectionOptions } from "./shipping/collection-options";

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
  timeZone: "Africa/Johannesburg",
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

/** Read-only summary. No parcel, address, catalogue, email body or history downloads. */
export async function getAdminOverview(includeOrders = true): Promise<AdminSnapshot> {
  if (!db) {
    if (process.env.NODE_ENV === "development") return includeOrders ? getDemoAdminSnapshot() : { orders: [], products: [] };
    throw new Error("DATABASE_URL is not configured.");
  }
  // Group once, rather than rescanning email/return/refund history per card.
  const emailSummary = db.select({ orderId: emailEvents.orderId,
    failed: sql<boolean>`bool_or(${emailEvents.status} = 'failed')`.as("has_failed_email") })
    .from(emailEvents).groupBy(emailEvents.orderId).as("email_summary");
  const returnSummary = db.select({ orderId: orderReturns.orderId,
    open: sql<boolean>`bool_or(${orderReturns.status} <> 'received')`.as("has_open_return") })
    .from(orderReturns).groupBy(orderReturns.orderId).as("return_summary");
  const refundSummary = db.select({ orderId: orderRefunds.orderId,
    total: sql<string>`sum(${orderRefunds.amount})`.as("refunded_total") })
    .from(orderRefunds).groupBy(orderRefunds.orderId).as("refund_summary");
  const [rows, incidents] = await Promise.all([
    includeOrders ? db.select({
      id: ordersTable.id, orderNumber: ordersTable.orderNumber, status: ordersTable.status,
      paymentStatus: ordersTable.paymentStatus, deliveryMethod: ordersTable.deliveryMethod,
      total: ordersTable.total, createdAt: ordersTable.createdAt, customerSnapshot: ordersTable.customerSnapshot,
      firstName: customers.firstName, lastName: customers.lastName, email: customers.email,
      paymentProvider: payments.provider, shipmentStatus: shipments.status,
      cancellationPending: sql<boolean>`exists (select 1 from ${orderDeliveryHistory} where ${orderDeliveryHistory.orderId} = ${ordersTable.id}
        and ${orderDeliveryHistory.action} = 'waybill_cancel_requested'
        and ${orderDeliveryHistory.after}->>'providerShipmentId' = ${shipments.providerShipmentId}
        and ${orderDeliveryHistory.after}->>'trackingNumber' = ${shipments.trackingNumber}
        and ${orderDeliveryHistory.after}->>'provider' = ${shipments.provider})`,
      emailFailed: sql<boolean>`coalesce(${emailSummary.failed}, false)`,
      returnOpen: sql<boolean>`coalesce(${returnSummary.open}, false)`,
      canRefund: sql<boolean>`${payments.status} = 'paid' and ${payments.providerPaymentId} <> '' and ${payments.verifiedAt} is not null
        and least(${ordersTable.total}, ${payments.amount}) > coalesce(${refundSummary.total}, 0)
        and (${ordersTable.status} = 'cancelled' or (${returnSummary.orderId} is not null and not ${returnSummary.open}))`,
    }).from(ordersTable).leftJoin(customers, eq(ordersTable.customerId, customers.id))
      .leftJoin(payments, eq(ordersTable.id, payments.orderId)).leftJoin(shipments, eq(ordersTable.id, shipments.orderId))
      .leftJoin(emailSummary, eq(ordersTable.id, emailSummary.orderId)).leftJoin(returnSummary, eq(ordersTable.id, returnSummary.orderId))
      .leftJoin(refundSummary, eq(ordersTable.id, refundSummary.orderId))
      .where(isNull(ordersTable.archivedAt)).orderBy(desc(ordersTable.createdAt), desc(ordersTable.id)) : Promise.resolve([]),
    getOperationalIssues().catch(() => null),
  ]);
  return {
    products: [],
    operationalNotice: incidents === null ? "Error monitoring is temporarily unavailable. Ask website support to check it."
      : incidents.some(incident => !incident.orderId && incident.severity === "error") ? "Recorded website issues need review. Open Technical alerts under Account." : undefined,
    orders: rows.map(order => {
      const customer = readOrderCustomer(order.customerSnapshot, { firstName: order.firstName || "", lastName: order.lastName || "", email: order.email || "", phone: "" });
      const status = statusLabels[order.status], paid = order.paymentStatus === "paid";
      const shippingStatus = order.cancellationPending && order.shipmentStatus !== "cancelled" ? "booking" : order.shipmentStatus;
      const actionNeeded = [
        ...(order.emailFailed ? [{ message: "An email notification needs attention." }] : []),
        ...(incidents || []).filter(incident => incident.orderId === order.id && incident.severity === "error" && incident.source !== "email"
          && !(incident.source === "payment" && paid)).map(incident => ({ message: incidentAction(incident.source, incident.code), reference: incident.reference })),
      ];
      return { id: order.orderNumber, customer: `${customer.firstName} ${customer.lastName}`.trim() || "Guest customer", email: customer.email, phone: "",
        placedAt: dateFormatter.format(order.createdAt) + " SAST", placedDate: order.createdAt.toISOString(), total: Number(order.total),
        paymentStatus: paymentLabels[order.paymentStatus], payment: { provider: "PayFast", environment: paymentEnvironmentFromProvider(order.paymentProvider) },
        status, deliveryMethod: deliveryLabels[order.deliveryMethod], items: [], detailsLoaded: false, actionNeeded,
        listNeedsAttention: Boolean(actionNeeded.length || order.returnOpen || order.canRefund || paid &&
          (["New", "Confirmed"].includes(status) || status === "Ready" && !["booking", "booked"].includes(shippingStatus || "")
          || !["Collected", "Delivered", "Cancelled"].includes(status) && shippingStatus === "failed")),
        listInProgress: paid && (["Preparing", "Dispatched"].includes(status) || status === "Ready" && ["booking", "booked"].includes(shippingStatus || "")),
      };
    }),
  };
}

export async function getAdminSnapshot(options: { orderNumber?: string; includeProducts?: boolean } = {}): Promise<AdminSnapshot> {
  if (!db) {
    if (process.env.NODE_ENV === "development") return getDemoAdminSnapshot();
    throw new Error("DATABASE_URL is not configured.");
  }

  const syncConfiguration = getOrderSyncConfiguration();
  const bobGo = getBobGoConfiguration();
  const orderCondition = and(isNull(ordersTable.archivedAt), options.orderNumber ? eq(ordersTable.orderNumber, options.orderNumber) : undefined);
  const scope = db.select({ id: ordersTable.id }).from(ordersTable).where(orderCondition);
  const [orderRows, itemRows, productRows, variantRows, shipmentRows, notificationRows, incidents, returnRows, refundRows, stockRows, senderSettings, syncRows, deliveryHistory] = await Promise.all([
    db
      .select({
        id: ordersTable.id,
        orderNumber: ordersTable.orderNumber,
        status: ordersTable.status,
        paymentStatus: ordersTable.paymentStatus,
        deliveryMethod: ordersTable.deliveryMethod,
        subtotal: ordersTable.subtotal,
        discountAmount: ordersTable.discountAmount,
        discountSnapshot: ordersTable.discountSnapshot,
        deliveryFee: ordersTable.deliveryFee,
        total: ordersTable.total,
        createdAt: ordersTable.createdAt,
        providerPaymentId: payments.providerPaymentId,
        paymentProvider: payments.provider,
        providerStatus: payments.providerStatus,
        paymentFailureReason: payments.failureReason,
        paymentUpdatedAt: payments.updatedAt,
        paymentVerifiedAt: payments.verifiedAt,
        originalPaymentStatus: payments.status,
        paidAmount: payments.amount,
        customerFirstName: customers.firstName,
        customerLastName: customers.lastName,
        customerEmail: customers.email,
        customerPhone: customers.phone,
        customerSnapshot: ordersTable.customerSnapshot,
        courierPlan: ordersTable.courierPlan,
        deliveryRevision: ordersTable.deliveryRevision,
        deliveryNotes: ordersTable.deliveryNotes,
        privateNote: ordersTable.privateNote,
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
      .where(orderCondition)
      .orderBy(desc(ordersTable.createdAt)),
    db
      .select({
        id: orderItems.id,
        variantId: orderItems.variantId,
        orderId: orderItems.orderId,
        name: orderItems.productName,
        variant: orderItems.variantName,
        quantity: orderItems.quantity,
        price: orderItems.unitPrice,
        productSnapshot: orderItems.productSnapshot,
      })
      .from(orderItems).where(inArray(orderItems.orderId, scope)),
    options.includeProducts !== false ? db
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
      .orderBy(desc(productsTable.createdAt)) : Promise.resolve([]),
    options.includeProducts !== false ? db
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
      .from(productVariants) : Promise.resolve([]),
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
        bookingSnapshot: shipments.bookingSnapshot,
        courierStatus: shipments.courierStatus,
        providerShipmentId: shipments.providerShipmentId,
        shipmentProvider: shipments.provider,
      })
      .from(shipments).where(inArray(shipments.orderId, scope)),
    db.select().from(emailEvents).where(inArray(emailEvents.orderId, scope)).orderBy(desc(emailEvents.createdAt)),
    getOperationalIssues().catch(() => null),
    db.select().from(orderReturns).where(inArray(orderReturns.orderId, scope)),
    db.select().from(orderRefunds).where(inArray(orderRefunds.orderId, scope)).orderBy(desc(orderRefunds.createdAt)),
    db.select({ orderId: inventoryMovements.orderId, variantId: inventoryMovements.variantId,
      type: inventoryMovements.type, quantity: inventoryMovements.quantity }).from(inventoryMovements).where(inArray(inventoryMovements.orderId, scope)),
    db.select().from(courierSettings).where(inArray(courierSettings.id, ["sender", "sender-door", "sender-pickup_point"])),
    db.select().from(bobgoOrderSync).where(and(eq(bobgoOrderSync.environment, bobGo.environment), inArray(bobgoOrderSync.orderId, scope))),
    db.select().from(orderDeliveryHistory).where(inArray(orderDeliveryHistory.orderId, scope)).orderBy(desc(orderDeliveryHistory.createdAt)),
  ]);

  const shipmentByOrder = new Map(shipmentRows.map((shipment) => [shipment.orderId, shipment]));

  const itemsByOrder = new Map<string, AdminOrder["items"]>();
  for (const item of itemRows) {
    const items = itemsByOrder.get(item.orderId) ?? [];
    items.push({
      id: item.id,
      returnableQuantity: Math.max(0, item.quantity - returnRows.filter(row => row.orderId === item.orderId).flatMap(row => row.items)
        .filter(row => row.itemId === item.id).reduce((sum, row) => sum + row.quantity, 0)),
      restockableQuantity: item.variantId ? Math.max(0, stockRows.filter(row => row.orderId === item.orderId && row.variantId === item.variantId)
        .reduce((sum, row) => sum + (row.type === "order_allocated" ? Math.abs(row.quantity) : row.type === "return" ? -Math.max(0, row.quantity) : 0), 0)) : 0,
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
      : incidents.some(incident => !incident.orderId && incident.severity === "error") ? "Recorded website issues need review. Open Technical alerts under Account." : undefined,
    orders: orderRows.map((order) => {
      const customer = readOrderCustomer(order.customerSnapshot, { firstName: order.customerFirstName ?? "", lastName: order.customerLastName ?? "", email: order.customerEmail ?? "", phone: order.customerPhone });
      const shipment = shipmentByOrder.get(order.id);
      const defaultContact = { name: bobGo.senderName, email: bobGo.senderEmail, phone: bobGo.senderPhone };
      const defaultCollection: CourierEndpoint = senderSettings.find(row => row.id === "sender")?.collection || (bobGo.pickupPointLocationId && bobGo.pickupPointProviderSlug
        ? { kind: "pickup_point", contact: defaultContact, point: { id: bobGo.pickupPointLocationId, providerSlug: bobGo.pickupPointProviderSlug, name: bobGo.senderLocationName } }
        : { kind: "door", contact: defaultContact, address: { company: "", line1: "", line2: "", suburb: "", city: "", province: "Western Cape", postalCode: "" } });
      const savedDoor = senderSettings.find(row => row.id === "sender-door")?.collection || (defaultCollection.kind === "door" ? defaultCollection : undefined);
      const savedPoint = senderSettings.find(row => row.id === "sender-pickup_point")?.collection || (defaultCollection.kind === "pickup_point" ? defaultCollection : undefined);
      const dropOff: CourierEndpoint | undefined = savedPoint || (bobGo.pickupPointLocationId && bobGo.pickupPointProviderSlug ? { kind: "pickup_point", contact: defaultCollection.contact,
        point: { id: bobGo.pickupPointLocationId, providerSlug: bobGo.pickupPointProviderSlug, name: bobGo.senderLocationName } } : undefined);
      const draftPlan: CourierPlan = withCollectionOptions(order.courierPlan || { version: 1, collection: defaultCollection,
        delivery: { kind: "door", contact: { name: order.recipientName || `${customer.firstName} ${customer.lastName}`.trim(), email: customer.email, phone: customer.phone || "" },
          address: { company: "", line1: order.line1 || "", line2: order.line2 || "", suburb: order.suburb || "", city: order.city || "",
            province: (order.province || "Western Cape") as import("./delivery-input").CourierAddress["province"], postalCode: order.postalCode || "" } },
        collectionInstructions: "", deliveryInstructions: order.deliveryNotes || "", customerApprovedPickup: false },
        { ...(savedDoor?.kind === "door" ? { door: savedDoor } : {}), ...(dropOff?.kind === "pickup_point" ? { pickupPoint: dropOff } : {}) });
      const editBlocker = deliveryEditBlocker(order, shipment);
      const history = deliveryHistory.filter(row => row.orderId === order.id);
      const cancellationPending = cancellationRequested(history, shipment);
      const inSyncScope = syncConfiguration.enabled && order.paymentProvider === `payfast-${syncConfiguration.environment}` && isOrderInSyncScope(order, syncConfiguration);
      const linkedOrder = inSyncScope || syncRows.some(row => row.orderId === order.id && (row.remoteOrderId || row.submittedAt
        || ["synced", "checking", "syncing"].includes(row.status) || row.leaseExpiresAt && row.leaseExpiresAt.getTime() > Date.now()));
      const linkedConfig = getLinkedBookingConfiguration(), linkedSnapshot = shipment?.bookingSnapshot?.linkedOrder;
      const linkedChangeAllowed = linkedOrder && linkedConfig.enabled && linkedConfig.environment === bobGo.environment
        && paymentEnvironmentFromProvider(order.paymentProvider) === bobGo.environment && linkedSnapshot?.channelRef === linkedConfig.channelRef
        && syncRows.some(row => row.orderId === order.id && row.environment === bobGo.environment && row.channelRef === linkedConfig.channelRef && row.status === "synced" && row.remoteOrderId === linkedSnapshot?.remoteOrderId);
      const canChangeWaybill = bobGo.enabled && bobGo.apiTokenConfigured && (!linkedOrder || linkedChangeAllowed) && order.paymentStatus === "paid"
        && ["new", "confirmed", "processing", "ready"].includes(order.status) && order.originalPaymentStatus === "paid"
        && Boolean(order.providerPaymentId && order.paymentVerifiedAt) && Number(order.total) === Number(order.paidAmount)
        && !(bobGo.environment === "production" && paymentEnvironmentFromProvider(order.paymentProvider) === "sandbox")
        && shipment?.shipmentProvider === `bobgo-${bobGo.environment}` && /^[1-9]\d{0,18}$/.test(shipment.providerShipmentId || "") && Boolean(shipment.trackingNumber)
        && !handedOverStatuses.has(shipment.courierStatus || "")
        && ["booking", "booked", "cancelled"].includes(shipment.status);
      const orderReturnRows = returnRows.filter(row => row.orderId === order.id);
      const orderRefundRows = refundRows.filter(row => row.orderId === order.id);
      const refundedTotal = orderRefundRows.reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0) / 100;
      const verifiedPaid = order.originalPaymentStatus === "paid" && Boolean(order.providerPaymentId && order.paymentVerifiedAt);
      const remainingRefundable = verifiedPaid ? Math.max(0, Math.round((Math.min(Number(order.total), Number(order.paidAmount)) - refundedTotal) * 100) / 100) : 0;
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
      if (order.courierPlan) {
        for (let i = blockers.length - 1; i >= 0; i--) if (/pickup-point ID|Private sender contact/.test(blockers[i])) blockers.splice(i, 1);
      } else if (!bobGo.pickupPointProviderSlug) blockers.push("The pickup-point courier provider still needs to be configured.");
      if (bobGo.environment === "production" && paymentEnvironmentFromProvider(order.paymentProvider) === "sandbox") blockers.push("Test payments cannot create live courier bookings.");
      if (!customer.phone || !customer.email) blockers.push("Customer phone and email are required.");
      if (order.status !== "ready") blockers.push("Mark the packed order ready for courier first.");
      if (shipment && (["booking", "booked", "cancelled"].includes(shipment.status) || shipment.providerShipmentId)) blockers.push("A shipment already exists or may still be processing. Do not book a duplicate.");
      if (linkedOrder && !getLinkedBookingConfiguration().enabled) blockers.push("Linked portal booking is not activated. Do not create a separate shipment for an existing Bob Go order.");

      return {
      id: order.orderNumber,
      customer:
        `${customer.firstName} ${customer.lastName}`.trim() ||
        order.recipientName ||
        "Guest customer",
      email: customer.email,
      phone: customer.phone ?? "",
      placedAt: dateFormatter.format(order.createdAt) + " SAST",
      placedDate: order.createdAt.toISOString(),
      subtotal: Number(order.subtotal),
      discountAmount: Number(order.discountAmount),
      discountCode: order.discountSnapshot?.code,
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
      aftersales: {
        canStartReturn: verifiedPaid && ["delivered", "collected"].includes(order.status)
          && !orderReturnRows.some(row => row.status !== "received") && (itemsByOrder.get(order.id) || []).some(item => (item.returnableQuantity || 0) > 0),
        canRecordRefund: verifiedPaid && remainingRefundable > 0 && (order.status === "cancelled"
          || orderReturnRows.length > 0 && orderReturnRows.every(row => row.status === "received")),
        refundedTotal, remainingRefundable,
        returns: orderReturnRows.map(row => ({ id: row.id, status: row.status, reason: row.reason, items: row.items,
          waybillReference: row.waybillReference || undefined, receivedAt: row.receivedAt?.toISOString() })),
        refunds: orderRefundRows.map(row => ({ id: row.id, amount: Number(row.amount), reference: row.reference,
          reason: row.reason, refundedAt: row.refundedAt.toISOString(), recordedBy: row.recordedBy })),
      },
      status: statusLabels[order.status] ?? "New",
      deliveryMethod: deliveryLabels[order.deliveryMethod],
      workflow: getOrderWorkflow({
        status: statusLabels[order.status] ?? "New",
        paymentStatus: paymentLabels[order.paymentStatus] ?? "Pending payment",
        deliveryMethod: deliveryLabels[order.deliveryMethod],
        shipmentStatus: cancellationPending && shipment?.status !== "cancelled" ? "Booking" : shipment ? shipmentStatusLabels[shipment.status] : undefined,
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
      deliveryDetails: order.deliveryMethod === "courier" ? { revision: order.deliveryRevision, plan: order.courierPlan ? draftPlan : null, draftPlan,
        collectionTimeMode: linkedOrder ? "preferred_instructions" as const : undefined,
        privateNote: order.privateNote || "", canEdit: !editBlocker, blockedReason: editBlocker || undefined,
        previousWaybills: previousWaybills(history),
        waybillChange: canChangeWaybill && shipment?.trackingNumber ? {
          trackingNumber: shipment.trackingNumber,
          action: shipment.courierStatus === "cancelled" && (!linkedOrder || linkedSnapshot?.cancellationConfirmed) ? "prepare_replacement" as const
            : cancellationPending || linkedOrder && shipment.courierStatus === "cancelled" ? "check_cancellation" as const : "cancel_waybill" as const,
        } : undefined } : undefined,
      bobGoSync: order.deliveryMethod === "courier" && order.paymentStatus === "paid" ? syncConfiguration.enabled && !inSyncScope
        ? { status: "Excluded from new-order sync", message: "Sync is enabled for new live-paid orders only. This existing or test order is unchanged." }
        : orderSyncView(syncRows.find(row => row.orderId === order.id), inSyncScope, getLinkedBookingConfiguration().enabled) : undefined,
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
        courierName: shipment?.bookingSnapshot?.providerName,
        serviceName: shipment?.bookingSnapshot?.serviceName,
        courierStatus: shipment?.courierStatus ?? undefined,
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
      .where(and(eq(ordersTable.orderNumber, orderNumber), isNull(ordersTable.archivedAt))).limit(1).for("update");
    if (!existing) return false;
    const [shipment] = await transaction.select().from(shipments)
      .where(eq(shipments.orderId, existing.id)).limit(1).for("update");
    const history = shipment?.providerShipmentId ? await transaction.select().from(orderDeliveryHistory).where(eq(orderDeliveryHistory.orderId, existing.id)) : [];
    const cancellationPending = cancellationRequested(history, shipment);
    assertOrderTransition({
      status: statusLabels[existing.status],
      paymentStatus: paymentLabels[existing.paymentStatus],
      deliveryMethod: deliveryLabels[existing.deliveryMethod],
      shipmentStatus: cancellationPending && shipment?.status !== "cancelled" ? "Booking" : shipment ? shipmentStatusLabels[shipment.status] : undefined,
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
