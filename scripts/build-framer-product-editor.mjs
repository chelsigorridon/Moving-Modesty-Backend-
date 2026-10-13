// Mechanical, reproducible single-file bundling: Framer cannot import workspace modules.
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
const target = new URL("../framer/AdminPortal.tsx", import.meta.url);
const begin = "// BEGIN GENERATED PRODUCT EDITOR";
const end = "// END GENERATED PRODUCT EDITOR";
let portal = readFileSync(target, "utf8").replace(new RegExp(`\\n${begin}[\\s\\S]*?${end}\\n?`), "");
let editor = readFileSync(new URL("../components/product-catalogue-editor.tsx", import.meta.url), "utf8");
editor = editor.slice(editor.indexOf("type Draft ="));
editor = editor.replace("export default function ProductCatalogueEditor", "function LiveCatalogueEditor").replace("catalogueDocumentSchema.parse(current.document)", "current.document");
let helpers = readFileSync(new URL("../lib/catalogue-editor.ts", import.meta.url), "utf8");
helpers = helpers.slice(helpers.indexOf("export function productAddress"));
helpers = helpers.replace(/export /g, "");
helpers = helpers.replace(/function catalogueEditorErrors[\s\S]*?(?=function productAvailability)/, `function catalogueEditorErrors(document: CatalogueDocument, demo = false): CatalogueEditorErrors {
  void demo;
  const errors: CatalogueEditorErrors = {};
  if (document.name.trim().length < 2) errors.name = "Enter a product name.";
  document.colours.forEach((colour, i) => {
    if (!colour.name.trim()) errors[\`colours.\${i}.name\`] = "Enter a colour name.";
    colour.variants.forEach((variant, j) => {
      const path = \`colours.\${i}.variants.\${j}\`;
      if (!variant.size.trim()) errors[\`\${path}.size\`] = "Enter a size name.";
      if (!Number.isFinite(variant.price) || variant.price <= 0) errors[\`\${path}.price\`] = "Enter a price greater than zero.";
      if (!Number.isInteger(variant.stock) || variant.stock < 0) errors[\`\${path}.stock\`] = "Enter a whole stock quantity.";
    });
  });
  return errors;
}
`);
const types = `type CatalogueDocument = {
  name: string; slug: string; description: string; tagline?: string; productDetails?: string;
  fabricMaterials?: string; benefits?: string; fabricWeight?: string; dimensions?: string; careInstructions?: string; deliveryReturns?: string; category: string;
  homepageImage: { url: string; alt: string }; showOnHomepage: boolean; homepageOrder: number;
  colours: Array<{ id: string; name: string; available: boolean; photos: Array<{ url: string; alt: string }>;
    variants: Array<{ id: string; size: string; price: number; stock: number; stockVerified?: boolean; available: boolean }> }>;
};
type CatalogueEditorErrors = Record<string, string>;
type Colour = CatalogueDocument["colours"][number];
`;
let generated = types + helpers + editor.replace('type Colour = CatalogueDocument["colours"][number];', "");
// Rename code identifiers only, never visible labels, strings or JSX text.
const names = { Draft: "CatalogueDraft", Props: "CatalogueEditorProps", Colour: "CatalogueColour", Field: "CatalogueField", Photo: "CataloguePhoto", money: "catalogueMoney", styles: "catalogueEditorStyles", stages: "catalogueStages" };
const source = ts.createSourceFile("editor.tsx", generated, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const replacements = [];
function collect(node) {
  if (ts.isIdentifier(node) && Object.hasOwn(names, node.text)) {
    replacements.push({ start: node.getStart(source), end: node.end, text: names[node.text] });
  }
  ts.forEachChild(node, collect);
}
collect(source);
for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
  generated = generated.slice(0, replacement.start) + replacement.text + generated.slice(replacement.end);
}
writeFileSync(target, `${portal.trimEnd()}\n\n${begin}\n${generated}\n${end}\n`);
console.log("Bundled the shared product editor into AdminPortal.tsx.");
