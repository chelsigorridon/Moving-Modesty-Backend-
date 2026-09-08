import "server-only";

import { randomUUID } from "node:crypto";
import { connect, type CollectionItem } from "framer-api";
import { db } from "./db";
import { products, productVariants } from "./db/schema";

const DEFAULT_COLLECTION_ID = "m15OMOfwH";

type CmsProductGroup = {
  slug: string;
  name: string;
  category: string;
  description: string;
  image: string;
  active: boolean;
  variants: Array<{
    colour: string;
    size: string;
    price: number;
    stock: number;
  }>;
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function stringValue(item: CollectionItem, fieldId: string | undefined) {
  if (!fieldId) return "";
  const value = item.fieldData[fieldId];
  return value?.type === "string" ? value.value.trim() : "";
}

function booleanValue(item: CollectionItem, fieldId: string | undefined) {
  if (!fieldId) return false;
  const value = item.fieldData[fieldId];
  return value?.type === "boolean" ? value.value : false;
}

function imageValue(item: CollectionItem, fieldId: string | undefined) {
  if (!fieldId) return "";
  const value = item.fieldData[fieldId];
  return value?.type === "image" ? value.value?.url ?? "" : "";
}

function parseMoney(value: string) {
  const parsed = Number(value.replace(/[^0-9.,-]/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseStock(value: string) {
  const parsed = Number.parseInt(value.replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function parseSizes(value: string) {
  if (!value.trim()) return ["One size fits all"];
  if (/one\s*size/i.test(value)) return ["One size fits all"];
  const sizes = value
    .split(/\s*(?:\/|,|\||\band\b)\s*/i)
    .map((size) => size.trim())
    .filter(Boolean);
  return sizes.length ? Array.from(new Set(sizes)) : ["One size fits all"];
}

function baseName(value: string) {
  return value.split(/\s+[-–—]\s+/)[0]?.trim() || value.trim();
}

function isAllCaps(value: string) {
  const letters = value.replace(/[^a-z]/gi, "");
  return Boolean(letters) && letters === letters.toUpperCase();
}

function baseSlug(itemSlug: string, colour: string) {
  const colourSuffix = slugify(colour);
  return colourSuffix && itemSlug.endsWith(`-${colourSuffix}`)
    ? itemSlug.slice(0, -(colourSuffix.length + 1))
    : slugify(baseName(itemSlug));
}

function skuFor(productSlug: string, colour: string, size: string) {
  const sizeCode = /one\s*size/i.test(size) ? "OS" : slugify(size).toUpperCase();
  return `${slugify(productSlug).toUpperCase()}-${slugify(colour).toUpperCase()}-${sizeCode}`;
}

export async function importFramerProductsIfInventoryEmpty() {
  if (!db) throw new Error("DATABASE_URL is not configured.");

  const existingProducts = await db.select({ id: products.id }).from(products).limit(1);
  if (existingProducts.length) return { importedProducts: 0, importedVariants: 0 };

  const projectId = process.env.FRAMER_PROJECT_ID?.trim();
  const apiKey = process.env.FRAMER_API_KEY?.trim();
  const collectionId =
    process.env.FRAMER_PRODUCTS_COLLECTION_ID?.trim() || DEFAULT_COLLECTION_ID;
  if (!projectId || !apiKey) {
    throw new Error("Framer CMS import is not configured on Vercel.");
  }

  const framer = await connect(projectId, apiKey);
  try {
    const collection = await framer.getCollection(collectionId);
    if (!collection) throw new Error("The Framer Products collection could not be found.");

    const [fields, items] = await Promise.all([
      collection.getFields(),
      collection.getItems(),
    ]);
    const fieldIds = new Map(fields.map((field) => [field.name.toLowerCase(), field.id]));
    const groups = new Map<string, CmsProductGroup>();

    for (const item of items) {
      const colour = stringValue(item, fieldIds.get("colour")) || "Default";
      const slug = baseSlug(item.slug, colour);
      const itemName = baseName(stringValue(item, fieldIds.get("name")) || item.slug);
      const current = groups.get(slug);
      const group: CmsProductGroup = current ?? {
        slug,
        name: itemName,
        category: stringValue(item, fieldIds.get("category")) || "Scarves",
        description: stringValue(item, fieldIds.get("description")),
        image: imageValue(item, fieldIds.get("image")),
        active: !item.draft || booleanValue(item, fieldIds.get("featured")),
        variants: [],
      };

      if (isAllCaps(group.name) && !isAllCaps(itemName)) group.name = itemName;
      if (!group.image) group.image = imageValue(item, fieldIds.get("image"));
      group.active ||= !item.draft || booleanValue(item, fieldIds.get("featured"));

      const price = parseMoney(stringValue(item, fieldIds.get("price")));
      const stock = parseStock(stringValue(item, fieldIds.get("stock")));
      for (const size of parseSizes(stringValue(item, fieldIds.get("size options")))) {
        group.variants.push({ colour, size, price, stock });
      }
      groups.set(slug, group);
    }

    const productRows = [];
    const variantRows = [];

    for (const group of groups.values()) {
      const productId = randomUUID();
      productRows.push({
        id: productId,
        name: group.name,
        slug: group.slug,
        category: group.category,
        description: group.description || null,
        primaryImageUrl: group.image || null,
        status: group.active ? ("active" as const) : ("draft" as const),
      });
      variantRows.push(
        ...group.variants.map((variant) => ({
          productId,
          sku: skuFor(group.slug, variant.colour, variant.size),
          size: variant.size,
          colour: variant.colour,
          price: variant.price.toFixed(2),
          stockOnHand: variant.stock,
          lowStockThreshold: 3,
        }))
      );
    }

    if (!productRows.length) return { importedProducts: 0, importedVariants: 0 };

    const insertProducts = db
      .insert(products)
      .values(productRows)
      .onConflictDoNothing({ target: products.slug });

    if (variantRows.length) {
      await db.batch([
        insertProducts,
        db
          .insert(productVariants)
          .values(variantRows)
          .onConflictDoNothing({ target: productVariants.sku }),
      ]);
    } else {
      await insertProducts;
    }

    return {
      importedProducts: productRows.length,
      importedVariants: variantRows.length,
    };
  } finally {
    await framer.disconnect();
  }
}
