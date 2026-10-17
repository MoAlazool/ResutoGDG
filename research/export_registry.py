#!/usr/bin/env python3
"""Exports the committed research results into the API's platform model registry
(apps/api/src/modules/intelligence/registry/baselines.generated.ts). The API upserts these rows
into ai_models / ai_evaluations at start-up, all with is_synthetic_data = true.

Usage: python research/export_registry.py   (uses the latest run of each track)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESEARCH = ROOT / "research"
OUT = ROOT / "apps" / "api" / "src" / "modules" / "intelligence" / "registry" / "baselines.generated.ts"


def latest(track: str) -> dict:
    runs = sorted((RESEARCH / track / "results").glob("*/metrics.json"))
    if not runs:
        sys.exit(f"no results for {track}; run research/{track}/run.py first")
    m = json.loads(runs[-1].read_text())
    cfg = json.loads((runs[-1].parent / "config.json").read_text())
    return {"metrics": m, "config": cfg}


def dataset(m: dict) -> dict:
    d = m["dataset"]
    return {"name": d["name"], "kind": "synthetic", "isSyntheticData": True, "generator": "research/data/generate_synthetic.py",
            "generatorSeed": d["generatorSeed"], "rows": {k: v["rows"] for k, v in d["files"].items()},
            "checksum": d["files"]["orders.csv"]["sha256"], "period": "2024-01-01..2025-06-30"}


def ev(run_id: str, split: str, metrics, baseline=None, notes=None) -> dict:
    return {"runId": run_id, "split": split, "metrics": metrics, "baselineMetrics": baseline, "isSyntheticData": True, "notes": notes}


def main():
    f, c, r = latest("forecasting"), latest("customers"), latest("routing")
    fm, cm, rm = f["metrics"], c["metrics"], r["metrics"]
    models = []

    test = fm["test"]["overall"]
    by_slice = fm["test"]["bySlice"]
    note_f = (f"Temporal rolling-origin test ({len(fm['protocol']['testOrigins'])} origins x 14 days, {fm['protocol']['series']} series). "
              "Synthetic data.")
    for name, algo, params in [
        ("seasonal_naive_7", "Seasonal naive (same weekday last week)", {}),
        ("moving_average_28", "Moving average of the last 28 days", {"window": 28}),
        ("hist_gbm", "HistGradientBoostingRegressor (Poisson) with calendar, lag and rolling features, recursive multi-step",
         {**fm["validation"]["selectedGbmParams"], "features": ["dow", "is_weekend(Fri,Sat)", "is_ramadan", "day_of_month", "lag1",
                                                                  "lag7", "lag14", "lag21", "lag28", "roll7", "roll28", "same_dow_mean4"]}),
    ]:
        evals = [ev(fm["runId"], "test", {**test[name], "bySlice": {s: v[name] for s, v in by_slice.items()}},
                    None if name == "seasonal_naive_7" else test["seasonal_naive_7"], note_f)]
        if name == "hist_gbm":
            evals.append(ev(fm["runId"], "validation", {"gbmGrid": fm["validation"]["gbmGrid"]}, None,
                            "Hyper-parameter grid on Jan-Feb 2025 validation origins (selection by pooled WAPE)."))
        models.append({"task": "demand_forecast", "name": name, "version": "v1", "algorithm": algo, "params": params, "status": "deployed",
                       "dataset": dataset(fm), "isSyntheticData": True, "evaluations": evals})
    models.append({"task": "demand_forecast", "name": "auto_select", "version": "v1",
                   "algorithm": "Per-series selection by lowest backtest WAPE among the three models (service behaviour)",
                   "params": {"backtestFolds": 3}, "status": "deployed", "dataset": dataset(fm), "isSyntheticData": True,
                   "evaluations": [ev(fm["runId"], "test", {**test["auto_select"], "interval80Coverage": fm["autoSelect"]["interval80Coverage"],
                                                             "chosenModelShare": fm["autoSelect"]["chosenModelShare"]},
                                      test["seasonal_naive_7"], note_f)]})
    models.append({"task": "demand_forecast", "name": "hist_gbm_no_ramadan", "version": "v1",
                   "algorithm": "Ablation: hist_gbm without the Ramadan flag (research only)", "params": {}, "status": "retired",
                   "dataset": dataset(fm), "isSyntheticData": True,
                   "evaluations": [ev(fm["runId"], "test", {**test["hist_gbm_no_ramadan"], "bySlice": {s: v["hist_gbm_no_ramadan"] for s, v in by_slice.items()}},
                                      test["hist_gbm"], "Ablation; baselineMetrics = hist_gbm with the Ramadan flag.")]})

    ch = cm["churn"]
    note_c = f"Temporal test: features at {ch['referenceDate']}, label = no order in the next {ch['windowDays']} days. Synthetic data."
    models.append({"task": "churn", "name": "logistic_regression", "version": "v1",
                   "algorithm": "Logistic regression on standardised recency, frequency, log-monetary, tenure, mean gap; temporally derived labels",
                   "params": {"windowDays": ch["windowDays"]}, "status": "deployed", "dataset": dataset(cm), "isSyntheticData": True,
                   "evaluations": [ev(cm["runId"], "test", ch["test"]["logisticRegression"], ch["test"]["recencyHeuristic"], note_c)]})
    models.append({"task": "churn", "name": "recency_heuristic", "version": "v1",
                   "algorithm": "risk = 1 - exp(-recency / (2 x usual gap)); fallback when labels are not derivable",
                   "params": {}, "status": "deployed", "dataset": dataset(cm), "isSyntheticData": True,
                   "evaluations": [ev(cm["runId"], "test", ch["test"]["recencyHeuristic"], ch["test"]["baseRate"], note_c)]})
    models.append({"task": "customer_segmentation", "name": "rfm_quintiles", "version": "v1",
                   "algorithm": "RFM rank quintiles with named segment rules", "params": {}, "status": "deployed",
                   "dataset": dataset(cm), "isSyntheticData": True,
                   "evaluations": [ev(cm["runId"], "test", {"segmentSizes": ch["segments"]["sizes"], "observedChurnRateBySegment": ch["segments"]["observedChurnRate"]},
                                      None, "Descriptive: share of each segment with no order in the following 60 days. Synthetic data.")]})

    rc = cm["recommendations"]
    note_r = f"Leave-last-basket-out, streamed in time order; {rc['protocol']['eligibleCustomers']} customers. Synthetic data."
    models.append({"task": "recommendation", "name": "hybrid_next_basket", "version": "v1",
                   "algorithm": "Weighted personal frequency + association confidence + popularity", "params": {"weights": rc["selectedWeights"]},
                   "status": "deployed", "dataset": dataset(cm), "isSyntheticData": True,
                   "evaluations": [ev(cm["runId"], "test", rc["test"]["hybrid_selected"], rc["test"]["popularity"], note_r),
                                   ev(cm["runId"], "validation", rc["validation"], None, "Weights chosen by validation NDCG@5.")]})
    models.append({"task": "recommendation", "name": "association_rules", "version": "v1",
                   "algorithm": "Item-to-item association rules (support, confidence, lift) with popularity fallback", "params": {"minPairCount": 2},
                   "status": "deployed", "dataset": dataset(cm), "isSyntheticData": True,
                   "evaluations": [ev(cm["runId"], "test", {**rc["test"]["association"], "plantedStructureRecovery": rc["plantedStructureRecovery"]["recoveredShare"]},
                                      rc["test"]["popularity"], note_r)]})
    models.append({"task": "recommendation", "name": "popularity", "version": "v1", "algorithm": "Global popularity (past baskets only)",
                   "params": {}, "status": "deployed", "dataset": dataset(cm), "isSyntheticData": True,
                   "evaluations": [ev(cm["runId"], "test", rc["test"]["popularity"], None, note_r)]})

    note_t = "Instance sets built from synthetic delivery orders (20-min dispatch batches; scale sets). Haversine x 1.3 at 25 km/h. Synthetic data."
    models.append({"task": "routing", "name": "nn_2opt", "version": "v1", "algorithm": "Nearest neighbour + 2-opt (distance objective)",
                   "params": {"roadFactor": 1.3, "speedKmh": 25}, "status": "deployed", "dataset": dataset(rm), "isSyntheticData": True,
                   "evaluations": [ev(rm["runId"], "test",
                                      {"dispatch": {b: v["nn_2opt_distance"] for b, v in rm["dispatch"].items()},
                                       "scale": {n: v["nn_2opt_distance"] for n, v in rm["scale"].items()}},
                                      {"dispatch": {b: v["naive"] for b, v in rm["dispatch"].items()},
                                       "scale": {n: v["naive"] for n, v in rm["scale"].items()}}, note_t)]})

    notice = fm["notice"]
    body = ("// GENERATED by research/export_registry.py from the committed research runs — do not edit by hand.\n"
            "// Every evaluation below was computed on SYNTHETIC data (is_synthetic_data = true).\n"
            "/* eslint-disable */\n"
            "export interface RegistryEvaluation { runId: string; split: 'validation' | 'test' | 'backtest'; metrics: any; baselineMetrics: any; isSyntheticData: boolean; notes: string | null }\n"
            "export interface RegistryModel { task: string; name: string; version: string; algorithm: string; params: any; dataset: any; isSyntheticData: boolean; status: string; evaluations: RegistryEvaluation[] }\n"
            f"export const REGISTRY_NOTICE = {json.dumps(notice)};\n"
            f"export const BASELINE_REGISTRY: RegistryModel[] = {json.dumps(models, indent=2)};\n")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(body)
    print(f"wrote {OUT.relative_to(ROOT)} ({len(models)} models)")


if __name__ == "__main__":
    main()
