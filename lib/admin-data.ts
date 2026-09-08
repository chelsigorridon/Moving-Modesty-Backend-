import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import {
  addresses,
  customers,
  inventoryMovements,
  orderItems,
  orders as ordersTable,
  orderStatusHistory,
  products as productsTable,
  productVariants,
} from "./db/schema";
import { orders as demoOrders, products as demoProducts, type OrderStatus } from "./store-data";
import type { ProductInput } from "./product-input";
import { importFramerProductsIfInventoryEmpty } from "./framer-import";

export type AdminOrder = (typeof demoOrders)[number];
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
};

const statusLabels: Record<string, OrderStatus> = {
  new: "New",
  confirmed: "Confirmed",
  processing: "Processing",
  ready: "Ready",
  dispatched: "Dispatched",
  delivered: "Delivered",
  cancelled: "Delivered",
};

const deliveryLabels = {
  courier: "Courier",
  collection: "Collection",
  to_be_confirmed: "To be confirmed",
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

  await importFramerProductsIfInventoryEmpty();

  const [orderRows, itemRows, productRows, variantRows] = await Promise.all([
    db
      .select({
        id: ordersTable.id,
        orderNumber: ordersTable.orderNumber,
        status: ordersTable.status,
        paymentStatus: ordersTable.paymentStatus,
        deliveryMethod: ordersTable.deliveryMethod,
        total: ordersTable.total,
        createdAt: ordersTable.createdAt,
        customerFirstName: customers.firstName,
        customerLastName: customers.lastName,
        customerEmail: customers.email,
        customerPhone: customers.phone,
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
      .orderBy(desc(ordersTable.createdAt)),
    db
      .select({
        orderId: orderItems.orderId,
        name: orderItems.productName,
        variant: orderItems.variantName,
        quantity: orderItems.quantity,
        price: orderItems.unitPrice,
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
  ]);

  const itemsByOrder = new Map<string, AdminOrder["items"]>();
  for (const item of itemRows) {
    const items = itemsByOrder.get(item.orderId) ?? [];
    items.push({
      name: item.name,
      variant: item.variant,
      quantity: item.quantity,
      price: Number(item.price),
      image: "",
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
    orders: orderRows.map((order) => ({
      id: order.orderNumber,
      customer:
        `${order.customerFirstName ?? ""} ${order.customerLastName ?? ""}`.trim() ||
        order.recipientName ||
        "Guest customer",
      email: order.customerEmail ?? "",
      phone: order.customerPhone ?? "",
      placedAt: dateFormatter.format(order.createdAt),
      placedDate: order.createdAt.toISOString(),
      total: Number(order.total),
      paymentStatus: order.paymentStatus === "paid" ? "Paid" : "Pending",
      status: statusLabels[order.status] ?? "New",
      deliveryMethod: deliveryLabels[order.deliveryMethod],
      address: formatAddress([
        order.line1,
        order.line2,
        order.suburb,
        order.city,
        order.province,
        order.postalCode,
      ]),
      items: itemsByOrder.get(order.id) ?? [],
    })),
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
  const databaseStatus = nextStatus.toLowerCase() as
    | "new"
    | "confirmed"
    | "processing"
    | "ready"
    | "dispatched"
    | "delivered";
  const [existing] = await db
    .select({ id: ordersTable.id, status: ordersTable.status })
    .from(ordersTable)
    .where(eq(ordersTable.orderNumber, orderNumber))
    .limit(1);
  if (!existing) return null;

  await db.transaction(async (transaction) => {
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
  });

  const snapshot = await getAdminSnapshot();
  return snapshot.orders.find((order) => order.id === orderNumber) ?? null;
}
