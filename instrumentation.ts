import type { Instrumentation } from "next";

export const onRequestError: Instrumentation.onRequestError = async error => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportFailure } = await import("./lib/monitoring");
    // Deliberately omit request headers, full URLs, bodies, stacks and React digests.
    await reportFailure(error, { operation: "server_request" });
  }
};
