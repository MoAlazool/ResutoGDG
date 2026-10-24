# Resuto 2.1 — Product Experience Redesign & Platform Evolution (plan)

## Context

Resuto 2.0 is functionally broad and stable. CI run 61 is green, and staging runs `5c359d5`. The product experience has not kept up with the feature set:

- **Navigation:** a flat 28-item sidebar with no search, command palette or shortcuts.
- **Styling:** a light-only token set named per element, Unicode glyphs instead of icons, and no provider logos.
- **Inbox:** a cramped tab with no Customer 360 panel.
- **Integrations:** a 636-line page of letter tiles and key forms.
- **MCP:** setup is aimed at admins.
- **Free tier:** signup ends in a heavy 8-step checklist that asks a free QR-menu restaurant for a legal name, floor plan and payments.

Resuto 2.1 turns this into a premium, fast, bilingual restaurant operating system without rewriting working modules. Priority order: **1A Foundation → 1B MCP → 1C Core experience → 1D Stabilization**.

The **iPad app is developed in parallel** by Codex Cloud on `feature/ipad-pos`, starting now. This track never edits that branch. It owns the shared backend contracts the iPad needs (WS 21-POSAPI, moved to 1A so Codex is never blocked), published as additive, documented API contracts. The iPad's final integration and release depend only on those contracts being stable and validated.

**Scope:** the entire redesign is implemented as working functionality, not mockups. It is delivered in small, testable, reviewable increments that preserve existing behaviour, backend compatibility, Arabic RTL, Western digits, performance budgets and Resuto branding.

Work stays on `claude/relaxed-mayer-omkl3f`. `main`, `legacy/` and production are untouched, and nothing goes to `feature/ipad-pos`.

### Owner decisions (2026-10-24)

| Topic | Decision |
|---|---|
| WhatsApp | Both stay on the roadmap. The official Embedded Signup path is the production default. The QR compatibility approach is limited to isolated research and a proof of concept on Resuto-owned test numbers. It is never activated for real restaurant accounts or production without a documented policy/security assessment and your explicit approval (G-WA). |
| Integrations | Real, end-to-end connections, not decorative UI. Unverified capabilities are labelled honestly. |
| Dark mode | All tokens and components are dark-ready from day one. Dark ships for the staff dashboard after light is done. |
| Brand | Keep the logo, colours and name. Modernise typography, density, layout and components. |
| Plans | I propose Free / Starter / Growth / Pro tables (no prices). Nothing is enforced until you approve them. |

---

## 1. Current-state assessment (repository-backed)

### Shell and navigation

- **Sidebar:** `apps/web/lib/nav.ts` is a flat `NAV` of 5 groups and 28 items, with locked modules shown as `⊘`. On phones it becomes a horizontal strip of 28 chips.
- **Shell:** `components/shell/DashboardShell.tsx` (300 lines) draws a snapshot first and then hydrates.
- **Branch selection:** two selectors that can disagree. One is the shell chip (`lib/org-context.tsx`); the other is a `BranchSelect` repeated in 9 pages.
- **Sub-navigation:** four patterns — `Tabs`, `FinanceFrame` pills, `IntelShell`, `McpPage` tabs.
- **States:** one `loading.tsx` and one `error.tsx` for the whole dashboard.
- **Account chrome:** clicking the profile button signs you out. The language pill floats outside the shell.

### Design system

- **`packages/ui`** (~1.4k lines): `base`, `primitives`, `shell`, `overlays`, `inputs`, `display`, `states`, `toast`.
- **Tokens:** `tokens.css`, generated from `docs/ui/design-tokens.json`. About 130 colour variables named per element, no neutral scale, 4 spacing steps, 1 easing, light only.
- **Global CSS:** `globals.css` has ~416 rules. There are 16 page CSS files; `landing.css` alone is 1.6k lines.
- **Debt baselines:** 285 inline styles and 430 stray hex colours, held only by baselines that may not grow.
- **Icons:** Unicode glyphs, with duplicates (`◉` used three times).
- **Charts:** two separate sets.
- **Duplicated or unused primitives:** two date pickers; `Pagination` unused.
- **`DataTable`:** no sorting, sticky header or selection, and rows can't be reached by keyboard.
- **`Modal`:** fixed 560 px, with English-only labels.

### Arabic, RTL and digits (strong — keep)

- **Formatting:** `packages/contracts/src/locale-format.ts` (`ar-EG-u-nu-latn`).
- **Guards:** digit, bidi and order-ref policy tests.
- **Mixed-direction helpers:** `UserText`, `Ltr`, `Phone`, `Money` and `OrderRef`.
- **Translations:** per-scope dictionaries, about 140 KB in the staff scope.
- **Fonts:** Manrope and IBM Plex Sans Arabic.

### Overview

- **Scope:** today only, with a fixed "same weekday last week" comparison.
- **KPIs:** revenue, tables, orders and satisfaction, plus a live floor preview and an hourly line chart.
- **Panels:** alerts and AI.
- **Missing:** date ranges, acquisition, campaigns, retention, pending approvals and configuration.

### Inbox

- **Layout:** `inbox/page.tsx` (421 lines, 25 inline styles) is a tab with an auto-fit grid of 340/520 px cards, polled every 4–5 seconds.
- **Exists:** assignment, templates, 24-hour window handling, handoff, and the ordering-session banner.
- **Missing:** conversation tags, internal notes (the `'note'` message kind exists but is unused), saved replies and a Customer 360 panel.
- **API gaps:** the customer profile API doesn't return acquisition source or conversations.

### Studio

- **Editor:** `website/_components/WebsiteStudio.tsx` with tabs for sections, design, SEO, media, domains, creative and history.
- **Preview:** an inline `<aside>`, not a canvas.
- **Model:** 3 templates and 11 section kinds; the theme is 3 colours and 2 fonts.
- **Publishing:** immutable revisions with restore.
- **AI:** AI copy goes through draft → approve → apply. Structural or AI layout changes have no approval path.

### Integrations

- **UI:** `integrations/page.tsx` (636 lines), with letter tiles and modals generated from declared fields.
- **OAuth already exists:**
  - Meta Pages, Meta Ads, TikTok Ads, Snap Ads and Foodics (PKCE).
  - WhatsApp Embedded Signup v4 (`whatsapp-signup.service.ts`, `MetaChannels.tsx`).
- **Key-based:** CAPI pixels, accounting, payments, Resend, Twilio and Routes.
- **Platform app credentials:** environment variables only, with no operator console.
- **Verification:** no provider has been verified against the real service (`docs/INTEGRATION_READINESS.md`, blockers B-3 to B-21).

### MCP

- **Server:** `apps/mcp-server` is a thin proxy with in-memory sessions. `apps/api/src/modules/mcp` enforces everything.
- **Tools:** 22 — 17 reads, 2 draft writes, 3 approval-gated.
- **Approval:** bound to a snapshot of scope and preview digest, with a 24-hour TTL.
- **OAuth 2.1:** with PKCE and refresh-token rotation, but off by default. Only the SDK client has been tested.
- **Gaps:** approve has no MFA requirement; no menu, price, website or promotion actions; no per-tool risk policy; `mcp_calls_per_month` is not enforced.
- **UI:** admin forms (`dashboard/[orgId]/mcp/*`).

### Billing and onboarding

- **Plans:** seeded as `free` (core, 1 branch, 2 staff, 300 orders a month), `starter`, `growth`, `pro` (the only plan with MCP) and `custom`.
- **Gates:** `@RequiresModule` on controllers, `ModuleGate` on the web, and HTTP 402 limits.
- **Lapsed trial bug:** `app.module_enabled()` returns false even for *core* when a paid trial lapses, instead of falling back to Free.
- **Onboarding:** one form whose UI defaults to `growth`.
- **Missing for QR menus:** theme presets (and Studio is paid), social links, a standalone menu QR, true spreadsheet import (CSV only) and subdomains (paths only).

### Security

- **In place:** RLS everywhere, the `resuto_api` least-privilege role, MFA step-up (opt-in), a CSP nonce, raw-body webhook verification with dedupe, AES-GCM key ring, SSRF guard, and many negative tests.
- **Gaps:**
  - Staging still connects as the database owner.
  - No MFA on MCP approval.
  - Owner MFA is optional.
  - Password policy is client-side only.
  - No CAPTCHA.
  - The rate limiter fails open.
  - The session lives in `localStorage`.
  - `img-src https:` is broad.
  - Security docs are stale.

### CRM

- **Data:** customers with identities, consent events, stats, segments (rule engine), loyalty, `tracking_links`, `attribution_events` and `orders.attribution`.
- **Missing:**
  - First-touch acquisition source.
  - The funnel events `page_view`, `add_to_cart` and `checkout_started` are defined but never written.
  - A conversation timeline on the customer profile.

---

## 2. Design direction

Principles taken from the reference products (patterns, not appearance):

1. **Calm density (Stripe):** neutral surfaces, one accent, numbers first, and generous whitespace on the overview but dense tables in operations.
2. **Speed as a feature (Linear):**
   - a ⌘K / Ctrl K command palette for navigation, actions and search;
   - keyboard shortcuts (g o for orders, g i for inbox…) with a `?` cheat sheet;
   - optimistic updates with undo toasts;
   - instant route changes from cached data.
3. **Contextual panels (macOS):** a three-pane layout where useful (Inbox, Studio, Customers), inspectors that slide in from the reading end (RTL-aware), and sheets instead of modals for long forms.
4. **Canvas workspaces (Framer/Webflow):** Studio has a left navigator, centre canvas, right inspector, and a top toolbar with device, undo/redo, versions and publish.
5. **Merchant progressive disclosure (Shopify/Salla):** a short setup guide tailored to the plan and service mode, locked features shown as tasteful previews with a "what you get" panel, and themes as the starting point.
6. **Operations reliability (Square/Foodics):** big touch targets on kitchen/host/floor views, high-contrast status colours, and "glanceable at 2 m" kitchen cards.
7. **Honesty:** every metric carries provenance (live / estimated / sandbox / unavailable), reusing the existing `MetaPanel` and `Freshness` components, and is never animated beyond its real value.

---

## 3. Information architecture

**Primary sidebar: 7 areas.** It is collapsible to icons. Each area opens a secondary list in the sidebar (on phones, a bottom tab bar plus a drawer).

| Area | Contains (current routes) |
|---|---|
| **Home** | Overview (command centre), Setup guide, Notifications |
| **Operations** | Orders, Kitchen, Floor & tables, Front desk, Reservations, Delivery, Inventory |
| **Menu & Store** | Menu (with Import as an action, not a separate item), Studio (website + digital menu), Food photos (inside Studio Assets), QR codes (new hub), Domains |
| **Customers** | Inbox, Customers (with 360 profile), Loyalty, Marketing & Growth (campaigns, segments, promotions, links, SEO/local) |
| **Money** | Payments, Finance (P&L, expenses, exports as tabs), Compliance |
| **Insights** | Analytics, Intelligence (forecast, recommendations, research, routes) |
| **AI & Apps** | Copilot (assistant + approvals inbox), MCP connections, Integrations |

**Footer cluster:** Settings (restaurant, team & roles, billing & plan, data import/export, audit log). An account menu replaces the profile button that signs you out on click.

**Global conventions:**
- **One branch context:** the shell chip becomes "All branches / Branch X" and pages read it from `org-context`. The 9 per-page `BranchSelect` copies are removed.
- **Sub-navigation:** one pattern, `SectionNav`, replaces the `FinanceFrame`, `IntelShell` and `McpPage` tabs.
- **Free plan shell:** Home, Menu, Store design, QR codes, Settings, and an "Explore Resuto" upgrade area. Operational areas stay hidden until the restaurant upgrades or enables them.
- **Role landing:** kitchen → Kitchen, host → Front desk, driver → `/driver`. This already exists in `lib/shell.test.ts`; keep it.

---

## 4. Design system specification

**Package:** extend `packages/ui`. Do not replace it.

**Token build:** keep generating tokens from `docs/ui/design-tokens.json` with `scripts/ui/build-tokens.mjs`, restructured into tiers:

| Tier | Contents |
|---|---|
| Primitive | Neutral scale (0, 25, 50 … 950), brand scale derived from the current Resuto accent, status hues (green, amber, red, blue, violet) |
| Semantic | `--bg`, `--surface-1..3`, `--text`, `--text-muted`, `--border`, `--accent`, `--focus`, `--ok/warn/danger/info` with `-bg`/`-fg`, and chart series 1–8 |
| Themes | `:root` (light) and `[data-theme=dark]`. Dark values are defined now and shipped later |

The old per-element names stay as aliases to semantic tokens, so nothing breaks. The `tokens-baseline` and `inline-styles-baseline` ratchets go down as pages migrate.

**Typography:**
- Fonts: Manrope (Latin) and IBM Plex Sans Arabic, already preloaded per language.
- Scale: 12 / 13 / 14 (body) / 16 / 18 / 20 / 24 / 30 / 36. Arabic gets +1 px at body sizes and line-height 1.6 (Latin 1.5).
- Tabular figures for every number (`font-variant-numeric: tabular-nums`). Western digits stay enforced by the existing policy tests.

**Layout:**
- Spacing: a 4 px grid with steps 1–12.
- Radii: 6 / 10 / 14 / pill.
- Elevation: 3 levels.
- Breakpoints: phone < 700, tablet 700–1100, desktop > 1100.
- Page templates:
  - `ListPage` — header, filter bar and `DataTable`.
  - `DetailPage` — header, main column and a side inspector.
  - `WorkspacePage` — 3 panes, full height.
  - `BoardPage` — lanes.
  - `SettingsPage` — section nav and forms.

**Components to add or upgrade:**

| Component | Notes |
|---|---|
| `Icon` | Lucide icons via per-icon ESM imports (tree-shaken, about 1 KB each), with the per-route cost checked by the bundle budget. Inline SVG is the fallback if the budget is hit. |
| `ProviderLogo` | Official SVG marks in `apps/web/public/brand/providers/`, used under each provider's brand guidelines. Reuses the `components/landing/brand-marks.ts` data. |
| `CommandPalette` | In-house fuzzy matcher, no dependency. |
| `Kbd`, `ShortcutsProvider` | Keyboard hints and the `?` cheat sheet. |
| `DataTable` v2 | Sorting, sticky header, keyboard-reachable rows (`<a>` row links), selection plus bulk bar, column visibility, density, server pagination (the existing keyset cursors), and an empty state. |
| `FilterBar` | Saved views. |
| `Sheet` | Side and bottom, RTL-aware, replaces most `Modal` forms. |
| `Popover`, `Menu`, `Tooltip` | |
| `SegmentedControl`, `Switch`, `Combobox`, `MoneyInput`, `PhoneInput` | Built on the existing `normalizeNumericInput`. |
| `Stat` v2 | Value, delta, sparkline, provenance badge. |
| Charts | One chart kit from the merged `components/charts` and `intelligence/_components/charts.tsx`: line, area, bar, donut, funnel, heatmap, sparkline. Inline SVG, no library. |
| States | `EmptyState` with illustration and action; `ErrorState` and `Loadable` replace the 10 `LoadError` copies. A `loading.tsx` per area. |
| `LockedFeature` | Preview, benefits, upgrade CTA. Replaces raw permission text in `ModuleGate`. |

**Motion:**
- CSS only: `--dur-fast` 150 ms, `--dur` 200 ms, `--dur-slow` 280 ms, with `--ease-out` and `--ease-spring-ish`.
- Only `transform` and `opacity` are animated.
- Route transitions use the View Transitions API where supported and fall back to no animation.
- Skeleton-to-content uses a 120 ms fade, and charts draw in with stroke-dash once.
- Number changes cross-fade; they never count up from zero.
- Covered by the existing global `prefers-reduced-motion` rule and `useReducedMotion`.
- No animation library.

**Accessibility:**
- WCAG 2.2 AA contrast through token pairs, checked by a script against design-tokens.
- Visible `--focus` ring, skip link, all dialogs as native `<dialog>` (already in place), `aria-live` for toasts and polling status, and targets of at least 44 px on operations screens.

**RTL:**
- Logical properties only (`margin-inline`, `inset-inline`), enforced by a new lint test forbidding `left`/`right`/`margin-left` in the CSS and components touched.
- Icons that imply direction are mirrored with `[dir=rtl] .icon-dir`.

---

## 5. Page-by-page redesign matrix (prioritised)

**Priority:** P0 = in 1A/1B/1C first wave, P1 = 1C second wave, P2 = 1C last / 1D.

| Page / area | Main problems | Redesign | Pri |
|---|---|---|---|
| Shell, nav (`DashboardShell`, `nav.ts`) | 28 flat items, two branch selectors, sign-out on the profile button | 7-area IA, collapsible, ⌘K, shortcuts, account menu, single branch context, mobile bottom bar | P0 (1A) |
| Overview `/dashboard/[orgId]` | Today only, no attention list, floor dominates | Command centre (§6.1) | P0 (1C) |
| MCP `/mcp/*` | Admin forms, raw keys | Wizard, permission groups, approvals inbox, activity (§6.6) | P0 (1B) |
| Onboarding `/onboarding` and Setup | One heavy form, defaults to growth, legal name required | Free QR path (§6.2); setup steps depend on plan and service mode | P0 (1C) |
| Menu `/menu` (446 lines) and `/menu-import` | Two entries, plain table | One workspace: category rail, items table v2, item sheet, import action (CSV and xlsx), availability toggles, bulk edit | P0 (1C) |
| Studio `/website` and `/studio-media` | Tabs plus an inline preview | Canvas workspace (§6.4) | P0 (1C) |
| Inbox `/inbox` | Cramped tab | Three-pane workspace plus Customer 360 (§6.5) | P0 (1C) |
| Integrations `/integrations` (636 lines) | Letter tiles, key forms | Marketplace plus guided connect (§6.3) | P0 (1C) |
| Customers `/customers`, `[id]` | Plain list, no timeline | List v2 with segments; 360 page shares the Inbox panel; unified timeline | P1 |
| Orders `/orders` | Board vs list toggle | `BoardPage` with lane counts, order sheet, keyboard nav, bulk actions | P1 |
| Kitchen `/kitchen`, `/kitchen/[orgId]` | Duplicate entry | One route; the dashboard link opens full-screen mode; glanceable cards, bump bar shortcuts | P1 |
| Floor / Host / Reservations | Three pages | Area tabs, shared live map, reservation timeline (Gantt-style per table), waitlist sheet | P1 |
| Delivery | Board | Dispatch map plus board, driver status chips | P1 |
| Inventory | Tabs | `ListPage` with low-stock first, stocktake sheet | P1 |
| Marketing (6 tabs, 428 lines) | Tab sprawl | Growth hub: campaigns, segments, promotions, links, SEO/local; recommendations surface on Home | P1 |
| Loyalty | Fine | Restyle; program preview card | P2 |
| Payments, Finance, P&L, Expenses, Exports | Pill nav | `SectionNav`; finance overview with period compare; export centre | P1 |
| Compliance | Dense | Stepper per regime (ZATCA, ETA); certification status honesty kept | P2 |
| Analytics, Intelligence (`IntelShell`) | Two shells, two chart kits | Insights area; one chart kit; saved reports; drill-down from Home | P1 |
| Notifications | Page plus bell | Bell popover with grouped items; page becomes "all activity" | P2 |
| Team, Settings, Data, Audit, Billing | Copy-pasted table wrappers, 20 inline styles in billing | `SettingsPage` template; Plan & billing with entitlement matrix and usage meters | P1 |
| Admin `/admin/*` | Separate shell | Operator console, including provider app credentials (§6.3) | P1 |
| Guest pages (`/r`, `/order`, `/t`, `/reserve`, `/pay`, `/s`, `/o`) | Budget-sensitive, good LCP | Token migration only; social icons; theme presets; no first-paint regressions (guards exist) | P2 |
| Landing, Pricing | `pricing-model.ts` hardcodes plan `business`, which does not exist | Align to the approved tiers; read from `/v1/public/plans` | P1 |
| Driver PWA | OK | Token migration, larger targets | P2 |

---

## 6. Key workflows

### 6.1 Overview command centre

Five rows answer the five questions:

1. **Right now:**
   - live orders by stage, kitchen load per station, tables occupied/free, next 3 reservations;
   - a compact floor thumbnail, expandable (no longer the dominant panel).
2. **Performance:**
   - revenue, orders, AOV and repeat rate with deltas and sparklines;
   - a period picker (today, 7 d, 30 d, custom), comparison (previous period / same period last year / none), and branch from the shell.
3. **Needs attention:**
   - slow orders, low stock, failing integrations, expiring tokens, pending MCP and creative approvals, unpaid bills, negative reviews.
4. **Customers and channels:**
   - acquisition by channel (QR, website, WhatsApp, Instagram, campaign link);
   - new vs returning;
   - campaign conversion.
5. **Next actions:**
   - AI insights (existing intelligence module) with one-click actions that open prefilled drafts, never auto-executed.

**Configuration:** "Customise" lets the owner show, hide and reorder sections, stored per user (`user_preferences`, new small table).

**Backend:**
- Extend `GET analytics/overview` with `from/to/compare`.
- Add a new `GET o/:id/attention` aggregator.
- Source acquisition from `attribution_events` plus the new first-touch field (§6.7).

### 6.2 Free QR menu onboarding

A wizard at `/onboarding` that saves progress server-side after every step:

1. Account (existing Supabase signup).
2. Restaurant name (EN/AR), country, service type.
3. Address pick:
   - Pick a slug and see a live availability check.
   - Add a reserved-word list for slugs.
   - Subdomain `<slug>.<root domain>` **if you provide a wildcard domain** (owner prerequisite O-1). The path `/r/<slug>` is always available.
4. Logo upload (the existing storage service) and a theme preset. Presets are a new `theme_presets` set (café, bakery, fine dining, QSR, cloud kitchen, family), each a full `websiteTheme`/`storefrontTheme`.
5. Menu:
   - manual (inline category and item creation);
   - spreadsheet (CSV plus xlsx parsed client-side in a lazily loaded worker; no server dependency);
   - upload a photo or PDF for assisted extraction (existing FT-08 pipeline; "assisted" wording, review step kept).
6. Images, prices, descriptions, availability (the menu workspace in compact mode).
7. Social links: new `organizations.social_links` (validated URLs per network), shown as icons on the storefront.
8. Preview (desktop/phone frames) and publish (reuses the website publish revisions).
9. Menu QR:
   - a new org/branch-level `menu_qr` that points to the digital menu;
   - downloadable PNG/SVG/PDF poster in A4/A5/table-tent sizes;
   - reuses the `qrcode` lib and `QrSheet`.

**Free vs paid separation:**
- **Menu QR (Free, view only):** the digital menu with categories, items, prices, images and availability. No cart, no ordering, no table session.
- **Ordering QR (paid):** table/counter QR ordering, kitchen routing, payments and POS.

The two use different QR kinds and routes. The existing `/t/[qr]` and `/v/[qr]` stay as the ordering QRs; a new `/m/[slug]` (or subdomain root) is the view-only menu. A Free restaurant can never create an ordering QR.

**Free dashboard:** focused on Home (menu status, QR downloads, menu views), Menu, Store design, QR codes and Settings. Paid areas appear only inside "Explore Resuto" as upgrade previews, never as disabled navigation.

**Backend changes:**
- Free plans skip the legal-name, floor and payments setup steps (`setup.service.ts` gets plan- and mode-aware required steps).
- The onboarding UI defaults to `free`.
- Fix the lapsed-trial fallback: `app.module_enabled()` grants core and the free-plan modules when a subscription is not active.
- Allow basic theme presets and logo editing on Free without the Studio module, through a new `studio_basic` entitlement scope inside core.

### 6.3 Integrations marketplace and operator console

**Marketplace:** cards with `ProviderLogo`, category filters (Messaging, Ads & tracking, Payments, POS, Accounting, Tax, Delivery & maps, AI), and an honest status chip:
- Not connected
- Connected
- Needs attention
- Sandbox
- Pending provider review
- Not yet available

**Connect method per provider** (descriptor field `connectMethod`), each with a matching guided UI:

| Method | Providers |
|---|---|
| `oauth` ("Continue with Facebook / TikTok / Snapchat / Foodics") | Meta Pages, Meta Ads, TikTok Ads, Snap Ads, Foodics |
| `embedded_signup` | WhatsApp Cloud |
| `guided_onboarding` | ZATCA (OTP stepper), ETA |
| `api_key` (under "Advanced", with instructions and "where do I find this?") | CAPI pixels, Paymob, Moyasar, Stripe, Wafeq, Qoyod, Odoo, Resend, Twilio, Google Routes, Gemini BYOK |
| `platform_managed` | Vercel domains |

**Connection detail sheet:** capabilities enabled and missing (from `readiness.ts`), missing requirements (App Review, business verification, ad account access), token expiry and reconnect, last successful sync, health history, logs, disconnect.

**Copy rule:** an OAuth login never claims capabilities that need provider review. The copy comes from readiness states.

**Real-integration definition of done (per provider, not per card).** Each provider must have:

1. **Authorization** with the supported method:
   - OAuth with bound state, PKCE where offered, and a token exchange;
   - or embedded signup;
   - API keys only where the provider offers nothing else.
2. **Account / asset selection** where relevant: Page, IG account, ad account, WABA and number, pixel, Foodics business, payment merchant account.
3. **Permission verification:** granted scopes are read back and compared with the scopes required per capability, so a missing scope shows as "needs permission X".
4. **Health:** a scheduled check (existing `scheduledHealth`), last success, last error, and token expiry with refresh (refresh tokens where offered; otherwise an expiry warning plus a reconnect prompt).
5. **Reconnect** keeps the connection history; **disconnect** revokes provider-side where the API allows and seals or deletes the stored tokens.
6. **Tokens:** sealed with the key ring, never returned to the browser, and rotatable.
7. **Capability acceptance:** each capability (send template, receive webhook, sync orders, post CAPI event, create payment…) has an acceptance check in `scripts/providers/acceptance.mjs`. It is recorded per environment, and the UI state "verified" comes only from recorded runs.

Until credentials and provider approvals exist (O-6), each capability shows "Implemented, verification pending".

**Operator console** (`/admin/providers`):
- A new `platform_provider_apps` table, sealed with the key ring.
- It holds app id, secret, config id, webhook verify token and environment per provider. The existing environment variables become the fallback.
- Platform role only.
- It shows the redirect/webhook URLs to register with each provider, and a readiness checklist sourced from `INTEGRATION_READINESS.md`.

### 6.4 Resuto Studio workspace

**Layout:**
- **Toolbar:** page switcher, device (desktop/tablet/phone), EN/AR, undo/redo (a client history stack over draft operations), save state, preview, publish, version history.
- **Left:** Pages / Sections / Assets (media library plus food photos) / Templates.
- **Centre:** canvas — a sandboxed iframe rendering `SiteView` from the draft with `postMessage` selection. It replaces the inline aside.
- **Right:** inspector — content, layout, typography, colours, spacing, SEO, with section-level and site-level tabs.

**Templates:** 6 style families × variants built from the existing 11 section kinds plus new kinds (`promo_banner`, `offers` (products plus discount badges), `social`, `faq`, `menu_full`).

**Tiers (entitlement scopes):**

| Tier | Includes |
|---|---|
| `studio_basic` (Free) | Presets, logo, colours, social links, menu-only site |
| `studio` (Growth) | Sections, pages, banners, advanced styling, SEO, domains |
| `studio_advanced` (Pro) | Theme tokens editor, custom CSS variables (validated, no arbitrary JS), structured-data overrides |

**AI-assisted editing:**
- Example: "Add an Eid offers section with these 3 products at 15% off."
- The request goes to the change-set engine (§6.8), which produces typed ops (`website.section.add`, `promotion.create`, `product.discount.set`).
- The canvas shows a visual before/after diff, validation (discount bounds, products exist and are in the tenant, permissions), then approve (MFA if it touches prices) → apply → publish.
- The same engine serves MCP.

**SEO/AEO/GEO panel:**
- Schema.org `Restaurant`, `Menu` and `Offer` JSON-LD generated from data.
- Sitemap and hreflang.
- Local listing checklist.
- An "AI answer readiness" checklist: FAQ section, structured hours, menu text present.

### 6.5 Inbox workspace and Customer 360

**Layout:** a full-height `WorkspacePage` at `/inbox`. Channels and Templates move into Settings › Messaging.

- **Left pane:**
  - search, channel filter chips with logos, views (Mine, Unassigned, Open, Leads, Ordering), priority, tags;
  - virtualised list;
  - unread state and SLA timer.
- **Centre pane:**
  - thread with day separators, media, delivery state, the existing 24-hour window badge;
  - order cards (from `ordering_sessions` and orders);
  - composer with saved replies (`/` trigger), templates, internal notes (activating `messages.kind='note'`, staff-only, never sent);
  - AI suggested reply (draft only, labelled, the human sends);
  - quick actions: create order link, payment link, reservation.
- **Right pane:** Customer 360.
  - Identity and identities, consent per channel with source and time.
  - Totals, AOV, favourite items, visit cadence.
  - Acquisition source, recent orders, reservations, loyalty, campaigns received.
  - Tags and notes.

**Keyboard:** j/k to move, r reply, n note, a assign, e close, ⌘K actions. Polling becomes conditional (ETag/304 already in place) at a 4-second interval only while the thread is visible.

**Backend:**
- `conversation_tags`, `saved_replies`.
- Note sending path (`kind='note'`, excluded from sender jobs).
- `GET customers/:id/360`, aggregating `customer_stats`, top items, attribution, conversations and loyalty under RLS, with the `customers:read` permission.

### 6.6 MCP experience (Phase 1B)

**Connection wizard** (`/mcp/new`, replaces the form):

1. **Choose assistant.** Each client card shows its auth method honestly:

   | Client | Method shown | Notes |
   |---|---|---|
   | Claude.ai / Claude Desktop custom connector | OAuth 2.1 | Labelled "verified" only after a live test is recorded |
   | ChatGPT connectors | OAuth | Labelled "verified" only after a live test is recorded |
   | Other / developer | Connection key | |

2. **Authorize.** For OAuth clients: copy the server URL, the assistant opens `/dashboard/mcp-authorize`, and the user approves with MFA. For key clients: the key is shown once, under Advanced.
3. **Restaurant and branches.**
4. **Permission groups.** These map to tool sets, are filtered by role and entitlement, and the raw tool list sits under Advanced:
   - read orders and analytics
   - customers
   - menu
   - website drafts
   - website publish
   - promotions
   - campaigns prepare
   - send approved messages
   - payment links
   - operations
5. **Approval policy per group:** auto / requires approval / blocked, with risk defaults:
   - anything that spends money, changes prices or sends messages needs approval;
   - discounts over a threshold need an owner;
   - optional second approver.
6. **Review, expiry, test call** (runs `get_restaurant_profile`) and done.

**New write tools** (each with zod input, tenant-scoped, idempotency key, preview):
- `update_menu_item`, `set_item_price`, `toggle_availability` (existing, renamed alias kept)
- `create_promotion`, `draft_website_change`, `publish_website_revision`
- `create_reservation`, `update_order_status` (operational, role-bound)

**Server rules:**
- All sensitive tools go through change sets (§6.8).
- Approve requires MFA (`@RequireMfa`, closing a current gap).
- The approval TTL comes from the policy.
- Enforce `mcp_calls_per_month`.
- MCP sessions move from memory to stateless or DB-backed, so the server can scale horizontally.

**Prompt-injection safeguards:**
- Tool outputs mark customer-authored text as untrusted (`untrusted: true` fields) and are never interpreted server-side.
- Write tools only accept typed params, never free text that becomes code or SQL (`query_data` stays bounded).

**UI:**
- "Approvals" becomes a cross-feature approvals inbox in AI & Apps › Copilot, covering MCP, Studio AI and campaigns.
- Before/after diff, approve/reject with reason, notification plus optional email/WhatsApp to the approver (once a provider is configured).
- Activity timeline per connection (`mcp_tool_calls`).
- Revoke, expiry badges.

### 6.7 CRM, growth and funnels

- **First touch:** `customers.first_touch` (channel, campaign, link id, timestamp), set once on the first identified interaction, from `attribution_events`.
- **Funnel events:** write `page_view` (sampled), `qr_scan`, `add_to_cart` and `checkout_started` from guest pages through a beacon endpoint. It is rate-limited and stores no personal data, and is consent-aware for tracking pixels (the existing consent library).
- **Funnels view (Insights):** visits → QR scans → messages → leads → orders → repeat. Each step is labelled with its data source and completeness.
- **Segments:** reuse the rule engine, with the segment builder UI inside Customers.
- **Retention:** cohort heatmap; repeat-purchase curve.
- **Consent:**
  - Messaging a business does **not** set marketing consent. Only explicit opt-in events do, in the existing `customer_consent_events`.
  - Facebook comments and WhatsApp chats show as "contact allowed for service replies only".

### 6.8 Shared change-set engine (backbone of 1B and the Studio AI work)

**Tables:** `change_sets` (org, origin `mcp|studio_ai|copilot|staff`, actor, status `draft → validated → pending_approval → approved → applied | rejected | expired | invalidated`, policy snapshot, digest) and `change_ops` (typed op, target, before, after).

**Behaviour:**
- **Registry:** typed op handlers in the API, each with `validate()` (zod plus domain rules plus permission), `preview()`, `applyLocal(tx)` and an optional `effect()`.
- **Stale-data checks:**
  - Every op records the target's version (`updated_at` or a revision counter) and the `before` values at proposal time.
  - Approval and apply re-read the targets under `SELECT … FOR UPDATE`. If anything changed, the change set is `invalidated` and must be re-proposed. It is never silently merged.
  - The preview digest is bound to the approval (existing behaviour).
- **Concurrency:**
  - A transaction-level advisory lock per change set and per target (in a stable order to avoid deadlocks).
  - A state machine with conditional `UPDATE … WHERE status = 'approved'`, so apply runs once even under parallel approves or retries.
- **Idempotency:** a client idempotency key per proposal; apply keyed by change-set id; each external effect carries its own provider idempotency key (`<changeSetId>:<opId>`) wherever the provider supports it.
- **Local vs external effects.** Database transactions cannot atomically commit third-party API actions, so the engine uses a transactional outbox:
  - **Local ops** (menu, prices, website draft or publish, promotions) commit in one transaction under RLS.
  - **External ops** (send WhatsApp/email, create a provider payment link, push to Foodics or ads) are written in that same transaction as `pending_effect` rows. They are executed afterwards by the job runner with retries and backoff.
  - Per-op status: `pending_effect → succeeded | failed | needs_attention`.
  - The change set reports `applied`, `partially_applied` or `failed` honestly.
  - Compensation is explicit: a reversible effect gets a reverse action; an irreversible one (a sent message) is flagged for human follow-up. Nothing is reported "done" before the provider confirms.
- **Audit:** an `audit_logs` entry per transition and per op (actor, origin, approver, before/after, effect result, request id).
- **Tests:**
  - concurrent approve races;
  - stale target → invalidated;
  - replayed apply → no-op;
  - effect failure → `partially_applied` with the local part kept and visible;
  - cross-tenant op refused;
  - RLS negative tests.

**Migration:** the existing `mcp_approvals` binding logic moves into it, keeping scope snapshot and digest checks. Current tools keep working through an adapter.

### 6.9 WhatsApp onboarding

**Official path (default).** A guided stepper in Customers › Inbox › Connect WhatsApp:

1. Connect with Facebook (Embedded Signup, existing).
2. Choose number and branch.
3. Ordering flow setup: the structured bot from `ordering.service.ts`, with branch selection, fulfilment, menu link and payment method.
4. Templates and language (prefilled from the template library).
5. Staff routing (assignment rules: round-robin or by branch).
6. Test conversation: a new "send test template to my phone" action, plus a live inbound check.
7. Activate.

Status chips reflect Meta review and the number's state.

**QR compatibility mode (stays on the roadmap; gate G-WA).** It runs in two stages.

- **Stage 1 — allowed now: isolated research and proof of concept.**
  - Work happens in `research/wa-qr/` plus an `apps/wa-bridge` prototype that is not wired into the API or web build, and is excluded from deploys.
  - Only Resuto-owned test numbers are used. There are no restaurant accounts and no customer data.
  - The deliverable is a written policy/security assessment covering:
    - the WhatsApp Terms position on unofficial clients;
    - number-ban risk and observed stability;
    - session storage and hijack risk;
    - the consent and data-protection duties;
    - an operating cost estimate;
    - a recommendation.
- **Stage 2 — only after your explicit approval of that assessment:** productisation under the constraints below. It is never activated for real restaurant accounts or production before then.

Constraints for stage 2:

| Constraint | Detail |
|---|---|
| Process | A separate `apps/wa-bridge` process, isolated and never in the API process |
| Library | Linked-device protocol library chosen during the assessment |
| Session storage | Encrypted with the key ring |
| Availability | Operator flag off by default; per-restaurant opt-in screen with an explicit high-risk disclosure and owner acknowledgement (stored) |
| Allowed traffic | Inbound plus one-to-one service replies only. Bulk or marketing sends and templates are disabled. Strict rate limits |
| Labelling | "Unofficial" everywhere, never the default, never pre-selected |
| Exit | A one-click migration path to the official path |
| Rollout | Ships last in 1C. Never enabled for real customers without your explicit go-ahead |

---

## 7. Proposed entitlement matrix (for approval — not enforced until approved)

The `free/starter/growth/pro/custom` plans already exist in the database. The table below is a proposal for their feature contents; there are no prices.

| Capability | Free (QR menu) | Starter | Growth | Pro |
|---|---|---|---|---|
| Restaurant profile, logo, theme presets, social links | ✓ | ✓ | ✓ | ✓ |
| Digital menu + menu QR posters, path URL | ✓ (1 menu) | ✓ | ✓ | ✓ |
| Subdomain (if O-1 provided) | ✓ | ✓ | ✓ | ✓ |
| Branches / staff seats | 1 / 2 | 1 / 5 | 3 / 15 | 10 / 50 |
| Menu import (CSV/xlsx), assisted extraction | CSV/xlsx; extraction 3/mo | ✓ | ✓ | ✓ |
| Online ordering, table QR ordering, KDS, floor | — (preview) | ✓ | ✓ | ✓ |
| Payments (online) | — | ✓ | ✓ | ✓ |
| Inbox + WhatsApp/Messenger/IG | — | 1 channel | ✓ | ✓ |
| Customers 360, segments | basic list | ✓ | ✓ | ✓ |
| Marketing campaigns, loyalty, ads integrations | — | — | ✓ | ✓ |
| Studio sections/pages/SEO, custom domain | — | — | ✓ | ✓ |
| Studio advanced theme | — | — | — | ✓ |
| Delivery & drivers | — | — | ✓ | ✓ |
| Finance, P&L, exports; Compliance (ZATCA/ETA) | — | basic exports | ✓ | ✓ |
| Analytics & intelligence | 7-day basic | 30-day | full | full + forecast |
| AI requests / month | 0 | small | medium | large |
| MCP connections | — | — | — | ✓ |

Exact limits are left as parameters for you to fill in. A lapsed paid plan falls back to Free, never to nothing.

**Locked-state UX:** areas appear in "Explore Resuto" with a preview screenshot, three benefits and an "Upgrade to X" CTA. There are no disabled controls scattered through pages.

---

## 8. Roadmap, workstreams and acceptance criteria

### Ownership rules

- **Shared foundation:** `packages/ui`, tokens, `nav.ts`, `DashboardShell`, the `packages/contracts` lite/index exports, and migrations are owned by one foundation workstream at a time. Others consume them.
- **Agent isolation:** each parallel agent works in its own worktree branch (`ws/21-*`) and merges into `claude/relaxed-mayer-omkl3f` after the full local suite plus review.
- **Contract changes:** additive only on `/v1`. Breaking changes need a new route plus a deprecation header, documented in `docs/api/openapi.json` (drift test exists) and a new `docs/api/CHANGELOG.md`, so the iPad track stays compatible.

### Increment rules

- **Size:** each WS is split into increments of ≤ ~1–2 days of change. Each increment has passing tests, a code review (independent reviewer agent), and a green GitHub CI on the branch before the next one builds on it.
- **Existing behaviour:** existing E2E scenarios and API suites must stay green at every merge.
- **Security:** continuous testing — every new endpoint or table ships with negative authorization and RLS tests in the same increment, and `/security-review` runs on each merged WS.

### 1A — Foundation (sequential core, then a parallel page migration)

| WS | Scope | Acceptance |
|---|---|---|
| 21-POSAPI (starts first, parallel to DS) | API contracts for Codex's iPad track: device registration/auth with branch scope, delta sync of menu, floor, tables and orders with cursors, idempotent order/payment submit keyed by client UUIDs, kitchen routing and printer-job events, conflict rules (server authoritative for prices and availability). Published in `docs/api/openapi.json`, plus `docs/api/CHANGELOG.md` and `docs/api/IPAD_COMPATIBILITY.md` (a dependency and compatibility checklist: each endpoint the iPad needs, its status draft/stable, version, tests, and breaking-change policy) | Contract tests; OpenAPI drift test; additive-only check in CI; checklist kept current on every API change; **cross-platform acceptance test (below)** |

**21-POSAPI cross-platform acceptance test.** It is backend-side, on this branch. It runs first with a simulated iPad client (a scripted device in `apps/api/test/pos-flow.test.ts` plus a Playwright spec), then with the real iPad build when Codex has one.

**The flow, end to end:**

1. The device (registered, branch-scoped token) creates an order with a client UUID.
2. The API validates it (prices and availability are server-authoritative) and persists it.
3. Web Orders and the Dashboard overview show it (polling/ETag cursors and the event feed).
4. The KDS receives the ticket and the kitchen changes its status.
5. The iPad (via the sync cursor or event stream) and the web both reflect the new status.
6. Payment captured against the order, inventory depletion and analytics rollups are consistent (they reconcile with the order totals).

**Covered cases:**

| Concern | What the test checks |
|---|---|
| Event delivery | A per-branch ordered event feed with sequence numbers; at-least-once delivery with client dedupe |
| Reconnection | Resume from the last sequence, with a gap triggering a full resync |
| Offline replay | A queued order is replayed after reconnect; a duplicate submit with the same client UUID returns the original order (idempotent) |
| Conflicts | A price or availability change while offline is rejected, or repriced with an explicit conflict response; concurrent status changes use version checks |
| Permissions | A device scoped to branch A cannot read or write branch B or another restaurant (negative tests); revoked devices are refused |

**Coordination:** contracts are agreed with Codex through `docs/api/IPAD_COMPATIBILITY.md`, kept current on every change. No other workstream waits for the iPad app.
| 21-DS | Token tiers, aliases, dark-ready values; typography scale; spacing/radius/elevation; motion tokens; `Icon` and `ProviderLogo`; new components (Sheet, Popover, Menu, Tooltip, Combobox, Switch, Segmented, MoneyInput, `DataTable` v2, `FilterBar`, `Stat` v2, unified chart kit, `LockedFeature`, states) | Unit tests per component (EN/AR, RTL snapshot, keyboard); contrast script passes AA for all token pairs; bundle budget passes; `tokens-baseline` ≤ current |
| 21-SHELL | 7-area IA, collapsible sidebar, `SectionNav`, ⌘K palette (routes, actions, records search via a new `GET o/:id/search` endpoint over orders/customers/menu), shortcuts plus cheat sheet, account menu, single branch context (remove 9 `BranchSelect`s), mobile bottom bar, per-area `loading.tsx`/`error.tsx`, free-plan shell | `lib/shell.test.ts` extended: every current route reachable within 2 clicks or ⌘K; role landing unchanged; E2E keyboard-only navigation spec; first-load JS of staff routes ≤ 220 kB |
| 21-MIGRATE | Migrate all staff pages to page templates and semantic tokens (parallel by area after DS+SHELL merge) | inline-styles and hex baselines reduced ≥ 70 %; visual baselines re-recorded EN/AR × desktop/phone for ~20 key screens |

### 1B — MCP (after 21-DS/SHELL)

| WS | Scope | Acceptance |
|---|---|---|
| 21-CS | Change-set engine (§6.8), migration of `mcp_approvals` binding, approvals inbox UI | API tests: validate, preview, approve (MFA), apply-once, stale digest → invalidated, cross-tenant op refused, idempotent replays; RLS negative tests on the new tables |
| 21-MCP | Wizard, permission groups, approval policies, new write tools, MFA on approve, `mcp_calls_per_month`, DB/stateless sessions, activity timeline | MCP SDK E2E: OAuth connect → read → write requiring approval → approve in UI → executed → audit row; "Eid section + 3 products at 15 %" scenario E2E passes end to end on staging; client compatibility table updated only from recorded live tests |

### 1C — Core experience (parallel workstreams once 1A merges; 21-CS before AI Studio)

| WS | Scope | Acceptance |
|---|---|---|
| 21-HOME | Command centre (§6.1), overview/attention APIs, preferences | Each widget shows provenance; period/compare/branch E2E; no metric without a data source |
| 21-ONB | Free QR onboarding (§6.2), presets, social links, menu QR posters, xlsx import, lapsed-trial fallback fix, plan-aware setup | E2E: signup → published menu → QR downloaded in ≤ 10 steps on phone and desktop; DB test: lapsed trial keeps core |
| 21-MENU | Menu workspace merge (menu + import) | Bulk edit, availability, reorder E2E |
| 21-STUDIO | Canvas workspace, templates, tiers, AI editing via change sets, SEO/AEO panel, JSON-LD | Iframe isolation test; AI proposal → diff → approve → publish E2E; structured-data validator test |
| 21-INBOX | Three-pane Inbox, notes, tags, saved replies, Customer 360 API/panel | Keyboard E2E; notes never sent (test on the sender job); 360 RLS negative test |
| 21-INT | Marketplace, connect methods, provider logos, connection sheet, operator console, WhatsApp official stepper + test send | Each provider card's status derived from readiness; OAuth flows unchanged and passing existing tests; operator console platform-role-only test |
| 21-CRM | First touch, funnel beacons, funnels/cohorts views, segment builder | Beacon rate-limit test; consent rules tests; funnel numbers reconcile with raw events in test fixtures |
| 21-OPS | Orders, Kitchen, Floor/Host/Reservations, Delivery, Inventory redesign | Existing E2E scenarios (dine-in, driver, WhatsApp, owner) green on Chromium and WebKit |
| 21-MONEY | Payments, Finance, Compliance, Billing & plan (entitlement matrix after approval) | Plan-change E2E; locked states visible, not disabled controls |
| 21-INSIGHTS | Analytics + Intelligence unification, saved reports | Chart kit only; drill-down from Home |
| 21-ADMIN | Admin console restyle + providers | — |
| 21-WAQR | Stage 1: isolated research/PoC and the assessment (any time in 1C). Stage 2: productisation **only after your approval** | Stage 1: the assessment document, the PoC excluded from builds and deploys. Stage 2: isolation, disclosure, opt-in and rate-limit tests; disabled by default |

### 1D — Stabilisation

- Full E2E on Chromium and WebKit; visual regression EN/AR × desktop/tablet/phone for all key screens.
- axe-core accessibility scan in Playwright on every staff route (zero serious/critical).
- Lighthouse/Web Vitals on key routes with recorded before/after.
- A comprehensive threat-model-driven security assessment (§9). It covers MCP actions and approvals, the change-set engine and its external effects, tenant isolation/RLS, OAuth and provider credentials, payments and webhooks, public endpoints (QR, beacons, search, ordering) and every new table. Findings are fixed or documented as accepted risks with your sign-off.
- Docs and handoff refresh.
- Staging redeploy plus smoke, MCP and demo integrity checks.

---

## 9. Testing, accessibility, performance and security strategy

**Tests:**
- Keep every existing suite and guard.
- Add component tests in `packages/ui` (vitest, jsdom).
- Add new policy tests:
  - no physical CSS directions in migrated files;
  - every route has `loading`/`error`;
  - every nav item resolves;
  - every icon comes from `Icon`.
- Add Playwright: keyboard navigation, ⌘K, Inbox, Studio, onboarding, MCP approval; axe on each route.

**Performance:**
- Bundle budgets stay enforced and are not raised. New libraries need a budget proof.
- Charts and motion are CSS/SVG.
- Studio canvas and xlsx parsing are lazy chunks.
- Measured LCP/INP before/after in `docs/PERFORMANCE.md`.

**Security** (threat model doc `docs/security/THREAT_MODEL_2.1.md`, STRIDE per surface):

| Area | Work |
|---|---|
| Change sets and MCP | Server-side policy, MFA approval, typed ops, untrusted-content marking, per-tool rate limits, `mcp_calls` quota |
| Auth | Require MFA for owners/admins on sensitive routes (configurable); server-side password policy via a Supabase hook if available, else documented; Cloudflare Turnstile (free) on signup and public forms (owner prerequisite O-2) |
| Session | Evaluate moving the access token from `localStorage` to an httpOnly cookie plus CSRF token; decision recorded |
| CSP | Narrow `img-src` to the storage host, provider CDNs and the custom-domain set |
| Rate limiter | Fail closed for auth-sensitive routes when the store is unavailable |
| Staging DB role | Switch staging to `resuto_api` (owner-approved step, O-3) |
| New tables | RLS plus negative tests for every new table (change_sets, change_ops, conversation_tags, saved_replies, user_preferences, platform_provider_apps, theme presets) |
| Public surfaces | Beacon and search endpoints abuse-tested; QR tokens unguessable (existing) |
| Supply chain | `pnpm audit` gate (exists); lockfile review on new deps; no postinstall scripts on new deps |
| Docs | Refresh the stale `SECURITY_MODEL.md` gaps; unresolved risks listed explicitly. Passing tests are not treated as proof of security |

---

## 10. Native iPad — parallel track (executed by Codex on `feature/ipad-pos`; this track never edits it)

**Scope:** waiter ordering, table-side bill and split, cashier/POS, optional kiosk, live sync, kitchen routing, receipt printing, offline tolerance.

**This track's contribution:** the 21-POSAPI contracts:
- device auth with branch scope;
- delta sync endpoints with cursors;
- idempotent order/payment submission keyed by client UUIDs;
- conflict rules (server authoritative for prices and availability);
- printer-job and kitchen-routing events.

All of it lands in OpenAPI plus `docs/api/CHANGELOG.md`.

**Printing research for Codex:**
- ESC/POS over TCP 9100 (network printers).
- Epson ePOS SDK and Star StarXpand/StarPRNT SDKs (Bluetooth/LAN/USB via MFi).
- Not every Bluetooth printer works; only an MFi-certified or vendor-SDK list is supported.

**Timing:** Codex develops in parallel from now. Integration and release of the iPad app depend on the 21-POSAPI contracts being marked stable in `IPAD_COMPATIBILITY.md` and validated against staging. Neither track blocks the other.

---

## 11. Owner prerequisites and open inputs

| ID | Item |
|---|---|
| O-1 | Root domain with wildcard DNS for restaurant subdomains (otherwise path URLs only) |
| O-2 | Cloudflare Turnstile site key (free) for signup protection |
| O-3 | Approve switching staging `DATABASE_URL` to `resuto_api` |
| O-4 | Approve the §7 entitlement matrix and fill in limits |
| O-5 | G-WA: review and sign the QR-mode risk assessment |
| O-6 | Meta / TikTok / Snap developer apps and review; provider test credentials (existing blockers B-3 … B-21). Integrations remain "implemented, verification pending" until then |
| O-7 | Brand: confirm the accent colour hex and provide logo source files (SVG) |

## 12. Verification (per increment and at the end)

1. **Local:**
   - `pnpm --filter @resuto/contracts build test`, integrations test
   - `node --test supabase/tests/*.test.mjs`
   - `pnpm --filter @resuto/api test` (plus restricted role)
   - MCP tests, web unit, web build, `node scripts/ui/bundle-budget.mjs`
   - `pnpm e2e` (Chromium), axe spec
2. **GitHub CI green on every merge:** all four jobs, with WebKit included.
3. **Staging:**
   - redeploy (Vercel CLI plus the 3 Render services);
   - `EXPECT_COMMIT=<sha> node …/run-checks.mjs scripts/staging/smoke.mjs scripts/staging/mcp-check.mjs`;
   - a new staging check for the change-set "Eid section" flow and the free onboarding flow.
4. **Evidence:** EN/AR desktop and phone screenshots of every redesigned screen in a private gallery artifact; performance before/after; updated `docs/TEST_RESULTS.md`, `RESUME.md`, `HANDOFF.md`.
