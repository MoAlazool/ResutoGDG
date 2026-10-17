# Resuto legacy: feature inventory

Source: `legacy/` as of 2026-10-17. Paths are relative to `legacy/`.

**What each status means:**

| Status | Meaning |
|---|---|
| **Implemented** | Works end to end in the legacy app with real server-side rules. It still has to be ported to the 2.0 stack. |
| **Partial** | Some of the capability exists, or it exists only as a simulation, demo or display without enforcement. |
| **Missing** | No code for it. At most it appears as copy or a "coming soon" card. |
| **Requires Migration** | Works, but is tied to a design that must be re-architected rather than ported 1:1, such as the single-document state, global provider credentials or post-render translation. |
| **Requires External Approval** | Cannot go live without third-party merchant onboarding, credentials, a regulator or platform approval. |

## Onboarding, tenancy, organization

| Capability | Legacy location | Status | Notes |
|---|---|---|---|
| Owner sign-up and sign-in (email/password, Google) | `public/account.js`, `client/firebase-client.js`, `firebase-platform.js` (`bootstrap`) | Requires Migration | Firebase Auth. Bootstrap creates the slug, restaurant, owner membership and a seeded tenant. It only works in `FIREBASE_TENANT_MODE`. Local mode uses shared role passwords. |
| Guided setup wizard (8 steps) | `public/setup.js`, `restaurant-experience.js` (`setupView`/`saveSetup`), `/api/setup` | Implemented | Welcome, Profile, Branch, Operating mode, Menu, Floor, Payment readiness, Preview. It is revision-protected and limited to EGP and Africa/Cairo. Logo is a data URL. Maps link must be Google HTTPS. |
| Restaurant profile and settings | `/api/settings`, `/api/setup`, `s.profile`, `s.settings` | Implemented | Settings cover duration, buffer, deposit, delivery fee, `serviceMode` (tables/counter/delivery) and `reservationsEnabled`. |
| Multi-tenant isolation | `firebase-platform.js`, `firestore.rules` | Requires Migration | One Firestore doc per tenant, isolated by membership. Unauthenticated traffic falls back to the demo tenant. Webhooks carry no tenant. |
| Branches | `/api/branch`, `platform-domain.migratePlatform`, `manager-platform.js` (`branches` tab) | Partial | Branches live inside one state. Per-branch menu (`branchIds`), tables, pickup/delivery flags, delivery areas, payment provider and Arabic name. There are no per-branch hours enforcement, staff scoping or analytics split. The `main` branch cannot be deactivated. |
| Second brand on shared backend | `platform-domain.seedBurger`, `public/burger.js` (`/burger`) | Partial | Demo "Smash & Co" branch with its own storefront. Hard-coded seed. |
| Staff roles | `server.js` `auth()`, `firebase-platform.roleFor` | Implemented | manager / kitchen / host (+ owner in Firebase). Server-enforced matrix. Local mode has one shared password per role. |
| Staff invites and accounts | `/api/account/invite` | Partial | Firebase only. The manager sets the password, and there is no email invite flow. There is no staff list or removal UI and no granular permissions. |
| Platform admin (super-admin, tenant management) | none | Missing | No cross-tenant admin, impersonation, plan management or support tooling. Sales inquiries sit inside the demo tenant's state. |

## Menu and catalogue

| Capability | Legacy location | Status | Notes |
|---|---|---|---|
| Menu items, categories, stations | `/api/menu`, `public/app.js` (`menu` tab) | Implemented | Category and station are free strings, with no category entity or sort order. Price is integer piastres. Edits are version-checked. |
| Modifiers (options with price, required flag) | `/api/menu-metadata`, `platform-domain.quoteLines` | Implemented | At most 20 per item. Prices are server-validated and required options are enforced. There are no option groups or min/max selection. |
| Sizes, variants, add-ons | `data-tools.menuPreview`, `ai-imports.js` | Partial | Stored from import but **not used in pricing or ordering**. Only `modifiers` are honoured. |
| Allergens and dietary tags | menu `allergens[]`, `dietary[]`, `vegetarian` | Implemented | Allergens are free text. Disclaimers say "listed allergens only". |
| Bilingual fields (EN/AR) | `nameAr`, `descriptionAr`, modifier `nameAr`, branch `nameAr` | Implemented | Category names are not bilingual. |
| Spice level and prep minutes | `/api/menu-metadata` | Implemented | Used by AI filters (`mild`, `quick`). |
| Menu images (upload, AI generate) | `/api/menu-image`, `/api/menu-image-generate`, `media-store.js`, `public/owner-media.js` | Implemented | Max 800 KB. Generation needs `GEMINI_IMAGE_MODEL`. |
| CSV import/export with preview | `data-tools.js`, `/api/menu-preview`, `/api/menu-import`, `/api/export` | Implemented | Formula-injection escaping and version checks. Export covers menu, orders, reservations and payments. |
| AI menu extraction (PDF/photo) | `ai-imports.extractMenuDraft`, `/api/menu-extract`, `public/owner-menu.js` | Implemented | Produces a review draft only. Without `GEMINI_API_KEY` it returns 503 and the UI offers manual or CSV entry. |
| Inventory / stock | menu `stock` (portions), `manager-platform.js` (`inventory` tab) | Partial | Only portion counts per dish, decremented by orders and restored on cancel. There are no ingredients, recipes, suppliers, purchase orders, waste or units. The low-stock threshold (<6) is hard-coded. |

## Guest ordering and service

| Capability | Legacy location | Status | Notes |
|---|---|---|---|
| QR table ordering | `/t/:qr`, `/api/table-session`, `public/guest.js` | Implemented | Auto-opens the visit and needs no PIN. **Security flaw:** table `qr` values are public via `/api/public` (see CURRENT_STATE §16). |
| Counter / single venue QR | `settings.venueQr`, `/qr/venue`, `serviceMode=counter` | Implemented | For cloud kitchens and takeaway windows. |
| Dine-in | `/api/seat`, `/api/order` | Implemented | Server-side pricing and stock, idempotent orders. |
| Pickup | `/api/online-order` (`placeOnline`), `/menu` | Implemented | Menu-first checkout. Payment is demo or a provider checkout. |
| Delivery ordering | `/api/online-order`, branch `deliveryAreas` | Partial | Takes the address and area, applies the fee, and runs the `out_for_delivery → delivered` transitions. There is no zone geometry, ETA or driver. |
| Waiter call and bill request | `/api/request`, `/api/resolve` | Implemented | Deduplicated while open. |
| Order status tracking (guest) | `guest.js` status screen, `/api/events` polling | Implemented | 2-second revision polling. No push. |
| KDS (kitchen display) | `/kitchen`, `public/app.js`, `public/kitchen-dnd.js`, `/api/transition` | Implemented | Kanban columns New / Preparing / Ready / On the way / Completed with drag-and-drop. Stale versions are rejected. There is no per-station routing screen; station is shown per line. |
| Order state machine | `server.js` L214 | Implemented | received→preparing→ready→served / picked_up / out_for_delivery→delivered; manager cancel only from received. |
| Front desk / host screen | `/host`, `public/host.js` | Implemented | Seat a walk-in, check in, clean tables, see open bills and requests. Cannot touch money, menu or layout. |
| Table auto-open, undo, auto-close | `server.js` L56-79, L177-223 | Implemented | 60-second undo window and 10-minute quiet auto-close. |
| Reservations | `/reserve`, `public/reservations.js`, `/api/reserve`, `/api/availability`, `/api/reservation-change` | Implemented | Floor-map table choice with feature filters. 5-minute hold, duration+buffer overlap, −15/+30 min check-in, guest modify or cancel. |
| Reservation deposits | `/api/deposit` | Partial | **Simulated only.** Refused in live mode. Becomes visit credit, and unused credit produces a `test-refund` row. There is no real provider charge or refund. |
| AI table recommendation | `restaurant-experience.recommendTables`, `/api/table-recommend` | Implemented | Rules parse Arabic and English; Gemini picks among validated tables. |
| Floor studio (editor) | `/manager/floor-editor`, `public/floor-editor.js`, `floor-domain.js`, `public/floor-shared.js` | Implemented | SVG, schema v2, 1200×800 units. Revision conflict 409, archival protection, server-issued QR codes, 13 feature tags, minimum spend and premium flags. |
| AI floor extraction from plan image | `ai-imports.extractFloorDraft`, `/api/floor-extract`, `public/owner-import.js` | Implemented | Draft only. Gemini vision. |
| Ratings / feedback | `/api/rating`, `platform-domain.addRating` | Implemented | Overall plus food, service, speed and value, only after payment. Shown in analytics. |

## Payments and money

| Capability | Legacy location | Status | Notes |
|---|---|---|---|
| Test / simulated payments | `/api/pay`, `payShare`, `placeOnline(payment:'demo')` | Implemented | Default `PAYMENT_MODE=test`, **including the Render production config**. |
| Stripe hosted checkout plus signed webhook | `payments.js`, `/api/checkout`, `/api/webhooks/stripe` | Requires External Approval | Code is complete and tested with mocks. It needs a Stripe account with EGP support, keys and a webhook secret. Credentials are platform-global, with no Stripe Connect per restaurant. |
| Paymob card checkout plus HMAC webhook | `payments.js`, `/api/webhooks/paymob` | Requires External Approval | Intention API plus HMAC-SHA512. Needs Paymob merchant onboarding and integration IDs. Platform-global credentials. |
| Paymob mobile wallet | `payments.js` (`PAYMOB_INTEGRATION_ID_WALLET`) | Partial | A checkout can be created, but the webhook only accepts the **card** integration id, so wallet payments never confirm. Also needs merchant approval. |
| InstaPay | `payments.js` (`INSTAPAY_MERCHANT_ADDRESS`) | Partial | The address is displayed only. There is no manager confirmation endpoint and no reconciliation. |
| Cash | `paymentConfig.methods` (`cash`, `request`) | Partial | Only a "request" method label. There is no cash-taken recording or till. |
| Split bills (full / equal / custom / by item) | `platform-domain.createSplit`, `/api/split`, `/s/:token`, `/api/share`, `/api/share-pay` | Implemented | Integer largest-remainder apportioning. Per-share links with QR and WhatsApp share link. Shares can pay through a provider checkout. |
| Refunds | `settleVisit` `test-refund` rows | Missing | Only an internal record of unused deposit credit. There are no provider refunds, partial refunds or voids. A guest cancel only says "Contact restaurant for deposit refund". |
| Reconciliation | webhook 409 "Payment requires reconciliation", checkout `creating` flag | Missing | Error messages point to manager reconciliation, but there is no UI, no endpoint and no provider status polling. |
| Receipts | `receipts.js`, `public/receipt.js`, `/api/receipt(s)` | Implemented | Digital, from confirmed payments only, printable, shareable as text. There is no tax breakdown or fiscal numbering. |
| Payments overview (manager) | `manager-platform.js` (`payments` tab), `insights().recentPayments` | Partial | Lists the last 10 payments. No settlement report. |

## Customers, analytics, marketing, AI

| Capability | Legacy location | Status | Notes |
|---|---|---|---|
| Customers / CRM | `platform-domain.insights().customers`, `customers` tab | Partial | Derived on the fly from visits with a `contact` (visits and spend). There are no customer records, consent, notes, segments or loyalty. |
| Analytics dashboard | `insights()`, `overview` and `analytics` tabs | Partial | Revenue and orders today (Cairo time), active tables, low stock, station load and ratings. No history, trends, cohorts or exports beyond CSV. |
| AI meal assistant / recommendations | `ai-service.recommend`, `/api/recommend`, `public/guest-chat.css` | Implemented | Validated Gemini output with demo-rule fallback and the mode label shown. Unauthenticated, with no rate limit. |
| Complementary upsell suggestions | `suggestions.js`, `/api/suggest` | Implemented | Rules find the gap; Gemini only re-ranks. |
| AI manager insights | `ai-service.managerInsights`, `/api/manager-insights` | Partial | Gemini only selects among rule cards (low stock, station load). Not a real assistant. |
| AI forecasting (demand, prep, staffing) | none | Missing | |
| MCP / WebMCP | `public/app.js` (`document.modelContext.registerTool`), `seo.js` (`/llms.txt`) | Partial | One read-only WebMCP tool, `read_current_menu`, registered only where the browser supports `document.modelContext`. `llms.txt` is served. There is no MCP server. |
| Marketing / campaigns / ads | none (landing copy only) | Missing | No campaigns, promo codes, discounts, audiences or ad integrations. |
| WhatsApp | `guest.js` (`wa.me/?text=` share link), `integrations.js` (`implemented:false`) | Partial | Guests can share a split link through WhatsApp. No WhatsApp Business API, templates or notifications, which would also need Meta approval. |
| Unified inbox (WhatsApp / Instagram / web chat) | none | Missing | |
| Email / SMS notifications | `integrations.js` (`implemented:false`) | Missing | Shown as "Coming soon". |

## Operations and back office

| Capability | Legacy location | Status | Notes |
|---|---|---|---|
| Drivers / delivery dispatch | `integrations.js` ("Delivery providers", `implemented:false`) | Missing | Statuses only (`out_for_delivery`, `delivered`). No drivers, assignment, tracking or courier APIs. |
| Restaurant website (guest-facing site) | `/restaurant`, `public/pages.js` (`restaurantPage`), `/burger` | Partial | A page per tenant via `?restaurant=slug` in Firebase mode, using a fixed template. No theming or CMS. |
| Custom domains | none | Missing | `APP_ORIGIN` is single-origin, and QR codes and URLs are built from it. |
| Finance / expenses | none | Missing | |
| Tax / VAT handling | none | Missing | No tax rates on items, no service charge, no tax lines on receipts. |
| ZATCA (KSA e-invoicing) | none | Requires External Approval | Missing, and would need ZATCA onboarding (CSID) and certified e-invoice generation. |
| Egypt ETA e-receipt / e-invoice | none | Requires External Approval | Missing, and would need ETA taxpayer registration and POS e-receipt certification. |
| Audit log | `s.audit` (`event()`) | Partial | Type, entity and time only, without the actor. Last 100 shown to the manager. Unbounded growth. |
| POS integrations framework | `integrations.js` (`IntegrationAdapter`, `marketplace()`), `/api/integrations`, `/api/integration-sync` | Partial | An adapter base class plus a marketplace list. Only menu import. No order push, OAuth, per-tenant credentials or webhooks. |
| Foodics | `FoodicsAdapter` | Requires External Approval | Menu import via `FOODICS_API_TOKEN`. Production needs Foodics partner app approval and per-merchant OAuth. |
| Odoo | `OdooAdapter` | Partial | Odoo 19 JSON-2 menu import with a global env key. Currency is only trusted when `ODOO_CURRENCY=EGP`. |
| Data export | `/api/export` | Implemented | CSV or JSON for menu, orders, reservations and payments. Manager only. |

## Commercial, platform, i18n

| Capability | Legacy location | Status | Notes |
|---|---|---|---|
| Pricing page and plan catalogue | `/pricing`, `public/pricing.js`, `public/plan-comparison.js`, `restaurant-experience.plans` | Implemented | Starter 799, Growth 1499, Pro 2999 EGP/month; Business on quote. Includes a Foodics comparison. |
| Billing / subscriptions | `firebase-platform.bootstrap` (`subscription.status:'trialing'`) | Missing | `billingEnabled:false`. No payment collection, invoices or dunning. A 14-day trial date is recorded but never checked. |
| Entitlements / plan limits | `plan-comparison.js` comment: "Nothing in the product gates a feature by plan yet" | Missing | Branch and staff limits are displayed only. |
| Sales inquiries (Business plan lead) | `/api/sales-inquiry`, `restaurant-experience.salesInquiry` | Implemented | Stored in tenant state (capped at 1000) and shown in setup. |
| Marketing landing with interactive demos | `/`, `public/landing*.js`, `landing.css`, `landing-demos.css` | Implemented | Also shipped as a static Vercel build (`scripts/build-static-landing.mjs`). |
| SEO (meta, hreflang, JSON-LD, sitemap, llms.txt) | `seo.js` | Implemented | Five public routes are indexed. |
| Arabic / RTL | `public/i18n.js`, `public/locales/ar*.js`, `typography.css`, `[dir=rtl]` rules, `seo.js` | Requires Migration | Full Arabic dictionaries, `?lang=ar`, and server-set `dir`. Staff screens are translated after render by a DOM TreeWalker, which is fragile. CSS mixes logical properties with physical `[dir=rtl]` overrides. Arabic gets a separate larger type scale. |
| Real-time updates | `/api/events` revision polling (2 s) | Requires Migration | Polling a whole-state revision. No per-entity change feed, SSE or websockets. |
| Persistence (single JSON document) | `server.js` `tx()`, `firebase-platform.FirestoreTenantStore` | Requires Migration | Whole-state read, parse, write per mutation. Will hit Firestore's 1 MiB doc limit. Must move to a normalized schema. |
