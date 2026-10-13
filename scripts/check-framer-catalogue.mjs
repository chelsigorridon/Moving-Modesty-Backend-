import nextEnvironment from "@next/env";
import { checkFramerCatalogueConnection, FramerCatalogueConnectionError } from "../lib/framer-catalogue-connection.ts";

nextEnvironment.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });

// Bound the standalone process as well as individual API calls. Never print raw SDK errors.
const watchdog = setTimeout(() => {
  console.error(JSON.stringify({ connected: false, readOnly: true, code: "PROCESS_TIMEOUT", message: "The check was stopped after 30 seconds. No publishing or product edits were requested." }));
  process.exit(1);
}, 30000);
try {
  const result = await checkFramerCatalogueConnection(process.env);
  console.log(JSON.stringify(result, null, 2));
  if (!result.trialReady) process.exitCode = 1;
} catch (error) {
  const safe = error instanceof FramerCatalogueConnectionError ? error : new FramerCatalogueConnectionError("CHECK_FAILED", "The read-only connection check could not finish.");
  console.error(JSON.stringify({ connected: false, readOnly: true, code: safe.code, message: safe.message }, null, 2));
  process.exitCode = 1;
} finally { clearTimeout(watchdog); }
