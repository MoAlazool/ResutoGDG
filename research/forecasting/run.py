#!/usr/bin/env python3
"""Track 1 — daily item demand forecasting (SYNTHETIC data; see research/forecasting/README.md).

Protocol (temporal, no leakage):
* Series: daily quantity per (branch, item) from the synthetic order lines, by business date.
* Validation: rolling origins in Jan–Feb 2025 (before Ramadan 2025); used only to choose the
  gradient-boosting hyper-parameters from a small grid.
* Test: 8 rolling origins every 14 days from 2025-03-01 (covers Ramadan 2025, Eid and the
  following months); every model is refitted at each origin on data strictly before it and
  forecasts the next 14 days.
* Models: seasonal naive (7), moving average (28), HistGBM with and without the Ramadan flag
  (ablation), and the service's automatic selection (backtest on the pre-origin history only).
* Metrics: MAE, RMSE, WAPE pooled over all series-days, plus slices and 80 % interval coverage.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date, timedelta
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common  # noqa: E402
from app.core import forecast as fc  # noqa: E402
from app.core.metrics import forecast_metrics  # noqa: E402

HORIZON = 14
VAL_ORIGINS = ["2025-01-18", "2025-02-01", "2025-02-15"]
TEST_ORIGINS = [(date(2025, 3, 1) + timedelta(days=14 * i)).isoformat() for i in range(8)]
GBM_GRID = [{"learning_rate": 0.05, "max_iter": 200}, {"learning_rate": 0.1, "max_iter": 100}, {"learning_rate": 0.03, "max_iter": 300}]


def _cal(manifest, use_ramadan=True):
    rams = tuple((date.fromisoformat(a), date.fromisoformat(b)) for a, b in manifest["config"]["ramadan"])
    return fc.Calendar(ramadan=rams, use_ramadan=use_ramadan)


def _predict(name, train: fc.Series, cal, seed, params=None):
    if name.startswith("hist_gbm"):
        m = fc.HistGBM(seed=seed, **(params or {}))
    else:
        m = fc.default_factories(seed)[name]()
    m.fit(train, cal)
    return m.predict(HORIZON)


def validation_task(args):
    key, start, y, manifest, seed = args
    s = fc.Series(start=date.fromisoformat(start), y=np.asarray(y, float))
    cal = _cal(manifest)
    rows = []
    for o in VAL_ORIGINS:
        oi = (date.fromisoformat(o) - s.start).days
        train = fc.Series(start=s.start, y=s.y[:oi])
        actual = s.y[oi:oi + HORIZON]
        for gi, params in enumerate(GBM_GRID):
            rows.append((gi, actual.tolist(), _predict("hist_gbm", train, cal, seed, params).tolist()))
    return rows


def test_task(args):
    key, start, y, manifest, seed, params = args
    s = fc.Series(start=date.fromisoformat(start), y=np.asarray(y, float))
    cal = _cal(manifest)
    cal_no = _cal(manifest, use_ramadan=False)
    out = []
    for o in TEST_ORIGINS:
        oi = (date.fromisoformat(o) - s.start).days
        train = fc.Series(start=s.start, y=s.y[:oi])
        actual = s.y[oi:oi + HORIZON]
        dates = [(s.start + timedelta(days=oi + i)).isoformat() for i in range(HORIZON)]
        preds = {
            "seasonal_naive_7": _predict("seasonal_naive_7", train, cal, seed),
            "moving_average_28": _predict("moving_average_28", train, cal, seed),
            "hist_gbm": _predict("hist_gbm", train, cal, seed, params),
            "hist_gbm_no_ramadan": _predict("hist_gbm", train, cal_no, seed, params),
        }
        auto = fc.forecast_series(train, cal, HORIZON, seed=seed, level=0.8)
        preds["auto_select"] = np.array([p["yhat"] for p in auto["forecast"]])
        lower = [p["lower"] for p in auto["forecast"]]
        upper = [p["upper"] for p in auto["forecast"]]
        for i in range(HORIZON):
            row = {"key": key, "origin": o, "date": dates[i], "step": i + 1, "y": float(actual[i]),
                   "auto_model": auto["model"], "auto_lower": lower[i], "auto_upper": upper[i]}
            for m, p in preds.items():
                row[m] = float(p[i])
            out.append(row)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42, help="model seed")
    ap.add_argument("--data-seed", type=int, default=2026, help="synthetic generator seed")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    t0 = time.time()
    manifest, df = common.load_dataset(args.data_seed)
    lines = df["order_lines"].merge(df["orders"][["order_id", "branch_id", "business_date"]], on="order_id")
    daily = lines.groupby(["branch_id", "item_id", "business_date"], as_index=False)["quantity"].sum()
    start, end = manifest["config"]["start"], manifest["config"]["end"]
    idx = pd.date_range(start, end, freq="D").strftime("%Y-%m-%d")
    series = {}
    for (b, i), g in daily.groupby(["branch_id", "item_id"]):
        y = g.set_index("business_date")["quantity"].reindex(idx, fill_value=0).astype(float)
        series[f"{b}|{i}"] = y.values.tolist()
    items = df["items"].set_index("item_id")

    with Pool(args.workers) as pool:
        val = pool.map(validation_task, [(k, start, y, manifest, args.seed) for k, y in series.items()])
        val_scores = []
        for gi, params in enumerate(GBM_GRID):
            a = np.concatenate([np.array(r[1]) for rows in val for r in rows if r[0] == gi])
            p = np.concatenate([np.array(r[2]) for rows in val for r in rows if r[0] == gi])
            val_scores.append({"params": params, **forecast_metrics(a, p)})
        best = min(range(len(GBM_GRID)), key=lambda g: val_scores[g]["wape"])
        params = GBM_GRID[best]
        test_rows = [r for rows in pool.map(test_task, [(k, start, y, manifest, args.seed, params) for k, y in series.items()]) for r in rows]

    t = pd.DataFrame(test_rows)
    t["branch"] = t["key"].str.split("|").str[0]
    t["item"] = t["key"].str.split("|").str[1]
    t["category"] = t["item"].map(items["category"])
    ram = [(a, b) for a, b in manifest["config"]["ramadan"]]
    eid = [(a, b) for a, b in manifest["config"]["eid"]]
    t["slice"] = np.where(t["date"].apply(lambda d: any(a <= d <= b for a, b in ram)), "ramadan",
                          np.where(t["date"].apply(lambda d: any(a <= d <= b for a, b in eid)), "eid", "regular"))
    models = ["seasonal_naive_7", "moving_average_28", "hist_gbm", "hist_gbm_no_ramadan", "auto_select"]

    def block(frame):
        return {m: forecast_metrics(frame["y"], frame[m]) for m in models}

    metrics = {
        "protocol": {"horizon": HORIZON, "validationOrigins": VAL_ORIGINS, "testOrigins": TEST_ORIGINS,
                     "split": "temporal rolling origin; each fit uses only data before its origin",
                     "series": len(series), "testPoints": int(len(t))},
        "validation": {"gbmGrid": val_scores, "selectedGbmParams": params, "selection": "lowest pooled WAPE on validation"},
        "test": {"overall": block(t), "bySlice": {s: block(g) for s, g in t.groupby("slice")},
                 "byCategory": {c: block(g) for c, g in t.groupby("category")},
                 "byBranch": {b: block(g) for b, g in t.groupby("branch")}},
        "autoSelect": {
            "chosenModelShare": (t.drop_duplicates(["key", "origin"])["auto_model"].value_counts(normalize=True).round(4).to_dict()),
            "interval80Coverage": float(((t["y"] >= t["auto_lower"]) & (t["y"] <= t["auto_upper"])).mean()),
        },
        "runtimeSeconds": round(time.time() - t0, 1),
    }
    config = {"seed": args.seed, "dataSeed": args.data_seed, "horizon": HORIZON, "gbmGrid": GBM_GRID,
              "serviceGbmDefaults": {"learning_rate": fc.HistGBM().learning_rate, "max_iter": fc.HistGBM().max_iter},
              "models": models}
    out = common.write_results("forecasting", common.run_id(args.seed), config, metrics, manifest)
    print(json.dumps({"out": str(out), "overall": metrics["test"]["overall"], "validation": metrics["validation"],
                      "autoSelect": metrics["autoSelect"], "runtimeSeconds": metrics["runtimeSeconds"]}, indent=2))


if __name__ == "__main__":
    main()
