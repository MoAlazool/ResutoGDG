# Track 2 — Customer intelligence & recommendations

Owners: Mohamed Adel Fouad (segmentation, churn) and Hamed Atef Mohamed (recommendations, engagement).
Code under test: `apps/ai-service/app/core/customers.py` and `app/core/recommend.py` (the production service).

> **SYNTHETIC DATA.** Results below come from `resuto-synth-v1` (seed 2026; see `../data/DATASHEET.md`). They
> are **not** evidence of real-world performance.

## Data

Orders linked to a customer (58 % of synthetic orders; 4,600 customers) with timestamp and total; baskets =
distinct items per order (anonymous orders contribute to global co-occurrence counts only).

## Churn — protocol

- Reference date T = 2025-04-30 23:59:59 UTC, window W = 60 days. The service receives orders up to T only.
- Inside the service, labels are derived at T − W (2025-03-01): features from orders before it, label = no order in
  (T − W, T]. Logistic regression (standardised recency, frequency, log-monetary, tenure, mean gap) is fitted there.
- **Test (out-of-time):** the fitted model scores features at T; label = no order in (T, T + 60 d].
  Baselines on the same 3,596 customers: the service's recency heuristic, recency rank, base rate.

### Churn results — run `20261017-seed42` (synthetic)

Training cohort 3,265 customers (2,047 churned / 1,218 retained). Test churn rate 64.8 %.

| Method | ROC-AUC | Average precision | Brier |
|---|---|---|---|
| Logistic regression (service) | 0.948 | 0.974 | **0.083** |
| Recency heuristic (service fallback) | 0.925 | 0.964 | 0.110 |
| Recency rank | **0.951** | **0.975** | 0.128 (not calibrated) |
| Base rate | 0.500 | 0.648 | 0.228 |

The service's internal same-cohort holdout reported AUC 0.932 (heuristic 0.898). **Finding:** on this synthetic data,
ranking customers by recency alone discriminates as well as logistic regression (AUC 0.951 vs 0.948); the model's
advantage is calibration (Brier 0.083 vs 0.128). The generator's churn is driven mostly by recency, so this is
expected — Semester 2 must show gains out-of-time on real data or with richer features.

### RFM segments at T (descriptive)

| Segment | Customers | Observed 60-day churn |
|---|---|---|
| champions | 554 | 11.4 % |
| potential_loyal | 576 | 22.9 % |
| promising | 23 | 34.8 % |
| new | 99 | 39.4 % |
| loyal | 496 | 66.3 % |
| needs_attention | 409 | 81.9 % |
| hibernating | 708 | 98.0 % |
| at_risk | 731 | 99.9 % |

Segments order churn as intended (champions lowest, at_risk/hibernating highest). "Loyal" (high frequency,
recency score 3) churning at 66 % shows that the rule thresholds are relative to this dataset's low visit rates.

## Recommendations — protocol (leave-last-basket-out)

- 3,104 customers with ≥ 3 baskets. Validation target = second-to-last basket; test target = last basket.
- All baskets are processed in time order: global co-occurrence counts at a target contain only earlier baskets
  and never a held-out basket; the customer history is their earlier baskets. No future information is used.
- Methods: popularity; personal frequency; association (mean confidence from items in the latest basket); hybrid
  `w_personal·personal + w_assoc·association + w_pop·popularity`, weights from an 89-point grid selected by validation NDCG@5.
- Metrics: Precision@K, Recall@K, NDCG@K, HitRate@K for K = 3, 5.

### Recommendation results — run `20261017-seed42` (synthetic, test = last basket)

Selected weights: personal 0.4, association 0.1, popularity 0 (now the service default).

| Method | P@3 | R@3 | NDCG@3 | P@5 | R@5 | NDCG@5 | Hit@5 |
|---|---|---|---|---|---|---|---|
| Popularity | 0.301 | 0.257 | 0.337 | 0.275 | 0.392 | 0.375 | 0.758 |
| Association only | 0.308 | 0.266 | 0.336 | 0.283 | 0.398 | 0.376 | 0.786 |
| Personal frequency | 0.447 | 0.405 | 0.524 | 0.350 | 0.512 | 0.532 | **0.866** |
| **Hybrid (selected, service default)** | **0.454** | **0.412** | **0.532** | **0.353** | **0.516** | **0.538** | 0.858 |

Sanity check on planted structure: for all 10 mains (100 %), the top side by association confidence is the side
the generator prefers. **Finding:** repeat behaviour dominates; the association term adds a small gain over
personal frequency (NDCG@5 0.538 vs 0.532), and association alone is no better than popularity for next-basket
prediction (it is still the right tool for "frequently bought with" on an item page).
