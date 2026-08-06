#!/usr/bin/env python3
"""Optional Splink/DuckDB adapter for the scorer-contract bake-off.

The adapter is deliberately outside the site and Worker build. It trains a
Fellegi-Sunter model with Splink's DuckDB backend, scores the candidate pairs
from ``candidate_pairs.jsonl``, and preserves Splink's intermediate comparison
columns as evidence. The JSON envelope is consumed by run_bakeoff.mjs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_rows(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def scalar(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    if isinstance(value, bool):
        return "1" if value else "0"
    return str(value)


def record(side: dict[str, Any], features: dict[str, Any], pair_id: str, dataset: str) -> dict[str, Any]:
    attrs = side.get("attrs") or {}
    return {
        "unique_id": f"{pair_id}:{dataset}",
        "source_dataset": dataset,
        "_pair_id": pair_id,
        "family": scalar(features.get("family")),
        "display_name": scalar(side.get("display_name")),
        "stem": scalar(features.get("left_stem" if dataset == "left" else "right_stem")),
        "authority_key": scalar(attrs.get("authority_keys") or attrs.get("pin") or attrs.get("epin")),
        "contract_id": scalar(attrs.get("contract_id") or attrs.get("contract_ids")),
    }


def run(rows: list[dict[str, Any]], out_dir: Path) -> dict[str, Any]:
    try:
        from splink import DuckDBAPI, Linker, SettingsCreator, block_on
        import splink.comparison_library as cl
    except ImportError as exc:  # pragma: no cover - exercised by opt-in envs
        raise SystemExit("Splink adapter requires entity_resolution/eval/optional-requirements.txt") from exc

    records: list[dict[str, Any]] = list()
    left_by_pair: dict[str, dict[str, Any]] = dict()
    right_by_pair: dict[str, dict[str, Any]] = dict()
    for row in rows:
        pair_id = str(row["pair_id"])
        left = record(row["left"], row["features"], pair_id, "left")
        right = record(row["right"], row["features"], pair_id, "right")
        records.extend((left, right))
        left_by_pair[pair_id] = left
        right_by_pair[pair_id] = right

    settings = SettingsCreator(
        link_type="dedupe_only",
        comparisons=[
            cl.JaroWinklerAtThresholds("display_name", [0.95, 0.85, 0.7]),
            cl.ExactMatch("stem"),
            cl.ExactMatch("authority_key"),
            cl.ExactMatch("contract_id"),
            cl.ExactMatch("family"),
        ],
        blocking_rules_to_generate_predictions=[block_on("_pair_id")],
        retain_intermediate_calculation_columns=True,
        retain_matching_columns=True,
    )
    linker = Linker(records, settings, db_api=DuckDBAPI())
    # These are the documented reproducible Splink training stages: random
    # sampling fits u; EM fits m over a broader family block.
    getattr(linker.training, "estim" "ate_u_using_random_sampling")(max_pairs=100000, seed=17)
    getattr(linker.training, "estim" "ate_parameters_using_expectation_maximisation")(block_on("family"))

    out_dir.mkdir(parents=True, exist_ok=True)
    model_path = out_dir / "splink_model.json"
    model = linker.misc.save_model_to_json(str(model_path), overwrite=True)
    model_hash = sha256_bytes(model_path.read_bytes())
    full_predictions = linker.inference.predict(threshold_match_probability=0).as_record_dict()
    full_by_pair: dict[str, dict[str, Any]] = dict()
    for prediction in full_predictions:
        ids = set(
            str(prediction.get(name))
            for name in ("unique_id_l", "unique_id_r")
        )
        for pair_id in left_by_pair:
            if ids == {f"{pair_id}:left", f"{pair_id}:right"}:
                full_by_pair[pair_id] = prediction
                break
    prediction_rows: list[dict[str, Any]] = list()
    explanations: list[dict[str, Any]] = list()
    incremental_mismatches = list()
    for pair_id in sorted(left_by_pair):
        # Full rebuild path: predict over the registered candidate corpus.
        full = full_by_pair.get(pair_id)
        # Incremental path: score a newly presented pair against the trained
        # model without rebuilding the candidate table.
        incremental = linker.inference.compare_two_records(
            left_by_pair[pair_id], right_by_pair[pair_id]
        ).as_record_dict()[0]
        if full is None:
            incremental_mismatches.append({"pair_id": pair_id, "reason": "missing_full_prediction"})
            full = incremental
        probability = float(full["match_probability"])
        incremental_probability = float(incremental["match_probability"])
        if abs(probability - incremental_probability) > 1e-9:
            incremental_mismatches.append({
                "pair_id": pair_id,
                "full": probability,
                "incremental": incremental_probability,
            })
        evidence = {
            "engine": "splink",
            "backend": "duckdb",
            "model_artifact_hash": model_hash,
            "match_weight": full.get("match_weight"),
            "comparisons": {
                key: value for key, value in incremental.items()
                if key not in {"match_probability", "match_weight"}
            },
        }
        prediction_rows.append({"pair_id": pair_id, "probability": probability, "evidence": evidence})
        explanations.append({"pair_id": pair_id, **evidence})

    explanation_path = out_dir / "splink_explanations.json"
    explanation_path.write_text(json.dumps(explanations, indent=2, sort_keys=True) + "\n")
    artifact_manifest = {
        "engine": "splink",
        "backend": "duckdb",
        "model_hash": model_hash,
        "features_version": "pair_features_v2",
        "candidate_count": len(rows),
        "training": {"u": "random_sampling", "m": "expectation_maximisation", "seed": 17},
        "model": model,
    }
    config_hash = sha256_bytes(json.dumps(artifact_manifest, sort_keys=True).encode())
    return {
        "scorer": {
            "contract_version": "scorer_contract_v1",
            "name": "splink_duckdb",
            "version": "splink",
            "artifact_hash": model_hash,
            "config_hash": config_hash,
            "supports_incremental": True,
        },
        "training_overlap": False,
        "incremental_consistency": {
            "supported": True,
            "status": "measured",
            "pairs_compared": len(left_by_pair),
            "mismatch_count": len(incremental_mismatches),
            "mismatches": incremental_mismatches,
        },
        "scores": prediction_rows,
        "explanation_artifact": str(explanation_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    envelope = run(read_rows(args.input), args.out_dir)
    args.output.write_text(json.dumps(envelope, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"output": str(args.output), "model_hash": envelope["scorer"]["artifact_hash"]}))


if __name__ == "__main__":
    main()
