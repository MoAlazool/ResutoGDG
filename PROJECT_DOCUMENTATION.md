# Resuto — Project Documentation

## Overview

Resuto is a restaurant operations MVP for a single restaurant installation. It combines a public restaurant experience with staff tools for reservations, tables, ordering, kitchen workflows, payments, menu administration, data import/export, and optional AI-assisted workflows.

The included demo restaurant is **The Olive Room** in Zamalek, Cairo. Monetary values are stored as integer minor units (for example, `14500` represents EGP 145.00).

## Primary capabilities

- Public Resuto product, pricing, and sales-inquiry pages.
- Branded guest restaurant website with reservations, table recommendations, and QR table access.
- Dine-in, pickup, and delivery ordering with menu notes, stock validation, and immutable line-item prices.
- Manager workspace for seating, reservations, table cleaning, menu management, data management, settings, integrations, and analytics.
- Kitchen display with guarded order-status transitions.
- SVG floor-plan editor with tables, structural objects, alignment tools, undo/redo, drafts, QR downloads, and optimistic-concurrency protection.
- Test-mode ledger payments, split-bill flows, and optional hosted Stripe and Paymob checkout adapters.
- CSV/JSON export; reviewed CSV import; optional AI extraction from menu files and floor plans.
- Optional Gemini-powered menu recommendations, manager insights, and image generation. The app clearly identifies demo-rule fallbacks.

## Technology

| Area | Implementation |
| --- | --- |
| Runtime | Node.js 24+ with ES modules |
| HTTP server | Node built-in `http` module |
| Local persistence | SQLite using `node:sqlite` |
| Hosted persistence | Firestore, one state document per restaurant |
| Frontend | Static HTML, CSS, and browser JavaScript modules |
| QR generation | `qrcode` |
| Hosting | Firebase Hosting + Firestore |
| Tests | Node test runner and Python Playwright smoke suites |

## Getting started

1. Install Node.js 24 or newer.
2. Create local configuration from the example file.
3. Choose strong staff passwords.
4. Install dependencies and start the server.

```sh
cp .env.example .env
npm install
npm start
```

Open the following pages after startup:

| Page | Local URL |
| --- | --- |
| Resuto product page | `http://localhost:3000/` |
| Restaurant guest site | `http://localhost:3000/restaurant` |
| Reservation flow | `http://localhost:3000/reserve` |
| Manager workspace | `http://localhost:3000/manager` |
| Kitchen display | `http://localhost:3000/kitchen` |
| Floor editor | `http://localhost:3000/manager/floor-editor` |
| Guided manager setup | `http://localhost:3000/manager/setup` |

## Configuration

Copy `.env.example` to `.env`. Do not commit `.env`, the local `data/` directory, or database credentials.

| Variable | Purpose |
| --- | --- |
| `PORT` | Local server port; defaults to `3000`. |
| `APP_ORIGIN` | Canonical public origin used in QR codes, cookies, and payment callbacks. |
| `MANAGER_PASSWORD` | Required manager login password. |
| `KITCHEN_PASSWORD` | Required kitchen login password. |
| `DB_PATH` | Optional local SQLite path; defaults to `data/resuto.sqlite`. |
| `FIREBASE_PROJECT_ID` / `FIREBASE_TENANT_MODE` | Firestore project and tenant-isolation switch for hosted deployments. |
| `PAYMENT_MODE` | `test` for simulated payments or `live` to require real gateways. |
| `GEMINI_API_KEY` | Enables Gemini-backed text and vision capabilities. |
| `GEMINI_MODEL` | Default Gemini model; capability-specific overrides are also supported. |
| Stripe / Paymob variables | Enable their corresponding hosted checkout adapters. |
| Foodics / Odoo variables | Enable reviewed menu-import connectors. |

## Architecture

```text
Browser UI (public/)
        │ JSON API / static assets
        ▼
server.js
 ├── restaurant-experience.js   Reservations, plans, setup, table suggestions
 ├── platform-domain.js         Ordering, payments, split bills, operations
 ├── floor-domain.js            Floor layout migration, validation, persistence views
 ├── data-tools.js              Imports and exports
 ├── ai-service.js              Recommendations and manager insights
 ├── gemini-provider.js         Gemini request and capability adapter
 ├── payments.js                Stripe / Paymob checkout and webhook validation
 ├── integrations.js            Foodics / Odoo integration adapters
 ├── media-store.js             Local or hosted media persistence
 └── firebase-platform.js      Firestore tenant store, cache and auth
        │
        ├── SQLite state document (local development)
        └── Firestore state document (hosted deployment)
```

State mutations execute inside a single write transaction. Each mutation increments a state revision; selected resources, including menus and floor layouts, also use versions or base revisions to detect stale updates. The application is designed for one restaurant installation, not multi-tenant use.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `server.js` | HTTP server, static assets, API routing, authentication, rate limits, transactions. |
| `public/` | Browser application, routes, styles, translation modules, fonts, and visual assets. |
| `public/floor-*.js` | Shared floor model, guest preview, and manager floor editor. |
| `public/owner-*.js` | Manager menu, media, and import interfaces. |
| `restaurant-experience.js` | Reservation, setup, product, and guest experience domain functions. |
| `platform-domain.js` | Visits, orders, bills, payment shares, operational reports, and ratings. |
| `floor-domain.js` | Versioned floor-layout validation and public/staff views. |
| `payments.js` | Payment configuration, checkout creation, and signed webhook verification. |
| `data-tools.js` | Import previews, imports, exports, CSV formatting, and AI extraction helpers. |
| `ai-service.js`, `gemini-provider.js`, `ai-imports.js` | AI recommendations, insights, structured Gemini calls, and extraction flows. |
| `firebase-platform.js` | Firestore tenant storage, in-memory cache and Firebase Auth. |
| `scripts/` | Source checks, client build, fixture server, and browser smoke tests. |
| `tests/` | API, domain, payment, rendering, deployment, and AI tests. |
| `docs/` | Verification reports and screenshots. |

## Main application flows

### Reservations and seating

Guests choose a date, party size, and table. The system calculates availability using reservation duration and buffer settings, prevents table overlaps, and creates a five-minute reservation hold. In test mode, the reservation deposit is confirmed in-app. Staff can check a confirmed reservation in from 15 minutes before until 30 minutes after the scheduled time.

### Guest ordering

A guest can open a table QR URL, join an active visit, order at the table, or start pickup/delivery. Orders are validated against current availability and stock, then receive immutable prices and a kitchen station. The kitchen transitions orders through the allowed statuses only.

### Billing and closeout

The bill supports full payments, partial payments, equal shares, group/family shares, and custom shares. A pending settlement locks new orders. A visit can be closed only after its bill is settled and all orders are fulfilled or cancelled; closing a dine-in visit marks its table as needing cleaning.

### Manager operations

Managers can manage the menu, floor, settings, branches, reservations, table state, integrations, media, imported data, exports, and audit history. Manager sessions are HTTP-only, SameSite-Strict cookies that expire after eight hours.

## API summary

The API is JSON-based and served under `/api`. Staff-only endpoints require a manager or kitchen session; guest visit endpoints require the visit bearer token. Important endpoint groups are:

| Group | Examples |
| --- | --- |
| Authentication | `POST /api/login`, `POST /api/logout` |
| Public restaurant data | `GET /api/public`, `GET /api/availability`, `GET /api/plans` |
| Reservations | `POST /api/reserve`, `POST /api/deposit`, `GET /api/reservation`, `POST /api/reservation-change` |
| Guest visit and order | `POST /api/table-session`, `POST /api/join`, `GET /api/visit`, `POST /api/order`, `POST /api/pay` |
| Staff operations | `GET /api/staff`, `POST /api/seat`, `POST /api/transition`, `POST /api/close`, `POST /api/clean` |
| Floor plan | `GET/POST /api/floor`, `POST /api/background`, `GET /qr/:tableQr` |
| Menu and data | `POST /api/menu`, `POST /api/menu-import`, `POST /api/menu-preview`, `GET /api/export` |
| AI | `GET /api/ai-capabilities`, `POST /api/recommend`, `POST /api/menu-extract`, `POST /api/floor-extract` |
| Payments | `POST /api/checkout`, `POST /api/webhooks/stripe`, `POST /api/webhooks/paymob` |

All write requests must use `application/json`. Cross-origin write requests are rejected, except for webhook endpoints that perform provider-signature validation.

## Quality checks

Run the basic source and unit checks:

```sh
npm run build
npm test
```

Additional browser and workflow suites:

```sh
npm run test:browser
npm run test:experience
npm run test:editor
npm run test:data
npm run test:owner-ai
```

The browser suites require Python Playwright and Chromium:

```sh
pip install playwright
python -m playwright install chromium
```

## Deployment

The project deploys to Firebase. `firebase.json` serves `public/` through Firebase Hosting with long-lived caching for static assets, and Firestore holds each restaurant's state under `restaurants/{id}/private/state`. Run `npm run deploy` to publish Hosting and the Firestore rules.

For deployment:

1. Set an HTTPS `APP_ORIGIN`.
2. Set strong `MANAGER_PASSWORD` and `KITCHEN_PASSWORD` values.
3. Confirm the Firebase project and service-account credentials.
4. Configure payment credentials only when live payments are intended.
5. Register the Stripe and/or Paymob webhook URLs when those providers are enabled.
6. Run `npm run build` and `npm run test:firebase` before release validation.

See [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) for the full hosted-data migration and gateway configuration details.

## Security and operational notes

- Keep `.env`, SQLite files, service-account keys, and backups private.
- Use HTTPS and a phone-reachable `APP_ORIGIN` for LAN/mobile testing so QR codes resolve correctly.
- The local SQLite implementation uses a serialized state document and is appropriate for a small single-process deployment, not a production multi-tenant architecture.
- Payment simulation is the default. Stripe and Paymob adapters require merchant configuration and real-account validation before production use.
- AI results are constrained and reviewed; extraction imports begin unavailable with zero stock. Allergy information is not a guarantee of allergy or cross-contact safety.
- Floor geometry is illustrative and must not be treated as an architectural or safety plan.

## Related documentation

- [README.md](README.md) — quick start, feature overview, rehearsal steps, and current boundaries.
- [NETLIFY_DEPLOYMENT.md](NETLIFY_DEPLOYMENT.md) — deployment, database, and payment-provider setup.
- [MVP_VERIFICATION.md](MVP_VERIFICATION.md) — verification record.
- [BROWSER_VERIFICATION.md](BROWSER_VERIFICATION.md) — browser test scope and results.
- [docs/EXPERIENCE-VERIFICATION.md](docs/EXPERIENCE-VERIFICATION.md) — experience implementation and screenshots.
