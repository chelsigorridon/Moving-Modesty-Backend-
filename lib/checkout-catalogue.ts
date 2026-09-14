export type CheckoutCatalogueItem = {
  sku: string;
  slug: string;
  name: string;
  colour: string;
  size: string;
  price: number;
  image: string;
};

const cmsImages = {
  aminaLavender: "https://framerusercontent.com/images/3J5Dcr1Y5v0kCYCmQKhGlGDEPD4.jpg",
  aminaBlack: "https://framerusercontent.com/images/yTBnAmvzSKmhiXSLTuzL0Tr6iCg.png",
  aminaLilac: "https://framerusercontent.com/images/8b042gsmMfmJqk7wlszFeZvlJXA.jpg",
  hawaBlack: "https://framerusercontent.com/images/i6owtTY1yDSiItsUFxWH0UF63zg.jpg",
  hawaPink: "https://framerusercontent.com/images/nHUZyoFclAPd6qiYkasCMFCBsc.jpg",
  hawaSage: "https://framerusercontent.com/images/f6WMhOKjLsm49Y7wGAM81zcaec.jpg",
  hawaGrey: "https://framerusercontent.com/images/JcsoV8pbMEH6JsIWfcw4pIjlAEM.jpg",
} as const;

const builtInCatalogue: CheckoutCatalogueItem[] = [
  { sku: "AMINA-LAV-OS", slug: "amina-tie-back-lavender", name: "Amina Tie-Back", colour: "Lavender", size: "One size fits all", price: 420, image: cmsImages.aminaLavender },
  { sku: "AMINA-BLK-OS", slug: "amina-tie-back-black", name: "Amina Tie-Back", colour: "Black", size: "One size fits all", price: 420, image: cmsImages.aminaBlack },
  { sku: "AMINA-LIL-OS", slug: "amina-tie-back-lilac", name: "Amina Tie-Back", colour: "Lilac", size: "One size fits all", price: 420, image: cmsImages.aminaLilac },
  { sku: "HAWA-BLK-S", slug: "hawa-tri-instant-scarf-black", name: "Hawa Tri-Instant Scarf", colour: "Black", size: "Small", price: 450, image: cmsImages.hawaBlack },
  { sku: "HAWA-BLK-L", slug: "hawa-tri-instant-scarf-black", name: "Hawa Tri-Instant Scarf", colour: "Black", size: "Large", price: 450, image: cmsImages.hawaBlack },
  { sku: "HAWA-PNK-S", slug: "hawa-tri-instant-scarf-soft-pink", name: "Hawa Tri-Instant Scarf", colour: "Soft Pink", size: "Small", price: 450, image: cmsImages.hawaPink },
  { sku: "HAWA-PNK-L", slug: "hawa-tri-instant-scarf-soft-pink", name: "Hawa Tri-Instant Scarf", colour: "Soft Pink", size: "Large", price: 450, image: cmsImages.hawaPink },
  { sku: "HAWA-SGE-S", slug: "hawa-tri-instant-scarf-sage", name: "Hawa Tri-Instant Scarf", colour: "Sage", size: "Small", price: 450, image: cmsImages.hawaSage },
  { sku: "HAWA-SGE-L", slug: "hawa-tri-instant-scarf-sage", name: "Hawa Tri-Instant Scarf", colour: "Sage", size: "Large", price: 450, image: cmsImages.hawaSage },
  { sku: "HAWA-GRY-S", slug: "hawa-tri-instant-scarf-grey", name: "Hawa Tri-Instant Scarf", colour: "Grey", size: "Small", price: 450, image: cmsImages.hawaGrey },
  { sku: "HAWA-GRY-L", slug: "hawa-tri-instant-scarf-grey", name: "Hawa Tri-Instant Scarf", colour: "Grey", size: "Large", price: 450, image: cmsImages.hawaGrey },
];

function isCatalogueItem(value: unknown): value is CheckoutCatalogueItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.sku === "string" &&
    typeof item.slug === "string" &&
    typeof item.name === "string" &&
    typeof item.colour === "string" &&
    typeof item.size === "string" &&
    typeof item.price === "number" &&
    Number.isFinite(item.price) &&
    item.price >= 0 &&
    typeof item.image === "string"
  );
}

function configuredCatalogue() {
  const raw = process.env.CHECKOUT_CATALOGUE_JSON;
  if (!raw) return builtInCatalogue;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isCatalogueItem)) {
      throw new Error("CHECKOUT_CATALOGUE_JSON must be an array of valid catalogue items.");
    }
    return parsed;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "CHECKOUT_CATALOGUE_JSON is invalid.");
  }
}

export function getCheckoutCatalogue() {
  return new Map(configuredCatalogue().map((item) => [item.sku.toUpperCase(), item]));
}

export function resolveCheckoutItem(sku: string) {
  return getCheckoutCatalogue().get(sku.trim().toUpperCase()) ?? null;
}
