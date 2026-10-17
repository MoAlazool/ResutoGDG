# Resuto Intelligence — research (graduation project, AI track)

Reproducible offline research behind the native AI features of Resuto 2.0. The models evaluated here
are imported from `apps/ai-service/app/core` — **the same code that serves predictions in production** —
so every reported number corresponds to deployed behaviour.

> **All results in this directory were computed on SYNTHETIC data** (`research/data/generate_synthetic.py`,
> datasheet in `research/data/DATASHEET.md`). They demonstrate the pipelines and compare baselines on
> simulated Egyptian/Saudi restaurant patterns. They are **not** evidence of real-world performance and are
> labelled `isSyntheticData: true` in every metrics file, in the database (`ai_evaluations.is_synthetic_data`),
> in the API (`GET /v1/o/:orgId/intelligence/research`) and on the dashboard "Research results" page.

## Layout

| Path | Contents |
|---|---|
| `data/generate_synthetic.py`, `data/DATASHEET.md` | Seeded synthetic generator (EG/SA weekends, meal peaks, Ramadan/Eid shift, churn, co-occurrence) and its datasheet |
| `common.py` | Dataset loading with checksum verification, run ids, result writing |
| `forecasting/` | Track 1 — demand forecasting (`run.py`, README, `results/<run-id>/`) |
| `customers/` | Track 2 — customer intelligence & recommendations |
| `routing/` | Track 3 — delivery & operational optimisation |
| `export_registry.py` | Exports the latest runs into the API's platform model registry |
| `literature/LITERATURE_REVIEW.md` | 14 Crossref-verified papers mapped to the tracks |

## Reproduce

```bash
cd apps/ai-service && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && cd ../..
PY=apps/ai-service/.venv/bin/python
$PY research/data/generate_synthetic.py          # optional: run.py regenerates the dataset if missing
$PY research/forecasting/run.py                   # ~5 min on 4 cores
$PY research/customers/run.py                     # ~30 s
$PY research/routing/run.py                       # ~10 s
$PY research/export_registry.py                   # refresh apps/api/.../registry/baselines.generated.ts
```

Each run writes `results/<YYYYMMDD>-seed<seed>/metrics.json` (with the synthetic notice, dataset checksums
and seed) and `config.json` (parameters, git revision, library versions, CPU count). Seeds: generator 2026,
models 42. Computation times are machine-dependent.

## Team responsibilities

| Member | Responsibility | Tracks | Code they own in Semester 2 |
|---|---|---|---|
| **Mohamed Adel Fouad** | Forecasting & customer intelligence | **T1** demand forecasting; **T2a** RFM segmentation and churn | `app/core/forecast.py`, `app/core/customers.py`, `research/forecasting`, churn part of `research/customers` |
| **Hamed Atef Mohamed** | Engagement, recommendation & growth | **T2b** recommendations (association rules, next-basket), insight → campaign loop | `app/core/recommend.py`, recommendation part of `research/customers`, insights rules |
| **Fahd Taha Kassem** | Delivery optimisation & data pipelines | **T3** routing; dataset generator, extraction SQL, registry export | `app/core/routing.py`, `research/routing`, `research/data`, `apps/api/.../data.service.ts` |

## Semester-2 plan

**Data.** Replace synthetic evaluation with consented, anonymised pilot-restaurant data (same pipelines;
`kind: "real"` datasets with their own datasheet). Keep the synthetic set as a regression benchmark.

**T1 — forecasting.** (1) Global (cross-series) gradient boosting trained over all items/branches with item
and category encodings instead of one model per series; (2) Eid, school-holiday, salary-day and weather
features; (3) direct multi-horizon models to remove recursive error accumulation; (4) quantile loss / conformal
intervals to fix the under-coverage observed (80 % nominal intervals covered 72.2 % of synthetic test days);
(5) ablations: Ramadan flag (done), weekend flag, lag sets, history length; (6) baselines: ETS/SARIMA and a
seasonal moving average next to the current ones, compared with Diebold–Mariano tests.

**T2 — customers & recommendations.** (1) Probabilistic CLV / "alive" models (BG/NBD, Pareto/NBD) versus the
logistic-regression and recency baselines (recency rank is currently as discriminative as logistic regression
on synthetic data — Semester 2 must show a model that beats it out-of-time); (2) calibration analysis;
(3) FPMC / sequential next-basket models versus the hybrid baseline, with ablations of each hybrid component;
(4) uplift-style evaluation of win-back campaigns once Marketing (Agent C) sends real campaigns.

**T3 — routing & operations.** (1) Multi-driver assignment and batching (insertion heuristics, Solomon-style)
instead of one driver per batch; (2) hard time-window handling and Or-opt/relocate moves; (3) road-network
distances (OSRM) versus haversine × 1.3, measuring the error of the approximation; (4) prep-time and ETA
prediction from kitchen timestamps; (5) staffing recommendations from the demand forecast.
