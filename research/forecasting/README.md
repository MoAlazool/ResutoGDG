# Track 1 — Daily item demand forecasting

Owner: Mohamed Adel Fouad. Code under test: `apps/ai-service/app/core/forecast.py` (the production service).

> **SYNTHETIC DATA.** Results below come from `resuto-synth-v1` (seed 2026; see `../data/DATASHEET.md`). They
> compare baselines on simulated patterns and are **not** evidence of real-world accuracy.

## Dataset & preprocessing

Order lines aggregated to daily quantity per (branch, item) by business date (local date of placement − 4 h);
days without sales are zeros. 56 series (2 branches × 28 items), 2024-01-01 … 2025-06-30.

## Models

| Name | Description |
|---|---|
| `seasonal_naive_7` | value of the same weekday last week |
| `moving_average_28` | mean of the last 28 days |
| `hist_gbm` | scikit-learn `HistGradientBoostingRegressor`, Poisson loss; features: weekday (categorical), Fri/Sat weekend flag, Ramadan flag, day of month, lags 1/7/14/21/28, rolling means 7/28, same-weekday mean of the last 4 weeks; recursive multi-step |
| `hist_gbm_no_ramadan` | ablation: same model with the Ramadan flag switched off |
| `auto_select` | what the service does: per series, backtest the three models on the pre-origin history (3 folds × 14 days) and keep the lowest WAPE; GBM only when ≥ 84 + 14 days of history |

## Protocol (temporal, leakage-free)

- **Validation:** origins 2025-01-18, 02-01, 02-15 (before Ramadan 2025), 14-day horizon; used only to choose GBM
  hyper-parameters from {(0.05, 200), (0.1, 100), (0.03, 300)} (learning rate, iterations).
- **Test:** 8 rolling origins every 14 days from 2025-03-01 (covers Ramadan 2025, Eid al-Fitr and April–June).
  At every origin each model is refitted on data strictly before the origin and forecasts 14 days.
- **Metrics:** MAE, RMSE, WAPE (= Σ|e| / Σ|y|) pooled over 56 series × 8 origins × 14 days = 6,272 points; slices
  by calendar (Ramadan / Eid / regular) and category; empirical coverage of the service's 80 % intervals.

Run: `apps/ai-service/.venv/bin/python research/forecasting/run.py` → `results/<run-id>/metrics.json` (seed 42).

## Results — run `20261017-seed42` (executed 2026-10-17, synthetic data, 562 s on 4 CPUs)

Validation selected learning rate 0.03 / 300 iterations (WAPE 0.2716 vs 0.2718 and 0.2738 for the other two);
these are now the service defaults.

| Model | MAE | RMSE | WAPE | WAPE Ramadan (n=1,624) | WAPE Eid (n=168) | WAPE regular (n=4,480) |
|---|---|---|---|---|---|---|
| seasonal_naive_7 | 6.28 | 9.53 | 0.388 | 0.455 | 0.580 | 0.356 |
| moving_average_28 | 5.86 | 8.89 | 0.362 | 0.434 | 0.528 | 0.329 |
| **hist_gbm** | **4.54** | **6.87** | **0.281** | **0.286** | 0.355 | **0.275** |
| hist_gbm_no_ramadan (ablation) | 5.16 | 8.00 | 0.318 | 0.395 | 0.495 | 0.284 |
| auto_select (service behaviour) | 4.90 | 7.56 | 0.303 | 0.363 | **0.338** | 0.281 |

By category (WAPE, hist_gbm vs best baseline): desserts 0.399 vs 0.876, drinks 0.266 vs 0.424, mains 0.284 vs 0.293,
sides 0.269 vs 0.280. Auto-selection picked GBM for 59.8 % of series-origins, the moving average for 34.8 % and
seasonal naive for 5.4 %. **80 % prediction intervals covered 72.2 %** of test actuals (under-coverage).

## Findings (on synthetic data)

1. Gradient boosting beats both baselines overall (WAPE 0.281 vs 0.362) and most on Ramadan-sensitive items
   (desserts, drinks); on mains/sides the gain over a 28-day average is small.
2. The Ramadan flag matters: removing it raises Ramadan-period WAPE from 0.286 to 0.395 and barely changes regular days.
3. The service's automatic selection is **worse than always using GBM** (0.303 vs 0.281). Its backtest windows
   precede the evaluation period, so at the start of Ramadan the selection is made on pre-Ramadan behaviour.
   Semester 2: calendar-aware selection (or a global model) and conformal intervals to fix the 72 % coverage.
4. These conclusions hold for the generator's assumptions only; they must be re-tested on real pilot data.
