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

Until a courier is selected, delivery remains provider-neutral. Courier name, tracking number, tracking URL, delivery fee and notes are all optional fields.

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

No Framer API credentials are required by the Vercel backend. Editing a product in Framer CMS does not import it into Neon, and admin API actions do not create, update, or publish CMS collection items.

After deploying, paste the Vercel deployment URL into the **Vercel API** property on each `AdminPortal` instance in Framer.
