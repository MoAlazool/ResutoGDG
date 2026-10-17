"""Evaluation metrics shared by the service backtests and the research pipelines."""
from __future__ import annotations

import math
from typing import Iterable, Sequence

import numpy as np


def mae(y: Sequence[float], yhat: Sequence[float]) -> float:
    a, b = np.asarray(y, float), np.asarray(yhat, float)
    return float(np.mean(np.abs(a - b))) if a.size else float("nan")


def rmse(y: Sequence[float], yhat: Sequence[float]) -> float:
    a, b = np.asarray(y, float), np.asarray(yhat, float)
    return float(math.sqrt(np.mean((a - b) ** 2))) if a.size else float("nan")


def wape(y: Sequence[float], yhat: Sequence[float]) -> float | None:
    """Weighted absolute percentage error = sum|y - yhat| / sum|y|. None when sum|y| == 0."""
    a, b = np.asarray(y, float), np.asarray(yhat, float)
    denom = float(np.sum(np.abs(a)))
    if denom == 0:
        return None
    return float(np.sum(np.abs(a - b)) / denom)


def forecast_metrics(y: Sequence[float], yhat: Sequence[float]) -> dict:
    return {"mae": mae(y, yhat), "rmse": rmse(y, yhat), "wape": wape(y, yhat), "n": int(len(y))}


# ---------------------------------------------------------------------------
# Ranking metrics (recommendations). `relevant` is a set of item ids.
# ---------------------------------------------------------------------------

def precision_at_k(ranked: Sequence[str], relevant: set, k: int) -> float:
    if k <= 0:
        return 0.0
    hits = sum(1 for i in ranked[:k] if i in relevant)
    return hits / k


def recall_at_k(ranked: Sequence[str], relevant: set, k: int) -> float:
    if not relevant:
        return 0.0
    hits = sum(1 for i in ranked[:k] if i in relevant)
    return hits / len(relevant)


def ndcg_at_k(ranked: Sequence[str], relevant: set, k: int) -> float:
    """Binary-relevance NDCG@K (Järvelin & Kekäläinen 2002)."""
    dcg = sum(1.0 / math.log2(pos + 2) for pos, i in enumerate(ranked[:k]) if i in relevant)
    ideal = sum(1.0 / math.log2(pos + 2) for pos in range(min(k, len(relevant))))
    return dcg / ideal if ideal > 0 else 0.0


def mean(values: Iterable[float]) -> float | None:
    vals = [v for v in values if v is not None]
    return float(np.mean(vals)) if vals else None


# ---------------------------------------------------------------------------
# Classification metrics (churn) without extra dependencies beyond sklearn.
# ---------------------------------------------------------------------------

def classification_metrics(y_true: Sequence[int], p: Sequence[float]) -> dict:
    from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

    yt = np.asarray(y_true, int)
    pp = np.asarray(p, float)
    out: dict = {"n": int(yt.size), "positiveRate": float(yt.mean()) if yt.size else None}
    if yt.size and 0 < yt.sum() < yt.size:
        out["rocAuc"] = float(roc_auc_score(yt, pp))
        out["averagePrecision"] = float(average_precision_score(yt, pp))
    else:
        out["rocAuc"] = None
        out["averagePrecision"] = None
    out["brier"] = float(brier_score_loss(yt, pp)) if yt.size else None
    return out
