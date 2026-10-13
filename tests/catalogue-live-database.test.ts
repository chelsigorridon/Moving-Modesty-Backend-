/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated PostgreSQL integration loader. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

test("live product drafts, publication, prices, stock reservations and paid deductions stay consistent", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), require = createRequire(import.meta.url);
  const postgres = new PGlite(), database = require("drizzle-orm/pglite").drizzle(postgres), cache = new Map<string, any>();
  // PGlite has one connection: queries that use the production pool inside a
  // transaction must reuse that connection in this isolated integration harness.
  let transactionScope: any;
  const transact = database.transaction.bind(database);
  database.transaction = (callback: any, options: any) => transact(async (tx: any) => {
    transactionScope = tx;
    try { return await callback(tx); } finally { transactionScope = undefined; }
  }, options);
  const previous = process.env.PRODUCT_MANAGEMENT_ENABLED;
  process.env.PRODUCT_MANAGEMENT_ENABLED = "true";
  let publishCalls = 0, authenticated = true;
  function load(file: string): any {
    const absolute = resolve(root, file);
    if (/lib[\\/]db(?:[\\/]index)?\.ts$/.test(absolute)) return { db: database, requireDatabase: () => transactionScope ?? database };
    if (/lib[\\/]auth\.ts$/.test(absolute)) return { getRequestAdmin: async () => authenticated ? { email: "test@example.com", role: "owner" } : null };
    if (/lib[\\/]monitoring\.ts$/.test(absolute)) return { reportFailure: async () => ({ reference: "TEST-ONLY" }) };
    if (/integrations[\\/]payfast[\\/]configuration\.ts$/.test(absolute)) return { requirePayFastConfiguration: () => ({ environment: "production", merchantId: "12345678", merchantKey: "test-key", passphrase: "test-only", storeUrl: "https://store.test.invalid", processUrl: "https://test.invalid/payfast", validationUrl: "https://test.invalid/validate", enforceSourceIp: false }) };
    if (/lib[\\/]framer-catalogue-live\.ts$/.test(absolute)) return { CataloguePublishPreflightError: Error, importCmsCatalogue: async () => [], publishCmsCatalogue: async (_doc: any, mapping: any) => { publishCalls++; return mapping; } };
    if (cache.has(absolute)) return cache.get(absolute);
    const compiledModule = { exports: {} }; cache.set(absolute, compiledModule.exports);
    const code = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = (name: string) => {
      if (name === "server-only") return {};
      if (name.startsWith("@/")) return load(name.slice(2) + ".ts");
      if (name.startsWith(".")) return load(resolve(dirname(absolute), name) + (name === "./db" ? "/index.ts" : name.endsWith(".ts") ? "" : ".ts"));
      return require(name);
    };
    new Function("require", "module", "exports", code)(localRequire, compiledModule, compiledModule.exports);
    return compiledModule.exports;
  }
  try {
    const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"));
    for (const entry of journal.entries) for (const statement of readFileSync(resolve(root, `drizzle/${entry.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (statement.trim()) await postgres.exec(statement);
    const live = load("lib/catalogue-live.ts"), storefront = load("lib/catalogue-storefront.ts");
    const variantId = randomUUID(), largeId = randomUUID(), colourId = randomUUID();
    const document = { name: "TEST private product", slug: "private-product", description: "Integration test only", category: "Hijabs", homepageImage: { url: "https://example.com/image.jpg", alt: "Black" },
      showOnHomepage: true, homepageOrder: 0, colours: [{ id: colourId, name: "Black", available: true, photos: [{ url: "https://example.com/image.jpg", alt: "Black" }],
        variants: [{ id: variantId, size: "Small", price: 490, stock: 3, stockVerified: true, available: true },
          { id: largeId, size: "Large", price: 490, stock: 0, stockVerified: false, available: false }] }] };
    let saved = await live.saveLiveCatalogue({ expectedRevision: 0, document });
    assert.equal(saved.revision, 1);
    assert.equal((await postgres.query("select * from product_variants")).rows.length, 0, "Saving a draft does not alter live checkout");
    const sku = `MM-${variantId.replaceAll("-", "").toUpperCase()}`;
    assert.equal(await storefront.resolveLiveCheckoutItem(sku), null);
    saved = await live.publishLiveCatalogue(saved.id, saved.revision, "test@example.com");
    assert.equal(publishCalls, 1);
    assert.equal(saved.publishedRevision, 1);
    assert.equal((await storefront.resolveLiveCheckoutItem(sku)).price, 490);
    assert.equal((await storefront.resolveLiveCheckoutItem(sku)).stock, 3);
    const largeSku = `MM-${largeId.replaceAll("-", "").toUpperCase()}`;
    assert.equal((await storefront.resolveLiveCheckoutItem(largeSku)).available, false, "Large is independently switched off; Small stays available");
    const checkout = load("lib/checkout-order.ts"), payment = load("lib/integrations/payfast/checkout.ts");
    const checkoutInput = { checkoutToken: randomUUID(), stage: "complete", fulfilmentMethod: "collection",
      customer: { firstName: "TEST", lastName: "Customer", email: "test@example.com", phone: "0821234567" }, items: [{ sku: largeSku, quantity: 1 }] };
    await assert.rejects(checkout.upsertCheckoutOrder(checkoutInput, database), /not available/, "Unavailable size cannot create a checkout order");
    assert.equal((await postgres.query("select * from orders")).rows.length, 0);
    const mapping = (await postgres.query<{ metadata: any }>("select metadata from catalogue_products where id=$1", [saved.id])).rows[0].metadata;
    const publicSlug = mapping.colours[colourId].slug;
    assert.deepEqual(await storefront.storefrontSizes(publicSlug), await storefront.storefrontSizes(mapping.colours[colourId].baseSku), "CMS slug and base SKU resolve to the same live variants");
    assert.equal((await storefront.storefrontSizes(publicSlug))[0].sku, sku);
    assert.deepEqual(await storefront.storefrontSizes("not-a-published-colour"), [], "Unknown identities cannot expose draft variants");
    await assert.rejects(live.saveLiveCatalogue({ id: saved.id, expectedRevision: 0, stockVersion: saved.stockVersion, document }), /another window/);
    await assert.rejects(live.saveLiveCatalogue({ expectedRevision: 0, document: { ...document, slug: "stolen-variant" } }), /belongs to another product/);
    const orderId = randomUUID();
    await postgres.query("insert into orders(id,order_number,status,payment_status,subtotal,total) values($1,'TEST-STOCK','new','pending','490','490')", [orderId]);
    await postgres.query("insert into order_items(order_id,variant_id,sku,product_name,variant_name,quantity,unit_price,line_total) values($1,$2,$3,'TEST','Small',2,'490','980')", [orderId, variantId, sku]);
    await database.transaction((tx: any) => storefront.reserveOrderStock(tx, orderId));
    assert.equal((await storefront.resolveLiveCheckoutItem(sku)).stock, 1);
    assert.equal((await storefront.resolveLiveCheckoutItem(sku, undefined, orderId)).stock, 3, "Payment retries do not compete with their own reservation");
    await database.transaction((tx: any) => storefront.reserveOrderStock(tx, orderId));
    assert.equal((await postgres.query("select * from stock_reservations")).rows.length, 1);
    await database.transaction((tx: any) => storefront.deductPaidStock(tx, orderId));
    await database.transaction((tx: any) => storefront.deductPaidStock(tx, orderId));
    assert.equal((await storefront.resolveLiveCheckoutItem(sku)).stock, 1, "Repeated payment callbacks deduct once");
    await assert.rejects(live.saveLiveCatalogue({ id: saved.id, expectedRevision: 1, stockVersion: saved.stockVersion, document }), /Stock changed/);
    saved = (await live.listLiveCatalogue())[0];
    const changed = structuredClone(saved.document); changed.colours[0].variants[0].price = 510;
    let draft = await live.saveLiveCatalogue({ id: saved.id, expectedRevision: saved.revision, stockVersion: saved.stockVersion, document: changed });
    assert.equal((await storefront.resolveLiveCheckoutItem(sku)).price, 490, "Draft pricing remains private");
    draft = await live.publishLiveCatalogue(draft.id, draft.revision, "test@example.com");
    assert.equal((await storefront.resolveLiveCheckoutItem(sku)).price, 510);
    const order = await checkout.upsertCheckoutOrder({ ...checkoutInput, items: [{ sku, quantity: 1 }] }, database);
    const paymentInput = { orderNumber: order.orderNumber, checkoutToken: checkoutInput.checkoutToken };
    const payfast = await payment.createPayFastCheckout(paymentInput, "https://test.invalid/api/payments/payfast/checkout");
    assert.equal(payfast.fields.amount, "510.00", "Available size still uses the existing PayFast form flow");
    assert.equal((await postgres.query("select * from payments")).rows.length, 1);
    const unavailable = structuredClone(draft.document); unavailable.colours[0].available = false;
    draft = await live.saveLiveCatalogue({ id: draft.id, expectedRevision: draft.revision, stockVersion: draft.stockVersion, document: unavailable });
    await live.publishLiveCatalogue(draft.id, draft.revision, "test@example.com");
    assert.equal((await storefront.resolveLiveCheckoutItem(sku)).available, false);
    await assert.rejects(payment.createPayFastCheckout(paymentInput, "https://test.invalid/api/payments/payfast/checkout"), /no longer available/, "A stock change after the order was saved blocks payment initiation");
    assert.equal((await postgres.query("select * from payments")).rows.length, 1, "Rejected payment does not create another attempt");
    const route = load("app/api/admin/product-catalogue/route.ts");
    authenticated = false;
    assert.equal((await route.GET(new Request("https://backend.test/api/admin/product-catalogue"))).status, 401);
    authenticated = true;
    assert.equal((await route.POST(new Request("https://backend.test/api/admin/product-catalogue", { method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/json" }, body: "{}" }))).status, 403);
  } finally {
    if (previous === undefined) delete process.env.PRODUCT_MANAGEMENT_ENABLED; else process.env.PRODUCT_MANAGEMENT_ENABLED = previous;
    await postgres.close();
  }
});
