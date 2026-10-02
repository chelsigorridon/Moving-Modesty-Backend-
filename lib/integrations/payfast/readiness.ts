export type PayFastReadinessInput = {
  enabled: boolean;
  environment: "sandbox" | "production";
  merchantId: string;
  merchantKey: string;
  passphrase: string;
  storeUrl: string;
  sourceIpValidation: boolean;
};

// Only return public availability information, never credential values.
export function evaluatePayFastReadiness(input: PayFastReadinessInput) {
  const issues: string[] = [];
  const placeholder = (value: string) => /^(?:PASTE_|REPLACE_|YOUR_|<)/i.test(value.trim());
  if (!input.enabled) issues.push("PayFast checkout is not enabled yet.");
  if (!input.merchantId || !input.merchantKey || placeholder(input.merchantId) || placeholder(input.merchantKey)) {
    issues.push("PayFast merchant credentials are incomplete.");
  }
  if (!input.passphrase || placeholder(input.passphrase)) issues.push("The PayFast passphrase is not configured.");
  try {
    if (new URL(input.storeUrl).protocol !== "https:") throw new Error("HTTPS required");
  } catch {
    issues.push("STORE_URL must be a public HTTPS address before PayFast can be enabled.");
  }
  if (input.environment === "production") {
    if (input.merchantId === "10000100" || input.merchantKey === "46f0cd694581a" ||
        (input.merchantId === "10004002" && input.merchantKey === "q1cd2rdny4a53")) {
      issues.push("Live checkout requires the live account's credentials, not PayFast's public test credentials.");
    }
    if (!input.sourceIpValidation) issues.push("PayFast source-IP validation must be enabled for live payments.");
  }
  return { available: issues.length === 0, environment: input.environment, issues };
}
