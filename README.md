# Moving Modesty Admin

The administration portal for Moving Modesty. It is a Next.js application designed for Vercel, with Neon Postgres for durable data and Resend for transactional customer email.

The customer-facing site and admin interface live in the connected Framer project. This repository is the secure Vercel API layer; it keeps Neon, authentication, and Resend credentials out of Framer. The authenticated admin Products editor saves drafts in Neon and explicitly publishes product content to Framer CMS through a private server-only connection. Direct CMS edits are conflict-checked rather than silently imported into checkout.

## Phase 1 and 2 architecture

- One Framer admin portal for order management
- Legacy Vercel dashboard pages redirect to the Framer admin
- Products are managed in the admin Products editor and published to Framer CMS
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
- free delivery for merchandise subtotals of R1200 or more
- local collection: no delivery fee

Bob Go support is isolated under `lib/integrations/bobgo/` and shipment state is stored separately from orders in Neon. Collection orders do not create a shipment. **The chosen workflow is direct portal booking, not sales-channel order copying.** Zarina checks the delivery details and parcel, compares eligible courier quotes, selects a service, explicitly approves its cost, books, and downloads the waybill from the existing admin portal. No pre-existing Bob Go order is needed. The API key never goes to Framer. The retained legacy route uses the configured locker. Delivery management adds per-order sender/recipient addresses, locker/counter options, instructions and private notes. Door-to-door requests do not filter couriers; pickup-point routes retain their verified point provider. Only services actually returned by Bob Go can be booked. The signed quote preserves its numeric rate-request ID as `selected_rate_request_id`; this associates the booking with its quote, not with a sales-channel order. First name and surname are submitted separately.

### Direct delivery updates (release preparation)

Apply additive migration `0016_bobgo_direct_delivery.sql` before deploying this change; this adds a private notification inbox and an informational courier-charged amount, with no changes to customer payments or stock. No production migration, subscription, scheduler or booking is performed by the test suite. Sales-channel sync remains hard-off, including when delivery updates are enabled. Existing mirrored/uncertain-import guards stay in place; these shipments are not presented as fulfilments of a Bob Go sales-channel order.

`POST /api/webhooks/bobgo` is opt-in with `BOBGO_DELIVERY_UPDATES_ENABLED=true` and the account's `BOBGO_WEBHOOK_SECRET` stored only in Production. Read the secret privately from Bob Go Settings → Webhook subscriptions; do not regenerate an existing secret without coordinating other consumers. Register the HTTPS backend route for `tracking/updated`, `shipment_submission_status/updated` and `shipment_charged_amount/updated`; weight/health notifications are also accepted. Check existing subscriptions first to avoid duplicates. Registration and activation require a separate live-configuration step. The endpoint verifies HMAC-SHA256 over bounded raw request bytes, using the literal secret and `bobgo-webhook-signature`. It filters topics and known environment-tagged shipments, stores only a deduplicated identifier job (not customer payloads), then acknowledges before processing with Next.js `after`.

Notifications trigger **GET-only** shipment read-back with the existing manual-booking API token; callback-provided status is never trusted directly. Known shipment ID, tracking reference, selected provider and service must agree. The portal stores courier status and actual charged amount independently of fulfilment/payment. Delivered status cannot regress to in-transit. Nothing in this path creates orders, books/cancels a courier, refunds a payment, changes stock, marks an order dispatched/delivered or sends emails. Failures retain a retryable durable job, bounded exponential backoff and sanitized operational diagnostics.

For recovery, configure a trusted recurring GET to `/api/internal/bobgo-delivery` with `Authorization: Bearer <CRON_SECRET>` (32+ characters). This separate delivery runner does not call the order-import runner. It drains at most two jobs and checks at most one due nonterminal shipment, using read-only provider requests. Deploying does not install a scheduler. Manual **Check shipment status** also works with sales-channel sync off and uses the same verified read-back. Keep automatic delivery updates disabled until the migration, secret, subscriptions and recovery schedule are configured. The first real booking remains an owner-approved action with a real courier cost—not an automated test. Local tests cannot prove successful live courier acceptance.

Protocol references: [direct shipping](https://developer.bobgo.co.za/getting-started/), [shipment creation](https://developer.bobgo.co.za/shipments/shipment-create/), [shipment lookup](https://developer.bobgo.co.za/shipments/shipment-list/), and [signed webhooks](https://developer.bobgo.co.za/webhooks/).

The public Constantia Emporium Bob Box listing is a human-facing reference only; its public location number is not treated as the Bob Go API pickup-point ID.

Existing manual Production booking uses `BOBGO_ENVIRONMENT=production`, the live API token and `BOBGO_INTEGRATION_ENABLED=true`. Legacy bookings also require sender contacts and verified `BOBGO_PICKUP_POINT_LOCATION_ID` / `BOBGO_PICKUP_POINT_PROVIDER_SLUG`. Constantia Emporium was verified as API location `1156`, provider `ie`; each pickup-point quote rechecks availability for the packed parcel. Apply additive migrations `0011`–`0015` before deploying this delivery release. Keep Preview booking disabled, especially when it shares Production's Neon database. Publishing this release must not enable automatic order sync or install a scheduler.

The reviewed **Check courier connection (no booking)** reads account access with `GET /orders?limit=1&offset=0`, returning no order/customer data. It is independent of a specific locker and does not prove quote availability, create permissions or sales-channel synchronisation. Configuration alone is not proof that the API is reachable. A real booking can charge Bob Go credit; Zarina must approve the service, quote and parcel details. The portal requests no additional declared-value cover. Final courier charges may differ from a quote. Customer delivery pricing remains R99/free at R1200 regardless of the courier quote.

Before submitting a shipment, a transaction locks the order and commits a durable Booking state with a unique reconciliation reference. Unknown responses, timeouts and Bob Go's `failed-will-retry` remain locked to prevent duplicate waybills. Use **Check shipment status**, or reconcile in Bob Go with the website administrator if the reference cannot be matched safely. Shipment records are environment-tagged so Sandbox cannot overwrite live bookings. Waybills are fetched on demand because download URLs expire. Booking does not automatically dispatch or email the customer: mark Dispatched only after physical handover using the booked collection method. Tracking opens Bob Go's official tracker and displays the waybill number to enter. Automatic tracking webhooks and courier cancellation are not active. Private notes never reach Bob Go; booked-waybill address/courier amendments remain a provider-confirmed process, not a local edit.

### Simplified delivery flow

The shared editor starts with sender/customer summaries, using the saved collection endpoint and checkout address. Change only one side at a time, or confirm the existing details. Optional instructions and private notes remain collapsed. Confirm details before the package step; editing invalidates old quotes. Silent browser autofill is captured from the component's own form before checkbox-triggered rerenders and on submit.

**Check details → choose packed parcel → compare courier quotes → confirm booking → print waybill.** Saved dimensions are loaded on demand with authenticated `GET /api/admin/bobgo/packages`; no package is created, changed or selected automatically. Unsupported responses fail visibly and custom dimensions remain available. A saved package never supplies actual parcel weight from its volumetric figure. The confirmed weight always includes the packaging.

Account → Delivery settings includes a collapsed one-time product-weight editor. Authenticated `GET/PATCH /api/admin/bobgo/weights` stores measured individual variant weights, supports clearing an unknown weight, rejects stale updates and records old/new weights and owner in `shipping_weight_history`. It never changes stock, payment, CMS product information or the sync gate. These are individual item weights, not the packed-parcel measurements used for booking.

### Prepared order-sync backend — hard disabled

This retained integration is **not part of the selected direct-booking workflow**. Its historical acceptance requirements below apply only if sales-channel order copying is revisited. Direct booking and its separately gated delivery updates do not require it, a new API key, or existing orders.

`getOrderSyncConfiguration()` is deliberately hard-disabled, with no environment-variable activation override. The server-only HTTP adapter, bounded background runner and support retry route are implemented but cannot run through this gate. No scheduler is installed and no public Bob Go webhook is registered or accepted. Existing manual courier booking remains separate. The verified PayFast transaction calls the outbox enqueue helper, which returns before database/provider access while disabled. Adding credentials, applying migrations or deploying alone does not activate sync.

The tested service factory accepts an isolated provider adapter. It provides one durable job per order/environment/channel, measured per-item weights, strict monetary/address/recipient reconciliation, bounded retries, leases, and a committed submission guard. A timed-out create is reconciled by reference and is never blindly repeated, even when an immediate lookup is empty. Order changes after submission require attention rather than silently changing the provider copy. New copies of already-booked/completed orders are blocked. No payment, stock, email or waybill writes are performed by the sync service. Tracking uses an authenticated provider read-back of the recorded shipment ID/reference; it stores courier-reported progress separately without altering the internal fulfilment workflow.

The prepared transport uses a separate channel token **and `bobgo-channel-identifier` header**, fixed Bob Go Sandbox/Production hosts, bounded response bodies/timeouts, no redirects, exact-reference lookup across active and archived orders, and sanitized errors. Unknown response envelopes fail closed rather than being treated as an empty lookup. There are no shipment-create/cancel, email, stock or payment operations in this adapter. Sandbox acceptance must verify its actual response envelopes, including archived lookups.

Waybill read-back uses the numeric ID of an already-verified Bob Go order with `GET /order-fulfillments?order_id=…`, followed by `GET /shipments?id=…`. A single full, successful outbound shipment must match the order's item IDs/quantities, waybill reference, address and recipient. Unknown, partial, split, return, cancelled or conflicting fulfilments require attention rather than replacing the portal's one outbound shipment slot. A unique provider/shipment index prevents one remote shipment being attached to two website orders. Linking writes only the existing waybill/tracking metadata and one audit note, never payment, stock, internal fulfilment status, email or a provider booking. The runner discovers at most two due links per invocation, only from its channel's existing synced outbox rows. It does not scan historical orders. The same hard-off gate prevents all link processing while automatic sync is disabled.

**After future activation, book a synced order from that order in Bob Go, not as a separate shipment in this portal.** The public shipment-create example does not document an order attachment field, so this release does not invent one. Portal quote/booking guards reject mirrored or uncertain-submission orders (even if an old quote exists or sync is later paused); today's unsynced orders keep manual portal booking unchanged. Bob Go's existing fulfilment then supplies the authoritative link back. Independent portal-booked shipments are not claimed to fulfil an imported Bob Go order.

`GET /api/internal/bobgo-sync` requires a server-side `CRON_SECRET` of at least 32 characters in its Bearer authorization header; it is not a browser/session endpoint. While disabled it returns 503 without touching the database or provider. The runner handles at most two due channel-scoped outbox jobs, two existing-waybill link checks and two known-shipment tracking checks per invocation, respects time budgets/leases/backoff, and never scans historical paid orders for import. Tracking polling is fair, avoids terminal shipments and updates only separate courier status—not payment, fulfilment, stock or email. Authenticated `POST /api/admin/orders/:orderNumber/bobgo-sync` with `{action:"retry",confirm:true}` can requeue an existing job after activation, but never clears its uncertain-submission guard. `{action:"check_waybill",confirm:true}` only reads existing provider records and records a verified link; it cannot enqueue/create an order or book delivery. Both remain unavailable while disabled. Error tracing uses `courier_sync` / `courier_tracking` without storing provider bodies or secrets.

Recorded merchandise discounts are mapped proportionally in exact integer cents, using largest-remainder allocation. A quantity may be split into two same-SKU price tiers when an exact cent unit price requires it. Quantities, weights and the paid merchandise total reconcile exactly; delivery is not discounted. Acceptance must confirm how Bob Go returns/displays these price tiers before activation.

Before activation: verify `STORE_URL` is Zarina's final HTTPS domain and its hostname exactly matches the sales-channel identifier; privately configure `BOBGO_ORDER_SYNC_API_TOKEN`, `BOBGO_ORDER_SYNC_CHANNEL_REF` and `CRON_SECRET` in Production (do not replace the existing manual-booking token). Supply verified individual weights. Confirm channel scope, response shapes, discounted totals, address changes after sync, and the complete order-to-existing-fulfilment-to-waybill read-back in Sandbox. Offline tests are not a live fulfilment acceptance test. Keep Bob Go's automatic fulfilment rules off so an order copy cannot cause a chargeable booking. There is no booked-waybill amendment or automatic cancellation implementation.

After these checks and a separately approved activation release, connect a trusted scheduler to the protected runner. Verify the hosting plan supports the chosen frequency and execution duration; no frequent Vercel cron is assumed or installed here. Scheduled authenticated polling supplies tracking read-back without depending on an unverified webhook signature scheme. A future webhook can accelerate that process only after Bob Go's authentication contract is confirmed. Do not treat simulated tests or the offline `/delivery-review` page as live API verification.

API contract reviewed: [Bob Go v1.0.7](https://api-docs.bob.co.za/bobgo). Runner authentication follows [Vercel's cron security guidance](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs), with a stricter local 32-character minimum. No credentials or real order data are needed for the automated tests.

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

The original backend did not need Framer API credentials. The current live product-management feature requires a private project-specific `FRAMER_API_KEY` in Vercel; it is never exposed in browser properties. Editing CMS directly does not automatically import it into Neon. The isolated local TEST connection below is historical and separate from the live Products editor.

## Reversible product-management trial

Branch `codex/product-catalogue-trial` adds a local, clearly labelled product editor at `/product-trial`. This route is available only in development and returns 404 in production. Its Amina/Hawa examples are copies of the current checkout catalogue, not an import of the complete CMS photo galleries or descriptions. Demo edits and photo previews stay in the browser window; refreshing discards them. No demo action calls checkout, payments, courier bookings, emails or Framer.

Migration `0008` adds only `catalogue_drafts`. It was subsequently applied alongside `0009` for the live product-management release below; the trial API remains disabled in production. The authenticated `/api/admin/catalogue` draft API is disabled by default; enable `PRODUCT_CATALOGUE_TRIAL_ENABLED=true` only in an isolated Preview database after applying the migration there. It validates prices, quantities, colours, sizes and HTTPS image addresses, generates stable variant codes, and rejects stale saves, duplicate page addresses and cross-product identifier collisions. Draft revisions are entirely separate from existing live products/inventory/orders.

The demo now uses three steps: **Product details → Colours & photos → Preview**, ending with **Save demo product**. Shared sizes/prices carry across to new colours, deliberately different prices are retained, and the first colour photo becomes the collection image automatically. Existing products open three collapsed sections for details, photos and stock, with a separate preview and **Save demo changes**. Page addresses, display order and technical publishing controls are hidden. Friendly errors appear beside the relevant fields. These changes do not enable live publication.

The editor supports draft content, per-colour photos, per-size price/availability/stock inputs, and illustrative product/homepage previews. Its connected mode saves drafts to the database; permanent photo uploading is not connected yet. Live publication is intentionally disabled and is never reported as successful. This is the first trial stage, **not** a completed CMS migration or a replacement checkout catalogue.

### Permanent Framer connection proof (read-only)

`npm run framer:check` uses the official `framer-api` SDK, not the agent/editor session. Put `FRAMER_CATALOGUE_PROBE_ENABLED=true`, the project URL from `.env.example`, and a private project-specific `FRAMER_API_KEY` in the ignored `.env.local` file. Create the key yourself in the Moving Modesty project's Site Settings → General → Server API; never paste it into chat, commit it, or expose it in a browser property. Production execution is blocked.

The check connects, reads only `CatalogueTrial` and `CatalogueTrialColours`, verifies the TEST Noor record, colour references, expected field types and draft status, then disconnects. It prints safe diagnostics and fails if the isolated test cannot be verified. It does not publish, update CMS records, change draft status, access Neon, send emails, or touch stock/orders/payments. A successful read is **not** proof of automatic CMS saving, product-page publication or checkout for new variants. Those remain separate rollout gates.

### Connected TEST draft saving (local only)

After the read-only connection passes, `FRAMER_CATALOGUE_DRAFT_SAVE_ENABLED=true` switches the existing local `/product-trial` editor to **TEST Noor only**. The first connected step edits name, description and tagline; images, prices, colours, sizes, stock and collection placement stay read-only. The previous browser-only add-product demo remains available when this flag is false. Do not enable this flag in Vercel: both Production and Preview are explicitly blocked.

`GET/POST /api/product-trial/framer` requires loopback Host, matching local port, same browser origin for writes, JSON and the development-only opt-in. Next.js may use `localhost` internally while the browser uses `127.0.0.1`; both must be loopback. Add only the exact local development origin to `API_ALLOWED_ORIGINS` in ignored `.env.development.local` (currently `http://127.0.0.1:3012,http://localhost:3012`). No production origin rules or admin authentication routes are changed.

The server key never enters the client. The server pins the verified project and isolated collections, checks field types and references, requires the exact three expected records to remain drafts, and permits only the fixed TEST family item’s three text fields. Each write explicitly preserves `draft: true`: the real Server API cleared the draft flag when it was omitted, which the read-back check detected during testing. It never allows the browser to change that flag or slug, add/delete records, publish, touch Neon, send mail or call checkout. `TEST` and `UNPUBLISHED TEST` labels are required. The CMS snapshot version rejects stale editor saves; a single-instance save lock prevents overlapping local saves. Framer offers no cross-system transaction/conditional-write guarantee here, so this is not yet a production concurrency design.

Success requires reading the saved values back from Framer. Timeout, uncertain write outcome, failed verification or session-close failure leaves edits in the editor and asks for a reload instead of claiming success or automatically retrying. If CMS was edited in another window, preserve those edits and reload before retrying.

Verified on 8 October 2026: a real local API save and a browser **Save draft** submission persisted the TEST description. Reopening the editor and a fresh Server API read returned the saved text; the product, both colours and both trial pages remained drafts. The first omitted-draft failure was repaired without publication. See `fixtures/catalogue-test-result.json` for the proof and remaining rollout limits. The suite passed 147 tests, with TypeScript, targeted lint and the production build clean.

### Published storefront proof (temporary TEST)

Later on 8 October 2026, the user explicitly approved temporarily publishing the **TEST — NOT FOR SALE** card and product page. Version `3177a496d` adds one CMS-backed TEST card inside the actual homepage collection at `https://holistic-brand-492217.framer.app/#collection`, linking to `/catalogue-trial/test-noor-active-hijab`. Existing Amina/Hawa data, cards and page links were preserved. The standalone `/catalogue-trial` collection page remains a draft, and the product page is no-index.

The published card link and a full product-page reload were verified, with homepage and product-page layouts checked at desktop (1280px), tablet (900px) and mobile (390px). The product shows two referenced colours, illustrative sizes and clearly labelled existing Amina photographs as placeholders. Purchasing is disabled. No orders, Neon changes, stock changes, emails, payments or courier bookings were performed.

Collection placement rule (user confirmed): preserve Amina on the left and Hawa on the right, then fill subsequent product rows **left to right**, starting underneath Amina. Do not use masonry for this collection: even small card-height differences can send the third card to the right. Framer version `6661819ee` disables masonry on the desktop/tablet Products grid and makes the CatalogueTrial list span a full row with its own two-column, non-masonry grid (40px desktop / 32px tablet gaps). Both lists remain vertical stacks on mobile. The single TEST card retains the original card width and appears on the left. Carry this same row-major rule into the eventual unified product list; this layout change does not enable the production Add product workflow.

Product-page design follow-up: Framer version `e88bf8c5c` matches the CatalogueTrial CMS detail template to the existing Amina/Hawa introduction, card borders/padding, name/price presets and responsive spacing. Desktop uses their 648px two-column grid, 300px cards, 48px gap and 276px square photos. The existing `CMSProductCarousel` renders the CMS cover image; a single photo correctly has no gallery arrows/dots. `framer/CatalogueTrialPurchasePreview.tsx` mirrors the existing size field and button styling but is permanently non-purchasable: its only interaction is selecting an illustrative CMS size in local React state. It has no SKU, cart handler, network request or checkout link. The TEST disclaimer, no-index setting and disabled local draft writer remain intact. Framer type checking and publish diagnostics were clean. Published desktop measurements and the Small → Large selection were checked; tablet/mobile Framer breakpoint screenshots were reviewed. The browser viewport override did not resize the live browser during this follow-up, so no new live mobile-browser verification is claimed. Existing Amina/Hawa pages, Home, shared layout, CMS records and backend were not changed. Product-specific details and wearing guides are not duplicated into the TEST page.

Historical public-test removal: at the user's request, version `afb8a505e` hid TEST Noor and returned its records/pages to draft, while preserving them for that trial. The homepage had only Amina/Hawa collection links, and the old TEST URL showed 404. The later two-collection consolidation removed those unused native test records/pages after backup. Earlier trial screenshots are historical proof, not the current live state.

`FRAMER_CATALOGUE_DRAFT_SAVE_ENABLED` remains **false** locally. Do not automatically re-enable the local writer or republish the retained TEST records.

### Live product management

The authenticated Framer `/admin/products` portal now embeds the same simple three-step editor. `PRODUCT_MANAGEMENT_ENABLED=true` activates `/api/admin/product-catalogue`, permanent photo uploads, safe draft saving and explicit publication. Migrations `0008` and `0009` have been applied to the linked production database; Amina and Hawa were imported with all seven colour cards, 11 size variants and existing checkout SKU aliases preserved.

Neon `catalogue_products.document` stores private drafts; `published_document` and real `product_variants` power checkout. Saving a draft does not change saleable prices, quantities or CMS content. Publishing updates the consolidated Products CMS collection and the shared `/collection/:slug` page template, then commits checkout prices and availability. Existing `/amina` and `/hawa` remain in place. Homepage cards use the existing collection list and family order, not a separate demo section.

Publishing rejects stale revisions, inventory changes and direct conflicting CMS edits. It will not publish unrelated pending Framer work. An uncertain publication pauses checkout for that product and records `needs_review`; support must reconcile CMS and inventory before releasing it. Do not manually clear that state without checking both systems. Framer credentials remain server-only. No automatic emails, payments or waybill bookings are triggered by product edits.

Existing zero-stock records were marked **not yet counted** before this feature. Their unverified state is preserved rather than inventing quantities or unexpectedly disabling the store. Entering a real stock count enables enforced reservations and one-time deductions after verified PayFast payment. New variants require stock quantities and enforce zero-stock availability immediately. New parcel combinations still require verified package measurements before courier booking.

`node scripts/build-framer-product-editor.mjs` bundles the shared editor into the single-file Framer component. `scripts/manage-live-catalogue.mjs --migrate --import` performs the scoped additive setup using ignored local credentials; it does not publish products or submit orders. The obsolete TEST CMS collections/pages were removed during the backed-up consolidation below; the local trial source remains historical, not a live publishing path.

### Two-collection CMS consolidation — 12 October 2026

The live CMS now has exactly **Products** and **Customer Reviews**. Products retains the seven original colour records and contains two additional page-information records for Amina/Hawa. `Is Product Page=true` identifies page information; colour/homepage lists explicitly exclude it. Shared page fields live on these information records, while colour images, prices and checkout SKU aliases retain their existing records. Do not recreate ProductCatalogue or the two trial collections by default.

Both existing detail templates now use Products: `/products/:slug` for individual colours and `/collection/:slug` for product families. Existing Home, `/amina`, `/hawa`, product URLs, responsive geometry and typography were preserved. Unlinked wrong-role detail URLs are no-index. The unused hidden shop and TEST draft pages were removed; no real product page was removed.

The backend bridge supports `metadata.cmsLayout="products-v1"`, separates information records from purchase records, and retains conflict/preflight protections. A guarded one-time reconciliation changed only Amina/Hawa's CMS mapping metadata in Neon, not documents, revisions, prices, stock, availability or orders. Original CMS/page and catalogue/inventory backups plus the post-migration snapshot are in ignored `.tmp/cms-consolidation-20261012/`; they must not be committed. `scripts/consolidate-cms-metadata.mjs` validates those safeguards and requires explicit `--reconcile` for writes. It is an operational migration tool, not a routine product-management command.

Framer production version `bfca63155` and backend deployment `dpl_6wdeDi6eoVPwj68AFYc9v7LHrysH` were verified. All 174 automated tests, TypeScript, targeted lint and the isolated production build passed. Home/Amina/Hawa were compared at 1280/820/390px; original family/colour URLs and fresh authenticated Products loading were checked without submitting orders, sending emails, taking payments or booking couriers. The production dependency audit reported zero vulnerabilities.

Remaining operational setup: Zarina must reconcile real stock counts rather than relying on legacy uncounted quantities, and new product combinations require verified parcel measurements before courier booking. Keep existing Amina/Hawa paths, colour slugs and legacy checkout SKUs. Do not invent stock or substitute generated trial identifiers. The live editor, imports, uploads, CMS publication, checkout integration and preflight/concurrency protections described above supersede the original trial rollout gates.

Rollback of the local editor: keep its trial feature flags disabled; saved Neon trial drafts remain separate. Native TEST collections/pages no longer exist in the current CMS. If an explicit recovery is requested, use the migration backups and review dependencies before restoring anything; do not recreate extra collections on the Basic plan automatically. No checkout rollback was required for removal of the public TEST proof.

After deploying, paste the Vercel deployment URL into the **Vercel API** property on each `AdminPortal` instance in Framer.

### Discounts — live rollout (9 October 2026)

`/discount-review` is a development-only, isolated layout review. It starts empty,
uses the shared Discounts editor, and keeps edits in React memory only. Refreshing
removes its sample codes. Its customer checkout preview uses the real product
discount calculation but never contacts Neon, PayFast, Framer or Resend. It returns
404 outside development. It is not the live admin portal.

The implementation adds authenticated `/api/admin/discounts`, a read-only public
`/api/checkout/discount` quote, and server-validated discount snapshots on orders.
Owners/managers can create, rename, edit and switch a shared code ON/OFF. New
discounts default OFF with no predefined campaign/code/value. Optional dates,
minimum spend and selected products are supported. One code applies per order;
product prices and delivery charges are separate. The R1,200 free-delivery
threshold uses the product subtotal before discounts. Zero-total/free-product
checkouts are deliberately rejected because this workflow requires PayFast.

Migration `0010_glamorous_cargill.sql` is additive: discount rules and change
history, plus a default zero discount and nullable snapshot on existing orders.
It does not create any discount codes. Payment-start revalidates availability and
the saved amount. A submitted payment keeps its snapshot for retries even if
Zarina later disables/renames the code; changed checkout contents require a new
checkout. Paid/closed orders cannot be rewritten. Order details, recovery and
payment emails use the saved snapshot, not the current editable promotion.
Existing hosted Resend template variables are reused, so no unapproved template
change or live email is needed for this feature.

The approved additive migration 0010 is applied in production Neon, with all 11
migration hashes verified. `DISCOUNTS_ENABLED=true` is set in Vercel Production.
Final verification found zero discount codes, zero active codes and the same six
existing orders. No order, payment, email or courier booking was created.

The backend was deployed from the explicit scoped bundle prepared by
`scripts/prepare-discounts-release.ps1`, based on Git HEAD plus the reviewed
Discounts files and dependencies already needed by the live product editor.
Unrelated product-trial routes, design assets and drafts were not deployed.
The final production deployment is `dpl_8fP1Y7RaEVaxnrhCNLuqKMQsrBmn` at
`https://movingmodesty.vercel.app`. This rollout did not commit or push Git changes.

Framer production version `3fc18b11f` includes `/admin/discounts`, the shared admin
navigation link and the checkout Discounts control on desktop/tablet/mobile.
`AdminPortal`, `CheckoutOrderSummary` and `CheckoutSlider` were uploaded and
type-checked. An initial live loading failure revealed an unnecessary cross-site
cookie request; the shared manager now uses `credentials: "same-origin"` and the
existing Framer bearer session, without broadening CORS. A regression test covers
GET and POST authentication. The live authenticated page loads successfully,
starts empty, opens a blank OFF form, and is accessible from the responsive menu.

`node scripts/build-framer-discounts.mjs` keeps the shared review/Framer editor
in sync. Leave the real list empty unless Zarina deliberately creates a code.
Turning the feature flag off rejects new discount applications but does not
change an already submitted payment's amount.

Local verification passed 157 tests, targeted ESLint, TypeScript and the production
build. A OneDrive lock prevented rebuilding the existing `.next` cache; the final
build used `MM_DISCOUNT_REVIEW_BUILD=true` to put output in the ignored
`.tmp/discount-review-build` directory instead. Normal/Vercel builds keep `.next`.
The compiled review page was verified as a 404 in production. Desktop, 820px
tablet and 390px mobile layouts were checked, including the mobile Menu, blank
OFF form and absence of horizontal overflow. All 108 scoped release tests and
the production build also pass with the approved Next.js/eslint-config-next 16.3.8
security patch. `npm audit --omit=dev` reports zero known production dependency
vulnerabilities; development-tool advisories remain outside this patch's scope.
Live checks confirm the admin API rejects unauthenticated access, CORS permits
the expected storefront origin without a wildcard, existing Amina pricing still loads, and an
unknown code produces an honest validation error without changing the cart total.
The customer code field was checked at desktop, 820px tablet and 390px mobile;
mobile/tablet customers open the order summary to access it. The temporary added
cart item was removed, preserving the original basket. Live code creation and
actual payment settlement still require a deliberate user-led test. Repository-wide
lint still reports four pre-existing CommonJS-import errors in the unrelated
logo-tracing script; discount changes pass their targeted lint check.
