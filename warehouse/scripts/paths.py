"""Warehouse path resolution. Bulk data never lives in git; only code + fixtures do."""

from __future__ import annotations

import json
import os
from pathlib import Path

WAREHOUSE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = WAREHOUSE_DIR.parent
DATASETS_PATH = WAREHOUSE_DIR / "datasets.v0.json"
LOCK_PATH = WAREHOUSE_DIR / ".ingest.lock"
DEFAULT_HEADROOM = Path.home() / "dev/agentic-engineering-principles/bin/headroom.py"


def warehouse_root() -> Path:
    """Root for raw/parquet/duckdb. Override with CITYSCROLL_WAREHOUSE_ROOT (Mini volume)."""
    env = os.environ.get("CITYSCROLL_WAREHOUSE_ROOT", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    return WAREHOUSE_DIR


def raw_dir(dataset_id: str, snapshot_date: str) -> Path:
    return warehouse_root() / "raw" / dataset_id / f"snapshot_date={snapshot_date}"


def parquet_dir(dataset_id: str, snapshot_date: str) -> Path:
    return warehouse_root() / "parquet" / dataset_id / f"snapshot_date={snapshot_date}"


def duckdb_path() -> Path:
    return warehouse_root() / "duckdb" / "cityscroll.duckdb"


def receipts_dir() -> Path:
    return warehouse_root() / "receipts"


def load_registry() -> dict:
    with DATASETS_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def get_dataset(dataset_id: str) -> dict:
    reg = load_registry()
    ds = reg.get("datasets", {}).get(dataset_id)
    if not ds:
        known = ", ".join(sorted(reg.get("datasets", {})))
        raise SystemExit(f"Unknown dataset {dataset_id!r}. Known: {known}")
    return ds


def defaults() -> dict:
    return load_registry().get("defaults", {})
