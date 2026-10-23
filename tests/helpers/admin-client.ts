import { readFileSync } from "node:fs";
import ts from "typescript";

// Executes the real browser transport with a per-test fetch implementation.
export function adminClientFixture(fetcher: typeof fetch, browser: unknown) {
  const compiledModule = { exports: {} as { adminRequest: typeof fetch } };
  const compiled = ts.transpileModule(readFileSync(new URL("../../lib/admin-client.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("module", "exports", "fetch", "window", "Headers", "URL", "AbortSignal", compiled)(
    compiledModule, compiledModule.exports, fetcher, browser, Headers, URL, AbortSignal,
  );
  return compiledModule.exports;
}
