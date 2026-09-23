import "server-only";

export type PayFastConfiguration = {
  enabled: boolean;
  environment: "sandbox" | "production";
  merchantConfigured: boolean;
  passphraseConfigured: boolean;
};

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
