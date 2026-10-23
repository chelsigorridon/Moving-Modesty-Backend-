// Reproducible single-file transport embedding; no network or account access.
import { readFileSync, writeFileSync } from "node:fs";
const target = new URL("../framer/AdminPortal.tsx", import.meta.url);
const begin = "// BEGIN GENERATED ADMIN CLIENT", end = "// END GENERATED ADMIN CLIENT";
let portal = readFileSync(target, "utf8");
// Mechanical removal of the retired bearer headers, including generated blocks.
portal = portal.replace(/Authorization: `Bearer \$\{(?:token\(\)|adminToken)\}`\s*,?/g, "");
portal = portal.replace(/[ \t]+$/gm, "");
const source = readFileSync(new URL("../lib/admin-client.ts", import.meta.url), "utf8").replace(/^export /gm, "");
const block = `${begin}\n${source}\n${end}`;
const section = new RegExp(`${begin}[\\s\\S]*?${end}`);
writeFileSync(target, section.test(portal) ? portal.replace(section, () => block) : `${portal.trimEnd()}\n\n${block}\n`);
