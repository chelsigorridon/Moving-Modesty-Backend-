// Mechanical single-file bundling keeps the review and Framer portal identical.
import { readFileSync, writeFileSync } from "node:fs";
const target = new URL("../framer/AdminPortal.tsx", import.meta.url);
const begin = "// BEGIN GENERATED DISCOUNT MANAGER";
const end = "// END GENERATED DISCOUNT MANAGER";
const portal = readFileSync(target, "utf8").replace(new RegExp(`\\n${begin}[\\s\\S]*?${end}\\n?`), "");
let manager = readFileSync(new URL("../components/discount-manager.tsx", import.meta.url), "utf8");
manager = manager.slice(manager.indexOf("type DiscountRecord =")).replace("export default function DiscountManager", "function DiscountManager");
writeFileSync(target, `${portal.trimEnd()}\n\n${begin}\n${manager}\n${end}\n`);
console.log("Bundled the shared discount manager into AdminPortal.tsx.");
