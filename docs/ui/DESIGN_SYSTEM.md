# Resuto design system (2.1)

The design system is `packages/ui` (`@resuto/ui`) plus the generated token file. This document covers the foundation that
workstream 21-DS added: token tiers, the type, space and motion scales, the components, and the rules for using them.
Plan reference: `docs/plans/RESUTO_2_1_PLAN.md` §4.

- **Tokens:** `docs/ui/design-tokens.json` → `node scripts/ui/build-tokens.mjs` → `packages/ui/src/tokens.css`. Never
  edit `tokens.css` by hand; `lib/tokens-policy.test.ts` fails when it is stale.
- **Component styles:** `packages/ui/src/ds.css`, imported once by `apps/web/app/globals.css` right after the tokens.
  The pre-2.1 components keep their styles in `globals.css` and `styles.tsx`.
- **Contrast:** `node scripts/ui/contrast.mjs` checks every text/background pair against WCAG 2.2 AA in light and dark
  (CI: `node --test scripts/ui/test/*.test.mjs`).
- **Tests:** `packages/ui/test/*.test.tsx` (vitest + jsdom). They run inside the web suite (`cd apps/web && npx vitest run`),
  which CI already runs.

## 1. Tokens

### Tiers

| Tier | Selector | What it holds | Use in components |
|---|---|---|---|
| `primitive` | `:root` | Raw scales: `--neutral-0…950`, `--brand-50…950`, `--sand-*`, status hues (`--green-*`, `--amber-*`, `--red-*`, `--blue-*`, `--violet-*`), identity accents (`--ember-*`, `--herb-*`, `--gold-*`, `--sky-*`, `--lime-*`, `--plum/teal/berry/olive-*`), type, space, radius, motion, z-index | No (only to define semantic tokens) |
| `semantic` | `:root, [data-theme='light']` | Roles: surfaces, text, borders, accent, focus, status, charts, elevation | **Yes** |
| `dark` | `[data-theme='dark']` | The same roles for the dark theme | Automatic |
| `alias` | `:root, [data-theme]` | Every pre-2.1 name (`--ink`, `--muted`, `--card`, `--line`, `--nav-text` …) mapped onto a semantic token or primitive step | Existing code only; migrate to semantic names |
| `component` | `:root, [data-theme]` | Domain palettes that are not roles: floor table states (`--state-*`, `--zone-*`), landing identity lines, sign-in panel (`--login-*`), code blocks, shell metrics, font stacks | Their own surfaces |
| `ar` | `html[lang='ar'], [lang='ar']` | Arabic type adjustments | Automatic |

Aliases and component tokens are re-declared on every `[data-theme]` element: custom properties inherit computed values, so
an alias declared only on `:root` would keep the light value inside a dark subtree.

**Dark mode** is defined and contrast-checked but not exposed (owner decision: it ships for the staff dashboard after
light is complete). To preview it, set `data-theme="dark"` on `<html>` in dev tools. Pages that still use per-element
aliases for backgrounds (for example `.btn-primary` on `--ink`) need their 21-MIGRATE pass before dark is offered.

### Semantic roles

| Role | Tokens | Light | Notes |
|---|---|---|---|
| Page background | `--bg` | sand-50 `#faf9f5` | Guest pages and `body` |
| Surfaces | `--surface-1` (cards, panels), `--surface-2` (table heads, input groups), `--surface-3` (app canvas, wells), `--surface-warm`, `--surface-hover`, `--surface-selected` | white, neutral-25, neutral-50, sand-100, neutral-50, neutral-100 | |
| Text | `--text`, `--text-strong` (headings, brand ink), `--text-secondary`, `--text-muted` (AA 4.5:1 on every surface), `--text-subtle` (3:1: large or non-essential text only) | neutral-800, brand-800, neutral-700, neutral-600, neutral-500 | |
| Borders | `--border`, `--border-subtle`, `--border-strong` (3:1: control outlines, switch tracks) | neutral-150, neutral-100, neutral-500 | |
| Accent | `--accent`, `--accent-hover`, `--accent-fg`, `--accent-soft`, `--accent-soft-fg` | brand-800 `#173f36` (the staff primary button), brand-600, white | The brand hue is unchanged |
| Focus | `--focus`, `--focus-soft` | herb-600 `#4d8a3a` (3:1 on every surface) | Was `#9bc76a` (1.8:1) |
| Status | `--ok/warn/danger/info/pay/sandbox` + `-bg` / `-fg` (`--sandbox-border`) | the existing status colours | `--ok`, `--warn` … remain as aliases of `-fg` |
| Charts | `--chart-1…8`, `--chart-grid`, `--chart-axis` | ember, herb, gold, sky (unchanged), plum, teal, berry, olive | Each 3:1 on `--surface-1` |
| Elevation | `--elevation-1/2/3` | the former `--shadow-card/-float/-sheet` | |
| Overlay | `--overlay` | brand-900 at 40 % | Dialog and sheet backdrops |

### Scales

- **Type:** `--fs-xs 12`, `--fs-sm 13`, `--fs-md 14` (body), `--fs-lg 16`, `--fs-xl 18`, `--fs-2xl 20`, `--fs-3xl 24`,
  `--fs-4xl 30`, `--fs-5xl 36` (px). Arabic: +1 px at the body sizes (13/14/15/17) and `--lh-body` 1.6 (Latin 1.5);
  `--lh-heading` 1.3 (Arabic 1.45). Weights `--fw-regular/medium/semibold/bold`. Every number uses
  `font-variant-numeric: tabular-nums` (`.num`); Western digits are enforced by `lib/digits-policy.test.ts`. The older
  `--t-xs…--t-field` scale (11.5–15 px) is kept verbatim for the pages that use it.
- **Space:** a 4 px grid, `--space-1` (4 px) … `--space-12` (48 px). The pre-2.1 `--space-1…4` (8–32 px) had no users and
  now follow the grid.
- **Radius:** `--radius-1` 6 px (controls, chips), `--radius-2` 10 px (panels, inputs, popovers), `--radius-3` 14 px
  (sheets, feature cards), `--radius-full`. The older `--radius`, `--radius-sm/md/lg` keep their values.
- **Elevation:** `--elevation-1` (resting card), `--elevation-2` (popover, tooltip, toast), `--elevation-3` (sheet, dialog).
- **Motion:** `--dur-fast` 150 ms, `--dur` 200 ms, `--dur-slow` 280 ms; `--ease-out` (the existing `--ease`),
  `--ease-in-out`, `--ease-spring-ish` (switch thumb only).
- **Layers:** `--z-popover`, `--z-tooltip`, `--z-toast`. Dialogs and sheets use the browser's top layer.
- **Breakpoints** (media queries cannot read custom properties): phone < 700 px, tablet 700–1100 px, desktop > 1100 px.

### What changed for existing names

Every old name still resolves. These now resolve to a slightly different colour (largest RGB channel change in brackets):

| Token | Before | Now | Why |
|---|---|---|---|
| `--accent` | `#f0b298` (peach) | `#173f36` | Now the semantic brand accent. The peach moved to `--accent-warm`; its one use (`website.css` variant border) was repointed. |
| `--focus` | `#9bc76a` | `#4d8a3a` | AA non-text contrast (1.8:1 → 3.8:1) |
| `--muted`, `--nav-text`, `--th-text`, `--stat-label`, `--pill-text`, `--fine-text`, `--file-text`, `--guest-link`, `--subtle` | `#66716a`…`#7a857e` | `--text-muted` `#666e66` [≤ 24] | Several were below 4.5:1 |
| `--faint`, `--nav-label`, `--profile-sub`, `--mode-note-end`, `--stat-unit` | `#8b958e`…`#9ba49e` | `--text-subtle` `#7f8982` [≤ 28] | Were 2.3–2.9:1 |
| `--green`, `--leaf-text`, `--nav-active-text`, `--file-btn-hover` | brand greens | `--accent` / `--accent-soft-fg` / `--accent-hover` [≤ 16] | One accent family |
| `--line`, `--nav-hover`, `--btn-hover`, `--chip-bg`, `--chip-line`, `--nav-badge`, `--file-hover-bg`, `--pill-bg`, `--nav-active-bg`, `--leaf-bg`, `--ink` | near neutrals | nearest neutral step [≤ 13] | Onto the scale |


## 2. Components

All components take visible text through props or a `labels` override, and fall back to built-in English and Arabic
defaults chosen by the page language (`UiLocaleProvider`, set by the web app's `LocaleProvider`) or a `locale` prop.

| Component | File | Use it for | Notes |
|---|---|---|---|
| `Icon`, `DIRECTIONAL_ICONS` | `icon.tsx` | Every icon | Lucide, one module per icon (see §3) |
| `NAV_ICONS`, `NavIcon` | `nav-icons.tsx` | Navigation and module names | Same keys as `NAV_GLYPHS`; the shell switches in 21-SHELL |
| `ProviderLogo`, `PROVIDER_LOGOS` | `provider-logo.tsx` | Integration cards, connection sheets | See §4 |
| `Sheet` | `sheet.tsx` | Long forms, inspectors, mobile actions | Native `<dialog>`; `side="end"` (reading end), `"start"`, `"bottom"`; sizes sm/md/lg/xl. Prefer it to `Modal`/`Drawer` in new code |
| `Popover` | `popover.tsx` | Filters, column pickers, small forms | Escape and outside press close; `align="start"/"end"` is logical |
| `Menu` | `popover.tsx` | Row and page action menus | WAI-ARIA menu button: roving focus, arrows, Home/End, type-ahead, Escape returns focus |
| `Tooltip` | `popover.tsx` | Short descriptions of icon buttons and truncated values | Never the only label of a control |
| `SegmentedControl` | `controls.tsx` | 2–5 mutually exclusive views | Radio group; arrows mirrored in RTL |
| `Switch` | `controls.tsx` | Settings that apply at once | Native checkbox with `role="switch"` |
| `Combobox` | `controls.tsx` | Picking one of many (suppliers, items, customers) | ARIA 1.2 combobox; matching ignores case, diacritics, hamza forms and Arabic-Indic digits |
| `MoneyInput` | `controls.tsx` | Amounts | Integer minor units in and out; accepts Arabic-Indic digits and separators (`normalizeNumericInput`), `parseMajor` from contracts |
| `PhoneInput` | `controls.tsx` | Phone numbers | LTR in both languages; returns E.164 via `normalizePhone` |
| `Kbd` | `controls.tsx` | Shortcut hints | LTR key names |
| `DataTableV2`, `useCursorPagination` | `data-table.tsx` | Lists | See below. The original `DataTable` is unchanged |
| `FilterBar`, `useSavedViews` | `filter-bar.tsx` | The row above a list | Saved views, search, controls, removable chips |
| `StatV2`, `ProvenanceBadge`, `provenanceFromMetaKind` | `stat.tsx` | KPI tiles | Value, unit, delta, sparkline, provenance |
| `EmptyState` (+ `icon`, `secondary`) | `base.tsx` | Empty lists and sections | Old markup unchanged without the new props |
| `LockedFeature` | `locked-feature.tsx` | Modules outside the plan | Inert preview, benefits, upgrade action |
| `ListPage`, `DetailPage`, `WorkspacePage`, `BoardPage`, `SettingsPage` | `templates.tsx` | Page layouts | Regions only; content stays in the page. `BoardPage` lanes carry `data-lane` and take `boardRef`, `label`, `footer` (21-OPS: drag and drop on the Orders board and kitchen display, `components/ops/KanbanBoard`) |
| Chart kit | `charts/` | All charts | See §5 |
| `Loadable` (+ `fade`) | `states.tsx` | Skeleton → content | Opt-in 120 ms fade |
| `withViewTransition`, `prefersReducedMotion`, `staggerStyle` | `motion.ts` | Route and pane changes | See §6 |

### DataTableV2

```tsx
<DataTableV2 label={t('orders.title')} rows={rows} rowKey={(o) => o.id}
  columns={[
    { key: 'ref', header: t('orders.ref'), render: (o) => <OrderRef … />, rowHeader: true },
    { key: 'total', header: t('orders.total'), align: 'end', render: (o) => <Money … />, sort: (a, b) => a.totalMinor - b.totalMinor },
    { key: 'channel', header: t('orders.channel'), render: …, defaultHidden: true },
  ]}
  rowHref={(o) => `/dashboard/${orgId}/orders/${o.id}`} renderLink={(href, children, cls) => <Link href={href} className={cls}>{children}</Link>}
  selectable bulkActions={(ids, clear) => <button className="btn btn-sm" onClick={() => markPaid(ids).then(clear)}>…</button>}
  columnToggle densityToggle
  pagination={{ hasNext: !!data.nextCursor, hasPrev: pager.hasPrev, onNext: () => pager.next(data.nextCursor), onPrev: pager.prev }} />
```

- Same column shape as `DataTable` (`key`, `header`, `render`, `align`), so a page migrates by renaming the import.
- Rows are reachable by keyboard: with `rowHref` the row-header cell holds a real link whose hit area covers the row; with
  `onRowClick` the row is focusable and Enter/Space activate it.
- Client sorting with `sort` comparators; server sorting with `sortKey` + `sort`/`onSortChange` (the API's keyset cursors
  stay valid because the page re-queries).
- The header row is sticky inside a scroll box (`maxHeight`, default 70vh). Under 700 px rows become label/value cards,
  as the original table does.

## 3. Icons

- Lucide (`lucide-react@1.53.0`, ISC). Import one icon per module so only those icons ship:
  `import Search from 'lucide-react/dist/esm/icons/search.mjs'` and render `<Icon icon={Search} />`. The type
  declaration for these paths is `packages/ui/src/lucide-icons.d.ts` (reference it with `/// <reference path>`).
- Decorative by default (`aria-hidden`); pass `label` for a meaningful icon. Icon-only buttons still need `aria-label`.
- Direction: icons in `DIRECTIONAL_ICONS` (chevrons, arrows, external link, undo/redo, send, log in/out, panels, bike,
  truck …) get `.rui-icon-dir` and are mirrored under `[dir='rtl']`; `mirror` overrides.
- Cost (measured with esbuild, gzip): Lucide's shared runtime ≈ 1.6 kB, then ≈ 0.1 kB per icon; the full `NAV_ICONS`
  map (35 icons) ≈ 5.7 kB. Nothing imports `Icon` yet, so today's routes pay nothing. The shell switch (21-SHELL)
  must fit the staff budget (220 kB, largest route 216.6 kB before 21-DS); it should remove the glyph code and split
  the nav map if needed. The fallback, if the budget cannot be met, is an inline SVG set built from the same path data.
- The glyph policy (`lib/glyph-policy.test.ts`) still applies: no colour emoji in staff code.

## 4. Provider logos

Files: `apps/web/public/brand/providers/` (served from Resuto's own origin, cached a day). They identify configurable
services and imply no partnership; trademarks belong to their owners. Review each brand's guidelines before launch.

| Provider | Asset | Source |
|---|---|---|
| Meta, Facebook, Instagram, Messenger, WhatsApp, TikTok, Stripe, Odoo, Google Maps, Gemini, Resend, Vercel | `<id>.svg` | Simple Icons 16.35.0 (CC0 path data), in the brand colour Simple Icons lists |
| Snapchat | `snapchat.svg` | Simple Icons ghost mark in black (Snap yellow is unreadable on light surfaces) |
| X | `x.svg` | Simple Icons X mark in black (21-ONB social links) |
| Website (social links) | `../social/website.svg` | Lucide `globe` path data (ISC), not a logo |
| Foodics | `foodics.svg` | The official Foodics wordmark already vendored for the landing page (`legacy/ASSET_SOURCES.md`) |
| Paymob | `/landing/logo-paymob.png` | The official Paymob PNG already served by the landing page |
| Moyasar, Wafeq, Qoyod, ZATCA, ETA, Twilio | none | **Need official artwork.** Drawn as a neutral monogram until it is added (`needsOfficialAsset`) |

Guest pages show a restaurant's social links with `components/guest/SocialIcons.tsx` (the view-only menu `/m`, the
site `/r` and storefronts): these marks on a light 44 px chip, the network's name as the accessible label.

To add an official asset: put the file in `public/brand/providers/`, set `src`, `aspect` and `source` in
`PROVIDER_LOGOS`, and record the source here. Do not draw or approximate a logo.

## 5. Charts

One kit (`packages/ui/src/charts/`, one module per chart so a page ships only what it renders) replaces `apps/web/components/charts` and
`intelligence/_components/charts.tsx`; both now re-export or adapt it, so existing imports keep working.

`LineChart`, `AreaChart`, `BarChart` (grouped), `BarList` (`items` or `rows`, optional toggle rows, single or
categorical palette), `DonutChart`, `FunnelChart`, `Heatmap`, `Sparkline`, `ForecastChart`, `SeriesLegend`,
`ChartLegend`, `ChartTable`, `chartColor`, `niceScale`.

- Inline SVG, no library. Every chart has a text alternative (`role="img"` + title, or a list) and a values table.
- Colour: one magnitude = `--chart-1`; current vs comparison = `--chart-1` + `--chart-4`; categories cycle 1–8.
- Interaction: hover and arrow keys (mirrored in RTL), Home/End, Escape; the tooltip shows the exact value.
- Motion: lines draw in once (stroke-dash on `pathLength=1`), bars grow from zero once. Values are never animated past or
  counted up to their real value. With reduced motion the final state shows at once.
- RTL: pass `rtl`; time runs right to left and the value axis sits on the right. Chart SVG text is laid out left to right
  and anchored by physical coordinates.
- Provenance: wrap a chart's figures with `ProvenanceBadge` / `MetaPanel`; never chart data that has no source.

## 6. Motion

- CSS only, `transform` and `opacity` only. Classes in `ds.css`: `.motion-fade-in`, `.motion-slide-up`,
  `.motion-slide-in-end` (mirrored in RTL), `.motion-scale-in`, `.motion-content` (skeleton → content and value changes,
  120 ms cross-fade).
- `withViewTransition(update)` wraps a route change or pane swap in the View Transitions API where the browser has it and
  motion is allowed, and otherwise runs `update` directly. The root cross-fade lasts `--dur`.
- `prefers-reduced-motion: reduce` turns everything off: the global rule in `globals.css` plus explicit rules for the
  view-transition pseudo-elements and transitions in `ds.css`. `useReducedMotion()` (display.tsx) is the React hook.
- No animation library.

## 7. RTL

- Logical properties only: `margin-inline`, `padding-inline-start`, `inset-inline-end`, `border-inline-start`,
  `text-align: start|end`, `border-start-start-radius`. `lib/logical-css-policy.test.ts` rejects physical left/right
  properties in every `packages/ui/src` file; a genuinely physical value (an SVG x coordinate) carries `logical-exempt`.
- Transforms do not flip by themselves: mirror them under `[dir='rtl']` (sheets, slide-ins, switch thumb, bar origin).
- Arrow keys in horizontal groups follow the reading direction (`horizontalStep`, `isRtl`).
- Phones, codes, shortcuts and Latin identifiers stay LTR (`PhoneInput`, `Kbd`, `Ltr`, `Phone`, `Code`); user text uses
  `UserText`/`<bdi>`.
- Western digits everywhere: format through `@resuto/contracts` (`INTL_LOCALE`, `numberFormat`), never a raw `ar-*`
  locale. Every component test renders Arabic and asserts no Arabic-Indic digits.

## 8. Accessibility

- Contrast: AA by construction for the semantic pairs (`scripts/ui/contrast.mjs`). Use `--text-subtle` only for large
  or non-essential text.
- Focus: the global `:focus-visible` ring uses `--focus`; custom widgets keep a visible ring (rows, menu items, options).
- Dialogs and sheets are native `<dialog>` (focus trap, Escape, inert page) and return focus to their opener.
- Keyboard: menus, segmented controls, comboboxes, tables and charts are fully operable without a pointer.
- Live regions: selection counts and tooltips use `aria-live`/`role="status"`; toasts are unchanged.
- Targets: `--touch-target` (44 px) for operations screens; controls are 32–44 px tall.

## 9. Usage rules

1. New code uses semantic tokens (`--surface-1`, `--text-muted`, `--accent` …), never primitives or hex literals
   (`lib/tokens-policy.test.ts`).
2. Prefer `Sheet` to `Modal` for forms longer than two fields; `ConfirmDialog`/`useConfirm` for confirmations.
3. Lists: `ListPage` + `FilterBar` + `DataTableV2`. Details: `DetailPage` with the inspector at the reading end.
4. KPIs: `StatV2` with a `provenance`; an unavailable source is shown as unavailable, not as zero.
5. Locked modules: `LockedFeature`, not raw permission text.
6. No inline styles in dashboard and admin pages beyond run-time geometry (`lib/inline-styles-policy.test.ts`).
7. Every new component ships with a jsdom test: English and Arabic, RTL, keyboard, no Arabic-Indic digits.
