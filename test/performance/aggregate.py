#!/usr/bin/env python3
"""Reduce deterministic performance shards and report the parallelism pilot."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from performance_contract import reduce_results


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BUDGETS = ROOT / "performance-budgets.json"
DEFAULT_OUTPUT = ROOT / "test" / "performance" / "artifacts" / "results.json"
DEFAULT_PILOT_OUTPUT = ROOT / "test" / "performance" / "artifacts" / "pilot.json"
CONTENTION_THRESHOLD_RATIO = 0.05


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--budgets", type=Path, default=DEFAULT_BUDGETS)
    parser.add_argument("--shards-dir", type=Path, required=True)
    parser.add_argument("--serial-results", type=Path, required=True)
    parser.add_argument("--serial-timing", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--pilot-output", type=Path, default=DEFAULT_PILOT_OUTPUT)
    parser.add_argument("--summary-file", type=Path)
    parser.add_argument("--assert", dest="assert_metric")
    return parser.parse_args()


def load_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"missing required file: {path}") from None
    except json.JSONDecodeError as error:
        raise SystemExit(f"invalid JSON in {path}: {error}") from None
    if not isinstance(value, dict):
        raise SystemExit(f"expected a JSON object in {path}")
    return value


def expected_run_keys(budgets: dict[str, Any]) -> list[tuple[str, str]]:
    return [
        (fixture, viewport)
        for fixture, budget in budgets["fixtures"].items()
        for viewport in budget["viewports"]
    ]


def load_shards(
    shards_dir: Path, budgets: dict[str, Any]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    shard_paths = sorted(shards_dir.glob("shard-*.json"))
    if not shard_paths:
        raise SystemExit(f"no shard-*.json receipts found in {shards_dir}")
    shards = [load_object(path) for path in shard_paths]
    shard_counts = {item.get("shard", {}).get("count") for item in shards}
    if len(shard_counts) != 1:
        raise SystemExit(f"shard receipts disagree on shard count: {shard_counts}")
    shard_count = shard_counts.pop()
    if not isinstance(shard_count, int) or shard_count < 1:
        raise SystemExit("shard count must be a positive integer")

    sample_count = budgets["statistics"]["samples"]
    expected_statistics = {
        "quantile": float(budgets["statistics"]["quantile"]),
        "samples": sample_count,
        "warmupSamples": int(budgets["statistics"]["warmupSamples"]),
    }
    actual_ids: set[int] = set()
    expected_keys = expected_run_keys(budgets)
    expected_key_set = set(expected_keys)

    for shard in shards:
        if shard.get("version") != 1:
            raise SystemExit("performance shard version must be 1")
        if shard.get("statistics") != expected_statistics:
            raise SystemExit("performance shard statistics differ from the budget contract")
        metadata = shard.get("shard", {})
        shard_index = metadata.get("index")
        if not isinstance(shard_index, int):
            raise SystemExit("performance shard index must be an integer")
        if shard_index in actual_ids:
            raise SystemExit(f"duplicate performance shard index: {shard_index}")
        actual_ids.add(shard_index)
        expected_indexes = list(range(shard_index, sample_count, shard_count))
        if metadata.get("sampleIndexes") != expected_indexes:
            raise SystemExit(
                f"shard {shard_index} sample indexes are not the deterministic partition: "
                f"expected={expected_indexes}, actual={metadata.get('sampleIndexes')}"
            )
        runs = shard.get("runs")
        if not isinstance(runs, list):
            raise SystemExit(f"shard {shard_index} runs must be an array")
        actual_keys = {(item.get("fixture"), item.get("viewport")) for item in runs}
        if actual_keys != expected_key_set or len(runs) != len(expected_keys):
            raise SystemExit(
                f"shard {shard_index} run set differs from the budget contract"
            )

    expected_ids = set(range(shard_count))
    if actual_ids != expected_ids or len(shards) != shard_count:
        raise SystemExit(
            f"missing or unexpected performance shards: "
            f"expected={sorted(expected_ids)}, actual={sorted(actual_ids)}"
        )

    collected_runs: list[dict[str, Any]] = []
    for fixture, viewport in expected_keys:
        indexed_samples: list[tuple[int, dict[str, Any], Any]] = []
        unexpected: set[str] = set()
        for shard in shards:
            run = next(
                item
                for item in shard["runs"]
                if item["fixture"] == fixture and item["viewport"] == viewport
            )
            unexpected.update(run.get("unexpected", []))
            for envelope in run.get("samples", []):
                indexed_samples.append(
                    (envelope["index"], envelope["sample"], envelope.get("wireFiles"))
                )
        indexed_samples.sort(key=lambda item: item[0])
        indexes = [item[0] for item in indexed_samples]
        expected_indexes = list(range(sample_count))
        if indexes != expected_indexes:
            raise SystemExit(
                f"{fixture} [{viewport}] does not contain exactly {sample_count} unique "
                f"raw samples: expected={expected_indexes}, actual={indexes}"
            )
        wire_inventories = [
            wire_files
            for _index, _sample, wire_files in indexed_samples
            if wire_files is not None
        ]
        collected_runs.append(
            {
                "fixture": fixture,
                "viewport": viewport,
                "samples": [sample for _index, sample, _wire in indexed_samples],
                "unexpected": sorted(unexpected),
                "wireInventories": wire_inventories,
            }
        )

    return shards, collected_runs, expected_statistics


def build_pilot(
    serial_results: dict[str, Any],
    serial_timing: dict[str, Any],
    parallel_results: dict[str, Any],
    shards: list[dict[str, Any]],
) -> dict[str, Any]:
    if serial_results.get("statistics") != parallel_results.get("statistics"):
        raise SystemExit("serial and parallel statistics contracts differ")

    serial_runs = {
        (item["fixture"], item["viewport"]): item for item in serial_results["runs"]
    }
    parallel_runs = {
        (item["fixture"], item["viewport"]): item for item in parallel_results["runs"]
    }
    if set(serial_runs) != set(parallel_runs):
        raise SystemExit("serial and parallel result run sets differ")

    comparisons: list[dict[str, Any]] = []
    for key in serial_runs:
        serial_p95 = serial_runs[key].get("p95", {})
        parallel_p95 = parallel_runs[key].get("p95", {})
        for metric in sorted(set(serial_p95) & set(parallel_p95)):
            serial_value = float(serial_p95[metric])
            parallel_value = float(parallel_p95[metric])
            relative_change = (
                (parallel_value - serial_value) / serial_value
                if serial_value != 0
                else None
            )
            comparisons.append(
                {
                    "fixture": key[0],
                    "viewport": key[1],
                    "metric": metric,
                    "serial_p95": serial_value,
                    "parallel_p95": parallel_value,
                    "delta": parallel_value - serial_value,
                    "relative_change": relative_change,
                }
            )

    comparable = [
        item["relative_change"]
        for item in comparisons
        if item["relative_change"] is not None
    ]
    if not comparable:
        contention_state = "data_incomplete"
    elif any(value > CONTENTION_THRESHOLD_RATIO for value in comparable):
        contention_state = "observed"
    else:
        contention_state = "not_observed"

    shard_starts = [float(item["timing"]["started_epoch"]) for item in shards]
    shard_finishes = [float(item["timing"]["finished_epoch"]) for item in shards]
    parallel_wall_span = max(shard_finishes) - min(shard_starts)
    serial_started = float(serial_timing["started_epoch"])
    serial_finished = float(serial_timing["finished_epoch"])
    serial_wall_span = serial_finished - serial_started

    return {
        "version": 1,
        "status": "complete",
        "inputs": {
            "sample_count": parallel_results["statistics"]["samples"],
            "shard_count": len(shards),
            "serial_result_status": serial_results.get("status", "UNKNOWN"),
            "parallel_result_status": parallel_results.get("status", "UNKNOWN"),
        },
        "wall_spans": {
            "before_serial_seconds": serial_wall_span,
            "after_parallel_seconds": parallel_wall_span,
            "difference_seconds": parallel_wall_span - serial_wall_span,
            "speedup_ratio": (
                serial_wall_span / parallel_wall_span
                if parallel_wall_span > 0
                else None
            ),
        },
        "contention": {
            "state": contention_state,
            "threshold_ratio": CONTENTION_THRESHOLD_RATIO,
            "basis": (
                "observed when any parallel p95 exceeds its same-input serial p95 "
                "by more than five percent"
            ),
            "comparisons": comparisons,
        },
    }


def pilot_summary(pilot: dict[str, Any]) -> str:
    spans = pilot["wall_spans"]
    contention = pilot["contention"]
    speedup = spans["speedup_ratio"]
    speedup_text = f"{speedup:.2f}×" if speedup is not None else "unknown"
    return (
        "### Performance parallelism pilot\n\n"
        "| Measure | Result |\n"
        "| --- | ---: |\n"
        f"| Serial wall span | {spans['before_serial_seconds']:.1f}s |\n"
        f"| Parallel wall span | {spans['after_parallel_seconds']:.1f}s |\n"
        f"| Observed speedup | {speedup_text} |\n"
        f"| Browser contention | {contention['state']} |\n\n"
        f"The aggregate reduced all {pilot['inputs']['sample_count']} raw samples before "
        "calculating p95. Detailed per-metric comparisons are preserved in `pilot.json`.\n"
    )


def main() -> int:
    args = parse_args()
    budgets = load_object(args.budgets.resolve())
    shards, collected_runs, statistics_config = load_shards(
        args.shards_dir.resolve(), budgets
    )
    results = reduce_results(
        budgets,
        statistics_config,
        collected_runs,
        args.assert_metric,
        report=True,
    )
    serial_results = load_object(args.serial_results.resolve())
    serial_timing = load_object(args.serial_timing.resolve())
    pilot = build_pilot(serial_results, serial_timing, results, shards)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2, allow_nan=False) + "\n")
    args.pilot_output.parent.mkdir(parents=True, exist_ok=True)
    args.pilot_output.write_text(json.dumps(pilot, indent=2, allow_nan=False) + "\n")
    summary = pilot_summary(pilot)
    print(summary)
    if args.summary_file:
        with args.summary_file.open("a", encoding="utf-8") as destination:
            destination.write(summary)
    print(f"Aggregated results: {args.output}")
    print(f"Pilot receipt: {args.pilot_output}")
    return 1 if results["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
