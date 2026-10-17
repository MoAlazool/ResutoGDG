# Track 3 — Delivery & operational optimisation

Owner: Fahd Taha Kassem. Code under test: `apps/ai-service/app/core/routing.py` (the production service).

> **SYNTHETIC DATA.** Instances are built from synthetic delivery orders (`../data/DATASHEET.md`). Results are
> **not** evidence of real-world performance. Distances are haversine × 1.3, not road distances.

## Instance sets (deterministic, seed 42)

- **dispatch:** all delivery orders a branch received in the same 20-minute window, bucketed by size
  (available: 3,801 batches of 3–5 stops, 234 of 6–8, 72 of 9–12; 60 sampled per bucket). Promised time =
  placement + 45 min; departure = window end + 10 min. One driver serves the batch (an upper bound on real batch
  sizes, which is why lateness is high).
- **scale:** 15 / 25 / 40 drop-offs sampled from a branch's delivery locations, no time windows, 20 instances each.

## Methods & metrics

Naive (placement order), nearest neighbour (NN), NN + 2-opt with distance objective (**service default**), NN + 2-opt
with lateness objective, exact enumeration for ≤ 8 stops. Metrics: distance, route duration (25 km/h + 3 min per
stop), time-window violations, total lateness, computation time (single-threaded Python; machine in `config.json`).

## Results — run `20261017-seed42` (synthetic)

Dispatch batches (means over 60 instances):

| Stops | Method | km | Late stops | Lateness (min) | Gap to optimal | ms |
|---|---|---|---|---|---|---|
| 3–5 | naive | 18.84 | 1.85 | 40.1 | 35.1 % | — |
| 3–5 | NN | 14.72 | 1.28 | 24.0 | 3.5 % | 0.01 |
| 3–5 | **NN + 2-opt** | **14.24** | 1.35 | 23.9 | **0.8 %** | 0.02 |
| 3–5 | NN + 2-opt (lateness) | 14.65 | **1.27** | **22.0** | 3.8 % | 0.18 |
| 3–5 | exact | 14.07 | 1.38 | 23.9 | 0 | 0.04 |
| 6–8 | naive | 36.01 | 5.23 | 222.7 | 62.3 % | — |
| 6–8 | NN | 24.04 | 3.58 | 101.3 | 7.8 % | 0.01 |
| 6–8 | **NN + 2-opt** | **22.38** | 3.97 | 103.4 | **0.6 %** (max 8.5 %) | 0.08 |
| 6–8 | NN + 2-opt (lateness) | 23.59 | **3.55** | **95.9** | 5.8 % | 1.32 |
| 6–8 | exact | 22.24 | 3.88 | 102.4 | 0 | 4.29 |
| 9–12 | naive | 56.36 | 8.83 | 643.9 | — | — |
| 9–12 | NN | 35.56 | 6.83 | 271.5 | — | 0.02 |
| 9–12 | **NN + 2-opt** | **31.80** | 7.07 | 296.6 | — | 0.18 |
| 9–12 | NN + 2-opt (lateness) | 34.47 | **6.82** | **260.1** | — | 4.94 |

Scale sets (no windows): NN + 2-opt saves 52.4 % / 59.4 % / 69.0 % distance versus the naive order for 15 / 25 / 40
stops, in 0.8 / 2.4 / 11.2 ms on average (p95 1.7 / 3.7 / 18.1 ms).

## Findings (on synthetic data)

1. NN + 2-opt is within 0.6–0.8 % of the optimum on ≤ 8 stops and cuts distance 22–43 % versus placement order.
2. Shortest distance is not fewest late deliveries: the lateness objective trades ~3–8 % more distance for fewer
   and shorter late arrivals. Batches of 6+ stops for one driver are late regardless — the real lever is
   multi-driver assignment (Semester 2).
3. Computation is negligible at restaurant scale (< 20 ms for 40 stops), so exact or metaheuristic methods are affordable for small batches.
