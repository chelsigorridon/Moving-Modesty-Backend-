import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import {
  addresses,
  customers,
  orderItems,
  orders,
  orderStatusHistory,
} from "./db/schema";
import { resolveCheckoutItem, type CheckoutCatalogueItem } from "./checkout-catalogue";

const addressSchema = z.object({
  line1: z.string().trim().min(2).max(180),
  line2: z.string().trim().max(180).optional().default(""),
  suburb: z.string().trim().min(2).max(100),
  city: z.string().trim().min(2).max(100),
  province: z.string().trim().min(2).max(100),
  postalCode: z.string().trim().min(3).max(12),
});

export const checkoutOrderSchema = z.object({
  checkoutToken: z.string().uuid(),
  stage: z.enum(["started", "fulfilment", "address", "complete"]),
  customer: z.object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(180),
    phone: z.string().trim().min(7).max(30),
  }),
  fulfilmentMethod: z.enum(["delivery", "collection", "to_be_confirmed"]),
  address: addressSchema.optional(),
  items: z.array(z.object({
    sku: z.string().trim().min(3).max(80),
    quantity: z.number().int().min(1).max(10),
  })).min(1).max(20),
}).superRefine((input, context) => {
  const needsAddress = input.fulfilmentMethod === "delivery" && ["address", "complete"].includes(input.stage);
  if (needsAddress && !input.address) {
    context.addIssue({ code: "custom", path: ["address"], message: "Enter a delivery address." });
  }
});

export type CheckoutOrderInput = z.infer<typeof checkoutOrderSchema>;

export class CheckoutValidationError extends Error {}

type ResolvedLine = {
  product: CheckoutCatalogueItem;
  quantity: number;
  lineTotal: number;
};

function resolveLines(items: CheckoutOrderInput["items"]): ResolvedLine[] {
  const quantities = new Map<string, number>();
  for (const item of items) {
    const sku = item.sku.toUpperCase();
    quantities.set(sku, (quantities.get(sku) ?? 0) + item.quantity);
  }

  return Array.from(quantities, ([sku, quantity]) => {
    if (quantity > 10) throw new CheckoutValidationError(`The quantity for ${sku} is too high.`);
    const product = resolveCheckoutItem(sku);
    if (!product) throw new CheckoutValidationError(`The product ${sku} is not available for checkout.`);
    return { product, quantity, lineTotal: product.price * quantity };
  });
}

function makeOrderNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `MM-${date}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

export async function upsertCheckoutOrder(input: CheckoutOrderInput) {
  const lines = resolveLines(input.items);
  if (!db) throw new Error("DATABASE_URL is not configured.");
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const deliveryFee = 0;
  const total = subtotal + deliveryFee;
  const email = input.customer.email.toLowerCase();
  const deliveryMethod = input.fulfilmentMethod === "delivery"
    ? "courier"
    : input.fulfilmentMethod === "collection"
      ? "collection"
      : "to_be_confirmed";

  const [existingOrder] = await db
    .select({ id: orders.id, orderNumber: orders.orderNumber, deliveryAddressId: orders.deliveryAddressId })
    .from(orders)
    .where(eq(orders.checkoutToken, input.checkoutToken))
    .limit(1);

  const result = await db.transaction(async (transaction) => {
    const [customer] = await transaction
      .insert(customers)
      .values({
        email,
        firstName: input.customer.firstName,
        lastName: input.customer.lastName,
        phone: input.customer.phone,
      })
      .onConflictDoUpdate({
        target: customers.email,
        set: {
          firstName: input.customer.firstName,
          lastName: input.customer.lastName,
          phone: input.customer.phone,
          updatedAt: new Date(),
        },
      })
      .returning({ id: customers.id });

    let deliveryAddressId = existingOrder?.deliveryAddressId ?? null;
    if (deliveryMethod === "collection") {
      deliveryAddressId = null;
    } else if (input.address) {
      const addressValues = {
        customerId: customer.id,
        recipientName: `${input.customer.firstName} ${input.customer.lastName}`.trim(),
        line1: input.address.line1,
        line2: input.address.line2 || null,
        suburb: input.address.suburb,
        city: input.address.city,
        province: input.address.province,
        postalCode: input.address.postalCode,
        countryCode: "ZA",
        updatedAt: new Date(),
      };
      if (deliveryAddressId) {
        await transaction.update(addresses).set(addressValues).where(eq(addresses.id, deliveryAddressId));
      } else {
        const [createdAddress] = await transaction
          .insert(addresses)
          .values(addressValues)
          .returning({ id: addresses.id });
        deliveryAddressId = createdAddress.id;
      }
    }

    let orderId = existingOrder?.id;
    let orderNumber = existingOrder?.orderNumber;
    let created = false;

    if (orderId) {
      await transaction
        .update(orders)
        .set({
          customerId: customer.id,
          deliveryAddressId,
          deliveryMethod,
          subtotal: subtotal.toFixed(2),
          deliveryFee: deliveryFee.toFixed(2),
          total: total.toFixed(2),
          updatedAt: new Date(),
        })
        .where(eq(orders.id, orderId));
      await transaction.delete(orderItems).where(eq(orderItems.orderId, orderId));
    } else {
      orderNumber = makeOrderNumber();
      const [createdOrder] = await transaction
        .insert(orders)
        .values({
          orderNumber,
          checkoutToken: input.checkoutToken,
          customerId: customer.id,
          deliveryAddressId,
          status: "new",
          paymentStatus: "pending",
          deliveryMethod,
          subtotal: subtotal.toFixed(2),
          deliveryFee: deliveryFee.toFixed(2),
          total: total.toFixed(2),
        })
        .returning({ id: orders.id });
      orderId = createdOrder.id;
      created = true;
      await transaction.insert(orderStatusHistory).values({
        orderId,
        toStatus: "new",
        note: "Checkout started on the Moving Modesty storefront.",
      });
    }

    await transaction.insert(orderItems).values(lines.map(({ product, quantity, lineTotal }) => ({
      orderId: orderId!,
      productName: product.name,
      variantName: `${product.colour} · ${product.size}`,
      sku: product.sku,
      quantity,
      unitPrice: product.price.toFixed(2),
      lineTotal: lineTotal.toFixed(2),
      productSnapshot: {
        slug: product.slug,
        name: product.name,
        colour: product.colour,
        size: product.size,
        image: product.image,
      },
    })));

    return { orderNumber: orderNumber!, created };
  });

  return {
    orderNumber: result.orderNumber,
    created: result.created,
    stage: input.stage,
    fulfilmentMethod: input.fulfilmentMethod,
    subtotal,
    deliveryFee,
    total,
    paymentStatus: "pending" as const,
  };
}
