import { boolean, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { CatalogueDocument } from "../catalogue-input";
import type { DiscountSnapshot } from "../discount-input";
import type { CourierEndpoint, CourierPlan } from "../delivery-input";
import type { CourierBookingSnapshot } from "../integrations/bobgo/protocol";
import type { BobGoOrderPayload } from "../integrations/bobgo/order-sync-policy";

export const adminRole = pgEnum("admin_role", ["owner", "manager", "fulfilment"]);
export const productStatus = pgEnum("product_status", ["draft", "active", "archived"]);
export const paymentStatus = pgEnum("payment_status", ["pending", "paid", "failed", "refunded"]);
export const orderStatus = pgEnum("order_status", ["new", "confirmed", "processing", "ready", "dispatched", "collected", "delivered", "cancelled"]);
export const deliveryMethod = pgEnum("delivery_method", ["courier", "collection", "to_be_confirmed"]);
export const inventoryMovementType = pgEnum("inventory_movement_type", ["stock_received", "order_allocated", "correction", "return"]);
export const emailStatus = pgEnum("email_status", ["queued", "sent", "delivered", "failed"]);
export const shipmentStatus = pgEnum("shipment_status", ["not_ready", "ready_to_book", "booking", "booked", "failed", "cancelled"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const adminUsers = pgTable("admin_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: adminRole("role").default("fulfilment").notNull(),
  active: boolean("active").default(true).notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("admin_users_email_idx").on(table.email)]);

export const customers = pgTable("customers", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  phone: text("phone"),
  ...timestamps,
}, (table) => [uniqueIndex("customers_email_idx").on(table.email)]);

export const addresses = pgTable("addresses", {
  id: uuid("id").defaultRandom().primaryKey(),
  customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
  recipientName: text("recipient_name").notNull(),
  line1: text("line_1").notNull(),
  line2: text("line_2"),
  suburb: text("suburb"),
  city: text("city").notNull(),
  province: text("province").notNull(),
  postalCode: text("postal_code").notNull(),
  countryCode: text("country_code").default("ZA").notNull(),
  ...timestamps,
});

export const products = pgTable("products", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  category: text("category").notNull(),
  status: productStatus("status").default("draft").notNull(),
  primaryImageUrl: text("primary_image_url"),
  ...timestamps,
}, (table) => [uniqueIndex("products_slug_idx").on(table.slug)]);

// Isolated drafts for the reversible product-management trial. The current
// live products, inventory, order snapshots and checkout resolver are untouched.
export const catalogueDrafts = pgTable("catalogue_drafts", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull(),
  document: jsonb("document").$type<CatalogueDocument>().notNull(),
  revision: integer("revision").default(1).notNull(),
  ...timestamps,
}, table => [uniqueIndex("catalogue_drafts_slug_idx").on(table.slug)]);

export type CatalogueCmsMapping = {
  familyCmsId?: string;
  cmsHash?: string;
  cmsLayout?: "legacy" | "products-v1";
  colours: Record<string, { cmsId?: string; slug: string; baseSku: string }>;
  variantSkus: Record<string, string>;
  stockVersion?: string;
  stockBaseline?: Record<string, { stock: number; stockVerified: boolean }>;
};

// Live management is separate from the retained, unpublished trial records.
export const catalogueProducts = pgTable("catalogue_products", {
  id: uuid("id").defaultRandom().primaryKey(),
  productId: uuid("product_id").notNull().references(() => products.id),
  slug: text("slug").notNull(),
  document: jsonb("document").$type<CatalogueDocument>().notNull(),
  publishedDocument: jsonb("published_document").$type<CatalogueDocument>(),
  metadata: jsonb("metadata").$type<CatalogueCmsMapping>().notNull(),
  revision: integer("revision").default(1).notNull(),
  publishedRevision: integer("published_revision").default(0).notNull(),
  publicationState: text("publication_state").default("idle").notNull(),
  publicationError: text("publication_error"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ...timestamps,
}, table => [uniqueIndex("catalogue_products_slug_idx").on(table.slug)]);

export const productVariants = pgTable("product_variants", {
  id: uuid("id").defaultRandom().primaryKey(),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  sku: text("sku").notNull(),
  size: text("size").notNull(),
  colour: text("colour").notNull(),
  price: numeric("price", { precision: 12, scale: 2 }).notNull(),
  stockOnHand: integer("stock_on_hand").default(0).notNull(),
  lowStockThreshold: integer("low_stock_threshold").default(3).notNull(),
  active: boolean("active").default(true).notNull(),
  stockVerified: boolean("stock_verified").default(false).notNull(),
  // Measured per item, never inferred from a multi-item packed parcel.
  shippingWeightGrams: integer("shipping_weight_grams"),
  ...timestamps,
}, (table) => [uniqueIndex("product_variants_sku_idx").on(table.sku)]);

export const inventoryMovements = pgTable("inventory_movements", {
  id: uuid("id").defaultRandom().primaryKey(),
  variantId: uuid("variant_id").notNull().references(() => productVariants.id, { onDelete: "cascade" }),
  type: inventoryMovementType("type").notNull(),
  quantity: integer("quantity").notNull(),
  note: text("note"),
  orderId: uuid("order_id"),
  adminUserId: uuid("admin_user_id").references(() => adminUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const discounts = pgTable("discounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull(),
  type: text("type").notNull(),
  value: numeric("value", { precision: 12, scale: 2 }).notNull(),
  active: boolean("active").default(false).notNull(),
  productIds: jsonb("product_ids").$type<string[]>().default([]).notNull(),
  minimumSpend: numeric("minimum_spend", { precision: 12, scale: 2 }).default("0").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  revision: integer("revision").default(1).notNull(),
  updatedBy: text("updated_by").notNull(),
  ...timestamps,
}, table => [uniqueIndex("discounts_code_idx").on(table.code)]);

export const discountHistory = pgTable("discount_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  discountId: uuid("discount_id").notNull().references(() => discounts.id),
  revision: integer("revision").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  changedBy: text("changed_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderNumber: text("order_number").notNull(),
  customerId: uuid("customer_id").references(() => customers.id),
  customerSnapshot: jsonb("customer_snapshot").$type<{ firstName: string; lastName: string; email: string; phone: string }>(),
  deliveryAddressId: uuid("delivery_address_id").references(() => addresses.id),
  status: orderStatus("status").default("new").notNull(),
  paymentStatus: paymentStatus("payment_status").default("pending").notNull(),
  deliveryMethod: deliveryMethod("delivery_method").default("to_be_confirmed").notNull(),
  subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull(),
  discountAmount: numeric("discount_amount", { precision: 12, scale: 2 }).default("0").notNull(),
  discountSnapshot: jsonb("discount_snapshot").$type<DiscountSnapshot>(),
  deliveryFee: numeric("delivery_fee", { precision: 12, scale: 2 }),
  total: numeric("total", { precision: 12, scale: 2 }).notNull(),
  courierName: text("courier_name"),
  trackingNumber: text("tracking_number"),
  trackingUrl: text("tracking_url"),
  deliveryNotes: text("delivery_notes"),
  courierPlan: jsonb("courier_plan").$type<CourierPlan>(),
  privateNote: text("private_note"),
  deliveryRevision: integer("delivery_revision").default(0).notNull(),
  paymentReference: text("payment_reference"),
  checkoutToken: text("checkout_token"),
  checkoutFingerprint: text("checkout_fingerprint"),
  inventoryIssue: text("inventory_issue"),
  // Recoverable cleanup: archived tests stay in the payment/audit ledger.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archiveReason: text("archive_reason"),
  ...timestamps,
}, (table) => [
  uniqueIndex("orders_order_number_idx").on(table.orderNumber),
  uniqueIndex("orders_checkout_token_idx").on(table.checkoutToken),
]);

export const orderItems = pgTable("order_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  variantId: uuid("variant_id").references(() => productVariants.id),
  productName: text("product_name").notNull(),
  variantName: text("variant_name").notNull(),
  sku: text("sku").notNull(),
  quantity: integer("quantity").notNull(),
  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
  lineTotal: numeric("line_total", { precision: 12, scale: 2 }).notNull(),
  productSnapshot: jsonb("product_snapshot"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const stockReservations = pgTable("stock_reservations", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  variantId: uuid("variant_id").notNull().references(() => productVariants.id),
  quantity: integer("quantity").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("stock_reservations_order_variant_idx").on(table.orderId, table.variantId)]);

export const shipments = pgTable("shipments", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  provider: text("provider").default("bobgo").notNull(),
  status: shipmentStatus("status").default("not_ready").notNull(),
  senderLocationName: text("sender_location_name").default("Constantia Emporium").notNull(),
  pickupPointLocationId: text("pickup_point_location_id"),
  weightGrams: integer("weight_grams"),
  lengthCm: numeric("length_cm", { precision: 8, scale: 2 }),
  widthCm: numeric("width_cm", { precision: 8, scale: 2 }),
  heightCm: numeric("height_cm", { precision: 8, scale: 2 }),
  providerShipmentId: text("provider_shipment_id"),
  serviceLevelCode: text("service_level_code"),
  waybillReference: text("waybill_reference"),
  trackingNumber: text("tracking_number"),
  trackingUrl: text("tracking_url"),
  lastError: text("last_error"),
  bookedAt: timestamp("booked_at", { withTimezone: true }),
  bookingSnapshot: jsonb("booking_snapshot").$type<CourierBookingSnapshot>(),
  courierStatus: text("courier_status"),
  courierStatusAt: timestamp("courier_status_at", { withTimezone: true }),
  courierCheckedAt: timestamp("courier_checked_at", { withTimezone: true }),
  courierChargedAmount: numeric("courier_charged_amount", { precision: 12, scale: 2 }),
  ...timestamps,
}, (table) => [uniqueIndex("shipments_order_idx").on(table.orderId),
  uniqueIndex("shipments_provider_remote_idx").on(table.provider, table.providerShipmentId)]);

// Signed delivery notifications are durably queued before acknowledgement.
// Store identifiers only, not provider payloads containing customer PII.
export const bobgoDeliveryEvents = pgTable("bobgo_delivery_events", {
  id: text("id").primaryKey(),
  shipmentId: uuid("shipment_id").notNull().references(() => shipments.id, { onDelete: "cascade" }),
  environment: text("environment").notNull(),
  topic: text("topic").notNull(),
  status: text("status").default("queued").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
  lastErrorCode: text("last_error_code"),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  ...timestamps,
});

// Only authenticated owner routes read these private collection details.
export const courierSettings = pgTable("courier_settings", {
  id: text("id").primaryKey(),
  collection: jsonb("collection").$type<CourierEndpoint>().notNull(),
  updatedBy: text("updated_by").notNull(),
  ...timestamps,
});

export const orderDeliveryHistory = pgTable("order_delivery_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  revision: integer("revision").notNull(),
  action: text("action").notNull(),
  before: jsonb("before").notNull(),
  after: jsonb("after").notNull(),
  changedBy: text("changed_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [uniqueIndex("order_delivery_history_revision_idx").on(table.orderId, table.revision)]);

// Durable outbox for a future, explicitly activated Bob Go sales channel.
// A submission with an unknown outcome is reconciled, never blindly repeated.
export const bobgoOrderSync = pgTable("bobgo_order_sync", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  environment: text("environment").notNull(),
  channelRef: text("channel_ref").notNull(),
  status: text("status").default("queued").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  remoteOrderId: text("remote_order_id"),
  deliveryRevision: integer("delivery_revision").default(0).notNull(),
  requestSnapshot: jsonb("request_snapshot").$type<BobGoOrderPayload>(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
  lastErrorCode: text("last_error_code"),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  waybillLinkCheckedAt: timestamp("waybill_link_checked_at", { withTimezone: true }),
  waybillLinkErrorCode: text("waybill_link_error_code"),
  ...timestamps,
}, table => [
  uniqueIndex("bobgo_order_sync_order_channel_idx").on(table.orderId, table.environment, table.channelRef),
  uniqueIndex("bobgo_order_sync_remote_channel_idx").on(table.remoteOrderId, table.environment, table.channelRef),
]);

export const shippingWeightHistory = pgTable("shipping_weight_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  variantId: uuid("variant_id").notNull().references(() => productVariants.id),
  previousGrams: integer("previous_grams"),
  grams: integer("grams"),
  changedBy: text("changed_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const payments = pgTable("payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  provider: text("provider").default("payfast").notNull(),
  merchantPaymentId: text("merchant_payment_id").notNull(),
  providerPaymentId: text("provider_payment_id"),
  status: paymentStatus("status").default("pending").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  providerStatus: text("provider_status"),
  failureReason: text("failure_reason"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("payments_order_idx").on(table.orderId),
  uniqueIndex("payments_merchant_payment_id_idx").on(table.merchantPaymentId),
  uniqueIndex("payments_provider_payment_id_idx").on(table.providerPaymentId),
]);

// A return is independent of outbound fulfilment and of the actual PayFast refund.
export const orderReturns = pgTable("order_returns", {
  id: uuid("id").primaryKey(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  status: text("status").default("approved").notNull(),
  reason: text("reason").notNull(),
  items: jsonb("items").$type<Array<{ itemId: string; quantity: number; restocked: number }>>().notNull(),
  waybillReference: text("waybill_reference"),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  recordedBy: text("recorded_by").notNull(),
  ...timestamps,
});

// Manual attestation only: recording a refund NEVER transfers money.
export const orderRefunds = pgTable("order_refunds", {
  id: uuid("id").primaryKey(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  reference: text("reference").notNull(),
  reason: text("reason").notNull(),
  refundedAt: timestamp("refunded_at", { withTimezone: true }).notNull(),
  recordedBy: text("recorded_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("order_refunds_reference_idx").on(table.reference)]);

export const orderStatusHistory = pgTable("order_status_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  fromStatus: orderStatus("from_status"),
  toStatus: orderStatus("to_status").notNull(),
  note: text("note"),
  adminUserId: uuid("admin_user_id").references(() => adminUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const emailEvents = pgTable("email_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
  resendEmailId: text("resend_email_id"),
  recipient: text("recipient").notNull(),
  template: text("template").notNull(),
  status: emailStatus("status").default("queued").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  errorMessage: text("error_message"),
  deliveryEvent: text("delivery_event"),
  deliveryEventAt: timestamp("delivery_event_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("email_events_idempotency_idx").on(table.idempotencyKey)]);

// Grouped, privacy-safe incidents. Never store request bodies, secrets or raw errors.
export const systemErrors = pgTable("system_errors", {
  id: uuid("id").defaultRandom().primaryKey(),
  fingerprint: text("fingerprint").notNull(),
  reference: uuid("reference").notNull(),
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
  source: text("source").notNull(),
  operation: text("operation").notNull(),
  code: text("code").notNull(),
  summary: text("summary").notNull(),
  severity: text("severity").notNull(),
  environment: text("environment").notNull(),
  httpStatus: integer("http_status"),
  occurrences: integer("occurrences").default(1).notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (table) => [uniqueIndex("system_errors_fingerprint_idx").on(table.fingerprint)]);

// An atomic hourly reservation stops duplicate alerts across server instances.
export const errorAlerts = pgTable("error_alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  dedupeKey: text("dedupe_key").notNull(),
  incidentId: uuid("incident_id").references(() => systemErrors.id, { onDelete: "set null" }),
  status: text("status").default("queued").notNull(),
  resendEmailId: text("resend_email_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("error_alerts_dedupe_idx").on(table.dedupeKey)]);

export const diagnosticRateLimits = pgTable("diagnostic_rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").default(1).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const adminSessions = pgTable("admin_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  adminUserId: uuid("admin_user_id").notNull().references(() => adminUsers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("admin_sessions_token_idx").on(table.tokenHash)]);
