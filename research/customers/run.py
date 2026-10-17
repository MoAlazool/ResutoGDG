#!/usr/bin/env python3
"""Track 2 — customer intelligence & recommendations (SYNTHETIC data; see research/customers/README.md).

Churn (temporal, no leakage)
* Reference date T = 2025-04-30 end of day; churn window W = 60 days.
* The service model (``churn_scores``) receives only orders up to T. Internally it derives labels on
  the cohort at T − W and fits logistic regression; it then scores features at T.
* Test labels: churned = no order in (T, T + W]. Baselines on the same customers: recency heuristic
  (service fallback), recency rank, and the base rate (Brier reference).
* Descriptive: RFM segment sizes at T and each segment's observed churn rate in (T, T + W].

Recommendations (leave-last-basket-out, streamed in time order so nothing from the future is used)
* Customers with ≥ 3 baskets. Validation target: second-to-last basket; test target: last basket.
* Global co-occurrence counts at a target's timestamp contain only earlier baskets and never any
  held-out basket; the customer's history is their earlier baskets.
* Methods: popularity, personal frequency, association (from the latest basket), hybrid. Hybrid weights
  are chosen on validation (NDCG@5) and reported on test. Metrics: Precision/Recall/NDCG/HitRate @3, @5.
* Sanity check on planted structure: does the top association rule from each main recover the
  generator's preferred side?
"""
from __future__ import annotations

import argparse
import itertools
import json
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common  # noqa: E402
import generate_synthetic as gen  # noqa: E402
from app.core import customers as cust  # noqa: E402
from app.core import metrics as mt  # noqa: E402
from app.core import recommend as rec  # noqa: E402

T_REF = datetime(2025, 4, 30, 23, 59, 59, tzinfo=timezone.utc)
WINDOW = 60
KS = (3, 5)
GRID_PERSONAL = (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)
GRID_ASSOC = (0.0, 0.1, 0.3, 0.5, 1.0)
GRID_POP = (0.0, 0.1, 0.3)


def churn_track(orders: pd.DataFrame, seed: int) -> dict:
    o = orders[orders["customer_id"].notna()].copy()
    o["at"] = pd.to_datetime(o["placed_at"], utc=True)
    past = o[o["at"] <= T_REF]
    future = o[(o["at"] > T_REF) & (o["at"] <= T_REF + timedelta(days=WINDOW))]
    as_orders = [cust.Order(c, t.to_pydatetime(), int(v)) for c, t, v in zip(past["customer_id"], past["at"], past["total_minor"])]
    res = cust.churn_scores(as_orders, T_REF, window_days=WINDOW, seed=seed)
    returned = set(future["customer_id"])
    scored = res["customers"]
    y = np.array([0 if c["customerId"] in returned else 1 for c in scored])
    feats = cust.features_at(as_orders, T_REF + timedelta(microseconds=1))
    gaps = [f.mean_gap_days for f in feats.values() if f.mean_gap_days]
    global_gap = float(np.median(gaps))
    model_p = np.array([c["risk"] for c in scored])
    heur_p = np.array([cust.heuristic_risk(feats[c["customerId"]], global_gap) for c in scored])
    rec_rank = pd.Series([feats[c["customerId"]].recency_days for c in scored]).rank(pct=True).values
    base = np.full(len(y), float(y.mean()))

    seg = cust.rfm_segments(as_orders, T_REF)
    seg_of = {c["customerId"]: c["segment"] for c in seg["customers"]}
    by_seg = defaultdict(list)
    for c, label in zip(scored, y):
        by_seg[seg_of[c["customerId"]]].append(label)
    return {
        "referenceDate": T_REF.isoformat(), "windowDays": WINDOW,
        "serviceMethod": res["method"], "labelCohort": res["labelCohort"], "serviceInternalHoldout": res["evaluation"],
        "test": {
            "split": "temporal: features at T from orders <= T; label = no order in (T, T+60d]",
            "customers": int(len(y)), "churnRate": float(y.mean()),
            "logisticRegression": mt.classification_metrics(y, model_p),
            "recencyHeuristic": mt.classification_metrics(y, heur_p),
            "recencyRank": mt.classification_metrics(y, rec_rank),
            "baseRate": mt.classification_metrics(y, base),
        },
        "segments": {"sizes": seg["segments"],
                     "observedChurnRate": {s: {"customers": len(v), "churnRate": float(np.mean(v))} for s, v in sorted(by_seg.items())}},
    }


def recommendation_track(orders: pd.DataFrame, lines: pd.DataFrame) -> dict:
    baskets = lines.groupby("order_id")["item_id"].apply(lambda s: sorted(set(s))).to_dict()
    o = orders[["order_id", "customer_id", "placed_at"]].copy()
    o["ts"] = pd.to_datetime(o["placed_at"], utc=True)
    o = o.sort_values(["ts", "order_id"]).reset_index(drop=True)
    by_cust = defaultdict(list)
    for i, c in zip(o.index, o["customer_id"]):
        if isinstance(c, str):
            by_cust[c].append(i)
    eligible = {c: idx for c, idx in by_cust.items() if len(idx) >= 3}
    val_t = {idx[-2]: c for c, idx in eligible.items()}
    test_t = {idx[-1]: c for c, idx in eligible.items()}
    order_ids = o["order_id"].tolist()

    configs = [dict(personal=p, assoc=a, pop=g) for p, a, g in itertools.product(GRID_PERSONAL, GRID_ASSOC, GRID_POP) if p + a + g > 0]
    named = {"popularity": {"personal": 0, "assoc": 0, "pop": 1}, "personal_frequency": {"personal": 1, "assoc": 0, "pop": 0},
             "association": {"personal": 0, "assoc": 1, "pop": 0}, "service_default": dict(rec.DEFAULT_WEIGHTS)}

    def run_phase(targets: dict, excluded: set, weight_sets: dict) -> dict:
        model = rec.CooccurrenceModel()
        acc = {name: defaultdict(list) for name in weight_sets}
        for i in range(len(order_ids)):
            if i in targets:
                c = targets[i]
                hist = [baskets[order_ids[j]] for j in by_cust[c] if j < i]
                relevant = set(baskets[order_ids[i]])
                for name, w in weight_sets.items():
                    ranked = [r["itemId"] for r in model.recommend_for_customer(hist, max(KS), weights=w)]
                    for k in KS:
                        acc[name][f"precision@{k}"].append(mt.precision_at_k(ranked, relevant, k))
                        acc[name][f"recall@{k}"].append(mt.recall_at_k(ranked, relevant, k))
                        acc[name][f"ndcg@{k}"].append(mt.ndcg_at_k(ranked, relevant, k))
                        acc[name][f"hitRate@{k}"].append(float(any(x in relevant for x in ranked[:k])))
            elif i not in excluded:
                model.add_basket(baskets[order_ids[i]])
        return {name: {m: float(np.mean(v)) for m, v in d.items()} for name, d in acc.items()}

    grid_sets = {f"p{w['personal']}_a{w['assoc']}_g{w['pop']}": w for w in configs}
    val = run_phase(val_t, set(val_t) | set(test_t), {**named, **grid_sets})
    best_key = max(grid_sets, key=lambda k: (val[k]["ndcg@5"], k))
    selected = grid_sets[best_key]
    test = run_phase(test_t, set(test_t), {**named, "hybrid_selected": selected})

    # planted structure recovery (synthetic sanity check), on all baskets before the first test target
    first_test = min(test_t)
    full = rec.CooccurrenceModel.from_baskets(baskets[order_ids[i]] for i in range(first_test) if i not in test_t and i not in val_t)
    sides = {r[0] for r in gen.MENU if r[1] == "side"}
    recovered = {}
    for main, side in gen.MAIN_SIDE_AFFINITY.items():
        top_side = next((r["itemId"] for r in full.associations(main, 30, min_pair_count=2) if r["itemId"] in sides), None)
        recovered[main] = {"plantedSide": side, "topSideByConfidence": top_side, "recovered": top_side == side}
    return {
        "protocol": {"split": "leave-last-basket-out (validation = second-to-last, test = last), streamed in time order",
                     "eligibleCustomers": len(eligible), "ks": list(KS), "gridSize": len(configs),
                     "selection": "highest validation NDCG@5"},
        "validation": {k: val[k] for k in [*named, best_key]},
        "selectedWeights": selected,
        "test": test,
        "plantedStructureRecovery": {"recoveredShare": float(np.mean([v["recovered"] for v in recovered.values()])), "mains": recovered},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--data-seed", type=int, default=2026)
    args = ap.parse_args()
    t0 = time.time()
    manifest, df = common.load_dataset(args.data_seed)
    metrics = {"churn": churn_track(df["orders"], args.seed), "recommendations": recommendation_track(df["orders"], df["order_lines"])}
    metrics["runtimeSeconds"] = round(time.time() - t0, 1)
    config = {"seed": args.seed, "dataSeed": args.data_seed, "churnReferenceDate": T_REF.isoformat(), "churnWindowDays": WINDOW,
              "ks": list(KS), "grid": {"personal": GRID_PERSONAL, "assoc": GRID_ASSOC, "pop": GRID_POP},
              "serviceDefaultWeights": rec.DEFAULT_WEIGHTS}
    out = common.write_results("customers", common.run_id(args.seed), config, metrics, manifest)
    print(json.dumps({"out": str(out), "churnTest": metrics["churn"]["test"], "selectedWeights": metrics["recommendations"]["selectedWeights"],
                      "recTest": metrics["recommendations"]["test"], "planted": metrics["recommendations"]["plantedStructureRecovery"]["recoveredShare"],
                      "runtimeSeconds": metrics["runtimeSeconds"]}, indent=2))


if __name__ == "__main__":
    main()
