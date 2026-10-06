# Moving Modesty Admin

The administration portal for Moving Modesty. It is a Next.js application designed for Vercel, with Neon Postgres for durable data and Resend for transactional customer email.

The customer-facing site and admin interface live in the connected Framer project. This repository is the secure Vercel API layer; it keeps Neon, authentication, and Resend credentials out of Framer. Product content and collection items are managed directly in Framer CMS and are intentionally independent from the admin portal.

## Phase 1 and 2 architecture

- One Framer admin portal for order management
- Legacy Vercel dashboard pages redirect to the Framer admin
- Products are created and edited only in Framer CMS
- Stable CMS checkout SKUs for every product colour and size
- Idempotent checkout order creation after customer details
- Order updates through delivery/collection and address steps
- Server-side SKU and price validation before any order total is saved
- Secure administrator session boundary
- Neon-compatible Drizzle schema and migrations
- Resend order-status email service
- Cross-origin bearer-token API for the Framer admin component
- Full payment states: pending, paid, failed, and refunded
- Full fulfilment states, including collected and cancelled

## Shipping foundation

Checkout pricing is enforced by the backend in `lib/shipping/policy.ts`:

- nationwide door delivery: R99
- free delivery for merchandise subtotals of R1500 or more
- local collection: no delivery fee

Bob Go support is isolated under `lib/integrations/bobgo/` and shipment state is stored separately from orders in Neon. Collection orders do not create a shipment. The Framer admin order panel now provides a manual quote → review → confirm booking → waybill workflow for paid delivery orders marked Ready. The API key never goes to Framer. Quotes use the configured locker as origin and the customer's door address as destination; only courier services actually returned by Bob Go can be booked.

The public Constantia Emporium Bob Box listing is a human-facing reference only; its public location number is not treated as the Bob Go API pickup-point ID.

Enable Production with `BOBGO_ENVIRONMENT=production`, the live API token, `BOBGO_INTEGRATION_ENABLED=true`, sender contacts and verified `BOBGO_PICKUP_POINT_LOCATION_ID` / `BOBGO_PICKUP_POINT_PROVIDER_SLUG`. Constantia Emporium was verified as API location `1156`, provider `ie`; each quote rechecks location availability for the packed parcel. Existing migration `0002_past_lester.sql` provides the shipment table; this workflow needs no additional migration. Keep Preview booking disabled, especially when it shares Production's Neon database.

The admin's **Check courier connection (no booking)** performs a read-only live API check. Configuration alone is not proof that the API is reachable. A real booking can charge Bob Go credit; Zarina must approve the displayed service, quote and parcel details. Extra declared-value cover is requested by default and can only be turned off explicitly after reviewing courier terms. Final courier charges may differ from a quote. Customer delivery pricing remains R99/free at R1500 regardless of the courier quote.

Before submitting a shipment, a transaction locks the order and commits a durable Booking state with a unique reconciliation reference. Unknown responses, timeouts and Bob Go's `failed-will-retry` remain locked to prevent duplicate waybills. Use **Check shipment status**, or reconcile in Bob Go with the website administrator if the reference cannot be matched safely. Shipment records are environment-tagged so Sandbox cannot overwrite live bookings. Waybills are fetched on demand because download URLs expire. Booking does not automatically dispatch or email the customer: mark Dispatched only after locker drop-off. Tracking opens Bob Go's official tracker and displays the waybill number to enter. Automatic tracking webhooks and courier cancellation are not implemented in this flow.

### Verified parcel presets

- exactly 1 × Hawa and 1 × Amina: 25 × 20.5 × 3.5 cm, 412 g packed

Only verified combinations receive automatic parcel measurements. Single-product orders and other quantities remain blocked until their packed measurements are supplied; the backend does not estimate them.

## Local development

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local` and replace the placeholders.
3. Generate an administrator password hash with `npm run auth:hash`.
4. Start the portal with `npm run dev`.

When authentication values are missing, the portal uses a local-development-only owner session. Deployed builds fail closed and show the login setup message until `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, and `AUTH_SECRET` are configured.

## Neon

Use a pooled Neon connection string as `DATABASE_URL` in Vercel. The backend also recognises the prefixed variable names created automatically when the Vercel Neon integration is named `DATABASE_URL`. The database definition is in `lib/db/schema.ts`, and the initial migration is in `drizzle/`.

After configuring `DATABASE_URL`, apply migrations with:

```text
npm run db:migrate
```

The Phase 2 migration adds the checkout idempotency token and the `collected` order status. Apply it before enabling the checkout component against a deployed API.

## Checkout catalogue

Framer CMS remains the content editor. The public checkout sends only SKU and quantity; customer-supplied names, images, prices, subtotals, and totals are not trusted. The API resolves each SKU through `lib/checkout-catalogue.ts` and saves the authoritative product snapshot and price.

The seven current CMS product colours are included in the built-in catalogue. `CHECKOUT_CATALOGUE_JSON` can replace that catalogue in Vercel without changing the checkout code. Add the CMS “Checkout SKU” base plus one server catalogue entry per size whenever a new product is released.

## Resend

Verify the Moving Modesty sending domain in Resend, then configure `RESEND_API_KEY` and `RESEND_FROM_EMAIL`. The email service uses a stable idempotency key for each order/status combination to prevent duplicate customer updates.

### Cancellations, returns and refund records

The selected Framer order contains a single **Returns & refunds** disclosure. Cancellation remains unavailable after an outbound waybill is booked. Returns can be approved after delivery or collection; Zarina books the return manually in Bob Go, supplies her private return address directly, records the booked reference, and confirms physical receipt and inspection. Booking a return does not restock or refund the order.

Refunds are completed separately in PayFast. Only an owner/manager may record a completed refund (amount, unique PayFast reference, completion date and reason) against a verified payment, after cancellation or receipt of an approved return. The portal never transfers money. Partial refunds retain Paid status; a full refund marks the order Refunded without replacing the original verified payment audit. Recorded refunds submit a separate customer confirmation with visible notification status and eligible failed-send retries.

Restocking only reverses a recorded `order_allocated` deduction, once. The current checkout does not create these movements, so older/untracked sales must be received without automatic restocking and their stock reviewed separately. Worn or damaged items should not be restored as resaleable stock.

Release sequence: apply `0006_clever_titania.sql`, create and publish the cancellation template in **Moving Modesty's** Resend account (not Party Pop), deploy the backend, then publish the Framer portal. `email-templates/customer-order-cancelled.html` is its source; `scripts/sync-cancellation-template.mjs` safely creates/updates and publishes alias `customer-order-cancelled` without sending emails. It requires a secure account API key. `RESEND_ORDER_CANCELLED_TEMPLATE` optionally overrides that alias. Do not enable this release before the hosted template exists.

Production release verified on 6 October 2026: migration `0006` is applied with no pending migrations, the backend deployment is `dpl_6WnhY5JYYrb6omCv2Z7cpUQ22vx9`, and the Framer production version is `7e9bed752`. Resend template `customer-order-cancelled` is published in Moving Modesty's account. All 96 automated tests passed; live sign-in, order loading and the eligible completed-order return form were checked without changing an order, sending an email, booking a courier or issuing a refund.

The custom Framer `ContactForm` submits to `POST /api/contact`; it does not use Framer's native form notifications. Set `STORE_URL` to the exact published storefront origin. The endpoint validates messages, escapes email content, applies a durable five-new-submissions-per-IP-per-hour limit, and records delivery attempts in `emailEvents` without creating an order. It sends enquiries to `ORDER_NOTIFICATION_EMAIL` (default `movingmodesty@gmail.com`) with the customer's email as Reply-To. A successful submission means Resend accepted the email, not that it reached the inbox. Deploy the API before publishing the new form, then verify an enquiry in the recipient inbox.

## Live and test orders

### Administrator security and support traces

Two-factor authentication is not enabled, at the owner's request. Both sign-in paths use a shared PostgreSQL login throttle (15-minute window). Administrator sessions expire after 12 hours, contain random opaque tokens, and store only keyed token hashes in Neon. Logging out revokes the server session. Changing the configured credentials or deployment environment invalidates existing sessions. The first release of this protection requires signing in again; the email and password do not change. Authentication fails closed if session storage cannot be checked.

API browser access is restricted to the exact storefront/admin origins and the backend's own origin; add intentional extra origins through `API_ALLOWED_ORIGINS`, never a wildcard. This is not a substitute for authentication: admin routes still require a valid session, and PayFast/Resend notifications require provider verification. API responses are non-cacheable and carry restrictive security headers.

Every live order has one collapsed **Support details** section. It loads `GET /api/admin/orders/[orderNumber]/trace` on demand and combines the latest payment/courier references, email events, recent status changes and privacy-safe error references. It does not change the order, send an email or book a shipment. Missing callbacks or missing error records are not proof of successful payment; check the provider dashboard when needed. Archived orders are excluded.

Create a delivery-event webhook in Moving Modesty's Resend account pointing to `https://movingmodesty.vercel.app/api/webhooks/resend`, select email sent/delivered/delivery-delayed/bounced/complained/failed/suppressed events, and securely enter its signing secret as Production `RESEND_WEBHOOK_SECRET` in Vercel before redeploying. Without this connection, Submitted does not mean Delivered. Never post the signing secret in chat or commit it.

Technical alerts go to `ERROR_ALERT_EMAIL` (default `moody.tech@gmail.com`). Repeated causes are grouped and capped at five email alerts per hour. Database outages still produce redacted Vercel log references, but cannot persist incidents or send database-backed alerts; use an independent availability monitor for that separate failure mode. `scripts/check-security-setup.mjs` provides a read-only, credential-free setup report when run with securely supplied deployment environment values.

New PayFast checkouts persist `payfast-production` or `payfast-sandbox` on the payment record. The admin dashboard excludes known sandbox payments and older unclassified payments from live paid sales. Legacy `payfast` records are deliberately unclassified; verify them in PayFast before fulfilment instead of treating the current environment setting as proof that an old payment was live.

Sandbox payments cannot request production Bob Go quotes or create live courier bookings. Courier booking remains a manual, confirmed action for paid, packed delivery orders. Do not treat configuration checks or automated tests as proof of a successful live payment, email delivery, or courier shipment.

## PayFast

The PayFast flow is guarded by `PAYFAST_INTEGRATION_ENABLED`. The checkout endpoint loads the order by its private checkout token, recalculates the current server-side catalogue total, signs the hosted-payment form, and never accepts a browser-supplied amount. The notification endpoint verifies the signature, merchant ID, source IP, stored order total, and PayFast validation response before marking an order paid. A browser return does not confirm payment.

For live checkout, set Production `PAYFAST_ENVIRONMENT=production`, `PAYFAST_INTEGRATION_ENABLED=true` and `PAYFAST_SOURCE_IP_VALIDATION=true`, with the verified merchant's live ID, key and matching passphrase stored only in Vercel. Keep Preview and Development isolated from live payments. Redeploy the exact committed build and verify `GET /api/payments/payfast/checkout` reports `available: true` and `environment: production`; this read-only preflight exposes no credentials and creates no orders. It checks configuration, not PayFast account ownership or payment acceptance. Zarina must complete a real delivery checkout herself, verify the paid order in Neon/admin and both confirmation emails, then manually quote and approve the Bob Go waybill. Live test payments and waybills can incur real fees. Historical sandbox orders are not real sales and must not be fulfilled.

Apply migration `0003_slippery_pet_avengers.sql` before enabling PayFast. Test with sandbox-only credentials in a non-production Vercel environment first. Keep the Production switch `false` until a complete sandbox payment, cancellation, duplicate notification, and failed-payment run have all passed.

## Vercel environment values

- `DATABASE_URL`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD_HASH`
- `AUTH_SECRET`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `STORE_URL`
- `FRAMER_ADMIN_URL`
- `CHECKOUT_CATALOGUE_JSON` (optional override)
- `BOBGO_INTEGRATION_ENABLED` (Production `true` only after sandbox sign-off; Preview stays `false`)
- `BOBGO_ENVIRONMENT`
- `BOBGO_API_TOKEN`
- `BOBGO_SENDER_NAME`
- `BOBGO_SENDER_EMAIL`
- `BOBGO_SENDER_PHONE`
- `BOBGO_SENDER_LOCATION_NAME`
- `BOBGO_PICKUP_POINT_LOCATION_ID`
- `BOBGO_PICKUP_POINT_PROVIDER_SLUG`
- `PAYFAST_INTEGRATION_ENABLED` (keep `false` until account verification)
- `PAYFAST_ENVIRONMENT`
- `PAYFAST_MERCHANT_ID`
- `PAYFAST_MERCHANT_KEY`
- `PAYFAST_PASSPHRASE`
- `PAYFAST_SOURCE_IP_VALIDATION` (keep `true` in production)

No Framer API credentials are required by the Vercel backend. Editing a product in Framer CMS does not import it into Neon, and admin API actions do not create, update, or publish CMS collection items.

After deploying, paste the Vercel deployment URL into the **Vercel API** property on each `AdminPortal` instance in Framer.
