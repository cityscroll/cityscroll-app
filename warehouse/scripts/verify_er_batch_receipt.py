#!/usr/bin/env python3
"""Fail-closed verification for the WH-04 ER batch receipt.

Parquet/DuckDB outputs stay outside Git. This gate verifies the committed
proof: snapshot pin, 200-row cap, identity publication, and promotion block.
Missing local stage files are warnings, not a claim that the historical run
never happened.
"""

from __future__ import annotations

import argparse
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
DEFAULT_PROOF = WAREHOUSE_DIR / "receipts" / "proof" / "wh04_er_batch_latest.json"
BULK_PROOF = (
    WAREHOUSE_DIR / "receipts" / "proof" / "ocp-recent-contract-awards_bulk_latest.json"
)
HEX64 = re.compile(r"^[0-9a-f]{64}$")
ABS_OR_FILE_URL = re.compile(r"^(?:/|file:|[A-Za-z]:\\)", re.I)


def _iso_clock(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _local_path(value: object) -> Path | None:
    if not isinstance(value, str) or not value:
        return None
    if value.startswith("backstage" + "://"):
        return None
    path = Path(value)
    if path.is_absolute():
        return path
    return REPO_ROOT / value


def _path_is_safe(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return True
    if value.startswith("backstage" + "://"):
        return True
    if ABS_OR_FILE_URL.match(value):
        return False
    parsed = urlparse(value)
    if parsed.scheme in ("http", "https"):
        return True
    return not Path(value).is_absolute()


def _collect_paths(node: object, found: list[str] | None = None) -> list[str]:
    found = found if found is not None else []
    if isinstance(node, dict):
        for key, value in node.items():
            if key in ("path", "receipt", "source_receipt", "raw_path", "parquet", "catalog", "stage_dir", "checkpoint") and isinstance(value, str):
                found.append(value)
            _collect_paths(value, found)
    elif isinstance(node, list):
        for item in node:
            _collect_paths(item, found)
    return found


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


def verify(proof_path: Path = DEFAULT_PROOF) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    try:
        receipt = json.loads(proof_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"cannot read WH-04 proof {proof_path}: {exc}"], warnings

    if receipt.get("phase") != "WH-04":
        errors.append(f"receipt phase is {receipt.get('phase')!r}, expected 'WH-04'")
    if receipt.get("er_batch_version") != "wh04_er_batch_v1":
        errors.append("receipt er_batch_version is not wh04_er_batch_v1")
    if not _iso_clock(receipt.get("observed_at")):
        errors.append("receipt observed_at is not an ISO timestamp")
    if receipt.get("live_ocp_cap") != 200 or receipt.get("limit") != 200:
        errors.append("receipt must keep the 200-row live OCP cap")

    metrics = receipt.get("metrics") or {}
    report = receipt.get("batch_report") or {}
    for field, metric_key in (
        ("candidates", "pair_candidates"),
        ("accepted", "pair_same"),
        ("unresolved", "pair_unresolved"),
        ("rejected", "pair_different"),
    ):
        if not isinstance(report.get(field), int) or report.get(field) < 0:
            errors.append(f"batch_report.{field} must be a non-negative integer")
        elif report.get(field) != metrics.get(metric_key):
            errors.append(f"batch_report.{field} does not match metrics.{metric_key}")
    if not isinstance(report.get("runtime_ms"), (int, float)) or report.get("runtime_ms") <= 0:
        errors.append("batch_report.runtime_ms must be a positive number")
    elif abs(float(report["runtime_ms"]) - float(receipt.get("runtime_ms") or 0)) > 0.001:
        errors.append("batch_report.runtime_ms does not match receipt.runtime_ms")

    if metrics.get("pair_candidates") != (
        int(metrics.get("pair_same") or 0)
        + int(metrics.get("pair_unresolved") or 0)
        + int(metrics.get("pair_different") or 0)
    ):
        errors.append("candidate counts do not sum to pair_candidates")

    gate = receipt.get("publication_gate") or {}
    if gate.get("unresolved_published_as_identity") is not False:
        errors.append("publication gate must keep unresolved candidates unpublished as identity")
    if gate.get("rejected_published_as_identity") is not False:
        errors.append("publication gate must keep rejected candidates unpublished as identity")
    if gate.get("accepted_same_requires_evidence") is not True:
        errors.append("publication gate must require evidence on accepted same links")

    promotion = receipt.get("promotion") or {}
    if promotion.get("allowed") is not False:
        errors.append("promotion must stay blocked without a precision review beyond the 200-row proof")
    if promotion.get("live_ocp_cap") != 200:
        errors.append("promotion live_ocp_cap must remain 200")

    residual = str(receipt.get("residual") or "")
    if "full-corpus" not in residual.lower() and "full corpus" not in residual.lower():
        errors.append("residual must refuse a full-corpus precision claim")

    snapshot = receipt.get("source_snapshot") or {}
    snap_hash = str(snapshot.get("source_snapshot_hash") or "")
    if not HEX64.fullmatch(snap_hash):
        fetch_hash = str((receipt.get("source_fetch") or {}).get("sha256") or "")
        if not HEX64.fullmatch(fetch_hash):
            errors.append("receipt is missing a SHA-256 source snapshot pin")
        else:
            warnings.append("source_snapshot.hash missing; falling back to source_fetch.sha256")
    source_receipt = snapshot.get("source_receipt") or (receipt.get("source_fetch") or {}).get("receipt")
    if isinstance(source_receipt, str) and source_receipt.endswith(
        "ocp-recent-contract-awards_bulk_latest.json"
    ):
        try:
            bulk = json.loads(BULK_PROOF.read_text(encoding="utf-8"))
            bulk_hash = str((bulk.get("raw") or {}).get("sha256") or "").lower()
            if snap_hash and snap_hash != bulk_hash:
                errors.append("warehouse replay pin does not match the WH-02 OCP bulk snapshot")
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"cannot read WH-02 OCP bulk receipt: {exc}")

    for value in _collect_paths(receipt):
        if not _path_is_safe(value):
            errors.append(f"proof path is not repository-relative or an owner-only evidence reference: {value}")

    cpu = receipt.get("cpu_discipline") or {}
    for field in ("single_job_lock", "headroom_gate", "taskpolicy_or_nice_wrap"):
        if cpu.get(field) not in (True, 1):
            errors.append(f"CPU discipline missing {field}=true")
    if cpu.get("resumable") is not True and cpu.get("incremental") is not True:
        errors.append("receipt must record a resumable or incremental run")

    review = receipt.get("quality_review")
    if isinstance(review, dict) and review:
        if review.get("candidate_pairs") != metrics.get("pair_candidates"):
            errors.append("quality review candidate_pairs does not match this ER run")
        if review.get("accepted_pair_candidates") != metrics.get("pair_same"):
            errors.append("quality review accepted_pair_candidates does not match this ER run")
        if review.get("ambiguous_pair_candidates") != metrics.get("pair_unresolved"):
            errors.append("quality review ambiguous_pair_candidates does not match this ER run")

    materialize = receipt.get("materialize") or {}
    for table in materialize.get("tables") or []:
        local = _local_path(table.get("parquet"))
        if table.get("parquet") and (local is None or not local.is_file()):
            warnings.append(f"{table.get('view')}: parquet artifact is not present in this checkout")

    stage = _local_path(receipt.get("stage_dir"))
    if receipt.get("stage_dir") and (stage is None or not stage.is_dir()):
        warnings.append("ER stage directory is not present in this checkout")

    for tracked in _tracked_bulk_files():
        if tracked.endswith("/.gitkeep") or tracked.startswith("warehouse/raw/public-records/"):
            continue
        errors.append(f"bulk artifact is tracked by Git: {tracked}")
    return errors, warnings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify WH-04 ER batch receipts")
    parser.add_argument("--check", action="store_true", help="verify and exit non-zero on errors")
    parser.add_argument("--proof", type=Path, default=DEFAULT_PROOF)
    args = parser.parse_args(argv)
    errors, warnings = verify(args.proof)
    for warning in warnings:
        print(f"WARN {warning}", file=sys.stderr)
    if errors:
        for error in errors:
            print(f"ERROR {error}", file=sys.stderr)
        return 1
    local_present = not any("not present" in warning for warning in warnings)
    print(f"OK WH-04 receipt verified; local ER artifacts present={str(local_present).lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
