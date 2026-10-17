import "server-only";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDatabase } from "./db";
import { addresses, customers, orderDeliveryHistory, orderItems, orders, payments, shipments } from "./db/schema";
import { courierAddressInput, courierContactInput } from "./delivery-input";
import { createPayFastSignature, type PayFastField } from "./integrations/payfast/signature";
import type { PayFastRuntimeConfiguration } from "./integrations/payfast/configuration";
import { verifyQuote } from "./integrations/bobgo/protocol";

// Temporary owner-only test, never an option on customer checkout. One durable
// creation record across the database prevents retries from creating more orders.
const createdAction = "live_courier_test_created";
const attemptedAction = "live_courier_test_booking_started";
export const liveCourierTestPrefix = "MM-COURIER-TEST-";
export const isLiveCourierTestNumber = (value: string) => value.startsWith(liveCourierTestPrefix);
type Database = ReturnType<typeof requireDatabase>;
type Reader = Pick<Database, "select">;
type Order = typeof orders.$inferSelect;
const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const quoteHash = (token: string) => createHash("sha256").update(token).digest("hex");
function costApproval(orderId: string, token: string) {
  if (!process.env.AUTH_SECRET) throw new LiveCourierTestConflict("Test cost approval signing is not configured.");
  return createHmac("sha256", process.env.AUTH_SECRET).update(`live-courier-test-cost:${orderId}:${quoteHash(token)}`).digest("hex");
}
export class LiveCourierTestConflict extends Error {}
export const liveCourierTestInput = z.object({
  contact: courierContactInput.extend({ name: z.literal("Test Test") }),
  address: courierAddressInput,
  confirm: z.literal(true),
});

export function requireCourierTestPayFastConfiguration(): PayFastRuntimeConfiguration {
  const merchantId = process.env.PAYFAST_TEST_MERCHANT_ID?.trim() || "";
  const merchantKey = process.env.PAYFAST_TEST_MERCHANT_KEY?.trim() || "";
  const passphrase = process.env.PAYFAST_TEST_PASSPHRASE?.trim() || "";
  if (!merchantId || !merchantKey || !passphrase || merchantId === process.env.PAYFAST_MERCHANT_ID?.trim()) {
    throw new LiveCourierTestConflict("Separate PayFast sandbox credentials are required. Normal live payment settings must not be changed.");
  }
  return { enabled: true, environment: "sandbox", merchantConfigured: true, passphraseConfigured: true,
    merchantId, merchantKey, passphrase, processUrl: "https://sandbox.payfast.co.za/eng/process",
    validationUrl: "https://sandbox.payfast.co.za/eng/query/validate", enforceSourceIp: false,
    storeUrl: process.env.STORE_URL?.trim() || "https://movingmodesty.com" };
}

export async function liveCourierTestRecord(reader: Reader, orderId: string) {
  const [row] = await reader.select().from(orderDeliveryHistory)
    .where(and(eq(orderDeliveryHistory.orderId, orderId), eq(orderDeliveryHistory.action, createdAction))).limit(1);
  const data = object(row?.after);
  return row && data.version === 1 && data.orderId === orderId && typeof data.orderNumber === "string"
    && isLiveCourierTestNumber(data.orderNumber) && typeof data.expiresAt === "number" ? { ...row, data } : null;
}

export async function testOrderByNumber(number: string, reader: Reader = requireDatabase()) {
  if (!isLiveCourierTestNumber(number)) return null;
  const [order] = await reader.select().from(orders).where(eq(orders.orderNumber, number)).limit(1);
  if (!order || !(await liveCourierTestRecord(reader, order.id))) throw new LiveCourierTestConflict("Unknown courier TEST order.");
  return order;
}

export async function assertCourierTestIdentity(reader: Reader, order: Order) {
  const grant = await liveCourierTestRecord(reader, order.id);
  const items = await reader.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  if (!grant || grant.data.orderNumber !== order.orderNumber || Number(order.total) !== 5 || Number(order.subtotal) !== 5
    || Number(order.discountAmount) !== 0 || Number(order.deliveryFee) !== 0 || order.customerSnapshot?.firstName !== "Test"
    || order.customerSnapshot?.lastName !== "Test" || items.length !== 1 || items[0].variantId !== null
    || items[0].sku !== "COURIER-TEST-NOT-FOR-SALE" || items[0].quantity !== 1 || Number(items[0].lineTotal) !== 5) {
    throw new LiveCourierTestConflict("This is not the authorised, non-inventory courier TEST order.");
  }
  return grant;
}

export async function assertCourierTestCanQuote(reader: Reader, order: Order, now = Date.now()) {
  const grant = await assertCourierTestIdentity(reader, order);
  const attempts = await reader.select().from(orderDeliveryHistory).where(and(eq(orderDeliveryHistory.orderId, order.id), eq(orderDeliveryHistory.action, attemptedAction)));
  if (process.env.LIVE_COURIER_TEST_ENABLED !== "true" || Number(grant.data.expiresAt) <= now || attempts.length || !order.courierPlan || order.courierPlan.delivery.contact.name !== "Test Test") {
    throw new LiveCourierTestConflict("TEST quoting is disabled, expired, already used, or still needs a manually chosen collection point and saved delivery setup.");
  }
}

export async function assertCourierTestBookingApproval(reader: Reader, order: Order, token: string, supplied = "", now = Date.now()) {
  await assertCourierTestCanQuote(reader, order, now);
  const quote = verifyQuote(token, process.env.AUTH_SECRET || "", now), expected = costApproval(order.id, token);
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    || quote.orderNumber !== order.orderNumber || quote.environment !== "production") {
    throw new LiveCourierTestConflict("This TEST can compare quotes only. Approve the exact real courier cost separately before booking.");
  }
}

export async function assertCourierTestCanCancel(reader: Reader, order: Order, shipment: typeof shipments.$inferSelect) {
  await assertCourierTestIdentity(reader, order);
  const [attempt] = await reader.select().from(orderDeliveryHistory).where(and(eq(orderDeliveryHistory.orderId, order.id), eq(orderDeliveryHistory.action, attemptedAction))).limit(1);
  // Cleanup remains possible after expiry or disabling the test. It can only
  // cancel the live shipment created by this test's one durable booking attempt.
  if (!attempt || object(attempt.after).attemptReference !== shipment.bookingSnapshot?.testAttemptReference) {
    // The booking reference is also kept in the immutable audit record and in
    // the provider's custom reference, not inferred from the word TEST.
    throw new LiveCourierTestConflict("This TEST waybill does not match its authorised booking attempt.");
  }
}

export function createLiveCourierTestService(database: Database, now = () => Date.now()) {
  async function current() {
    const [record] = await database.select().from(orderDeliveryHistory).where(eq(orderDeliveryHistory.action, createdAction)).limit(1);
    if (!record) return null;
    const [order] = await database.select().from(orders).where(eq(orders.id, record.orderId)).limit(1);
    return order || null;
  }
  async function create(value: unknown, owner: string) {
    if (process.env.LIVE_COURIER_TEST_ENABLED !== "true" || process.env.VERCEL_ENV === "preview") throw new LiveCourierTestConflict("The private courier test is not enabled.");
    requireCourierTestPayFastConfiguration();
    const input = liveCourierTestInput.parse(value);
    return database.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('mm-one-live-courier-test', 0))`);
      const [existing] = await tx.select().from(orderDeliveryHistory).where(eq(orderDeliveryHistory.action, createdAction)).limit(1);
      if (existing) {
        const [order] = await tx.select().from(orders).where(eq(orders.id, existing.orderId)).limit(1);
        if (!order || existing.changedBy !== owner) throw new LiveCourierTestConflict("The single courier test already exists.");
        return order;
      }
      const id = randomUUID(), orderNumber = `${liveCourierTestPrefix}${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      // Never overwrite an existing customer's profile with the TEST name.
      await tx.insert(customers).values({ email: input.contact.email, firstName: "Test", lastName: "Test", phone: input.contact.phone }).onConflictDoNothing({ target: customers.email });
      const [customer] = await tx.select().from(customers).where(eq(customers.email, input.contact.email)).limit(1);
      const [address] = await tx.insert(addresses).values({ ...input.address, customerId: customer.id, recipientName: "Test Test" }).returning();
      const [order] = await tx.insert(orders).values({ id, orderNumber, customerId: customer.id, deliveryAddressId: address.id,
        customerSnapshot: { firstName: "Test", lastName: "Test", email: input.contact.email, phone: input.contact.phone },
        deliveryMethod: "courier", subtotal: "5.00", deliveryFee: "0.00", total: "5.00", checkoutToken: randomUUID(), deliveryRevision: 1,
        privateNote: "OWNER TEST ONLY. PayFast sandbox: no money received. Any Bob Go waybill is real and chargeable. Sales-channel sync remains off." }).returning();
      await tx.insert(orderItems).values({ orderId: id, productName: "TEST parcel — not for sale", variantName: "No stock allocated",
        sku: "COURIER-TEST-NOT-FOR-SALE", quantity: 1, unitPrice: "5.00", lineTotal: "5.00", productSnapshot: { testOnly: true } });
      await tx.insert(payments).values({ orderId: id, merchantPaymentId: orderNumber, provider: "payfast-sandbox", amount: "5.00", providerStatus: "CHECKOUT_STARTED" });
      await tx.insert(orderDeliveryHistory).values({ orderId: id, revision: 1, action: createdAction, changedBy: owner, before: {},
        after: { version: 1, orderId: id, orderNumber, expiresAt: now() + 24 * 60 * 60_000 } });
      return order;
    });
  }
  async function checkout(orderNumber: string, ownerUrl: string) {
    const configuration = requireCourierTestPayFastConfiguration(), order = await testOrderByNumber(orderNumber, database);
    if (!order || order.archivedAt || order.paymentStatus === "paid" || order.status !== "new") throw new LiveCourierTestConflict("The TEST payment is closed.");
    const grant = await assertCourierTestIdentity(database, order);
    if (process.env.LIVE_COURIER_TEST_ENABLED !== "true" || Number(grant.data.expiresAt) <= now()) throw new LiveCourierTestConflict("The TEST payment session expired or is disabled.");
    const base = new URL(ownerUrl);
    if (process.env.NODE_ENV === "production" && base.protocol !== "https:") throw new LiveCourierTestConflict("The sandbox notification endpoint must be public HTTPS.");
    const fields: PayFastField[] = [["merchant_id", configuration.merchantId], ["merchant_key", configuration.merchantKey],
      ["return_url", new URL("/courier-test?payment=processing", base).toString()], ["cancel_url", new URL("/courier-test?payment=cancelled", base).toString()],
      ["notify_url", new URL("/api/payments/payfast/notify", base).toString()], ["name_first", "Test"], ["name_last", "Test"],
      ["email_address", order.customerSnapshot!.email], ["cell_number", order.customerSnapshot!.phone],
      ["m_payment_id", order.orderNumber], ["amount", "5.00"], ["item_name", "TEST ONLY — no money received"], ["item_description", "Owner courier-flow test; no product purchase or inventory allocation"]];
    return { action: configuration.processUrl, fields: Object.fromEntries([...fields, ["signature", createPayFastSignature(fields, configuration.passphrase)]]) };
  }
  async function approve(orderNumber: string, token: string, amount: number, owner: string) {
    const quote = verifyQuote(token, process.env.AUTH_SECRET || "", now());
    if (quote.environment !== "production" || quote.orderNumber !== orderNumber || quote.amount !== amount) throw new LiveCourierTestConflict("Confirm the exact fresh quote and its real cost.");
    if (!owner) throw new LiveCourierTestConflict("Owner approval is required.");
    return database.transaction(async tx => {
      const [order] = await tx.select().from(orders).where(eq(orders.orderNumber, orderNumber)).for("update");
      if (!order || order.paymentStatus !== "paid" || order.status !== "ready") throw new LiveCourierTestConflict("A verified sandbox TEST marked Ready is required.");
      await assertCourierTestCanQuote(tx, order, now());
      return { costApproval: costApproval(order.id, token), amount };
    });
  }
  async function archive(owner: string) {
    const record = await current();
    if (!record) throw new LiveCourierTestConflict("The TEST order does not exist.");
    return database.transaction(async tx => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, record.id)).for("update");
      await assertCourierTestIdentity(tx, order);
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.orderId, order.id)).for("update");
      if (shipment && (shipment.providerShipmentId || ["booking", "booked"].includes(shipment.status)) && shipment.status !== "cancelled") {
        throw new LiveCourierTestConflict("Confirm cancellation of the existing TEST waybill before archiving. An uncertain booking must be checked in Bob Go first.");
      }
      if (!order.archivedAt) await tx.update(orders).set({ status: "cancelled", archivedAt: new Date(now()),
        archiveReason: `Owner courier TEST cleanup by ${owner}; no payment refund or courier cancellation performed.`, updatedAt: new Date(now()) }).where(eq(orders.id, order.id));
      return { archived: true as const };
    });
  }
  return { current, create, checkout, approve, archive };
}

export async function reserveCourierTestAttempt(transaction: Parameters<Parameters<Database["transaction"]>[0]>[0], order: Order, token: string, approval: string, attemptReference: string) {
  await assertCourierTestBookingApproval(transaction, order, token, approval);
  const history = await transaction.select().from(orderDeliveryHistory).where(eq(orderDeliveryHistory.orderId, order.id));
  const revision = Math.max(order.deliveryRevision, ...history.map(row => row.revision)) + 1;
  await transaction.insert(orderDeliveryHistory).values({ orderId: order.id, revision, action: attemptedAction, changedBy: "owner-approved-quote",
    before: {}, after: { quoteHash: quoteHash(token), attemptReference } });
  await transaction.update(orders).set({ deliveryRevision: revision }).where(eq(orders.id, order.id));
}
