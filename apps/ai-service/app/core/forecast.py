"""Daily demand forecasting for one item at one branch.

Models
------
* ``seasonal_naive_7``  – value of the same weekday last week (weekly seasonal naive).
* ``moving_average_28`` – mean of the last 28 days (or all history if shorter).
* ``hist_gbm``          – scikit-learn ``HistGradientBoostingRegressor`` (Poisson loss) on calendar
  features (weekday, Fri/Sat weekend flag, optional Ramadan flag, day of month) plus lags
  (1, 7, 14, 21, 28 days) and rolling means (7, 28 days). Multi-step forecasts are recursive:
  each predicted day is appended to the history before the next day is predicted.

Selection
---------
All eligible models are backtested with rolling-origin evaluation on the *provided* history
(each fold trains strictly on data before its origin and predicts the next ``horizon`` days, so
there is no look-ahead). The model with the lowest pooled WAPE is chosen (MAE when the actual
total is zero; ties go to the simpler model). The gradient-boosting model is only a candidate when
the history is long enough (``GBM_MIN_TRAIN`` days before the earliest fold); otherwise the best
baseline is used and ``fallbackReason`` says why.

Prediction intervals
--------------------
Empirical quantiles of the chosen model's backtest residuals (pooled over folds and steps), added
to the point forecast and clipped at zero. With fewer than ``MIN_RESIDUALS`` residuals a Poisson
normal approximation (yhat ± z·sqrt(yhat)) is used and labelled as such.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from statistics import NormalDist
from typing import Callable, Iterable, Sequence

import numpy as np

from .metrics import forecast_metrics

GBM_MIN_TRAIN = 84          # days of history before a fold origin for the GBM to be eligible
BASELINE_MIN_TRAIN = 14     # days of history before a fold origin for baselines
MAX_LAG = 28
MIN_RESIDUALS = 14
MODEL_ORDER = ("seasonal_naive_7", "moving_average_28", "hist_gbm")  # simplest first (tie-break)


@dataclass(frozen=True)
class Calendar:
    """Calendar context. Python weekday numbers: Monday=0 … Friday=4, Saturday=5."""

    weekend_days: tuple[int, ...] = (4, 5)  # Egypt and Saudi Arabia: Friday–Saturday weekend
    ramadan: tuple[tuple[date, date], ...] = ()  # inclusive date ranges
    use_ramadan: bool = True

    def is_weekend(self, d: date) -> int:
        return int(d.weekday() in self.weekend_days)

    def is_ramadan(self, d: date) -> int:
        if not self.use_ramadan:
            return 0
        return int(any(a <= d <= b for a, b in self.ramadan))


@dataclass
class Series:
    start: date
    y: np.ndarray  # daily quantities, contiguous from `start`

    @property
    def end(self) -> date:
        return self.start + timedelta(days=len(self.y) - 1)

    def date_at(self, i: int) -> date:
        return self.start + timedelta(days=i)


def build_series(points: Iterable[tuple[date, float]], end: date | None = None) -> Series:
    """Aggregates (date, qty) points into a contiguous daily series; missing days are zero sales."""
    agg: dict[date, float] = {}
    for d, q in points:
        agg[d] = agg.get(d, 0.0) + float(q)
    if not agg:
        raise ValueError("empty history")
    start = min(agg)
    last = max(agg)
    end = max(end or last, last)
    n = (end - start).days + 1
    y = np.zeros(n, dtype=float)
    for d, q in agg.items():
        y[(d - start).days] = q
    return Series(start=start, y=y)


# ---------------------------------------------------------------------------
# Models: fit(history) -> predict(h). All operate on numpy arrays + start date.
# ---------------------------------------------------------------------------

class SeasonalNaive7:
    name = "seasonal_naive_7"
    min_train = 7

    def fit(self, s: Series, cal: Calendar) -> "SeasonalNaive7":
        if len(s.y) < 7:
            raise ValueError("seasonal naive needs at least 7 days")
        self._last_week = s.y[-7:].copy()
        return self

    def predict(self, h: int) -> np.ndarray:
        return np.array([self._last_week[i % 7] for i in range(h)], dtype=float)


class MovingAverage28:
    name = "moving_average_28"
    min_train = 1
    window = 28

    def fit(self, s: Series, cal: Calendar) -> "MovingAverage28":
        self._level = float(np.mean(s.y[-self.window:]))
        return self

    def predict(self, h: int) -> np.ndarray:
        return np.full(h, self._level, dtype=float)


FEATURE_NAMES = (
    "dow", "is_weekend", "is_ramadan", "day_of_month",
    "lag1", "lag7", "lag14", "lag21", "lag28", "roll7", "roll28", "same_dow_mean4",
)


def _features(y: Sequence[float], t: int, d: date, cal: Calendar) -> list[float]:
    """Features for day index t using only values strictly before t."""
    lag = lambda k: float(y[t - k])  # noqa: E731
    roll7 = float(np.mean(y[t - 7:t]))
    roll28 = float(np.mean(y[t - 28:t]))
    same = (lag(7) + lag(14) + lag(21) + lag(28)) / 4.0
    return [d.weekday(), cal.is_weekend(d), cal.is_ramadan(d), d.day,
            lag(1), lag(7), lag(14), lag(21), lag(28), roll7, roll28, same]


class HistGBM:
    name = "hist_gbm"
    min_train = GBM_MIN_TRAIN

    # Defaults chosen on the research validation split (research/forecasting, "selectedGbmParams").
    def __init__(self, seed: int = 42, max_iter: int = 300, learning_rate: float = 0.03):
        self.seed = seed
        self.max_iter = max_iter
        self.learning_rate = learning_rate

    def fit(self, s: Series, cal: Calendar) -> "HistGBM":
        from sklearn.ensemble import HistGradientBoostingRegressor

        n = len(s.y)
        if n < self.min_train:
            raise ValueError(f"gradient boosting needs at least {self.min_train} days")
        X = np.array([_features(s.y, t, s.date_at(t), cal) for t in range(MAX_LAG, n)], dtype=float)
        target = s.y[MAX_LAG:]
        self._model = HistGradientBoostingRegressor(
            loss="poisson", max_iter=self.max_iter, learning_rate=self.learning_rate, max_leaf_nodes=15,
            min_samples_leaf=10, l2_regularization=1.0, early_stopping=False, random_state=self.seed,
            categorical_features=[0],
        )
        self._model.fit(X, target)
        self._series = s
        self._cal = cal
        return self

    def predict(self, h: int) -> np.ndarray:
        ext = list(self._series.y)
        out = []
        for step in range(h):
            t = len(ext)
            d = self._series.date_at(t)
            yhat = float(self._model.predict(np.array([_features(ext, t, d, self._cal)], dtype=float))[0])
            yhat = max(yhat, 0.0)
            ext.append(yhat)
            out.append(yhat)
        return np.array(out, dtype=float)


ModelFactory = Callable[[], object]


def default_factories(seed: int = 42) -> dict[str, ModelFactory]:
    return {
        "seasonal_naive_7": SeasonalNaive7,
        "moving_average_28": MovingAverage28,
        "hist_gbm": lambda: HistGBM(seed=seed),
    }


def fit_predict(name: str, s: Series, cal: Calendar, h: int, seed: int = 42) -> np.ndarray:
    model = default_factories(seed)[name]()
    model.fit(s, cal)
    return model.predict(h)


def _slice(s: Series, n: int) -> Series:
    return Series(start=s.start, y=s.y[:n])


@dataclass
class BacktestResult:
    folds: int
    origins: list[date]
    metrics: dict[str, dict]
    residuals: dict[str, np.ndarray]
    excluded: dict[str, str] = field(default_factory=dict)


def backtest(s: Series, cal: Calendar, h: int, models: Sequence[str], folds: int = 3, seed: int = 42) -> BacktestResult:
    """Rolling-origin backtest on the history. All candidates share the same folds."""
    n = len(s.y)
    factories = default_factories(seed)
    excluded: dict[str, str] = {}
    candidates = [m for m in MODEL_ORDER if m in models]
    k_gbm = min(folds, (n - GBM_MIN_TRAIN) // h) if n > GBM_MIN_TRAIN else 0
    if "hist_gbm" in candidates and k_gbm < 1:
        candidates.remove("hist_gbm")
        excluded["hist_gbm"] = f"history_too_short: needs at least {GBM_MIN_TRAIN + h} days, has {n}"
    if "hist_gbm" in candidates:
        k = k_gbm
    else:
        k = min(folds, (n - BASELINE_MIN_TRAIN) // h) if n > BASELINE_MIN_TRAIN else 0
    origins = [n - h * (k - i) for i in range(k)]
    metrics: dict[str, dict] = {}
    residuals: dict[str, np.ndarray] = {}
    for name in candidates:
        ys, yh = [], []
        for o in origins:
            model = factories[name]()
            model.fit(_slice(s, o), cal)
            ys.append(s.y[o:o + h])
            yh.append(model.predict(h))
        if not origins:
            continue
        a, b = np.concatenate(ys), np.concatenate(yh)
        metrics[name] = forecast_metrics(a, b)
        residuals[name] = a - b
    return BacktestResult(folds=k, origins=[s.date_at(o) for o in origins], metrics=metrics, residuals=residuals, excluded=excluded)


def _score(m: dict) -> tuple[float, float]:
    w = m.get("wape")
    return (w if w is not None else float("inf"), m["mae"])


def prediction_interval(yhat: np.ndarray, residuals: np.ndarray | None, level: float) -> tuple[np.ndarray, np.ndarray, str]:
    if residuals is not None and residuals.size >= MIN_RESIDUALS:
        lo_q, hi_q = np.quantile(residuals, [(1 - level) / 2, 1 - (1 - level) / 2])
        lower = np.clip(yhat + lo_q, 0, None)
        upper = np.clip(yhat + hi_q, 0, None)
        method = "empirical_backtest_residuals"
    else:
        z = NormalDist().inv_cdf(1 - (1 - level) / 2)
        sd = np.sqrt(np.maximum(yhat, 1.0))
        lower = np.clip(yhat - z * sd, 0, None)
        upper = yhat + z * sd
        method = "poisson_normal_approximation"
    lower = np.minimum(lower, yhat)
    upper = np.maximum(upper, yhat)
    return lower, upper, method


def forecast_series(
    s: Series, cal: Calendar, horizon: int, *, models: Sequence[str] = MODEL_ORDER, folds: int = 3,
    level: float = 0.8, seed: int = 42,
) -> dict:
    """Backtest, select, refit on the full history and forecast `horizon` days after the series end."""
    bt = backtest(s, cal, horizon, models, folds=folds, seed=seed)
    fallback_reason = None
    if bt.metrics:
        chosen = min(bt.metrics, key=lambda m: (_score(bt.metrics[m]), MODEL_ORDER.index(m)))
        if "hist_gbm" in models and chosen != "hist_gbm":
            fallback_reason = bt.excluded.get("hist_gbm") or "baseline_outperformed_gbm_in_backtest"
    else:
        eligible = [m for m in MODEL_ORDER if m in models and (m != "seasonal_naive_7" or len(s.y) >= 7) and m != "hist_gbm"]
        chosen = eligible[0] if eligible else "moving_average_28"
        fallback_reason = f"insufficient_history_for_backtest: {len(s.y)} days"
    model = default_factories(seed)[chosen]()
    model.fit(s, cal)
    yhat = model.predict(horizon)
    lower, upper, interval_method = prediction_interval(yhat, bt.residuals.get(chosen), level)
    dates = [s.end + timedelta(days=i + 1) for i in range(horizon)]
    return {
        "model": chosen,
        "selection": "lowest_backtest_wape",
        "fallbackReason": fallback_reason,
        "candidates": [
            {"model": m, "metrics": bt.metrics.get(m), "excluded": bt.excluded.get(m)}
            for m in MODEL_ORDER if m in models
        ],
        "backtest": {"folds": bt.folds, "horizon": horizon, "origins": [d.isoformat() for d in bt.origins]},
        "interval": {"level": level, "method": interval_method},
        "forecast": [
            {"date": d.isoformat(), "yhat": round(float(p), 3), "lower": round(float(lo), 3), "upper": round(float(hi), 3),
             "isWeekend": bool(cal.is_weekend(d)), "isRamadan": bool(cal.is_ramadan(d))}
            for d, p, lo, hi in zip(dates, yhat, lower, upper)
        ],
        "coverage": {
            "start": s.start.isoformat(), "end": s.end.isoformat(), "days": int(len(s.y)),
            "nonZeroDays": int(np.count_nonzero(s.y)), "totalQuantity": float(np.sum(s.y)),
        },
    }
