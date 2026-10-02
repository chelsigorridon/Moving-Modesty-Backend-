import "server-only";
import { evaluatePayFastReadiness } from "./readiness";

export type PayFastConfiguration = {
  enabled: boolean;
  environment: "sandbox" | "production";
  merchantConfigured: boolean;
  passphraseConfigured: boolean;
};

export type PayFastRuntimeConfiguration = PayFastConfiguration & {
  merchantId: string;
  merchantKey: string;
  passphrase: string;
  processUrl: string;
  validationUrl: string;
  storeUrl: string;
  enforceSourceIp: boolean;
};

const PAYFAST_URLS = {
  sandbox: {
    process: "https://sandbox.payfast.co.za/eng/process",
    validation: "https://sandbox.payfast.co.za/eng/query/validate",
  },
  production: {
    process: "https://www.payfast.co.za/eng/process",
    validation: "https://www.payfast.co.za/eng/query/validate",
  },
} as const;

export function getPayFastConfiguration(): PayFastConfiguration {
  return {
    enabled: process.env.PAYFAST_INTEGRATION_ENABLED === "true",
    environment: process.env.PAYFAST_ENVIRONMENT === "production" ? "production" : "sandbox",
    merchantConfigured: Boolean(
      process.env.PAYFAST_MERCHANT_ID?.trim() && process.env.PAYFAST_MERCHANT_KEY?.trim(),
    ),
    passphraseConfigured: Boolean(process.env.PAYFAST_PASSPHRASE?.trim()),
  };
}

export function requirePayFastConfiguration(): PayFastRuntimeConfiguration {
  const configuration = getPayFastConfiguration();
  const merchantId = process.env.PAYFAST_MERCHANT_ID?.trim() ?? "";
  const merchantKey = process.env.PAYFAST_MERCHANT_KEY?.trim() ?? "";
  const passphrase = process.env.PAYFAST_PASSPHRASE?.trim() ?? "";
  const storeUrl = process.env.STORE_URL?.trim().replace(/\/$/, "") ?? "";

  const readiness = getPayFastCheckoutReadiness();
  if (!readiness.available) throw new Error(readiness.issues[0]);

  return {
    ...configuration,
    merchantId,
    merchantKey,
    passphrase,
    processUrl: PAYFAST_URLS[configuration.environment].process,
    validationUrl: PAYFAST_URLS[configuration.environment].validation,
    storeUrl,
    // PayFast's sandbox is isolated test infrastructure and can originate from
    // addresses outside the live payment ranges. Keep the source-IP check for
    // real payments; sandbox callbacks are still protected by their signature,
    // merchant ID, order amount, and PayFast's server-to-server validation.
    enforceSourceIp:
      configuration.environment === "production" &&
      process.env.PAYFAST_SOURCE_IP_VALIDATION !== "false",
  };
}

export function getPayFastCheckoutReadiness() {
  const configuration = getPayFastConfiguration();
  return evaluatePayFastReadiness({
    enabled: configuration.enabled,
    environment: configuration.environment,
    merchantId: process.env.PAYFAST_MERCHANT_ID?.trim() ?? "",
    merchantKey: process.env.PAYFAST_MERCHANT_KEY?.trim() ?? "",
    passphrase: process.env.PAYFAST_PASSPHRASE?.trim() ?? "",
    storeUrl: process.env.STORE_URL?.trim() ?? "",
    sourceIpValidation: process.env.PAYFAST_SOURCE_IP_VALIDATION !== "false",
  });
}
