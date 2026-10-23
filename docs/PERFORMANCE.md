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
- Repeat-visit LCP on `/order/<slug>` (and already on `/t/<qr>` before ws14b): the content streams behind
  `(menu)/loading.tsx`, and React 19.2's batched Suspense reveal (a timer about 300 ms after first paint) often loses
  to the cached JavaScript executing on a repeat visit, so the heading paints at hydration (~1.3 s on the lab profile)
  instead of ~0.3 s. ws14b's W01 change tipped web-order into that race (A/B: base 296 ms, HEAD ~1.35 s, 10/10 runs);
  neither srcset nor the font preload is the cause (variants measured). Fix: render the cached menu in the shell
  rather than behind the loading boundary, or reveal it without the batch throttle.
- Cross-instance cache invalidation (`LISTEN/NOTIFY` or Redis) once the API runs more than one instance.
- Staging measurement with this harness (attach mode) after deploy.
