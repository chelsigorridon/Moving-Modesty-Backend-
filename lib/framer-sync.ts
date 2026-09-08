import "server-only";

import {
  connect,
  type CollectionItem,
  type CollectionItemInput,
  type FieldDataInput,
} from "framer-api";
import type { AdminProduct } from "./admin-data";

export type FramerSyncResult = {
  configured: boolean;
  synced: boolean;
  published: boolean;
  itemCount: number;
  urls: string[];
  warning?: string;
};

const DEFAULT_COLLECTION_ID = "m15OMOfwH";

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function stringValue(item: CollectionItem, fieldId: string | undefined) {
  if (!fieldId) return "";
  const value = item.fieldData[fieldId];
  return value?.type === "string" ? value.value : "";
}

function displayName(productName: string, colour: string) {
  const cleanName = productName.trim();
  const cleanColour = colour.trim();
  return normalize(cleanName).endsWith(normalize(cleanColour))
    ? cleanName
    : `${cleanName} - ${cleanColour}`;
}

function cmsSlug(productSlug: string, colour: string) {
  const colourSlug = slugify(colour) || "default";
  const base = slugify(productSlug) || "product";
  return base.endsWith(`-${colourSlug}`) ? base : `${base}-${colourSlug}`;
}

function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

export async function syncProductToFramer(
  product: AdminProduct,
  options: { publish?: boolean } = {}
): Promise<FramerSyncResult> {
  const projectId = process.env.FRAMER_PROJECT_ID?.trim();
  const apiKey = process.env.FRAMER_API_KEY?.trim();
  const collectionId =
    process.env.FRAMER_PRODUCTS_COLLECTION_ID?.trim() || DEFAULT_COLLECTION_ID;

  if (!projectId || !apiKey) {
    return {
      configured: false,
      synced: false,
      published: false,
      itemCount: 0,
      urls: [],
      warning:
        "The product was saved to inventory, but Framer publishing is not configured yet.",
    };
  }

  const framer = await connect(projectId, apiKey);
  try {
    const collection = await framer.getCollection(collectionId);
    if (!collection) throw new Error("The Framer Products collection could not be found.");

    const [fields, existingItems] = await Promise.all([
      collection.getFields(),
      collection.getItems(),
    ]);
    const fieldIds = new Map(fields.map((field) => [field.name.toLowerCase(), field.id]));
    const requiredFields = [
      "name",
      "colour",
      "price",
      "stock",
      "availability",
      "category",
      "description",
      "size options",
      "featured",
    ];
    const missingFields = requiredFields.filter((name) => !fieldIds.has(name));
    if (missingFields.length) {
      throw new Error(`The Framer Products collection is missing: ${missingFields.join(", ")}.`);
    }

    const variantsByColour = new Map<string, AdminProduct["variants"]>();
    for (const variant of product.variants) {
      const colour = variant.colour.trim() || "Default";
      const current = variantsByColour.get(colour) ?? [];
      current.push(variant);
      variantsByColour.set(colour, current);
    }

    const updates: CollectionItemInput[] = [];
    const urls: string[] = [];
    for (const [colour, variants] of variantsByColour) {
      const name = displayName(product.name, colour);
      const slug = cmsSlug(product.id, colour);
      const sizes = Array.from(
        new Set(variants.map((variant) => variant.size.trim()).filter(Boolean))
      ).join(" / ");
      const stock = variants.reduce((total, variant) => total + variant.stock, 0);
      const price = Math.min(...variants.map((variant) => variant.price));
      const existing = existingItems.find(
        (item) =>
          item.slug === slug ||
          normalize(stringValue(item, fieldIds.get("name"))) === normalize(name)
      );

      const fieldData: FieldDataInput = {
        [fieldIds.get("name")!]: { type: "string", value: name },
        [fieldIds.get("colour")!]: { type: "string", value: colour },
        [fieldIds.get("price")!]: { type: "string", value: `R ${price.toFixed(2)}` },
        [fieldIds.get("stock")!]: { type: "string", value: String(stock) },
        [fieldIds.get("availability")!]: {
          type: "string",
          value: stock > 0 ? "In stock" : "Out of stock",
        },
        [fieldIds.get("category")!]: { type: "string", value: product.category },
        [fieldIds.get("description")!]: { type: "string", value: product.description },
        [fieldIds.get("size options")!]: {
          type: "string",
          value: sizes || "One size fits all",
        },
        [fieldIds.get("featured")!]: {
          type: "boolean",
          value: product.status === "Active",
        },
      };

      const imageFieldId = fieldIds.get("image");
      if (imageFieldId && product.image.trim()) {
        fieldData[imageFieldId] = {
          type: "image",
          value: product.image.trim(),
          alt: name,
        };
      }

      if (!existing) {
        const hasCarouselFieldId = fieldIds.get("has carousel");
        const careFieldId = fieldIds.get("care instructions");
        const deliveryFieldId = fieldIds.get("delivery returns");
        if (hasCarouselFieldId) {
          fieldData[hasCarouselFieldId] = { type: "boolean", value: false };
        }
        if (careFieldId) {
          fieldData[careFieldId] = { type: "string", value: "To be confirmed" };
        }
        if (deliveryFieldId) {
          fieldData[deliveryFieldId] = { type: "string", value: "To be confirmed" };
        }
      }

      updates.push({
        ...(existing ? { id: existing.id } : {}),
        slug,
        draft: product.status !== "Active",
        fieldData,
      });
      urls.push(`/products/${slug}`);
    }

    await collection.addItems(updates);

    let published = false;
    let warning: string | undefined;
    if (options.publish) {
      if (enabled(process.env.FRAMER_AUTO_PUBLISH)) {
        const result = await framer.publish();
        published = true;
        if (enabled(process.env.FRAMER_DEPLOY_TO_PRODUCTION)) {
          await framer.deploy(result.deployment.id);
        }
      } else {
        warning =
          "The CMS was updated, but automatic Framer publishing is disabled in the server settings.";
      }
    }

    return {
      configured: true,
      synced: true,
      published,
      itemCount: updates.length,
      urls,
      warning,
    };
  } finally {
    await framer.disconnect();
  }
}
