"""Shared helpers for the research pipelines: dataset loading (regenerating the seeded synthetic
dataset when missing and verifying its checksums), run ids and result writing.

The models evaluated here are imported from ``apps/ai-service/app/core`` — the same code the
production service runs."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RESEARCH = ROOT / "research"
sys.path.insert(0, str(ROOT / "apps" / "ai-service"))
sys.path.insert(0, str(RESEARCH / "data"))

import generate_synthetic as gen  # noqa: E402

DATA_DIR = RESEARCH / "data" / "synthetic" / gen.DATASET_NAME
SYNTHETIC_NOTICE = ("SYNTHETIC DATA: all metrics in this file were computed on the seeded synthetic dataset "
                    f"'{gen.DATASET_NAME}' (research/data/generate_synthetic.py). They show that the pipeline runs "
                    "and how the baselines compare on simulated patterns; they are NOT evidence of real-world performance.")


def load_dataset(seed: int = gen.DEFAULT_CONFIG["seed"]) -> tuple[dict, dict[str, pd.DataFrame]]:
    manifest_path = DATA_DIR / "manifest.json"
    if not manifest_path.exists() or json.loads(manifest_path.read_text())["config"]["seed"] != seed:
        gen.generate({**gen.DEFAULT_CONFIG, "seed": seed}, DATA_DIR)
    manifest = json.loads(manifest_path.read_text())
    for name, meta in manifest["files"].items():
        digest = hashlib.sha256((DATA_DIR / name).read_bytes()).hexdigest()
        if digest != meta["sha256"]:
            raise RuntimeError(f"checksum mismatch for {name}; regenerate the dataset")
    frames = {name.removesuffix(".csv"): pd.read_csv(DATA_DIR / name, keep_default_na=False, na_values=[""])
              for name in manifest["files"]}
    return manifest, frames


def git_revision() -> str | None:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return None


def run_id(seed: int) -> str:
    return f"{datetime.now(timezone.utc).strftime('%Y%m%d')}-seed{seed}"


def environment() -> dict:
    import numpy
    import sklearn

    return {"python": platform.python_version(), "numpy": numpy.__version__, "pandas": pd.__version__,
            "scikitLearn": sklearn.__version__, "platform": platform.platform(), "cpuCount": os.cpu_count()}


def write_results(track: str, rid: str, config: dict, metrics: dict, manifest: dict) -> Path:
    out = RESEARCH / track / "results" / rid
    out.mkdir(parents=True, exist_ok=True)
    dataset = {"name": manifest["dataset"], "kind": "synthetic", "isSyntheticData": True,
               "files": {k: v for k, v in manifest["files"].items()}, "generatorSeed": manifest["config"]["seed"]}
    (out / "config.json").write_text(json.dumps({**config, "dataset": dataset, "gitRevision": git_revision(),
                                                 "environment": environment()}, indent=2))
    (out / "metrics.json").write_text(json.dumps({"notice": SYNTHETIC_NOTICE, "isSyntheticData": True, "track": track,
                                                  "runId": rid, "seed": config["seed"], "dataset": dataset, **metrics}, indent=2))
    return out
