import { notFound } from "next/navigation";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import AdminPerformanceReview from "@/components/admin-performance-review";

export default async function Page() {
  if (process.env.NODE_ENV !== "development" || process.env.VERCEL_ENV) notFound();
  const source = await readFile(join(process.cwd(), "framer/AdminPortal.tsx"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  return <AdminPerformanceReview source={compiled} />;
}
