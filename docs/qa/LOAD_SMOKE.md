# Load smoke

`node scripts/load/load-smoke.mjs` against a compiled API (`node apps/api/dist/main.js`, pool 20) on
the local Postgres 16 cluster. Single API instance, 4 vCPU container, client and server on the same
machine — a smoke test for correctness under concurrency, not a capacity benchmark.

Run 2026-10-17 (concurrency 40, distinct client IPs to stay under per-IP public rate limits):

| Phase | Requests | p50 | p95 | p99 | Result |
|---|---|---|---|---|---|
| Public menu GET | 2000 | 83.7 ms | 127.9 ms | 176.2 ms | 2000 × 200 |
| Website order POST (kernel pricing, stock, numbering, outbox) | 300 | 171.5 ms | 416.5 ms | 606.9 ms | 300 × 201, order numbers unique |
| Limited-stock race (stock 50) | 100 | 139.7 ms | 336.9 ms | 358.0 ms | exactly 50 × 201, 50 × 409 `out_of_stock`, stock ends at 0 |

No 5xx responses. The script refuses non-local targets unless `ALLOW_REMOTE=1` and must never be pointed at production.
