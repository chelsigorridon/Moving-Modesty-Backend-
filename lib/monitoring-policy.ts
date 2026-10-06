export const operations = {
  checkout_save: "checkout", checkout_recover: "checkout", payment_start: "payment",
  payment_notify: "payment", payment_return: "payment", courier_quote: "courier",
  courier_book: "courier", courier_refresh: "courier", courier_waybill: "courier",
  courier_connection: "courier", email_send: "email", email_webhook: "email",
  contact_send: "contact", admin_load: "admin", admin_update: "admin", admin_product: "admin",
  admin_auth: "admin", admin_login: "admin", admin_logout: "admin",
  server_request: "server", browser_checkout: "browser", browser_contact: "browser",
  browser_admin: "browser",
} as const;
export type Operation = keyof typeof operations;

export const errorReasons = {
  unexpected: "An unexpected application error interrupted the operation.",
  database_unavailable: "The database connection was unavailable.",
  database_query: "The database rejected a query. Check the deployed schema and constraints.",
  configuration: "A required integration setting is missing or disabled.",
  timeout: "The provider did not respond before the request timed out.",
  network: "The service could not be reached over the network.",
  provider_auth: "The provider rejected the credentials or account permissions.",
  provider_quota: "The provider rate limit, quota or account balance blocked the request.",
  provider_request: "The provider rejected the request. Review the integration settings and input.",
  provider_unavailable: "The provider returned a temporary service error.",
  payment_validation: "PayFast callback verification failed. Payment was not accepted from this callback.",
  payment_signature: "PayFast callback signature verification failed. Check the merchant passphrase and signed fields.",
  payment_source: "The callback source could not be verified as PayFast.",
  payment_amount: "The PayFast callback amount did not match the stored order amount.",
  payment_environment: "The PayFast callback credentials or environment did not match this order.",
  payment_reference: "The PayFast callback reference did not match a valid payment attempt.",
  payment_server_validation: "PayFast's server-side callback validation failed or was unavailable.",
  email_bounced: "The recipient's mail server permanently rejected the email.",
  email_complained: "The recipient reported the email as spam. Do not resend it.",
  email_suppressed: "Resend suppressed the email. Check the recipient's suppression status.",
  email_failed: "Resend reported an email delivery failure. Review the sending configuration and recipient.",
  email_delayed: "Email delivery is delayed; the provider is still attempting delivery.",
  browser_network: "A browser could not reach the API. Check connectivity, CORS and the deployed endpoint.",
  browser_timeout: "A browser request timed out before a response arrived.",
} as const;
export type ErrorCode = keyof typeof errorReasons;

// Error messages are inspected only for classification, NEVER returned or stored.
// In particular, SQL query text, provider bodies and nested causes can contain PII.
export function classifyError(error: unknown): ErrorCode {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const value = current as { name?: unknown; code?: unknown; message?: unknown; status?: unknown; cause?: unknown; stage?: unknown };
    if (value.name === "AbortError" || value.name === "TimeoutError") return "timeout";
    if (typeof value.code === "string") {
      if (/^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)$/.test(value.code)) return "database_unavailable";
      if (/^(08\d{3}|57P0[123]|53300)$/.test(value.code)) return "database_unavailable";
      if (/^[0-9A-Z]{5}$/.test(value.code)) return "database_query";
    }
    if (value.stage && value.name === "PayFastNotificationError") {
      return ({ signature: "payment_signature", source: "payment_source", amount: "payment_amount", environment: "payment_environment", reference: "payment_reference", "transaction reference": "payment_reference", "server validation": "payment_server_validation" } as Record<string, ErrorCode>)[String(value.stage)] || "payment_validation";
    }
    if (value.status === 401 || value.status === 403) return "provider_auth";
    if (value.status === 402 || value.status === 429) return "provider_quota";
    if (typeof value.status === "number" && value.status >= 500) return "provider_unavailable";
    if (typeof value.status === "number" && value.status >= 400) return "provider_request";
    if (typeof value.message === "string" && /not configured|must be configured|integration is disabled/i.test(value.message)) return "configuration";
    if (value.name === "TypeError" && typeof value.message === "string" && /fetch|network/i.test(value.message)) return "network";
    current = value.cause;
  }
  return "unexpected";
}

export function safeHttpStatus(error: unknown) {
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

export function notificationDeliveryMessage(event: string | null | undefined, template?: string) {
  switch (event) {
    case "email.bounced": return template === "paid-order-owner" || template?.startsWith("contact-")
      ? "Email bounced. Check the store notification email address before sending again."
      : "Email bounced. Contact the customer to confirm their email address before sending again.";
    case "email.complained": return "The recipient marked this email as spam. Do not resend it; contact them another way.";
    case "email.suppressed": return "Email was blocked by the provider. Contact the recipient and ask your website support to check it.";
    case "email.failed": return "Email could not be delivered. Contact the recipient another way; website support has been notified if alerts are enabled.";
    case "email.delivery_delayed": return "Delivery is delayed. The email provider is still trying; do not send a duplicate.";
    default: return undefined;
  }
}

export function incidentAction(source: string, code: string) {
  if (code === "email_bounced" || code === "email_complained" || code === "email_suppressed") return "A notification could not reach the recipient. Contact them another way.";
  if (source === "courier") return "Courier request needs attention. Check the order and Bob Go before trying to book again.";
  if (source === "payment") return "Payment needs checking. Do not fulfil the order until payment is confirmed.";
  return "A website request needs attention. Website support can investigate using the error reference.";
}
