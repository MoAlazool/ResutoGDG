# Resuto legacy: UI inventory and design system

Source: `legacy/public/` (vanilla ES modules plus 17 stylesheets, all loaded by `legacy/public/index.html` on every page).
The structured token file is [`design-tokens.json`](./design-tokens.json). Baseline screenshots are in [`baseline/`](./baseline/) (see §4).

---

## 1. Screens

All pages share one SPA shell. `entry.js` chooses a module by path. The server only rewrites `<head>` and sets `<html lang dir>` (`legacy/seo.js`).

### Public and marketing

| Route | Purpose | Module / CSS | Key components | Interactions |
|---|---|---|---|---|
| `/` | Marketing landing ("Run the room. Resuto runs everything else.") | `landing.js` + `landing-stage`, `-kitchen`, `-manager`, `-reserve`, `-bill`, `-pricing`, `-import`, `-import-data.js`; `landing.css`, `landing-demos.css` | Sticky nav with language switch and "Open the live demo" CTA. Hero with a live "Service view" floor demo and service feed. "Not seven tools. One order, followed all the way through." grid. Chaptered sections: 01 Floor Studio, 02 Reservations, kitchen, bill split, manager, import. Integration arc with provider logos (`company-logos.js`, `brand-marks.js`). Pricing teaser and FAQ. | Click tables in the demo floor; auto-playing chapter demos with pause buttons; scroll reveals (IntersectionObserver); a 1.5 s demo ticker |
| `/pricing` | Plans and comparison | `pricing.js`, `plan-comparison.js`; `pages.css`, `platform.css` | Plan cards (Starter 799, Growth 1499, Pro 2999, Business on quote; EGP per month), feature comparison table with yes/no/planned/quote cells, add-ons, Foodics comparison, FAQ, Business sales-inquiry form | Monthly display; inquiry form POST `/api/sales-inquiry` |
| `/account` | Owner sign-up/sign-in (Firebase) | `account.js`, `firebase-client.js`; `account.css` | Email/password and Google sign-in, restaurant bootstrap (name, branch, plan, slug), staff invite | Firebase popup; `localStorage['resuto-restaurant-id']` |

### Guest

| Route | Purpose | Module / CSS | Key components | Interactions |
|---|---|---|---|---|
| `/restaurant` | Demo restaurant home page ("The Olive Room") | `guest.js` → `pages.js` `restaurantPage`; `pages.css`, `experience.css` | Hero photo, branch info, entry points to Menu, Reserve and Order | Navigation |
| `/menu`, `/order` | Menu-first online ordering (pickup/delivery). `/order` shows the open visit's status when a token exists, otherwise the menu. | `guest.js`; `experience.css`, `guest-chat.css` | Restaurant header, branch chip, "Help me choose" AI assistant card, dish search, category pill tabs, dish cards (photo, Vegetarian tag, description, price, "+ Add"), sticky cart bar (View bill, View cart, total, count), product sheet with modifiers, checkout form, order timeline, rating form | Add/remove items, product sheet quantity, AI chat (budget, party, Arabic text parsing), checkout (demo or provider), 2 s live status polling |
| `/t/:qr` | Table QR dine-in | `guest.js` | Same menu with the table label and PIN-free join; bill view; split builder (full, equal, custom, items); share rows with links, WhatsApp share and QR; waiter/bill request buttons; receipts | Auto-opens the visit on scan; order, request the bill, split, pay (simulated) |
| `/s/:token` | Split-share participant payment | `guest.js` (`screen='share'`) | Share amount, restaurant and branch, name field, pay button, rating | Pay share (demo or checkout), rate |
| (`screen='receipt'`) | Digital receipt | `receipt.js`; `receipt.css` | Paper receipt with tooth edge, barcode SVG, items, totals, split context, print and share actions | Animated print-in (`receipt-*` keyframes), print, share text |
| `/reserve` | Table booking | `reservations.js`; `booking.css`, `floor-system.css` | 3-step accordion: (1) date strip, guest stepper and quick-pick chips, Dinner/Lunch toggle, time-slot buttons with "N free"; (2) floor map with feature filters and table picker; (3) name and contact. Sticky summary bar with "Choose a table →" CTA. Confirmation ("Your table is booked") and deposit. | Slot select, table select on SVG, filter chips, hold → simulated deposit |
| `/burger` | Second demo storefront, "Smash & Co" | `burger.js`, `burger-art.js`; `burger.css` | Red/yellow brand header, hero, menu grid with photos (`assets/smash/*.webp`), cart (`sessionStorage['smash-cart']`) | Order pickup or delivery for the `burger` branch |

### Staff

| Route | Purpose | Module / CSS | Key components | Interactions |
|---|---|---|---|---|
| `/manager` (signed out) | Staff login | `app.js`; `style.css`, `platform.css` | Role-scoped password form ("Password", "Sign in") and Google sign-in (Firebase) | POST `/api/login` → HttpOnly cookie |
| `/manager` | Manager workspace | `app.js`, `manager-platform.js`; `style.css`, `platform.css`, `data-workspace.css`, `floor-system.css` | Fixed 250 px sidebar: wordmark, restaurant chip, "Workspace" nav with Unicode glyph icons and count badges. Top bar: "Service workspace", Live updates, date. Tabs: **Overview** (KPI tiles for revenue, active tables, orders today and satisfaction; live floor SVG with status legend; AI "Operational insights"; station load; low stock), **Floor overview** (select a table → side panel to seat, close or clean), **Reservations**, **Active visits**, **Orders**, **Menu & inventory** (item editor, metadata, modifiers, images), **Inventory**, **Customers**, **Payments**, **Analytics** (ratings breakdown), **Branches**, **Integrations** (provider cards), **Import & export**, **Settings** (service model, durations, deposit, delivery, QR print sheet). Footer: "Payments are simulated · EGP". | Tab switch, modals and confirm dialogs, CSV import preview, AI extraction review, 2 s revision polling (paused on data, integrations and inventory) |
| `/manager/floor-editor` | Floor Studio | `floor-editor.js`, `floor-shared.js`, `floor-model.js`, `owner-import.js`; `floor-editor.css`, `floor-system.css` | Toolbar (add table round/square/rectangle, zones, walls, doors, windows, counters, plants and more), SVG canvas `#studio-canvas` (1200×800 units, grid pattern), inspector (label, capacity, zone, features, reservable, minimum spend, premium, internal notes), background image controls, template (12 tables), AI floor import | Drag, rotate, resize, snap; validation messages; save with `baseRevision` (409 keeps the draft); export draft |
| `/manager/setup` | Guided setup | `setup.js`; `pages.css`, `platform.css` | Left step list (8 steps with check circles), progress bar "1 / 8", step card, Back and "Save & continue →", "Continue setup later →" | Revision-protected saves |
| `/kitchen` | Kitchen display (KDS) | `app.js` (role `kitchen`), `kitchen-dnd.js` | Columns New orders / Preparing / Ready to serve / On the way / Completed with counts. Ticket card: `#001`, time, table, line qty chips, dish, station, note (amber), primary action ("Start preparing", "Mark ready", "Mark served/picked up"). Service requests panel. | Click the action or drag the card between columns (version-checked) |
| `/host` | Front desk | `app.js` → `host.js` | KPI tiles (Tables free, Seated now, Booked today, Needs you), "Available tables" floor SVG, Free right now list, Arriving today, Open bills, Service requests, "+ Seat a walk-in" | Seat walk-in, check in a reservation, mark clean, resolve request |

The floating `العربية` / `EN` language switch (`.staff-language`) is fixed at the bottom-right on staff pages.

---

## 2. Design system

The full token values are in `design-tokens.json`.

### 2.1 Color

There are **three overlapping palettes**, all built on deep "service green" with warm ivory:

- **Brand** (`landing.css` `.lp`, `booking.css` `.bk`):
  - **Inks:** ink `#0C2620`, ink-2 `#061713`, ink-3 `#123A31`.
  - **Surfaces:** paper `#FCF9F3`, sand `#F3ECE0`, card `#FFF`.
  - **Lines:** line `#0c26201f`, line-soft `#0c262012`.
  - **Text:** muted `#57685F`, muted-2 `#7F8E86`.
  - **Accents:** **ember `#C85E33`** / ember-2 `#E8875A` (hospitality, danger/edit links), **herb `#6F9A4C`** ("go", focus ring), gold `#B8893A`, sky `#5A8598`.
- **Workspace** (`platform.css :root`, the staff and guest app): ink `#163d34` (`experience.css` sets `#173f36`, which is also `theme-color`), paper `#faf9f5`, muted `#747c74`, warm `#efe9df`, accent `#f0b298`, line `#e1e5dd`.
- **Legacy base** (`style.css :root`): text `#25382f`, bg `#f6f7f8`, green `#204f43`, border `#e5e9e6`, lime `#e6efce`. This is the active-nav pill tint, also visible as the light-green selected state.
- **Per-surface palettes:**
  - **Receipt:** paper `#fffefb`, ink `#233b31`.
  - **SaaS pages:** ink `#143d31`, accent `#ceef94`.
  - **Burger brand:** red `#b51218`, yellow `#ffd52f`, cream `#fff8ed`.
- **Semantic table states** (`floor-system.css`) are pastel fill plus darker stroke pairs:
  - **Occupied:** green `#dcebd7` / `#4d775e`.
  - **Preparing:** amber `#f7e8bf` / `#b88831`.
  - **Ready:** teal `#d3eee4` / `#168565`.
  - **Payment:** violet `#eadff3` / `#76528f`.
  - **Cleaning:** blue `#dce8f2` / `#4e7897`.
  - **Reserved:** grey `#ede9e1`, with a blue tag `#e6ecf7` / `#5d7cae`.

  This palette is the visual language of the floor, host and manager screens and should be kept.
- **No dark mode.** No `prefers-color-scheme` rules exist. The landing page uses dark sections (`#0C2620`-family, plus a near-black brown band) as a design device.

### 2.2 Typography

- **Families:** **Manrope** (Latin, variable 200-800, `fonts/manrope.ttf`) and **IBM Plex Sans Arabic**, declared as `'Plex Arabic'` (`fonts/plex-arabic.ttf` 400, `-medium` 500, `-semibold` 600, `-bold` 700-900). Both are self-hosted TTF with `font-display: swap`, and Manrope is preloaded by `seo.js`. Licenses are in `fonts/*-license.txt`.
  - **Leftovers:** `style.css` still names `Inter`, which is not shipped; `platform.css` overrides it.
  - **Other faces:** Georgia (serif accents, 12 uses) and a monospace stack (receipt amounts and codes).
- **Switching:** `[lang=ar]` swaps `--font-display` and `font-family` to Plex Arabic (`platform.css`, `landing.css`, `booking.css`, `burger.css`).
- **Scale** (`typography.css`): `--t-xs/sm/md/lg/field` = 11.5 / 12.5 / 13.5 / 15 / 14.5 px in English. Arabic gets **+1 px on every step** and heavier weights (body 500, controls 600, headings 700; `brand-refinements.css`).
- **Landing headings:** fluid `clamp()`. h1 is 48-112 px, weight 600, line-height .94, letter-spacing −.052em. h2 is 29-56 px. h3 is 19-26 px at weight 650. Eyebrow h4 is 12 px, weight 750, letter-spacing .12em, uppercase. Arabic headings reset letter-spacing to 0 and line-height to 1.22.
- **Weights in use, by frequency:** 650, 700, 600, 750, 500, 800, 900. The frequent 650 and 750 rely on the variable Manrope.
- **Staff UI sizes:** dense, mostly 11-14 px.

### 2.3 Spacing, radius, elevation

- **Spacing:**
  - `experience.css` has `--space-1..4` (.5, 1, 1.5, 2 rem).
  - The landing shell is `--shell: 1220px` with gutter `clamp(20px, 5vw, 48px)`; booking uses gutter `clamp(16px, 4vw, 40px)`.
  - The staff sidebar is 250 px (220 or 190 px at narrower widths).
  - Most spacing is literal px values, not tokens.
- **Radius:** landing `--rs 12px`, `--rm 18px`, `--rl 28px` (20 px on mobile); `--radius-card 24px`. Pills (`99px`, 51 uses) and circles (`50%`) dominate. Common literals are 8, 10, 12, 14, 16, 18 and 20 px. Primary buttons are pills (`.primary {border-radius: 99px}`).
- **Shadows:**
  - Mostly subtle: `--shadow-soft: 0 16px 48px #173f3610`, plus hairline rings `0 0 0 1px var(--line)`.
  - Dark primary buttons use `0 1px 0 #ffffff2e inset, 0 14px 28px -18px #0c2620d9`.
  - Hero device frames use long negative-spread shadows (`0 50px 80px -60px #0c262080`).
  - SVG tables use an `feDropShadow` tinted `#173f36`.
- **Focus:** `outline: 2.5px solid var(--herb); outline-offset: 3px`. A skip link is present (`index.html`).

### 2.4 Iconography

- **Staff navigation:** **Unicode glyphs**, not an icon library (`app.js const icons = {overview:'◈', floor:'▦', reservations:'▤', visits:'◉', orders:'▥', menu:'☷', analytics:'↗', integrations:'⇄', branches:'⌂', customers:'♙', host:'⌘', …}`).
- **Floor and product visuals:** hand-built **inline SVG** (`floor-shared.js` scene renderer, `landing*.js` illustrations, `burger-art.js`, receipt barcode).
- **Third-party logos:** Simple Icons data URIs (`brand-marks.js`) and `assets/logo-*.svg/png`.
- **Images:** Olive Room photos are AI-generated illustrations, disclosed in `assets/README.md`.
- **Brand mark:** `assets/resuto-icon.webp` (green rounded square with italic "r") plus the "resuto." wordmark; the Arabic wordmark is `assets/resuto-arabic-logo.*`.
- **Gap:** no consistent icon set. Arrows such as "→" and "↗" are text characters.

### 2.5 Motion

- **Easing:** the shared curve is `--ease: cubic-bezier(.22, 1, .36, 1)`, and `--motion-fast: 180ms`.
- **Transitions:** typically `opacity .3s`, `background/color .2-.3s`, and `transform .2s var(--ease)`.
- **Keyframes:** about 40 named animations.
  - Landing: `lp-*` (rise, enter, draw, pulse, scan, qr-in, paid, drawer, dock, arc-sway, tablepulse…).
  - Others: `mgr-*` (pop, draw, bump), `receipt-*` (roll, tick, shimmer, ring, spin), `bk-pop` and `bk-spin`, `studio-place`, `kds-route`, `pay-pop`, `float-payment` and `float-insight`, `imp-*`.
- **Reduced motion:** 8 stylesheets include `@media (prefers-reduced-motion: reduce)`. The landing demos auto-play with pause controls. Motion is explanatory (product demos), not decorative, as stated in the `landing.css` header comment.

### 2.6 RTL handling

- **Direction:** set by `i18n.js setLanguage()` (`document.documentElement.dir = 'rtl'`, `lang='ar'`), and server-side by `seo.js renderShell` for `?lang=ar`. The preference persists in `localStorage['resuto-language']`, and `?lang=` overrides it.
- **Logical properties** are used widely: `margin-block*` (~160 uses), `padding-block/inline`, `inset-inline-start` (33), `margin-inline-start` (39), and `text-align: start` (28).
- **Physical leftovers:** `left:`/`right:` (52) and `margin-left/right` (30) remain. About 76 `[dir=rtl]` and `[lang=ar]` override selectors patch these, for example `[dir=rtl] .sidebar {left:auto; right:0; border-left…}` and `[dir=rtl] .workspace {direction: rtl}`.
- **Fonts and scale** switch by `[lang=ar]`.
- **Numbers and money:** `Intl.NumberFormat('ar-EG')` produces Arabic-Indic digits. AI parsers accept `٠-٩`.
- **SVG floor text** is excluded from reflow (geometric positioning).
- **Staff copy** is translated after render (DOM TreeWalker in `i18n.translateLegacy`). This is a known source of untranslated strings; `scripts/premium_smoke.py` writes a review list.

### 2.7 Breakpoints

There is no shared breakpoint scale; each stylesheet has its own. The most common (max-width) values are:

| Width | Used by |
|---|---|
| 430 px | `platform`, `receipt` |
| 600 px | `landing`, `guest-chat`, `brand-refinements`, `owner-import` |
| 700 px | `style`, `platform`, `experience`, `typography`, `burger` |
| 860 px | `landing-demos` (10×) |
| 900 px | `landing`, `booking`, `style` |
| 1080 px | `landing-demos` |
| 1100 px | `style`, `platform`, `pages` |
| min-width 1600 px | `style`, `floor-editor` |

There are also 17 one-off values between 340 and 1200 px. `@media print` appears in two files (receipt). A 2.0 system should consolidate these to about 4 breakpoints: 430 / 700 / 900 / 1100.

### 2.8 Component patterns worth keeping

- KPI tile rows with large numerals and small labels.
- Pill primary buttons in dark green.
- Light-green active nav pill with a count badge.
- Status tags drawn above SVG tables.
- Kanban ticket cards with qty chips and an amber note.
- Sticky bottom summary/CTA bar (booking, cart).
- Date-strip and time-slot chips with "N free" sub-labels.
- Step accordion with a numbered circle.
- Paper receipt with a toothed edge.

---

## 3. Notable UI issues seen in the baseline

- **Fixed bars in full-page captures.** Sticky and fixed bars (the guest cart bar, the booking summary bar) appear mid-image in full-page screenshots. This is an artifact of how Playwright captures fixed elements, not a layout bug.
- **Landing sections only partly captured.** Pinned scroll-driven chapters render their resting state, and some dark chapter blocks appear mostly empty in a static capture.
- **Staff layout on mobile.** At 390 px the sidebar stacks above the content; there is no hamburger or bottom navigation.
- **Arabic landing on mobile.** The hero demo floor is clipped horizontally by design (it scrolls).

---

## 4. Baseline screenshots

**Capture setup.**
- **Script:** `tests/visual/capture-legacy-baseline.mjs`. Run it with `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/visual/capture-legacy-baseline.mjs`.
- **Server:** `legacy/server.js` on port 3200, with a throw-away `DB_PATH=/tmp/claude-0/resuto-audit/db.sqlite`, known role passwords and `PAYMENT_MODE=test`.
- **Seed data:** the demo seed plus one order (2× Burrata, 2× Hibiscus cooler) on T2 opened by QR, so the kitchen, manager and host boards show live data. Opening `/t/<T1 qr>` auto-opens T1.
- **Capture:** Chromium 1194 at desktop 1440×900 and mobile 390×844, with `deviceScaleFactor` 1, `animations: 'disabled'` and a scroll pass to trigger reveals.
- **Cropping:** full-page captures are cropped to the first 4000 px. Every file is under 3 MB.
- **Manifest:** `baseline/manifest.json` records page heights, crops and page errors (none).

| Name | Route | Desktop | Mobile | Notes |
|---|---|---|---|---|
| landing | `/` | `landing-desktop.webp` | `landing-mobile.webp` | Cropped (page is 10,128 / 13,334 px) |
| landing-ar | `/?lang=ar` | `landing-ar-desktop.webp` | `landing-ar-mobile.webp` | RTL; cropped |
| pricing | `/pricing` | `pricing-desktop.webp` | `pricing-mobile.webp` | Cropped (5,011 / 7,844 px) |
| restaurant | `/restaurant` | `restaurant-desktop.webp` | `restaurant-mobile.webp` | |
| restaurant-ar | `/restaurant?lang=ar` | `restaurant-ar-desktop.webp` | `restaurant-ar-mobile.webp` | RTL |
| menu | `/menu` | `menu-desktop.webp` | `menu-mobile.webp` | |
| reserve | `/reserve` | `reserve-desktop.webp` | `reserve-mobile.webp` | |
| order | `/order` | `order-desktop.webp` | `order-mobile.webp` | No visit token, so it renders the menu (identical to `/menu`) |
| table-qr | `/t/<T1 qr>` | `table-qr-desktop.webp` | `table-qr-mobile.webp` | Auto-opened dine-in visit |
| manager | `/manager` (signed in) | `manager-desktop.webp` | `manager-mobile.webp` | Overview tab |
| manager-floor-editor | `/manager/floor-editor` | `manager-floor-editor-desktop.webp` | `manager-floor-editor-mobile.webp` | |
| manager-setup | `/manager/setup` | `manager-setup-desktop.webp` | `manager-setup-mobile.webp` | Step 1 / 8 |
| kitchen | `/kitchen` (kitchen role) | `kitchen-desktop.webp` | `kitchen-mobile.webp` | One ticket in New orders |
| host | `/host` (host role) | `host-desktop.webp` | `host-mobile.webp` | |
| manager-login | `/manager` (signed out) | `manager-login-desktop.webp` | — | Extra |
| burger | `/burger` | `burger-desktop.webp` | `burger-mobile.webp` | Extra: second brand storefront |

**Failures:** none. Every requested capture succeeded and no page errors were recorded.

**Not captured:**
- `/account`, which needs the Firebase popup flow.
- `/s/:token` share pages and the receipt screen, which need a split or payment flow.
- Individual manager tabs other than Overview.
- Arabic variants of the staff screens.
