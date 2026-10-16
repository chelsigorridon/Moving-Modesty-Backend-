import { catalogueDocumentSchema, type CatalogueDocument } from "./catalogue-input.ts";

type Colour = CatalogueDocument["colours"][number];
export type CatalogueEditorErrors = Record<string, string>;

export function productAddress(name: string, used: string[] = []) {
  let base = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 140).replace(/-$/, "") || "product";
  if (base.length === 1) base += "-product";
  let address = base;
  for (let suffix = 2; used.includes(address); suffix++) address = `${base}-${suffix}`;
  return address;
}

export function productSizes(document: CatalogueDocument) {
  return [...new Set(document.colours.flatMap(colour => colour.variants.map(entry => entry.size)))];
}
export function usualProductPrice(document: CatalogueDocument) {
  const counts = new Map<number, number>();
  for (const colour of document.colours) for (const entry of colour.variants) counts.set(entry.price, (counts.get(entry.price) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}
// Shared edits preserve identifiers, stock and any deliberately different price.
export function changeUsualPrice(document: CatalogueDocument, previous: number, price: number): CatalogueDocument {
  return { ...document, colours: document.colours.map(colour => ({ ...colour,
    variants: colour.variants.map(entry => entry.price === previous ? { ...entry, price } : entry) })) };
}
export function addProductSize(document: CatalogueDocument, size: string, price: number): CatalogueDocument {
  return { ...document, colours: document.colours.map(colour => ({ ...colour,
    variants: [...colour.variants, { id: crypto.randomUUID(), size, price, stock: 0, stockVerified: true, available: true }] })) };
}
export function renameProductSize(document: CatalogueDocument, previous: string, size: string, position?: number): CatalogueDocument {
  return { ...document, colours: document.colours.map(colour => ({ ...colour,
    variants: colour.variants.map((entry, index) => entry.size === previous && (position === undefined || position === index) ? { ...entry, size } : entry) })) };
}
export function newProductColour(sizes: string[], price: number): Colour {
  return { id: crypto.randomUUID(), name: "", available: true, photos: [],
    variants: sizes.map(size => ({ id: crypto.randomUUID(), size, price, stock: 0, stockVerified: true, available: true })) };
}
export function withProductColours(document: CatalogueDocument, colours: Colour[]): CatalogueDocument {
  const photos = colours.flatMap(colour => colour.photos);
  const wasColourPhoto = document.colours.some(colour => colour.photos.some(photo => photo.url === document.homepageImage.url));
  const removed = wasColourPhoto && !photos.some(photo => photo.url === document.homepageImage.url);
  return { ...document, colours, homepageImage: !document.homepageImage.url || removed ? (photos[0] || { url: "", alt: "" }) : document.homepageImage };
}
export function catalogueEditorErrors(document: CatalogueDocument, demo = false): CatalogueEditorErrors {
  const input = structuredClone(document);
  if (demo) {
    const normalize = (photo: { url: string }) => { if (photo.url.startsWith("blob:")) photo.url = "https://example.com/demo-photo.jpg"; };
    normalize(input.homepageImage); input.colours.forEach(colour => colour.photos.forEach(normalize));
  }
  const checked = catalogueDocumentSchema.safeParse(input);
  const errors: CatalogueEditorErrors = {};
  if (!checked.success) for (const issue of checked.error.issues) {
    const path = issue.path.join(".");
    const field = issue.path.at(-1);
    let message = "Please check this information.";
    if (path === "name") message = "Enter a product name with 2–200 characters.";
    else if (path === "description") message = "Keep the description under 10,000 characters.";
    else if (field === "price") message = "Enter a price between R0.01 and R100,000, with no more than two decimal places.";
    else if (field === "stock") message = "Enter a whole stock quantity from 0 to 100,000.";
    else if (field === "size") message = issue.code === "custom" ? "Use a different name for each size." : "Enter a size name, such as Small or One size.";
    else if (field === "name" && path.startsWith("colours.")) message = issue.code === "custom" ? "This colour already exists. Use a different colour name." : "Enter the colour name, such as Black.";
    else if (field === "url") message = "Choose a valid photo or use an HTTPS photo link.";
    else if (path === "colours") message = "Add between 1 and 30 colours.";
    else if (field === "variants") message = "Choose between 1 and 30 sizes.";
    else if (path === "slug") message = "Please adjust the product name so its website address can be generated.";
    errors[path] ??= message;
  }
  return errors;
}
export function variantAvailable(entry: Colour["variants"][number]) {
  return entry.available && (entry.stock > 0 || entry.stockVerified === false);
}
export function productAvailability(document: CatalogueDocument) {
  if (!document.colours.some(colour => colour.available && colour.variants.some(entry => entry.available))) return "Unavailable";
  return document.colours.some(colour => colour.available && colour.variants.some(variantAvailable)) ? "Available" : "Out of stock";
}
