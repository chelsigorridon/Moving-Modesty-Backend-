export type PaymentEnvironment = "sandbox" | "production" | "unknown";

// Never infer the environment of an old payment from today's account settings.
export function paymentEnvironmentFromProvider(provider: string | null | undefined): PaymentEnvironment {
  return provider === "payfast-production" ? "production" : provider === "payfast-sandbox" ? "sandbox" : "unknown";
}
