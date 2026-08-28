import { boolean, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const adminRole = pgEnum("admin_role", ["owner", "manager", "fulfilment"]);
export const productStatus = pgEnum("product_status", ["draft", "active", "archived"]);
export const paymentStatus = pgEnum("payment_status", ["pending", "paid", "failed", "refunded"]);
export const orderStatus = pgEnum("order_status", ["new", "confirmed", "processing", "ready", "dispatched", "delivered", "cancelled"]);
export const deliveryMethod = pgEnum("delivery_method", ["courier", "collection", "to_be_confirmed"]);
export const inventoryMovementType = pgEnum("inventory_movement_type", ["stock_received", "order_allocated", "correction", "return"]);
export const emailStatus = pgEnum("email_status", ["queued", "sent", "delivered", "failed"]);

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

export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderNumber: text("order_number").notNull(),
  customerId: uuid("customer_id").references(() => customers.id),
  deliveryAddressId: uuid("delivery_address_id").references(() => addresses.id),
  status: orderStatus("status").default("new").notNull(),
  paymentStatus: paymentStatus("payment_status").default("pending").notNull(),
  deliveryMethod: deliveryMethod("delivery_method").default("to_be_confirmed").notNull(),
  subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull(),
  deliveryFee: numeric("delivery_fee", { precision: 12, scale: 2 }),
  total: numeric("total", { precision: 12, scale: 2 }).notNull(),
  courierName: text("courier_name"),
  trackingNumber: text("tracking_number"),
  trackingUrl: text("tracking_url"),
  deliveryNotes: text("delivery_notes"),
  paymentReference: text("payment_reference"),
  ...timestamps,
}, (table) => [uniqueIndex("orders_order_number_idx").on(table.orderNumber)]);

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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("email_events_idempotency_idx").on(table.idempotencyKey)]);

export const adminSessions = pgTable("admin_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  adminUserId: uuid("admin_user_id").notNull().references(() => adminUsers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("admin_sessions_token_idx").on(table.tokenHash)]);
