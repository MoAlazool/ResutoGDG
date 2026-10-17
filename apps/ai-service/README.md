# Resuto Intelligence service (`apps/ai-service`)

Stateless FastAPI service with the native ML baselines. The NestJS API (`apps/api/src/modules/intelligence`)
is its only client: it extracts minimal tenant-scoped data (ids, quantities, amounts, timestamps — never
names, phones or addresses), calls this service, and stores results in `ai_predictions`. The service has no
database credentials and keeps no state between requests.

## Run

```bash
cd apps/ai-service
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
AI_SERVICE_TOKEN=$(openssl rand -hex 24) .venv/bin/uvicorn app.main:app --port 8000
.venv/bin/python -m pytest            # unit + HTTP tests (deterministic seeds)
```

The process refuses to start without `AI_SERVICE_TOKEN` (≥ 16 chars) unless `AI_SERVICE_ALLOW_NO_AUTH=1`
(local tests only). Bodies above 16 MB are rejected (413); every list field has a maximum length.

## Endpoints (all `POST` require `Authorization: Bearer <AI_SERVICE_TOKEN>`)

| Endpoint | Model | Documentation |
|---|---|---|
| `GET /v1/health` | — | liveness, no auth, no data |
| `POST /v1/forecast/demand` | seasonal naive (7), moving average (28), `HistGradientBoostingRegressor` (Poisson) with calendar features, lags, rolling means, Fri/Sat weekend, optional Ramadan flag; rolling-origin backtest selection with fallback | `app/core/forecast.py` |
| `POST /v1/customers/segment` | RFM quintiles → named segments | `app/core/customers.py` (rule table) |
| `POST /v1/customers/churn` | logistic regression on temporally derived labels; recency heuristic (flagged `isHeuristic`) when labels are not derivable | `app/core/customers.py` |
| `POST /v1/recommend/items` | association rules (support, confidence, lift) with popularity fallback; per-customer hybrid next-basket score; unavailable items excluded | `app/core/recommend.py` |
| `POST /v1/routing/optimize` | nearest neighbour + 2-opt on haversine distance × road factor; time-window violations reported; compared to the naive order | `app/core/routing.py` |

Offline evaluation of exactly this code lives in `research/` (synthetic data, clearly labelled).
