#!/usr/bin/env python3
"""Track 3 — delivery & operational optimisation (SYNTHETIC data; see research/routing/README.md).

Instance sets (built deterministically from the synthetic delivery orders, seeded sampling):
* ``dispatch``: all delivery orders a branch received within a 20-minute window (≥ 3 stops),
  bucketed by size (3–5, 6–8, 9–12). Promised time = placement + 45 min; departure = window end +
  10 min preparation. One driver serves the whole batch (an upper bound on real batch sizes).
* ``scale``: 15 / 25 / 40 drop-offs sampled from the branch's delivery locations, no time windows,
  to measure distance gains and computation time as the stop count grows.

Methods: naive (placement order), nearest neighbour, NN + 2-opt (distance objective, the service
default), NN + 2-opt (lateness objective), and exact enumeration for instances with ≤ 8 stops
(optimality gap). Distances: haversine × road factor 1.3 at 25 km/h (the service defaults).
Metrics: distance (km), route duration (min), time-window violations, total lateness (min),
computation time (ms; machine-dependent, environment recorded in config.json).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common  # noqa: E402
from app.core import routing as rt  # noqa: E402

WINDOW_MIN = 20
PROMISE_MIN = 45
PREP_MIN = 10
PER_BUCKET = 60
BUCKETS = {"3-5": (3, 5), "6-8": (6, 8), "9-12": (9, 12)}
SCALE_SIZES = (15, 25, 40)
SCALE_INSTANCES = 20


def timed(fn):
    t0 = time.perf_counter()
    r = fn()
    return r, (time.perf_counter() - t0) * 1000


def solve_all(p: rt.Problem, exact: bool) -> dict:
    dist = p.matrix()
    out = {}
    naive = list(range(len(p.stops)))
    out["naive"] = (rt.evaluate(p, naive, dist), 0.0)
    nn, ms_nn = timed(lambda: rt.nearest_neighbour(p, dist))
    out["nearest_neighbour"] = (rt.evaluate(p, nn, dist), ms_nn)
    two, ms_two = timed(lambda: rt.two_opt(p, rt.nearest_neighbour(p, dist), dist, "distance"))
    out["nn_2opt_distance"] = (rt.evaluate(p, two, dist), ms_two)
    if p.depart_at is not None:
        late, ms_late = timed(lambda: rt.two_opt(p, rt.nearest_neighbour(p, dist), dist, "lateness"))
        out["nn_2opt_lateness"] = (rt.evaluate(p, late, dist), ms_late)
    if exact:
        ex, ms_ex = timed(lambda: rt.brute_force(p, "distance"))
        out["exact_distance"] = (rt.evaluate(p, ex, dist), ms_ex)
    return out


def summarise(results: list[dict]) -> dict:
    methods = sorted({m for r in results for m in r})
    summary = {}
    for m in methods:
        rows = [r[m] for r in results if m in r]
        summary[m] = {
            "instances": len(rows),
            "meanDistanceKm": float(np.mean([e["distanceKm"] for e, _ in rows])),
            "meanDurationMin": float(np.mean([e["durationMinutes"] for e, _ in rows])),
            "meanViolations": float(np.mean([len(e["violations"]) for e, _ in rows])),
            "meanLatenessMin": float(np.mean([e["totalLatenessMinutes"] for e, _ in rows])),
            "meanComputationMs": float(np.mean([ms for _, ms in rows])),
            "p95ComputationMs": float(np.percentile([ms for _, ms in rows], 95)),
        }
        base = [r["naive"][0]["distanceKm"] for r in results if m in r]
        summary[m]["meanDistanceSavingVsNaivePct"] = float(np.mean([(b - e["distanceKm"]) / b * 100 for b, (e, _) in zip(base, rows) if b > 0]))
        if all("exact_distance" in r for r in results):
            gaps = [(r[m][0]["distanceKm"] - r["exact_distance"][0]["distanceKm"]) / r["exact_distance"][0]["distanceKm"] * 100
                    for r in results if r["exact_distance"][0]["distanceKm"] > 0]
            summary[m]["meanGapToOptimalPct"] = float(np.mean(gaps))
            summary[m]["maxGapToOptimalPct"] = float(np.max(gaps))
    return summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--data-seed", type=int, default=2026)
    args = ap.parse_args()
    t0 = time.time()
    rng = np.random.default_rng(args.seed)
    manifest, df = common.load_dataset(args.data_seed)
    branches = df["branches"].set_index("id")
    d = df["orders"][df["orders"]["fulfillment"] == "delivery"].copy()
    d["ts"] = pd.to_datetime(d["placed_at"], utc=True)
    d["window"] = d["ts"].dt.floor(f"{WINDOW_MIN}min")

    dispatch: dict[str, list] = {k: [] for k in BUCKETS}
    for (b, w), g in d.groupby(["branch_id", "window"]):
        n = len(g)
        bucket = next((k for k, (lo, hi) in BUCKETS.items() if lo <= n <= hi), None)
        if bucket:
            dispatch[bucket].append((b, w, g.sort_values("ts")))
    instance_counts = {k: len(v) for k, v in dispatch.items()}
    results_dispatch = {}
    for k, groups in dispatch.items():
        pick = rng.choice(len(groups), size=min(PER_BUCKET, len(groups)), replace=False)
        res = []
        for gi in sorted(pick):
            b, w, g = groups[gi]
            depart = (w + timedelta(minutes=WINDOW_MIN + PREP_MIN)).to_pydatetime()
            stops = [rt.Stop(id=r.order_id, lat=float(r.dropoff_lat), lng=float(r.dropoff_lng),
                             window_end=(r.ts + timedelta(minutes=PROMISE_MIN)).to_pydatetime()) for r in g.itertuples()]
            p = rt.Problem(start=(float(branches.loc[b, "lat"]), float(branches.loc[b, "lng"])), stops=stops, depart_at=depart)
            res.append(solve_all(p, exact=len(stops) <= 8))
        results_dispatch[k] = summarise(res)

    results_scale = {}
    for n in SCALE_SIZES:
        res = []
        for _ in range(SCALE_INSTANCES):
            b = branches.index[int(rng.integers(len(branches)))]
            pool = d[d["branch_id"] == b]
            rows = pool.iloc[rng.choice(len(pool), size=n, replace=False)]
            stops = [rt.Stop(id=r.order_id, lat=float(r.dropoff_lat), lng=float(r.dropoff_lng)) for r in rows.itertuples()]
            p = rt.Problem(start=(float(branches.loc[b, "lat"]), float(branches.loc[b, "lng"])), stops=stops)
            res.append(solve_all(p, exact=False))
        results_scale[str(n)] = summarise(res)

    metrics = {
        "protocol": {"dispatchWindowMinutes": WINDOW_MIN, "promiseMinutes": PROMISE_MIN, "prepMinutes": PREP_MIN,
                     "speedKmh": 25.0, "roadFactor": 1.3, "distance": "haversine x road factor",
                     "availableDispatchBatches": instance_counts, "sampledPerBucket": PER_BUCKET,
                     "scaleSizes": list(SCALE_SIZES), "scaleInstances": SCALE_INSTANCES,
                     "exactBaseline": "enumeration for instances with <= 8 stops"},
        "dispatch": results_dispatch,
        "scale": results_scale,
        "runtimeSeconds": round(time.time() - t0, 1),
    }
    config = {"seed": args.seed, "dataSeed": args.data_seed, "buckets": BUCKETS, "perBucket": PER_BUCKET}
    out = common.write_results("routing", common.run_id(args.seed), config, metrics, manifest)
    print(json.dumps({"out": str(out), "dispatch": results_dispatch, "scale": results_scale, "runtimeSeconds": metrics["runtimeSeconds"]}, indent=2))


if __name__ == "__main__":
    main()
