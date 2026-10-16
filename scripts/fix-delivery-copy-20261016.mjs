// One-off, guarded copy-only maintenance. CMS old/new hashes were verified
// against all affected Framer fields, including the family metadata records.
// No inventory, prices, orders, payments or courier configuration are changed.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Pool } from "@neondatabase/serverless";

const targets = [
  { slug: "amina", oldHash: "4f0454130ffc624fd37182f0b3b42a1d1dca6b3b03bf1915fc48221f5fa84694", newHash: "8ab5281fa632476914008d7d542e78247852c0977397caa41eb916a054608f17" },
  { slug: "hawa", oldHash: "fafed02c7174647ee365b6988417857f1be50f18b1808d23a44b037f060dc0f5", newHash: "737666aac78a008e0217692a12d1414019ec0164648f61bdb8fc04c268ae6868" },
];
const env = parseEnv(readFileSync(".env.production.local", "utf8"));
const connectionString = [env.DATABASE_URL, env.DATABASE_URL_DATABASE_URL, env.DATABASE_URL_POSTGRES_URL, env.DATABASE_URL_POSTGRES_PRISMA_URL].find(value => value && value !== "[SENSITIVE]");
if (!connectionString) throw new Error("The private database connection is unavailable.");
const pool = new Pool({ connectionString });
let client;
try {
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('mm-catalogue-management', 0))");
  const results = [];
  for (const target of targets) {
    const { rows } = await client.query("SELECT id, revision, published_revision, publication_state, document, published_document, metadata FROM catalogue_products WHERE slug=$1 FOR UPDATE", [target.slug]);
    const row = rows[0];
    if (rows.length !== 1 || row.revision !== row.published_revision || row.publication_state !== "idle") throw new Error("A product has pending edits; no copy updates committed.");
    if (row.metadata.cmsHash === target.newHash && [row.document, row.published_document].every(doc => doc?.deliveryReturns?.includes("R1,200") && !doc.deliveryReturns.includes("R1,500"))) {
      results.push({ slug: target.slug, alreadyUpdated: true });
      continue;
    }
    if (row.metadata.cmsHash !== target.oldHash || ![row.document, row.published_document].every(doc => typeof doc?.deliveryReturns === "string" && doc.deliveryReturns.includes("R1,500"))) throw new Error("Product/CMS version changed; no copy updates committed.");
    const document = { ...row.document, deliveryReturns: row.document.deliveryReturns.replaceAll("R1,500", "R1,200") };
    const published = { ...row.published_document, deliveryReturns: row.published_document.deliveryReturns.replaceAll("R1,500", "R1,200") };
    await client.query("UPDATE catalogue_products SET document=$1::jsonb,published_document=$2::jsonb,metadata=$3::jsonb,revision=revision+1,published_revision=published_revision+1,updated_at=now() WHERE id=$4",
      [JSON.stringify(document), JSON.stringify(published), JSON.stringify({ ...row.metadata, cmsHash: target.newHash }), row.id]);
    results.push({ slug: target.slug, copyUpdated: true, revision: row.revision + 1 });
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({ results, inventoryChanged: false, ordersChanged: false, automaticSyncEnabled: false }));
} catch {
  await client?.query("ROLLBACK").catch(() => {});
  console.error("Copy maintenance could not be confirmed. The database transaction was rolled back; inspect product versions privately before retrying.");
  process.exitCode = 1;
} finally { client?.release(); await pool.end(); }
