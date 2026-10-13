import { z } from "zod";

const photo = z.object({
  url: z.union([z.literal(""), z.string().max(2048).url().refine(value => new URL(value).protocol === "https:", "Use an HTTPS image address.")]),
  alt: z.string().trim().max(250).default(""),
});
const variant = z.object({
  id: z.string().uuid(),
  size: z.string().trim().min(1).max(80),
  price: z.number().finite().min(0.01).max(100000).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001, "Prices can have at most two decimal places."),
  stock: z.number().int().min(0).max(100000),
  stockVerified: z.boolean().optional(),
  available: z.boolean(),
});

export const catalogueDocumentSchema = z.object({
  name: z.string().trim().min(2).max(200),
  slug: z.string().trim().min(2).max(150).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase words separated by hyphens for the page address."),
  description: z.string().trim().max(10000),
  tagline: z.string().trim().max(300).optional(),
  productDetails: z.string().trim().max(10000).optional(),
  benefits: z.string().trim().max(10000).optional(),
  fabricWeight: z.string().trim().max(10000).optional(),
  dimensions: z.string().trim().max(10000).optional(),
  fabricMaterials: z.string().trim().max(10000).optional(),
  careInstructions: z.string().trim().max(10000).optional(),
  deliveryReturns: z.string().trim().max(10000).optional(),
  category: z.string().trim().max(120),
  homepageImage: photo,
  showOnHomepage: z.boolean(),
  homepageOrder: z.number().int().min(0).max(10000),
  colours: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    available: z.boolean(),
    photos: z.array(photo).max(12),
    variants: z.array(variant).min(1).max(30),
  })).min(1).max(30),
}).superRefine((document, context) => {
  const names = new Set<string>();
  const ids = new Set<string>();
  document.colours.forEach((colour, colourIndex) => {
    const name = colour.name.toLowerCase();
    if (names.has(name)) context.addIssue({ code: "custom", message: "Each colour needs a different name.", path: ["colours", colourIndex, "name"] });
    names.add(name);
    const sizes = new Set<string>();
    for (const [variantIndex, entry] of colour.variants.entries()) {
      const size = entry.size.toLowerCase();
      if (sizes.has(size)) context.addIssue({ code: "custom", message: "A size can only appear once per colour.", path: ["colours", colourIndex, "variants", variantIndex, "size"] });
      sizes.add(size);
    }
    for (const id of [colour.id, ...colour.variants.map(entry => entry.id)]) {
      if (ids.has(id)) context.addIssue({ code: "custom", message: "Duplicate colour or size identifier.", path: ["colours", colourIndex] });
      ids.add(id);
    }
  });
});

export const catalogueSaveSchema = z.object({
  id: z.string().uuid().optional(),
  expectedRevision: z.number().int().nonnegative(),
  document: catalogueDocumentSchema,
});

export type CatalogueDocument = z.infer<typeof catalogueDocumentSchema>;
export type CatalogueSaveInput = z.infer<typeof catalogueSaveSchema>;

// These codes are independent of names/colours/sizes, which Zarina may rename.
export function catalogueVariantSku(id: string) {
  return `MM-${id.replaceAll("-", "").toUpperCase()}`;
}

export function cataloguePublicationIssues(document: CatalogueDocument) {
  const issues: string[] = [];
  if (!document.description) issues.push("Add a product description before publishing.");
  if (document.showOnHomepage && !document.homepageImage.url) issues.push("Choose a homepage collection image.");
  for (const colour of document.colours) {
    if (colour.available && !colour.photos.some(image => image.url)) issues.push(`Add a photo for ${colour.name}.`);
  }
  return issues;
}

export function catalogueCmsPreview(document: CatalogueDocument) {
  return {
    product: { slug: document.slug, name: document.name, description: document.description,
      category: document.category, image: document.homepageImage, showOnHomepage: document.showOnHomepage, order: document.homepageOrder,
      tagline: document.tagline ?? "", productDetails: document.productDetails ?? "", fabricMaterials: document.fabricMaterials ?? "",
      careInstructions: document.careInstructions ?? "", deliveryReturns: document.deliveryReturns ?? "" },
    colours: document.colours.map((colour, order) => ({ id: colour.id, name: colour.name, productSlug: document.slug,
      available: colour.available, order, photos: colour.photos,
      sizes: colour.variants.map(entry => ({ id: entry.id, sku: catalogueVariantSku(entry.id), size: entry.size, price: entry.price,
        available: colour.available && entry.available && entry.stock > 0 })) })),
  };
}
