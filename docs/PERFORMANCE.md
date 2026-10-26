# Performance — harness, baseline and results

How Resuto 2.0 is measured, what was slow, what changed and by how much. Every number here comes from the harness in
`scripts/perf/` and can be reproduced with the commands below. Caching rules (browser, API, CDN) are in
`docs/CACHE_POLICY.md`.

**What these numbers are not.** They are single-client lab measurements on one development machine (4 vCPU, 15 GB RAM,
local Postgres 16 with 128 MB shared_buffers, shared with other workloads), used to compare code versions on identical
data. They are not production capacity, not concurrency limits and not field Web Vitals. Cold starts (process start to
first healthy response, first request per route) are reported separately from steady-state ("warm") latency.

## Harness (`scripts/perf/`)

| Script | What it does |
|---|---|
| `scale-db.mjs` | Builds a large multi-tenant copy of the demo database: copies `resuto_demo` with `pg_dump`, migrates, adds (default) 200k historical orders over 365 days for the demo tenant across its branches, 60k customers, 4 noise tenants × 12.5k orders, lines from the real menu, payments + allocations, order events, 5 published outbox events per order and 300k job runs (`sql/scale.sql`, deterministic seed). Rebuilds trigger-maintained read models afterwards (`sql/after-scale.sql`). Refuses non-local hosts and protected databases (`resuto`, `resuto_demo`, `resuto_e2e_*`). About 65 s, 1.5 GB. |
| `api-latency.mjs` | Spawns the built API (`apps/api/dist`) with the `lib/pg-probe.cjs` preload on its own port and database, measures the cold start, then per endpoint: first request after start (cold), N warm requests after 5 warm-ups (p50/p95/p99/max), DB statements per request (median, from the probe; `app` excludes begin/commit/set_config), DB time, bytes raw and on the wire, `Content-Encoding`, `Cache-Control`, and whether `If-None-Match` revalidates (304). Attach mode (`--api`) measures an already running API (e.g. staging) without the probe. |
| `lib/pg-probe.cjs` | Perf-only preload: counts statements and DB time per HTTP request at the driver and returns them in `X-Perf-Db`. `pg_stat_statements` cannot be loaded on the shared local cluster, so the count is taken in the process. Never part of the app build. |
| `explain.mjs` + `sql/explain-suite.mjs` | `EXPLAIN (ANALYZE, BUFFERS)` of the hot queries exactly as the services send them, in the member RLS context, best of 3: execution time, rows scanned (returned + filtered, over all loops), buffers, seq scans, indexes, on-disk sorts. `--assert` fails when a query breaks its budget. |
| `web-vitals.mjs` | Playwright/Chromium on a throttled mobile profile (390×844 @2x, 150 ms RTT, 1.6 Mbit/s down, 750 kbit/s up, CPU ×4): LCP, FCP, CLS, TTFB, requests and KB by type for a first visit, the same for a repeat visit in the same profile (what HTTP caching saves), and API GETs per minute while the page sits open. Median of 3 runs. |
| `fonts/convert-woff2.py` | Lossless TTF → WOFF2 conversion of the self-hosted fonts with content-hashed names (fontTools + brotli), so `/fonts/*` can be immutable. |
| `guest-shell.mjs` (+ `lib/guest-shell.mjs`) | PERF-01 guard against a running build: fetches `/order/<slug>` and `/t/<qr>` and fails unless the `<h1>` and a dish card are in the HTML itself, with no Suspense fallback, loading shell or hidden streamed segment before them (Next's empty metadata boundary does not count). The same inspector runs in the web unit tests (`components/guest/first-paint.test.ts`). |
| `snapshot-responses.mjs` | Equivalence check for refactors: saves the JSON of the touched read endpoints and compares another build against it (clock-dependent fields normalised; customer lists compared modulo the order of ties). |

### Reproduce

```bash
# 1. Data (own database; never resuto_demo itself)
node scripts/perf/scale-db.mjs --target postgres://postgres@127.0.0.1:54329/resuto_perf
# 2. API (build first: pnpm --filter @resuto/api build). env file = demo env with own PORT/DATABASE_URL/STORAGE_LOCAL_DIR
node scripts/perf/api-latency.mjs --spawn --env api.env --db postgres://postgres@127.0.0.1:54329/resuto_perf \
  --accounts demo-accounts.json --label after --n 40 --out results/api.json
# 3. Query plans (add --assert for the regression budget)
node scripts/perf/explain.mjs --db postgres://postgres@127.0.0.1:54329/resuto_perf --out results/explain.json
# 4. Web (API + `next start` running on own ports)
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/perf/web-vitals.mjs --web http://127.0.0.1:3570 \
  --api http://127.0.0.1:4570 --accounts demo-accounts.json --label after --runs 3 --out results/web.json
```

`demo-accounts.json` is the local demo account file written by `scripts/demo/load-demo-data.mjs` (owner e-mail and
password; dev login). It is not committed.

## Baseline (commit `f2b232c`, 2026-10-20)

Data: `resuto_ws6_scale` = demo + scale-up → 250,419 orders (200,419 for The Olive Room, 2 branches; 4 noise
tenants × 12,500), 625,899 lines, 70,064 customers (60,064 + 64 for the demo tenant), 242,933 payments, 1.25M outbox
events.

### API (warm, N=40 after 5 warm-ups; cold start 1,046 ms)

| endpoint | cold ms | p50 | p95 | p99 | queries (app) | db ms | bytes | Cache-Control | INM |
|---|---|---|---|---|---|---|---|---|---|
| overview | 92.5 | 102.1 | 123.3 | 136.2 | 15 (8) | 99.5 | 2,473 | private, no-store | 200 |
| analytics.summary 30 d | 789.3 | 696.9 | 833.5 | 872.3 | 17 (10) | 701.2 | 10,643 | private, no-store | 200 |
| analytics.summary 365 d | 4,449.7 | 4,552.9 | 4,903.8 | 4,903.8 | 17 (10) | 4,549.4 | 29,281 | private, no-store | 200 |
| analytics.products 30 d | 311.3 | 296.1 | 358.7 | 367.6 | 10 (3) | 294.7 | 14,351 | private, no-store | 200 |
| analytics.products 365 d | 2,919.5 | 2,582.7 | 2,924.8 | 2,924.8 | 10 (3) | 2,597.5 | 14,616 | private, no-store | 200 |
| analytics.operations 30 d | 152.8 | 121.8 | 162.9 | 231.5 | 11 (4) | 117.6 | 1,105 | private, no-store | 200 |
| orders.active, branch (polled 5 s) | 52.9 | 41.5 | 57.1 | 58.5 | 9 (2) | 38.1 | 4,601 | private, no-store | 304 |
| orders.active, all branches | 73.4 | 74.8 | 100.1 | 112.6 | 9 (2) | 71.5 | 4,601 | private, no-store | 304 |
| orders.all page 1 / page 2 | 8.0 / 8.0 | 7.0 / 7.8 | 11.4 / 11.9 | 14.4 / 14.6 | 9 (2) | 5.0 / 5.9 | 25,104 | private, no-store | 304 |
| order.detail (polled 5 s in the drawer) | 477.2 | 453.5 | 633.4 | 664.4 | 13 (6) | 458.9 | 2,156 | private, no-store | 304 |
| kds.full (polled 2 s) | 160.1 | 126.8 | 139.8 | 139.9 | 13 (6) | 124.1 | 7,005 | private, no-store | 200 |
| kds.since (polled 2 s) | 62.2 | 64.5 | 82.3 | 84.9 | 11 (4) | 61.6 | 172 | private, no-store | 200 |
| floor.live | 12.1 | 10.6 | 14.6 | 19.4 | 13 (6) | 8.6 | 2,578 | private, no-store | 304 |
| customers page 1 | 535.1 | 513.1 | 662.3 | 704.1 | 10 (3) | 510.9 | 19,909 | private, no-store | 304 |
| customers page 2 (offset) | 504.4 | 515.9 | 697.7 | 732.6 | 10 (3) | 512.5 | 19,919 | private, no-store | 304 |
| customers sort=spend | 566.3 | 516.1 | 630.6 | 681.6 | 10 (3) | 517.3 | 20,168 | private, no-store | 304 |
| customers search | 99.2 | 93.2 | 146.6 | 151.4 | 10 (3) | 90.6 | 6,299 | private, no-store | 304 |
| menu.editor | 19.3 | 12.9 | 20.1 | 25.7 | 17 (10) | 10.9 | 22,337 | private, no-store | 304 |
| payments.list | 10.1 | 6.2 | 7.4 | 12.3 | 9 (2) | 4.2 | 29,157 | private, no-store | 304 |
| public.menu | 10.0 | 5.9 | 7.8 | 9.3 | 14 (7) | 4.2 | 5,807 | private, no-store | 304* |
| public.order | 6.4 | 7.0 | 8.9 | 20.8 | 18 (8) | 5.5 | 5,874 | private, no-store | 304* |
| public.site | 10.9 | 5.6 | 7.1 | 9.7 | 13 (6) | 4.1 | 3,815 | public, max-age=30, swr=120 | 304* |

No response was compressed. *Express's automatic ETag answers 304 only while the signed image URLs inside the body
stay identical, i.e. within the same second (PCL-14): in practice every poll and every visit re-downloads the menu.
Raw results: `docs/perf-results/2026-10-20-baseline-api.json`.

### Query plans (`explain.mjs`, member RLS context, best of 3)

| id | query | exec ms | rows scanned | notes |
|---|---|---|---|---|
| Q1 | orders.active, one branch | 36.1 | 121,582 | `status::text = any(...)`: the whole branch history |
| Q1b | orders.active, all branches | 103.8 | 250,443 | seq scan of orders |
| Q4 | overview live tiles | 42.8 | 250,419 | seq scan of orders |
| Q5 | KDS change marker | 66.4 | 401,746 | |
| Q6 | KDS tickets | 51.3 | 321,985 | |
| Q7 | order detail payments (OR across LEFT JOIN) | 667.4 | 583,200 | every payment of every tenant |
| Q8 / Q8b | revenue totals 30 d / 365 d | 69.5 / 307.2 | 252,280 / 400,860 | |
| Q8c | daily series 365 d | 657.9 | 400,860 | 14.5 MB on-disk sort |
| Q9 / Q9b | products 30 d / 365 d | 277.7 / 2,839.0 | 284,908 / 789,662 | 5.7 MB / 67.5 MB on-disk sorts |
| C1 | customers page 1 | 587.2 | 310,325 | lateral aggregate over each customer's orders |
| C2 | customers count | 33.1 | 70,069 | |
| A1 | admin outbox counters | 0.02 | 0 | already on the partial index (fixed before this baseline) |

### Web (throttled mobile, median of 3)

| page | LCP ms | FCP ms | CLS | requests | KB (font / img / js / api) | repeat visit KB (img / font), from cache, 304 | API GET/min open |
|---|---|---|---|---|---|---|---|
| landing (en) | 1,944 | 1,716 | 0.022 | 28 | 791 (170 / 192 / 351 / 0) | 38 (2 / 0), 25 of 28, 2 | – |
| landing (ar) | 2,496 | 2,496 | 0.035 | 30 | 912 (279 / 200 / 351 / 0) | 42 (3 / 0), 26 of 30, 3 | – |
| public site | 1,904 | 668 | 0.107 | 25 | 471 (170 / 89 / 177 / 0) | 20 (0 / 0), 24 of 25, 0 | – |
| guest QR menu (ar) | 5,444 | 2,464 | 0.156 | 42 | 547 (0 / 311 / 196 / 10) | 341 (314 / 0), 25 of 41, 0 | 24 |
| web order (en) | 5,172 | 2,784 | 0 | 34 | 815 (68 / 518 / 195 / 6) | 240 (218 / 0), 23 of 34, 1 | – |
| overview | 3,488 | 644 | 0.123 | 41 | 362 (68 / 0 / 207 / 21) | 76 (0 / 0), 25 of 40, 0 | 0 in 20 s |
| orders | 3,244 | 660 | 0.145 | 42 | 370 (68 / 0 / 210 / 25) | 79 (0 / 0), 24 of 40, 0 | 24 |
| customers | 3,272 | 652 | 0.123 | 46 | 386 (68 / 0 / 206 / 46) | 101 (0 / 0), 24 of 45, 0 | – |
| KDS (full screen) | 2,932 | 2,932 | 0.033 | 35 | 347 (68 / 0 / 204 / 11) | 64 (0 / 0), 25 of 32, 0 | 30 |

Repeat visits re-download every menu photo (signed URL changes every second) and revalidate fonts and public images
(`max-age=0`). Raw results: `docs/perf-results/2026-10-20-baseline-web.json` (EXPLAIN: `…-baseline-explain.json`).

For reference, the audit baseline at `c1a2501` (before this programme's earlier waves) measured guest QR LCP 5.75 s /
CLS 0.156, Orders CLS 0.381, KDS tickets 245 ms (498 ms with JIT) and customers 409 ms on the same kind of data.

## After (commit `50ed79b` + `ed4501d`, 2026-10-20)

The API build measured is `50ed79b` with the derivative-selection fix committed as `ed4501d` (the harness labels
results with the HEAD of the moment, `50ed79b`). Same machine, same data (`resuto_ws6_scale`, migrated to `20261020080007`, rollups built, demo photos backfilled with
derivatives), same harness and settings as the baseline. The machine was shared with other workstreams' test runs
during both measurements; web timings in particular move by a few hundred ms between runs (see the control below).
Raw results: `docs/perf-results/2026-10-20-after-*.json`, `…-control-ttf-web.json`.

### What changed

| Item | Change |
|---|---|
| PCL-09 | Partial indexes over open order statuses; the order list compares the enum (`status = any($4::order_status[])`); KDS marker index leads with `org_id` (RLS adds `org_id = current org`) |
| PCL-16 | Order payments as a `UNION` of two index lookups |
| PCL-17 | `customer_stats` / `customer_branch_stats` read models kept exact by triggers, keyset cursors, daily drift reconcile |
| PCL-26 | Exact daily analytics rollups (stale flag set by triggers, live window today − 3, minute refresh, daily reconcile); the summary is one statement over the grain |
| PCL-28 | Explicit columns on the polled order list/detail, overview base, public branches |
| PCL-11 / PCL-12 | WhatsApp sends: claim → renew the lease (compare-and-set) → send outside any transaction → record under the renewed lease (a failed record is retried, never treated as a failed send); unusable credentials fail once; Retry-After + jitter; per-tenant fairness with priorities; campaigns in 200-recipient transactions over an audience snapshotted at start (`campaign_recipients`, migration `20261020080008`) |
| PCL-14 / PS-18 / CR-12 | Window-stable signed URLs, one batched signing call per response after commit, WebP derivatives (320/640/1280) with dimensions, media cache headers until expiry |
| PCL-15 | Versioned ETag + public caching on `/public/menu` and `/public/order`, 304 on revalidation, bounded built-menu cache |
| PCL-24 | Brotli/gzip for compressible bodies ≥ 1 kB |
| PCL-25 | All in-memory caches bounded (LRU + TTL) |
| PCL-22 | WOFF2 fonts with hashed names (immutable for a year); `/brand`, `/landing` cached a day + a week stale-while-revalidate |

### API (warm, N=40 after 5 warm-ups; cold start 925 ms, baseline 1,046 ms)

p50 / p95 in ms; queries = statements per request (application statements in brackets); wire = bytes on the wire
with `Accept-Encoding: br`.

| endpoint | baseline p50 / p95 | after p50 / p95 | queries before → after | wire bytes before → after |
|---|---|---|---|---|
| overview | 102.1 / 123.3 | 46.3 / 69.8 | 15 (8) → 15 (8) | 2,473 → 843 |
| analytics.summary 30 d | 696.9 / 833.5 | 61.4 / 89.8 | 17 (10) → 11 (4) | 10,643 → 2,575 |
| analytics.summary 365 d | 4,552.9 / 4,903.8 | 224.1 / 275.4 | 17 (10) → 11 (4) | 29,281 → 5,742 |
| analytics.products 30 d | 296.1 / 358.7 | 40.8 / 46.7 | 10 (3) → 10 (3) | 14,351 → 2,310 |
| analytics.products 365 d | 2,582.7 / 2,924.8 | 74.6 / 100.5 | 10 (3) → 10 (3) | 14,616 → 2,345 |
| analytics.operations 30 d | 121.8 / 162.9 | 103.8 / 123.6 | 11 (4) → 11 (4) | 1,105 → 592 |
| orders.active, branch (polled 5 s) | 41.5 / 57.1 | 7.3 / 10.6 | 9 (2) → 9 (2) | 4,601 → 1,114 |
| orders.active, all branches | 74.8 / 100.1 | 6.2 / 8.9 | 9 (2) → 9 (2) | 4,601 → 1,114 |
| orders.all page 1 | 7.0 / 11.4 | 7.4 / 13.8 | 9 (2) → 9 (2) | 25,104 → 3,884 |
| order.detail (polled 5 s in the drawer) | 453.5 / 633.4 | 9.5 / 15.1 | 13 (6) → 13 (6) | 2,156 → 941 |
| kds.full (polled 2 s) | 126.8 / 139.8 | 10.4 / 16.7 | 13 (6) → 13 (6) | 7,005 → 1,777 |
| kds.since (polled 2 s) | 64.5 / 82.3 | 7.9 / 14.3 | 11 (4) → 11 (4) | 172 → 172 |
| floor.live | 10.6 / 14.6 | 9.3 / 18.1 | 13 (6) → 13 (6) | 2,578 → 719 |
| customers page 1 | 513.1 / 662.3 | 23.4 / 33.2 | 10 (3) → 10 (3) | 19,909 → 3,073 |
| customers page 2 (keyset) | 515.9 / 697.7 | 20.9 / 29.9 | 10 (3) → 10 (3) | 19,919 → 3,052 |
| customers sort=spend | 516.1 / 630.6 | 20.9 / 30.3 | 10 (3) → 10 (3) | 20,168 → 3,214 |
| customers search | 93.2 / 146.6 | 88.8 / 109.2 | 10 (3) → 10 (3) | 6,299 → 1,012 |
| menu.editor | 12.9 / 20.1 | 12.7 / 16.8 | 17 (10) → 17 (10) | 22,337 → 4,450 |
| payments.list | 6.2 / 7.4 | 9.4 / 18.2 | 9 (2) → 9 (2) | 29,157 → 3,613 |
| public.menu | 5.9 / 7.8 | 2.5 / 4.4 | 14 (7) → 4 (1) | 5,807 → 2,396 |
| public.order | 7.0 / 8.9 | 3.3 / 5.4 | 18 (8) → 4 (1) | 5,874 → 2,426 |
| public.site | 5.6 / 7.1 | 6.0 / 9.3 | 13 (6) → 13 (6) | 3,815 → 1,696 |

Notes:
- Public menu/order now answer `If-None-Match` with 304 whenever the menu has not changed (the baseline only matched
  within the same second); a cache hit costs one indexed lookup (4 statements including begin/commit/settings).
  The raw public menu body grew (5,807 → 7,535 bytes) with `imageSrcSet`, `imageWidth`, `imageHeight`.
- payments.list and floor.live p95 are slightly higher; their queries did not change, and these single-digit
  millisecond endpoints sit inside the run-to-run noise of a shared machine (compression of a 29 kB body costs well
  under a millisecond). Customer search (an `ilike` over names, e-mails and phones) was not in scope and is unchanged.
- Cold (first request after start): in the measured run analytics.summary 30 d took 5,834 ms and products 30 d
  3,605 ms on the first request, right after the migration had rebuilt indexes (cold shared buffers and OS cache);
  a second spawn of the API measured 130 ms and 63 ms for the same first requests
  (`--only analytics`, N=5). Treat single cold numbers as indicative only.

### Query plans (`explain.mjs --assert`, member RLS context, best of 3; budgets pass)

| id | query | baseline ms / rows scanned | after ms / rows scanned | plan after |
|---|---|---|---|---|
| Q1 | orders.active, one branch | 36.1 / 121,582 | 0.80 / 33 | orders_open_branch_idx |
| Q1b | orders.active, all branches | 103.8 / 250,443 | 0.69 / 33 | orders_open_org_idx |
| Q4 | overview live tiles | 42.8 / 250,419 | 0.41 / 9 | orders_open_branch_idx |
| Q5 | KDS change marker | 66.4 / 401,746 | 0.87 / 423 | orders_org_branch_updated_idx + orders_open_branch_idx |
| Q6 | KDS tickets | 51.3 / 321,985 | 0.84 / 17 | orders_open_branch_idx |
| Q7 | order detail payments | 667.4 / 583,200 | 0.75 / 5 | payments_order_idx, payment_allocations_order_idx |
| Q8 | analytics 30 d | 69.5 (totals only) | 43.9 (whole summary, one statement) / 13,471 | rollups + live slices |
| Q8b | analytics 365 d | 307.2 (totals) + 657.9 (daily series, 14.5 MB disk sort) | 234.2 (whole summary) / 99,075, no disk sort | rollups + live slices |
| Q9 / Q9b | products 30 d / 365 d | 277.7 / 2,839.0 (67.5 MB disk sort) | 38.5 / 78.7, no disk sort | product rollups |
| C1 | customers page 1 | 587.2 / 310,325 | 0.67 / 103 | customer_stats_last_order_idx |
| C2 | customers total count | 33.1 | 20.2 | count over customers (no aggregate) |

### Web (throttled mobile, median of 3; two after runs)

| page | LCP baseline → after (rerun) | CLS before → after | KB before → after (font) | repeat visit KB before → after (img) |
|---|---|---|---|---|
| landing (en) | 1,944 → 2,416 (2,472) | 0.022 → 0.022 | 791 → 746 (170 → 124) | 38 → 36 |
| landing (ar) | 2,496 → 2,860 (2,944) | 0.035 → 0.035 | 912 → 834 (279 → 201) | 42 → 40 |
| public site | 1,904 → 1,896 (1,832) | 0.107 → 0.107 | 471 → 425 (170 → 124) | 20 → 20 |
| guest QR menu (ar) | 5,444 → 5,140 | 0.156 → 0.169 | 547 → 766 (0 → 222, see note) | **341 (314) → 24 (0)** |
| web order (en) | 5,172 → 4,992 | 0 → 0 | 815 → 798 (68 → 53) | **240 (218) → 18 (0)** |
| overview | 3,488 → 3,512 (3,496) | 0.123 → 0.007 | 362 → 339 | 76 → 67 |
| orders | 3,244 → 3,556 (3,452) | 0.145 → 0.145 (0.029) | 370 → 345 | 79 → 69 |
| customers | 3,272 → 3,800 (3,264) | 0.123 → 0.007 | 386 → 348 | 101 → 77 |
| KDS (full screen) | 2,932 → 2,764 (2,748) | 0.033 → 0.033 | 347 → 327 | 64 → 58 |

- **Repeat visits** no longer re-download menu photos: guest QR 341 → 24 KB, web order 240 → 18 KB (stable URLs,
  `public, max-age=<until expiry>, immutable`). Fonts and `/brand`, `/landing` images come from cache without
  revalidation.
- **Landing LCP control.** The landing pages measured slower than the baseline in both after runs. A control build
  with the old TTF fonts, measured in between (`…-control-ttf-web.json`), gave 2,448 ms (en) and 2,956 ms (ar): the
  same as WOFF2. The difference to the morning baseline is machine load, not the font format; WOFF2 saves 46 KB
  (en) and 78 KB (ar) per first visit. Staff-page LCP moves by ±300 ms between the two after runs for the same reason.
- **Guest QR fonts.** The baseline counted 42 requests but 0 font KB on this page: the four Arabic TTF downloads were
  still in flight when the measurement window (load + 4 s) closed. The smaller WOFF2 files finish inside it and are
  counted (222 KB), so the first-visit KB of this page is not comparable for fonts.
- CLS on overview and customers dropped (0.123 → 0.007) without a change to those pages; the likely cause is the
  smaller font files arriving before the dashboard content renders (fewer font-swap shifts), but no TTF control was
  run for these pages, so this is not proven. Guest QR CLS (0.156 → 0.169) and orders CLS are layout work in web
  components outside this workstream.

### Realistic photos (CR-12)

Four menu items of the demo tenant got 4032×3024 JPEG uploads (8.7–9.1 MB each, synthetic noise images; real
photos compress differently) through the API (`…-after-phone-photos-bytes.json`): each upload took 0.9–1.9 s
including derivatives, and the guest menu serves the 640 px WebP (15–18 KB for these images) with a 320/640/1280
srcset and the original's 4032×3024 dimensions. Before this change the guest menu would have served each 8.7 MB
original. With them on the menu (`…-after-web-phone-photos.json`) guest QR measured LCP 5,364 ms and web order
4,764 ms, image KB 472 (the guest page also downloads its 211 KB placeholder background, `/brand/menu-photography.webp`,
from `guest.css`). The guest cards are 80×80 CSS px, so adopting `srcset`/`sizes` (web work) would serve the 320 px
copy.

### Not done here (follow-ups)

- PCL-23 push "change ticks" (SSE): needs client changes in `apps/web/lib/use-api.ts` and the polling screens.
- Done in ws14b (REM-W01..W03): pollers send `If-None-Match` (the API exposes `ETag` to the web origin) and a 304
  keeps the same data object (useApi still renders when a poll starts and ends: open); guest menu, web order, storefront and the restaurant site highlights use
  `imageSrcSet`; the root layout preloads the locale's primary font. Still open: the connect ordering link
  (`/o/<token>`) serves `products.image_url` only (no stored copies); the kitchen board (`serverTime`, `ageSeconds`)
  and analytics (`meta.generatedAt`) change on every request, so their polls never get a 304; a lighter placeholder
  than the 211 KB `menu-photography.webp` in `guest.css`.
- Repeat-visit LCP on `/order/<slug>` and `/t/<qr>` (the loading-boundary reveal race): fixed in ws15, see
  "Guest first paint without a loading boundary (PERF-01)" below.
- Cross-instance cache invalidation (`LISTEN/NOTIFY` or Redis) once the API runs more than one instance.
- Staging measurement with this harness (attach mode) after deploy.

## Guest first paint without a loading boundary (PERF-01, ws15, 2026-10-23)

**Problem.** `/order/<slug>` and `/t/<qr>` read their menu on the server, but each route had a `loading.tsx`, so the
HTML streamed in two parts: the branded loading shell first, then the page in a hidden segment (`<div hidden id="S:0">`)
that React 19.2 swaps in with its batched reveal (`$RC`, a timer about 300 ms after the last paint). On a repeat visit
the JavaScript comes from cache and runs at once; the hydration long task delays that timer, so the heading (the LCP
element) painted only after hydration: ~1.4 s instead of ~0.3 s on the lab profile. Reproduced on `e711f39` before the
change (`guest-shell.mjs`: both pages FAIL, H1 in a hidden segment after the loading fallback; web-order repeat LCP
1,244-1,492 ms in 5/5 runs, guest-qr 1,192-1,408 ms in 4/5).

**Change** (`34b4ece`). Both route `loading.tsx` files are gone, so the heading and menu are in the first HTML chunk.
The layouts already awaited the restaurant / table read before any HTML, so the pages add only the shared menu read
(cached 30 s, refreshed in the background). A menu read that is still running after `GUEST_MENU_BUDGET_MS` (1,200 ms,
`within()` in `components/guest/server.ts`) is not waited for: the page renders its heading with the branded menu
skeleton (`MenuSkeleton`, shared with `GuestLoading`) and loads the menu in the browser, while the server read carries on
and fills the shared cache. Responsive dish photos (srcset) and the font preload are unchanged. Client-side
navigations into these two routes now keep the previous page until the server answers instead of showing the skeleton
(the other guest routes keep their `loading.tsx`).

**Measured** with `web-vitals.mjs` (390x844, 150 ms RTT, 1.6 Mbit/s, CPU x4), 5 runs per build, builds alternated
base/HEAD/base/HEAD on one machine against the same API and data (dish photos served, 91 KB), medians with all runs:

| page | build | first LCP (= FCP) | repeat LCP [runs] | CLS | first KB (js) | requests |
|---|---|---|---|---|---|---|
| web-order (en) | base A / B | 944 / 956 | **1,440 / 1,380** [1444, 1400, 1320, 1544, 1440 / 304, 1412, 1468, 1348, 1380] | 0.001 | 496 / 499 (233) | 37 |
| web-order (en) | PERF-01 A / B | 860 / 904 | **312 / 312** [304, 312, 364, 292, 348 / 352, 312, 316, 300, 304] | 0.001 | 499 / 496 (233) | 37 |
| guest-qr (ar) | base A / B | 1,084 / 1,104 | **1,356 / 1,536** [1324, 1356, 1224, 1376, 1388 / 1588, 1596, 1448, 1536, 1432] | 0.012 | 688 / 691 (244) | 46 |
| guest-qr (ar) | PERF-01 A / B | 1,080 / 1,088 | **300 / 296** [320, 300, 296, 772, 296 / 280, 688, 320, 296, 256] | 0.012 | 686 / 683 (241) | 45 |

- Repeat-visit LCP: web-order 1.38-1.44 s → 0.31 s (10/10 runs 292-364 ms); guest-qr 1.36-1.54 s → 0.30 s (8/10 runs
  256-320 ms; two runs at 688 and 772 ms, still with the H1 as the LCP element and well under every base run of this page, 1,224-1,596 ms; their cause was
  not isolated).
- First visit: web-order LCP 944/956 → 860/904 ms (the heading no longer waits for the reveal on a cold load either);
  guest-qr unchanged (1,084/1,104 → 1,080/1,088). TTFB unchanged (22-30 ms, warm server cache). CLS unchanged.
- Bytes: the loading-shell chunk is no longer loaded on `/t/<qr>` (45 requests instead of 46, 241 KB of JS instead of
  244). Bundle budget green: First Load JS `/order/[slug]` 167.7 → 167.8 kB (budget 170), `/t/[qr]` 177.1 → 177.4 kB
  (route ratchet 178): the menu skeleton is now part of the page for the slow path.
- Raw results: `docs/perf-results/2026-10-23-perf01-{base-A,head-A,base-B,head-B}.json` (`build` names the measured
  web build; `commit` is the checkout the harness ran from).

**Guards.** `apps/web/components/guest/first-paint.test.ts` (web unit tests, CI): no `loading.tsx` or `<Suspense>` on
either route path (fails when the boundary comes back), the real pages rendered to HTML carry the `<h1>` and dish
cards (English web order, Arabic QR page), and a slow menu read renders the heading and skeleton after the budget.
`scripts/perf/guest-shell.mjs --web <url> --accounts <file>` checks a running build (base: FAIL on both pages; after:
ok).

**Review follow-up (ws15 fix).**
- *Slow path on a table without a visit.* With the menu late, `/t/<qr>` loaded it in the browser only through the table
  visit (`/public/visits/current/menu`). A table not taking orders (cleaning, out of service, staff seating, branch
  closed) or a refused session has no visit, so the skeleton and "Loading…" stayed up for good. `TableExperience` now
  loads the branch's public menu (`GET /public/menu/<slug>?branch=<code>`, from the table lookup) when there is no visit
  (`app/t/[qr]/_guest/menu-source.ts`), and a failed load shows why with *Retry* instead of an endless "Loading…".
  Reproduced and fixed on a cold build with the menu tables locked for 3 s (`ws15-slowpath`): `cleaning` and
  `out_of_service` tables now show the skeleton at first paint and 8 dishes after the lock (one browser request,
  `GET /v1/public/menu/the-olive-room`, no session); the accepting table still loads through its visit.
- *The budget counts from the start of the request* (`menuBudget(requestStartedAt())`), not from the menu read: the
  layouts' restaurant / table read used to come on top of the 1.2 s. The menu read always gets at least
  `GUEST_MENU_MIN_MS` (150 ms).
- *Cold-cache first byte, measured* (web build restarted before each request, so the server cache is empty; 3 runs
  each; curl time to first byte on the same machine, no network throttling):

  | case | `/t/<qr>` TTFB | menu in HTML | `/order/<slug>` TTFB | menu in HTML |
  |---|---|---|---|---|
  | cold cache, API answering normally | 66-84 ms | yes | 70-76 ms | yes |
  | cold cache, menu tables locked 3 s (slow menu read) | 1,235-1,268 ms | no (skeleton, loaded in the browser) | 2,537-2,556 ms | no |

  Trade-off: on a cold cache with a slow menu read, the first byte of `/t/<qr>` now waits up to the 1.2 s budget,
  where the base flushed its loading shell right after the table read (the API answers that read in 7-16 ms here) and
  revealed the page when the menu arrived (about 2.7 s into this run). The base build was not re-measured for this
  table; the reviewer observed that shape on base. FCP is therefore later on that path (about 1.2 s instead of
  roughly 0.1 s), while the
  first paint is the real page (H1, cover, table context) rather than a skeleton, and LCP is no later. With the menu
  read answering normally on a cold cache (the usual post-deploy case) nothing waits. The `/order/<slug>` row is held
  by its layout, not by the budget: the existence probe (`restaurantExists`) reads the same menu tables and waits for
  its 2.5 s timeout on base and after alike; the page then adds only the 150 ms minimum (with the per-read budget it
  would have added up to 1.2 s more).
- *Warm path re-measured* on this build (`web-vitals.mjs`, same profile, 5 runs, dish photos served): web-order first
  LCP 820 ms, repeat 284 ms [284, 284, 284, 260, 312]; guest-qr first 980 ms, repeat 288 ms [308, 288, 264, 296, 288];
  CLS 0.001 / 0.012. Raw: `docs/perf-results/2026-10-23-perf01-fix.json`. Bundle budget green (`/t/[qr]` 177.6 kB,
  ratchet 178).
- *Guards.* `first-paint.test.ts` adds the no-visit menu source, the Retry state, the QR slow path with no dish card,
  the request-start budget, and `template.tsx` to the route scan. The shape check now also runs in the browser E2E job:
  `tests/e2e/guest-first-paint.spec.ts` (server HTML of both pages through `inspectGuestShell`, and the slow path above
  in Chromium).


## Resuto 2.1 before/after (5c359d5 → e4d5bb0)

Plan §8 1D / §9: Web Vitals and bundle sizes of Resuto 2.0 as on staging before 2.1 (`5c359d5`) against the 2.1
phase-1A–1C merge (`e4d5bb0`), measured on 2026-10-26 (21-A11Y). The a11y fixes made in the same workstream are not in
either build.

**Method.**
- Builds: each commit checked out separately (`git worktree add --detach`), its own `next build` and API build, served
  with `next start` on :3672 and the built API on :4672 (`AUTH_DEV_MODE`, worker in process). So "after" includes the
  2.1 API changes as well as the web changes.
- Data: one demo restaurant ("The Olive Room", 2 branches, 8 weeks of orders, photos) loaded with the `5c359d5`
  loader (`scripts/demo/load-demo-data.mjs`) through the `5c359d5` API into its own database; the after database is a
  `CREATE DATABASE … TEMPLATE` copy of it migrated forward with the 14 migrations 2.1 adds. Same rows, same photo files
  (one storage directory). This is the demo data only, not the 200k-order scaled database of the sections above, so
  these numbers are not comparable with those tables.
- Harness: `scripts/perf/web-vitals.mjs` (390×844 @2x, 150 ms RTT, 1.6 Mbit/s down, 750 kbit/s up, CPU ×4), median of
  3 runs per page, from the `ws/21-a11y` checkout for both builds (it adds `inbox`, `menu`, `analytics`, `billing` and
  the view-only menu `menu-only` = `/m/<slug>` to the page list, and `--build` to record the measured build). Two passes
  per build, alternated: before A (07:39 UTC), after A (07:59), after B (08:08), before B (08:16). `/m/<slug>` does not
  exist on `5c359d5` (404), so it has after numbers only.
- First-load JS: `node scripts/ui/bundle-budget.mjs --next <build>/.next --report` on both builds (same algorithm).
  HTML documents: the same script's `--web` mode against each running build, now with `--slug`/`--qr` so the guest
  pages are measured too (21-A11Y addition; gzip level 9 of the document as served, `resuto_locale` cookie per locale).

**Environment caveats.** A shared development container (4 vCPU, 15 GB RAM, the shared local Postgres 16 cluster),
not production hardware, not a CDN, no HTTP/2 multiplexing from a real edge. Other agents' workloads ran on the same
machine during the passes (load average 0.3–1.7). Pass-to-pass spread of a page's median is up to ~400 ms (inbox
before: 3,044 vs 3,420 ms), so differences below that are within noise; the per-run values are in the raw files. For
some pages the LCP element differs between builds (overview: `span.row` → `h1`; orders: `h1` → `div.ticket-source`;
inbox: `p` → `span.inbox-row-preview`), so their LCP compares different paints. Raw results:
`docs/perf-results/2026-10-26-21a11y-{before-A,before-B,after-A,after-B}.json`, bundle and document sizes
`…-21a11y-budget-{before,after}.json`.

### Web (throttled mobile; medians of 3, pass A / pass B)

| page | LCP ms before → after | FCP ms before → after | CLS before → after | requests | KB first visit (js) before → after | repeat-visit LCP ms before → after |
|---|---|---|---|---|---|---|
| landing (en) | 2,460 / 2,408 → 2,460 / 2,484 | 1,704 / 1,668 → 1,712 / 1,692 | 0.02 → 0.02 | 27 → 31 | 645 (242) → 679 (266) | 1,156 / 1,244 → 1,412 / 1,344 |
| landing (ar) | 2,928 / 3,028 → **3,156 / 3,316** | 1,988 / 2,108 → **2,356 / 2,436** | 0.034 → 0.034 | 29 → 33 | 734 (242) → 769 (266) | 1,152 / 2,104 → 1,332 / 2,256 |
| public site `/r` (en) | 2,548 / 2,584 → **2,760 / 2,796** | 884 / 892 → 924 / 936 | 0.002 → 0.002 | 24 → 30 | 478 (150) → 519 (176) | 304 / 292 → 300 / 284 |
| guest QR `/t` (ar) | 3,532 / 3,520 → 3,448 / 3,484 | 992 / 1,024 → 1,040 / 1,064 | 0.021 → 0.021 | 46 → 54 | 742 (203) → 786 (235) | 276 / 264 → 280 / 268 |
| web order `/order` (en) | 2,964 / 2,960 → **3,172 / 3,144** | 880 / 868 → 892 / 952 | 0.001 → 0.001 | 37 → 45 / 44 | 550 (193) → 590 (222) | 284 / 288 → 300 / 304 |
| menu QR `/m` (ar, new) | – | – | – | – → 40 | – → 649 (202) | – → 260 / 288 |
| overview | 3,544 / 3,680 → 3,640 / 3,692 | 800 / 832 → 844 / 852 | **0.124 → 0.009** | 59 → 69 | 422 (231) → 528 / 526 (305) | 1,588 / 1,652 → 1,532 / 2,084 |
| orders | 3,348 / 3,568 → **3,980 / 4,224** | 764 / 804 → 832 / 852 | **0.329 → 0.225** | 55 / 53 → 60 | 438 (257) → 502 (282) | 1,372 / 1,680 → 1,820 / 1,908 |
| inbox | 3,044 / 3,420 → **3,728 / 3,680** | 768 / 792 → 808 / 824 | 0.159 / 0.043 → 0.14 | 51 → 64 | 389 (206) → 467 (248) | 1,232 / 1,496 → 1,640 / 1,724 |
| menu | 3,276 / 3,396 → **3,704 / 3,680** | 788 / 784 → 844 / 852 | 0.123 → 0.062 / 0.046 | 69 → 70 | 656 (251; img 218) → 812 (252; img 327) | 1,504 / 1,700 → 1,416 / 1,600 |
| analytics | 3,344 / 3,600 → 3,596 / 3,664 | 752 / 760 → 828 / 860 | **0.123 → 0.002** | 53 → 67 | 434 (253) → 476 / 479 (257) | 1,528 / 1,456 → 1,704 / 1,752 |
| billing | 3,216 / 3,228 → **3,796 / 3,800** | 772 / 792 → 832 / 824 | 0.007 → 0.046 | 56 → 71 | 431 (249) → 531 / 528 (305) | 1,340 / 1,424 → 1,736 / 1,812 |

Polling while open (20 s, first run): overview 9 GET/min → 0 (2.1 home no longer polls on this profile); orders 48 →
48 / 45; guest QR 12 → 12. TTFB 22–46 ms on every page in both builds.

### First-load JS (gzip kB, `bundle-budget.mjs`)

| route | 5c359d5 | e4d5bb0 |
|---|---|---|
| `/` | 182.4 | 184.5 |
| `/pricing` | 205.7 | 209.5 |
| `/login`, `/signup` | 182.5 | 186.1 |
| `/onboarding` | 131.8 | 139.4 |
| `/r/[slug]` | 112.4 | 115.0 |
| `/order/[slug]` | 129.7 | 133.7 |
| `/t/[qr]` | 140.6 | 144.1 |
| `/m/[slug]` | – | 124.2 |
| `/dashboard/[orgId]` | 182.4 | 179.3 |
| `/dashboard/[orgId]/orders` | 215.4 | 215.7 |
| `/dashboard/[orgId]/inbox` | 160.5 | 174.3 |
| `/dashboard/[orgId]/menu` | 210.2 | 182.5 |
| `/dashboard/[orgId]/analytics` | 207.0 | 174.3 |
| `/dashboard/[orgId]/billing` | 204.4 | 173.6 |
| `/kitchen/[orgId]` | 193.8 | 202.7 |
| group max: guest / public / staff / other | 162.2 / 205.7 / 216.5 / 184.5 | 167.5 / 209.5 / 218.9 / 189.8 |

Every route is inside its group budget in both builds (guest 170, public 226, staff 220). The first-load figure fell
on menu, analytics and billing (code moved behind lazy imports), but the JavaScript those pages actually transfer on a
first visit grew (billing 249 → 305 KB, overview 231 → 305 KB): the lazy chunks load right after the first paint, so
the budget does not see them.

### HTML documents (gzip kB, raw kB in brackets; `bundle-budget.mjs --web`)

| route | locale | 5c359d5 | e4d5bb0 | document budget |
|---|---|---|---|---|
| `/login` | en / ar | 22.7 (85.2) / 26.2 (104.8) | 23.5 (88.9) / 27.2 (108.9) | 18 — **over in both builds** |
| `/signup` | en / ar | 22.8 (85.3) / 26.3 (105.0) | 23.5 (89.0) / 27.2 (109.1) | 18 — **over in both** |
| `/onboarding` | en / ar | 22.5 (84.1) / 25.9 (103.6) | 25.5 (96.3) / 29.6 (118.8) | 18 — **over in both** |
| `/` | en / ar | 41.1 (170.7) / 45.1 (192.1) | 41.8 (174.2) / 46.0 (196.1) | 42 — **ar over in both** |
| `/pricing` | en / ar | 26.8 / 30.6 | 27.4 / 31.5 | 42 |
| `/r/[slug]` | en / ar | 24.0 / 27.2 | 25.3 / 28.7 | 42 |
| `/order/[slug]` | en / ar | 24.5 / 27.4 | 25.3 / 28.3 | 42 |
| `/t/[qr]` | en / ar | 24.6 / 27.5 | 25.3 / 28.4 | 42 |
| `/m/[slug]` | en / ar | – (404) | 24.7 / 27.8 | 42 |
| `/dashboard/[orgId]` | en / ar | 88.1 (338.4) / 103.0 (433.2) | 111.0 (428.2) / 130.8 (551.7) | 62 — **over in both** |
| `/dashboard/[orgId]/orders` | en / ar | 88.1 / 102.9 | 111.2 / 131.0 | 62 — **over in both** |
| `/kitchen/[orgId]` | en / ar | 86.6 / 101.4 | 109.5 / 129.3 | 62 — **over in both** |

The document budgets are not enforced in CI (the gate runs without `--web`), and both builds are over them on the auth,
staff and Arabic landing documents. Cause, measured on `/login` (en, after): 59.6 KB of the 88.9 KB document is the root
layout's message payload, the whole guest scope (1,096 keys, ~55 KB: `core.guest` 10.9 KB, `core.res` 6.6, `studio.site`
4.9, `core.web` 4.3, `connect.order` 4.0, and ~9 KB of `pay.*` staff payment copy that `GUEST_SCOPE`'s `/^pay\./`
pulls in). Every document, the auth and staff ones included, carries it before its own scope. Staff documents grew
~23 kB gz (en) / ~28 kB gz (ar) with the 2.1 copy, because the staff scope still serialises every module's strings.
Not fixed here: getting under the budgets needs the guest scope moved from the root layout to the guest route groups
and a per-module staff scope, which is a structural i18n change, not a cheap one (see the follow-ups below).

### Regressions (honest summary)

- **Staff pages are slower on this profile.** LCP after minus before, pass A / pass B: orders +632 / +656 ms,
  billing +580 / +572 ms, inbox +684 / +260 ms, menu +428 / +284 ms, analytics +252 / +64 ms, overview +96 / +12 ms.
  FCP is +20 to +100 ms on every staff page. They make 1–15 more requests and transfer more JavaScript on a first
  visit (overview +74 KB, billing +56 KB, inbox +42 KB), and repeat-visit LCP grew on orders, inbox, analytics and
  billing (+180 to +450 ms). Not root-caused in this workstream.
- **Guest and public pages:** web order +208 / +184 ms LCP and public site +212 / +212 ms, with +26 to +32 KB of JavaScript
  (guest first-load JS +2.6 to +4.0 kB gz per route); guest QR LCP is unchanged (−84 / −36 ms) despite +32 KB JS.
- **Arabic landing:** LCP +228 / +288 ms and FCP +368 / +328 ms; English landing unchanged within noise. Both load 24 KB more
  JavaScript and 4 more requests.
- **HTML documents** grew on every measured route (above) and stay over their budgets.
- **Improvements:** layout shift dropped on overview (0.124 → 0.009), analytics (0.123 → 0.002), menu (0.123 →
  0.05) and orders (0.329 → 0.225); the menu's repeat visit no longer re-downloads 100 KB of photos (216 → 135 KB);
  the 2.1 home stopped polling (9 → 0 GET/min); the new view-only menu `/m/<slug>` paints at ~1.6 s, half the time of
  the ordering menu.

### Follow-ups

- Staff LCP/JS: profile the orders, inbox and billing first visit (which lazy chunks load before the LCP element) and
  the shell's extra requests; add a transferred-JS check next to the first-load budget, which misses lazy chunks.
- HTML documents: move the guest message scope out of the root layout into the guest route groups, narrow
  `GUEST_SCOPE`'s `pay.` rule to the guest payment keys, split the staff scope per module, then run
  `bundle-budget.mjs --web` in CI so the document budgets are enforced.
- Orders CLS 0.225 is still above the 0.1 "good" threshold.
