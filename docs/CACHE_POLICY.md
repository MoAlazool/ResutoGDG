# Cache policy

Every cache in Resuto 2.0: what may be cached, where, for how long, how it is invalidated and what staleness a
user can observe. Measured effects are in `docs/PERFORMANCE.md`. Rule of thumb: **tenant data is never stored by a
browser disk cache, proxy or CDN**; only guest-facing public data and immutable assets are, and every cached copy
has a validator or a bounded lifetime.

## 1. HTTP: API responses (`apps/api`)

| Response | Cache-Control | Validator | Notes |
|---|---|---|---|
| Every staff/tenant route (`/v1/o/:orgId/...`), auth, guest session routes, admin | `private, no-store` (hardening middleware default) + `Vary: Authorization, ...` | weak ETag from Express (`If-None-Match` → 304 works when a client sends it) | Never stored by a shared or disk cache (PCL-04). CSV exports also `no-store`. |
| `GET /v1/public/menu/:slug`, `GET /v1/public/order/:slug` | `public, max-age=15, s-maxage=30, stale-while-revalidate=60, stale-if-error=600` | `W/"pm<shape>-<menu version>-<image URL window>-<org+branch hash>"` (`po…-<online pay flag>` for web order) | PCL-15. The ETag changes exactly when the response can change (below). A matching `If-None-Match` gets 304 with no body. |
| `GET /v1/public/sites/...` | `public, max-age=30, stale-while-revalidate=120` | Express weak ETag | Published site revisions; Next.js also revalidates the page every 30 s and on publish (`revalidateTag`). |
| `GET /v1/media/*` (local storage driver) | guest images (`<org>/menu/…`, `<org>/studio/…`): `public, max-age=<seconds until the URL expires>, immutable`; documents (receipts, delivery proofs, licences): `private, max-age=<same>, immutable` | none needed (immutable) | Object keys are random and never overwritten, so content behind a URL never changes. |
| Supabase Storage objects (production driver) | guest images uploaded with `cache-control: max-age=31536000` | — | Served through signed URLs that are stable per window (section 3). |
| `GET /v1/health` | `private, no-store` | — | |

**Compression (PCL-24).** Compressible bodies (JSON, text, CSV, SVG) of 1 kB or more are sent with Brotli (quality
4) when the client accepts it, else gzip; `Vary: Accept-Encoding`. Streamed bodies, `HEAD`, 204/304, bodies that
already carry an encoding and `Cache-Control: no-transform` pass through. If the hosting edge also compresses, it
leaves already-encoded responses alone.

**Conditional GET.** Every JSON GET carries a weak ETag computed on the uncompressed body, so `If-None-Match` works
for compressed responses too. The staff web client still sends staff polls with `cache: 'no-store'` until the API has
shown its no-store policy (apps/web/lib/api.ts, PCL-03) and does not send `If-None-Match` itself; teaching pollers to
revalidate (skip re-render on 304) is web-client work tracked as a follow-up, not done in this workstream.

### When the public menu ETag changes

`menu_versions.version` (migration `20261020080005`) is bumped in the same transaction as any change guests can see:

- any insert/update/delete of `menus`, `menu_categories`, `products`, `product_modifier_groups`, `modifier_groups`,
  `modifier_options`, `branches`;
- `product_branch_settings` when a product is offered or not, its branch price changes, or **stock crosses zero**
  (an order that decrements stock from 7 to 6 does not invalidate anything; the sale of the last unit does);
- `organizations` name, Arabic name, currency, slug or status;
- `media_assets` path, derivatives or dimensions (e.g. the derivative backfill).

The image URL window (one UTC day for menu images) is part of the tag, because the signed URLs inside the body roll
over once a day. A response-shape constant is part of the tag so a deploy that changes the payload never revalidates
an older cached copy.

The tag is not a hash of the body, so it is only given to a **complete** menu. When some image URLs could not be
signed (a transient storage failure; those images come back as `null`), the menu is not put in the built-menu cache,
carries no versioned ETag and is sent with `Cache-Control: no-store`, so neither a browser nor a CDN keeps an
image-less menu for the rest of the version and URL window; the next request rebuilds it.

**Observable staleness:** a guest (or CDN) may show a menu up to 15 s (30 s at a shared cache) old, plus up to 60 s
while it revalidates in the background, and up to 10 min only when the API is failing. Price and availability are
always re-checked server side when an order is quoted and placed, so a stale menu can never sell at a stale price.

## 2. HTTP: web app (`apps/web`)

| Path | Cache-Control | Why |
|---|---|---|
| `/_next/static/*` | `public, max-age=31536000, immutable` (Next.js default) | content-hashed by the build |
| `/fonts/*` | `public, max-age=31536000, immutable` | WOFF2 files carry a content hash in their name (`scripts/perf/fonts/convert-woff2.py`); a changed font gets a new name (PCL-22) |
| `/brand/*`, `/landing/*` | `public, max-age=86400, stale-while-revalidate=604800` | stable names referenced directly by pages; renaming them to hashed names would touch page components (owned elsewhere) |
| other `public/` files | Next.js default (`public, max-age=0`, revalidated) | |
| HTML pages | dynamic (per-request CSP nonce from middleware) | never shared-cached |
| Landing plan prices (server fetch) | `next: { revalidate: 300 }` | public price list |
| Restaurant site data (server fetch) | `next: { revalidate: 30, tags: ['site:<slug>'] }`, purged on publish | |

The static `Cache-Control` rules sit in `next.config.ts` `headers()` next to the security headers; the CSP rule is
unchanged.

## 3. Signed media URLs (PCL-14, PS-18)

- **Stable within a window.** Expiry = the window boundary after next (`stableExpiry`): every request in the same
  window gets the identical URL, valid for at least the TTL and at most twice it. Menu and studio images use a
  24-hour window (one URL per UTC day), site imagery 6 hours, the studio library 1 hour, receipts 10 minutes,
  delivery proofs and licences 15 minutes. Browsers and CDNs therefore reuse downloads instead of re-fetching every
  photo on every visit.
- **One signing call per response.** `MediaUrls` collects every image of a response and signs them in one batch
  (`POST /storage/v1/object/sign/<bucket>` with all paths) **after the database transaction has committed**. Signed
  Supabase URLs are cached per instance per window (bounded, 20k entries, dropped a minute before they expire). A
  failed batch leaves images out of that response instead of failing the page, and `resolve()` reports it so the
  public menu is not cached (section 1). Helpers that run inside a transaction (menu `loadProducts`/`publicMenuFor`,
  site `prepare`/`mediaMap`, the studio editor view) only collect URLs; `test/side-effects-guard.test.ts` checks
  transaction callbacks and every function with a `tx: Tx` parameter for signing, uploads and provider calls.
- **Derivatives (CR-12).** Menu and studio uploads store WebP copies at 320/640/1280 px (never wider than the
  original). The public menu's `imageUrl` is the smallest copy at least 640 px wide (the original when none is),
  `imageSrcSet` lists all copies and
  `imageWidth`/`imageHeight` give the original's size for reserving space. The `media.derivatives` job backfills
  media recorded without copies; an object that is missing (404) is marked checked, one whose read fails transiently
  (5xx, 429, timeout) stays unchecked and is retried after a 30-minute cool-down. Guest pages adopting `srcset`/`width`/`height` is web work (follow-up).

## 4. In-process caches (API)

All in-memory caches are per instance and size-capped (`BoundedCache`: LRU + TTL, PCL-25). None is the source of
truth; each has a short TTL that bounds cross-instance staleness.

| Cache | Key | Size cap | TTL | Invalidation | Cross-instance staleness |
|---|---|---|---|---|---|
| Entitlements | org + module | 20,000 | 15 s | `invalidate(orgId)` on plan changes (local) | ≤ 15 s |
| Tenant suspension (platform tooling) | org | 20,000 | 10 s | `invalidate(orgId)` (local) | ≤ 10 s; tenant routes re-check status on every request in AccessGuard |
| Built public menus | org + branch + menu version + URL window | 1,000 | 60 s | key changes with the version (database-wide) | none: the version comes from the database on every request |
| Supabase signed URLs | path + window | 20,000 | until a minute before expiry | key changes with the window | none (each instance signs its own) |
| Rate-limiter windows | key | ~40,000 (pruned) | window | — | limits are per instance (documented in rate-limiter.ts) |
| Web middleware host → slug | host | 5,000 | 60 s hit / 30 s miss | — | ≤ 60 s after a custom domain changes |

Cross-instance invalidation through Postgres `LISTEN/NOTIFY` (or Redis when `REDIS_URL` is set) is not implemented:
with TTLs of 10–15 s the staleness is bounded and only affects plan changes. It is a follow-up for when the API runs
more than one instance.

## 5. Database read models (freshness policy)

| Read model | Maintained by | Freshness | Repair |
|---|---|---|---|
| `customer_stats`, `customer_branch_stats` (PCL-17) | triggers on `orders`, same transaction | exact at commit | daily `customers.stats-reconcile` recomputes customers whose orders changed in 26 h and logs drift |
| Analytics daily rollups `analytics_*` (PCL-26) | triggers mark a day `stale` in the same transaction; `analytics.rollup-refresh` (every 60 s, 200 days per run) recomputes stale days | **reports are always exact**: a day is read from its rollup only while it is not stale and older than local today − 3; every other day is read live from orders | daily `analytics.rollup-reconcile` rediscovers days and recomputes the three most recent rolled days per branch, logging drift; a timezone change drops the branch's rollups |
| `menu_versions` (PCL-15) | triggers, same transaction | exact at commit | — |

Rollups only change how fast a report is, never its numbers: until the refresh job has caught up (for example right
after deploying migration `20261020080003`, or after a timezone change) the affected days are read live.

## 6. What is deliberately not cached

- Staff and tenant API responses in any shared cache, CDN or browser disk cache.
- Guest session data (QR visit, bill, order status): private, polled.
- Payment pages and webhooks.
- **Realtime (PCL-23)**: screens poll (KDS every 2 s with a delta cursor, Orders every 5 s, guest QR about 24 requests a minute). Push "change ticks"
  over SSE need a stream endpoint plus client changes in `apps/web/lib/use-api.ts` and the polling screens, which are
  outside this workstream; with compression, open-order indexes and the KDS delta cursor a poll costs about a
  millisecond of database time (docs/PERFORMANCE.md). Deferred, not started.
