"""Customer intelligence: RFM segmentation and churn risk.

RFM scoring
-----------
Recency (days since last order), Frequency (number of orders) and Monetary (total spend, minor
units) are converted to 1–5 scores with rank-based quintiles: ``score = 1 + floor(pct_rank * 5)``
(capped at 5) using average ranks, so tied customers always share a score. Recency is ranked so
that more recent customers score higher.

Segment rules (first matching rule wins; adapted from widely used RFM segment maps):

==================== =========================================================
``new``              first order within the last 30 days and only one order
``champions``        R ≥ 4 and F ≥ 4 and M ≥ 4
``loyal``            F ≥ 4 and R ≥ 3
``potential_loyal``  R ≥ 4 and F ≥ 2
``promising``        R ≥ 4 (single order, not new)
``needs_attention``  R = 3
``at_risk``          R ≤ 2 and (F ≥ 3 or M ≥ 4)   — used to buy often or spend a lot
``hibernating``      everyone else (R ≤ 2, low F and M)
==================== =========================================================

Churn
-----
A customer is *churned* when they place no order in the ``window_days`` after a reference date.
When the order history allows it, labels are derived with a temporal design: features are computed
at ``cutoff = as_of - window_days`` from orders strictly before the cutoff, and the label is whether
the customer ordered in ``(cutoff, as_of]``. A logistic-regression baseline (standardised recency,
frequency, log-monetary, tenure and mean inter-order gap) is fitted on that cohort and evaluated
on a seeded stratified 25 % holdout of the same cohort; it then scores every customer's features
at ``as_of`` (risk of no order in the next ``window_days``). Without enough labelled customers
(``MIN_TRAIN`` customers and ``MIN_CLASS`` per class) a recency heuristic is used,
``risk = 1 - exp(-recency / expected_gap)``, and the response is flagged ``method="heuristic"``.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable, Sequence

import numpy as np

from .metrics import classification_metrics

SEGMENTS = ("new", "champions", "loyal", "potential_loyal", "promising", "needs_attention", "at_risk", "hibernating")
MIN_TRAIN = 40
MIN_CLASS = 8


@dataclass(frozen=True)
class Order:
    customer_id: str
    at: datetime
    total_minor: int


def _utc(d: datetime) -> datetime:
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def quintile_scores(values: Sequence[float], higher_is_better: bool = True) -> np.ndarray:
    """1–5 scores from average-rank percentiles; ties share a score."""
    v = np.asarray(values, float)
    n = v.size
    if n == 0:
        return np.array([], dtype=int)
    if n == 1:
        return np.array([3])
    key = v if higher_is_better else -v
    order = key.argsort(kind="mergesort")
    ranks = np.empty(n, float)
    ranks[order] = np.arange(n, dtype=float)
    # average ranks for ties
    uniq, inv = np.unique(key, return_inverse=True)
    for u in range(len(uniq)):
        idx = np.where(inv == u)[0]
        if idx.size > 1:
            ranks[idx] = ranks[idx].mean()
    pct = ranks / n  # in [0, 1)
    return np.minimum(1 + np.floor(pct * 5).astype(int), 5)


def assign_segment(r: int, f: int, m: int, frequency: int, days_since_first: float) -> str:
    if frequency == 1 and days_since_first <= 30:
        return "new"
    if r >= 4 and f >= 4 and m >= 4:
        return "champions"
    if f >= 4 and r >= 3:
        return "loyal"
    if r >= 4 and frequency >= 2:
        return "potential_loyal"
    if r >= 4:
        return "promising"
    if r == 3:
        return "needs_attention"
    if r <= 2 and (f >= 3 or m >= 4):
        return "at_risk"
    return "hibernating"


@dataclass
class CustomerFeatures:
    customer_id: str
    recency_days: float
    frequency: int
    monetary_minor: int
    tenure_days: float
    mean_gap_days: float | None


def features_at(orders: Iterable[Order], ref: datetime) -> dict[str, CustomerFeatures]:
    """Features from orders strictly before `ref`."""
    ref = _utc(ref)
    by: dict[str, list[Order]] = {}
    for o in orders:
        if _utc(o.at) < ref:
            by.setdefault(o.customer_id, []).append(o)
    out: dict[str, CustomerFeatures] = {}
    for cid, os in by.items():
        times = sorted(_utc(o.at) for o in os)
        gaps = [(b - a).total_seconds() / 86400 for a, b in zip(times, times[1:])]
        out[cid] = CustomerFeatures(
            customer_id=cid,
            recency_days=(ref - times[-1]).total_seconds() / 86400,
            frequency=len(times),
            monetary_minor=int(sum(o.total_minor for o in os)),
            tenure_days=(ref - times[0]).total_seconds() / 86400,
            mean_gap_days=float(np.mean(gaps)) if gaps else None,
        )
    return out


def rfm_segments(orders: Sequence[Order], as_of: datetime) -> dict:
    as_of = _utc(as_of)
    feats = list(features_at(orders, as_of + timedelta(microseconds=1)).values())
    if not feats:
        return {"customers": [], "segments": {s: 0 for s in SEGMENTS}, "rules": "see service documentation"}
    r = quintile_scores([f.recency_days for f in feats], higher_is_better=False)
    fq = quintile_scores([f.frequency for f in feats])
    m = quintile_scores([f.monetary_minor for f in feats])
    customers = []
    counts = {s: 0 for s in SEGMENTS}
    for i, f in enumerate(feats):
        seg = assign_segment(int(r[i]), int(fq[i]), int(m[i]), f.frequency, f.tenure_days)
        counts[seg] += 1
        customers.append({
            "customerId": f.customer_id, "segment": seg, "r": int(r[i]), "f": int(fq[i]), "m": int(m[i]),
            "recencyDays": round(f.recency_days, 2), "frequency": f.frequency, "monetaryMinor": f.monetary_minor,
        })
    return {"customers": customers, "segments": counts}


def _matrix(feats: Sequence[CustomerFeatures], global_gap: float) -> np.ndarray:
    return np.array([[
        f.recency_days, f.frequency, math.log1p(max(f.monetary_minor, 0)), f.tenure_days,
        f.mean_gap_days if f.mean_gap_days is not None else global_gap,
    ] for f in feats], dtype=float)


def heuristic_risk(f: CustomerFeatures, global_gap: float) -> float:
    gap = f.mean_gap_days if f.mean_gap_days else global_gap
    gap = max(gap, 1.0)
    return float(1 - math.exp(-f.recency_days / (2 * gap)))


def churn_scores(orders: Sequence[Order], as_of: datetime, window_days: int = 60, seed: int = 42) -> dict:
    as_of = _utc(as_of)
    cutoff = as_of - timedelta(days=window_days)
    now_feats = features_at(orders, as_of + timedelta(microseconds=1))
    all_gaps = [f.mean_gap_days for f in now_feats.values() if f.mean_gap_days]
    global_gap = float(np.median(all_gaps)) if all_gaps else float(window_days)

    train_feats = features_at(orders, cutoff)
    ordered_after = {o.customer_id for o in orders if cutoff <= _utc(o.at) <= as_of}
    train = list(train_feats.values())
    labels = np.array([0 if f.customer_id in ordered_after else 1 for f in train], dtype=int)  # 1 = churned
    n_pos, n_neg = int(labels.sum()), int(len(labels) - labels.sum())

    method = "heuristic"
    evaluation = None
    reason = None
    model = None
    if len(train) >= MIN_TRAIN and n_pos >= MIN_CLASS and n_neg >= MIN_CLASS:
        from sklearn.linear_model import LogisticRegression
        from sklearn.model_selection import train_test_split
        from sklearn.pipeline import make_pipeline
        from sklearn.preprocessing import StandardScaler

        X = _matrix(train, global_gap)
        itr, ite = train_test_split(np.arange(len(train)), test_size=0.25, random_state=seed, stratify=labels)
        holdout = make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000, random_state=seed)).fit(X[itr], labels[itr])
        evaluation = classification_metrics(labels[ite], holdout.predict_proba(X[ite])[:, 1])
        evaluation["split"] = "stratified_holdout_25pct_same_cohort"
        evaluation["heuristicBaseline"] = classification_metrics(labels[ite], [heuristic_risk(train[i], global_gap) for i in ite])
        model = make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000, random_state=seed)).fit(X, labels)
        method = "logistic_regression"
    else:
        reason = f"labels_not_derivable: {len(train)} customers with history before cutoff ({n_pos} churned, {n_neg} retained); need {MIN_TRAIN} and {MIN_CLASS} per class"

    feats_now = list(now_feats.values())
    if model is not None and feats_now:
        risks = model.predict_proba(_matrix(feats_now, global_gap))[:, 1]
    else:
        risks = np.array([heuristic_risk(f, global_gap) for f in feats_now])
    customers = []
    for f, p in zip(feats_now, risks):
        p = float(p)
        customers.append({
            "customerId": f.customer_id, "risk": round(p, 4),
            "band": "high" if p >= 0.7 else "medium" if p >= 0.4 else "low",
            "recencyDays": round(f.recency_days, 2), "frequency": f.frequency, "monetaryMinor": f.monetary_minor,
        })
    customers.sort(key=lambda c: -c["risk"])
    return {
        "method": method,
        "isHeuristic": method == "heuristic",
        "reason": reason,
        "windowDays": window_days,
        "labelCohort": {"cutoff": cutoff.isoformat(), "customers": len(train), "churned": n_pos, "retained": n_neg},
        "evaluation": evaluation,
        "customers": customers,
    }
