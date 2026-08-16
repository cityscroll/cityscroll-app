#!/usr/bin/env python3
"""Pure reducer for CityScroll's browser performance contract."""

from __future__ import annotations

import json
import math
import sys
from typing import Any


METRIC_KEYS = {
    "ttfbMs",
    "fcpMs",
    "lcpMs",
    "cls",
    "wireBytes",
    "visualResponseMs",
    "settledMs",
    "eventDurationMs",
}


def quantile(values: list[float], probability: float) -> float:
    if not values:
        raise ValueError("cannot calculate a quantile without samples")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def reduce_results(
    budgets: dict[str, Any],
    statistics_config: dict[str, Any],
    collected_runs: list[dict[str, Any]],
    assert_metric: str | None = None,
    *,
    report: bool = False,
) -> dict[str, Any]:
    """Calculate the contract once from complete, ordered raw samples."""
    quantile_probability = float(statistics_config["quantile"])
    expected_samples = int(statistics_config["samples"])
    results: dict[str, Any] = {
        "version": 1,
        "statistics": {
            "quantile": quantile_probability,
            "samples": expected_samples,
            "warmupSamples": int(statistics_config["warmupSamples"]),
        },
        "runs": [],
    }
    failures: list[str] = []

    for collected in collected_runs:
        fixture_name = collected["fixture"]
        viewport_name = collected["viewport"]
        budget = budgets["fixtures"][fixture_name]
        raw = collected["samples"]
        unexpected = set(collected.get("unexpected", []))
        wire_inventories = collected.get("wireInventories", [])
        run_failures: list[str] = []

        if len(raw) != expected_samples:
            run_failures.append(
                f"expected {expected_samples} measured samples, received {len(raw)}"
            )

        summary: dict[str, float] = {}
        for metric in METRIC_KEYS:
            values = [
                float(sample[metric])
                for sample in raw
                if metric in sample and isinstance(sample[metric], (int, float))
            ]
            if values:
                summary[metric] = quantile(values, quantile_probability)

        invariant_passed = all(sample.get("invariant", 1) == 1 for sample in raw)
        wire_files = wire_inventories[0] if wire_inventories else None
        if "wireBytes" in budget and len(wire_inventories) != len(raw):
            run_failures.append(
                "wire file inventory was not captured for every measured sample"
            )
        elif wire_files is not None and any(
            inventory != wire_files for inventory in wire_inventories[1:]
        ):
            run_failures.append("wire file inventory changed across measured samples")
        if budget.get("invariant") and not invariant_passed:
            state = next(
                (sample.get("state") for sample in raw if sample.get("invariant") != 1),
                {},
            )
            run_failures.append(
                f"invariant {budget['invariant']} failed with state "
                f"{json.dumps(state, sort_keys=True)}"
            )
        for metric, ceiling in budget.items():
            if metric not in METRIC_KEYS:
                continue
            if assert_metric and metric != assert_metric:
                continue
            measured = summary.get(metric)
            if measured is None:
                run_failures.append(f"{metric} was not measured")
            elif measured > float(ceiling):
                run_failures.append(
                    f"{metric} p95 {measured:.3f} exceeds {float(ceiling):.3f}"
                )
        if unexpected:
            run_failures.append(
                "unexpected external requests: " + ", ".join(sorted(unexpected))
            )

        status = "PASS" if not run_failures else "FAIL"
        if report:
            print(
                f"{status} {fixture_name} [{viewport_name}] "
                + ", ".join(
                    f"{key}={value:.3f}" for key, value in sorted(summary.items())
                )
            )
            for failure in run_failures:
                print(f"  {failure}", file=sys.stderr)
        failures.extend(
            f"{fixture_name} [{viewport_name}]: {failure}" for failure in run_failures
        )
        run_result = {
            "fixture": fixture_name,
            "viewport": viewport_name,
            "status": status,
            "budget": budget,
            "p95": summary,
            "samples": raw,
            "failures": run_failures,
        }
        if wire_files is not None:
            run_result["wireFiles"] = wire_files
        results["runs"].append(run_result)

    results["status"] = "FAIL" if failures else "PASS"
    results["failures"] = failures
    return results
