#!/usr/bin/env python3
"""Fail-closed verification for the WH-02 manifest and committed receipts.

Bulk source files are intentionally outside Git, so a normal checkout cannot
re-hash historical raw/Parquet files. This gate verifies the durable source
and output claims in the committed receipts, then validates any local files
when a retained warehouse root is available. Missing local bulk artifacts are
reported as warnings rather than mistaken for a successful local snapshot.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

SCRIPT_DIR = Path(__file__).resolve().parent
WAREHOUSE_DIR = SCRIPT_DIR.parent
REPO_ROOT = WAREHOUSE_DIR.parent
DEFAULT_MANIFEST = WAREHOUSE_DIR / "manifests" / "wh02_load_manifest.json"
DEFAULT_PROOF_DIR = WAREHOUSE_DIR / "receipts" / "proof"
REGISTRY_PATH = WAREHOUSE_DIR / "datasets.v0.json"
HEX64 = re.compile(r"^[0-9a-f]{64}$")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _csv_rows(path: Path) -> int:
    with path.open("r", encoding="utf-8", errors="replace", newline="") as source:
        reader = csv.reader(source)
        next(reader, None)
        return sum(1 for _ in reader)


def _local_path(value: object) -> Path | None:
    if not isinstance(value, str) or not value:
        return None
    path = Path(value)
    if path.is_absolute():
        return path
    return REPO_ROOT / value


def _iso_clock(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _positive_int(value: object) -> bool:
    try:
        return int(value) > 0
    except (TypeError, ValueError):
        return False


def _tracked_bulk_files() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z", "warehouse/raw", "warehouse/parquet", "warehouse/duckdb"],
        cwd=REPO_ROOT,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        return []
    return [item for item in result.stdout.decode("utf-8").split("\0") if item]


def verify(manifest_path: Path = DEFAULT_MANIFEST, proof_dir: Path = DEFAULT_PROOF_DIR) -> tuple[list[str], list[str]]:
    """Return (errors, warnings) without requiring local DuckDB dependencies."""
    errors: list[str] = []
    warnings: list[str] = []
    try:
        registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"cannot read dataset registry: {exc}"], warnings
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"cannot read WH-02 manifest {manifest_path}: {exc}"], warnings

    pack = registry.get("wh02_pack") or {}
    queue = list(pack.get("queue") or [])
    if manifest.get("phase") != "WH-02":
        errors.append(f"manifest phase is {manifest.get('phase')!r}, expected 'WH-02'")
    if manifest.get("first_pick") != pack.get("first_pick"):
        errors.append("manifest first_pick does not match the registry")
    if manifest.get("remaining_primary_queue"):
        errors.append(f"primary queue is not complete: {manifest['remaining_primary_queue']!r}")

    cpu = manifest.get("cpu_discipline") or {}
    for field in ("single_job_lock", "headroom_gate", "taskpolicy_or_nice_wrap", "duckdb_threads", "sequential", "no_parallel_downloads"):
        if cpu.get(field) not in (True, 1):
            errors.append(f"manifest CPU discipline missing {field}=true")
    policy = manifest.get("git_policy") or {}
    for field in ("commit_raw_bulk", "commit_parquet_bulk", "commit_duckdb_catalog"):
        if policy.get(field) is not False:
            errors.append(f"manifest git policy must keep {field}=false")

    loaded = manifest.get("loaded") or []
    entries = {entry.get("dataset_id"): entry for entry in loaded}
    if set(entries) != set(queue):
        errors.append(f"manifest loaded set {sorted(entries)!r} does not match queue {sorted(queue)!r}")
    if len(entries) != len(loaded):
        errors.append("manifest contains duplicate loaded dataset entries")

    for dataset_id in queue:
        ds = (registry.get("datasets") or {}).get(dataset_id)
        if not ds:
            errors.append(f"registry is missing queued dataset {dataset_id!r}")
            continue
        entry = entries.get(dataset_id)
        if not entry:
            continue
        proof_name = entry.get("proof_receipt") or f"warehouse/receipts/proof/{dataset_id}_bulk_latest.json"
        proof_path = (
            _local_path(proof_name)
            if Path(str(proof_name)).is_absolute() or str(proof_name).startswith("warehouse/")
            else proof_dir / str(proof_name)
        )
        if proof_path is None or not proof_path.is_file():
            errors.append(f"{dataset_id}: proof receipt missing at {proof_name}")
            continue
        try:
            receipt = json.loads(proof_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"{dataset_id}: invalid proof receipt: {exc}")
            continue

        if receipt.get("dataset_id") != dataset_id:
            errors.append(f"{dataset_id}: receipt dataset_id mismatch")
        if receipt.get("socrata_dataset_id") != ds.get("dataset_id"):
            errors.append(f"{dataset_id}: receipt Socrata dataset id mismatch")
        if receipt.get("table_name") != ds.get("table_name"):
            errors.append(f"{dataset_id}: receipt table name mismatch")
        if not receipt.get("bulk"):
            errors.append(f"{dataset_id}: receipt is not marked bulk")
        if not _iso_clock(receipt.get("observed_at")):
            errors.append(f"{dataset_id}: receipt observed_at is not an ISO timestamp")
        if not isinstance(receipt.get("snapshot_date"), str) or not receipt.get("snapshot_date"):
            errors.append(f"{dataset_id}: receipt has no snapshot_date")

        raw = receipt.get("raw") or {}
        parsed = urlparse(str(raw.get("url") or ""))
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            errors.append(f"{dataset_id}: raw source URL is missing or not HTTP(S)")
        if ds.get("dataset_id") not in parsed.path:
            errors.append(f"{dataset_id}: raw source URL does not name the registered dataset")
        for field in ("bytes", "row_count"):
            if not _positive_int(raw.get(field)):
                errors.append(f"{dataset_id}: raw.{field} must be positive")
        if not HEX64.fullmatch(str(raw.get("sha256") or "")):
            errors.append(f"{dataset_id}: raw.sha256 is not a SHA-256 digest")

        parquet = receipt.get("parquet") or {}
        for field in ("bytes", "row_count"):
            if not _positive_int(parquet.get(field)):
                errors.append(f"{dataset_id}: parquet.{field} must be positive")
        if parquet.get("row_count") != raw.get("row_count"):
            errors.append(f"{dataset_id}: raw and parquet row counts differ")
        columns = parquet.get("columns") or (receipt.get("register") or {}).get("columns") or []
        missing_fields = sorted(set(ds.get("required_fields") or []) - set(columns))
        if missing_fields:
            errors.append(f"{dataset_id}: schema is missing required fields {missing_fields!r}")

        register = receipt.get("register") or {}
        if register.get("table") != ds.get("table_name"):
            errors.append(f"{dataset_id}: registered table is missing or mismatched")
        if register.get("row_count") != raw.get("row_count"):
            errors.append(f"{dataset_id}: register and raw row counts differ")
        if register.get("catalog") and not str(register["catalog"]).endswith("cityscroll.duckdb"):
            errors.append(f"{dataset_id}: catalog path is not cityscroll.duckdb")

        for label, block, path_key, expected_bytes, expected_rows in (
            ("raw", raw, "path", raw.get("bytes"), raw.get("row_count")),
            ("parquet", parquet, "parquet_path", parquet.get("bytes"), parquet.get("row_count")),
        ):
            local = _local_path(block.get(path_key))
            if local is None or not local.is_file():
                warnings.append(f"{dataset_id}: {label} artifact is not present in this checkout")
                continue
            if local.stat().st_size != int(expected_bytes):
                errors.append(f"{dataset_id}: local {label} byte count differs from receipt")
            if label == "raw":
                if _sha256(local) != raw.get("sha256"):
                    errors.append(f"{dataset_id}: local raw checksum differs from receipt")
                if _csv_rows(local) != int(expected_rows):
                    errors.append(f"{dataset_id}: local raw row count differs from receipt")
            elif parquet.get("parquet_sha256") and _sha256(local) != parquet.get("parquet_sha256"):
                errors.append(f"{dataset_id}: local Parquet checksum differs from receipt")

        headroom = receipt.get("headroom") or {}
        if headroom.get("status") == "not_applied":
            warnings.append(f"{dataset_id}: historical receipt records headroom as not_applied")
        elif headroom.get("status") not in ("ok", "constrained", "unknown"):
            warnings.append(f"{dataset_id}: receipt has no normalized headroom status")
        if receipt.get("phase") not in ("WH-02", ds.get("bulk_phase")):
            warnings.append(f"{dataset_id}: receipt phase {receipt.get('phase')!r} is later than WH-02")

    for tracked in _tracked_bulk_files():
        if tracked.endswith("/.gitkeep") or tracked.startswith("warehouse/raw/public-records/"):
            continue
        errors.append(f"bulk artifact is tracked by Git: {tracked}")
    return errors, warnings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify WH-02 bulk receipts")
    parser.add_argument("--check", action="store_true", help="verify and exit non-zero on errors")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--proof-dir", type=Path, default=DEFAULT_PROOF_DIR)
    args = parser.parse_args(argv)
    errors, warnings = verify(args.manifest, args.proof_dir)
    for warning in warnings:
        print(f"WARN {warning}", file=sys.stderr)
    if errors:
        for error in errors:
            print(f"ERROR {error}", file=sys.stderr)
        return 1
    local_present = not any("not present" in warning for warning in warnings)
    print(f"OK WH-02 receipts verified; local bulk artifacts present={str(local_present).lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
