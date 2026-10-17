# Resuto architecture audit — premium platform upgrade

The current native Node 24 HTTP application has no framework or build-time UI dependency. `server.js` owns authentication, reservations, visits, orders, stock, test payments and staff actions. Domain state is one JSON document in SQLite locally or JSONB in Postgres on Netlify. Each mutation runs under SQLite BEGIN IMMEDIATE or a Postgres row lock. Existing table IDs and QR identifiers must survive migration.

Public routes are `/`, `/restaurant`, `/menu`, `/order`, `/reserve` and `/t/:qr`; staff routes are `/manager`, `/kitchen`, `/manager/floor-editor`. The browser currently uses HTML string renderers, sessionStorage bearer/cart state and 2-second refreshes. Manager sessions are opaque HttpOnly cookies, distinct from guest visit tokens. Floor editing is already a proper SVG draft workspace with geometric validation and optimistic revision saves.

Working safeguards: server-side stock/price checks, snapshots on order lines, transactional holds and deposits, role permissions, idempotency fingerprints, guarded kitchen transitions, floor archival restrictions, preserved operational state and signed Stripe/Paymob callbacks. Keep these intact. Existing automated and Chromium suites provide regression coverage.

Gaps: menu browsing currently branches to fulfillment forms; no named share records/participant links; no ratings; no localization system; AI logic is inside HTTP routing; no adapter marketplace or customer analysis; landing page is predominantly a static feature grid. Payment amounts are partial bill transactions, not assigned shares. Branches are implicit in settings. Polling has no change cursor. Menu metadata lacks descriptions, modifiers and bilingual fields.

Implementation boundaries:

1. Add repeatable platform migration, menu metadata and one real native branch; never fabricate branches, performance metrics or connected providers.
2. Add an isolated platform domain for checkout, share allocation, ratings and measured analytics, always invoked within existing transactions. Add provider/service boundaries for AI and integrations.
3. Add dictionaries, locally licensed font assets, logical-layout tokens and RTL support. Reuse the SVG floor scene and draft editor.
4. Add a mobile-first guest application with menu-first browsing, explicit checkout, structured AI recommendations, reservation list/map, share participants and rating.
5. Extend the existing manager workspace with overview, integrations and analytics; keep role-sensitive operations in existing APIs.
6. Replace SaaS marketing visuals with an original interactive product composition informed by Qlub/Foodics principles, using no borrowed assets, metrics or testimonials.
7. Verify migration, concurrency, sharing authorization and scenario A–F with isolated data. Real provider acceptance remains credential-dependent and must be identified explicitly.

Netlify requests are short-lived functions: avoid unbounded SSE connections there. A revision-aware event endpoint can support change-driven refresh using short requests on both local and hosted deployments. Preserve draft/form focus across background refreshes.
