#!/usr/bin/env python3
"""Optional Dedupe Gazetteer adapter for the scorer-contract bake-off.

Each left-hand record is treated as the canonical registry (the gazette) and
each right-hand record as an incoming observation. Dedupe's trained
probabilities are emitted without turning them into links; CityScroll policy
remains the consumer's responsibility.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_rows(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def scalar(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    return str(value)


def shaped(side: dict[str, Any], features: dict[str, Any], pair_id: str, stem_key: str) -> dict[str, Any]:
    attrs = side.get("attrs") or {}
    return {
        "name": scalar(side.get("display_name")),
        "stem": scalar(features.get(stem_key)),
        "family": scalar(features.get("family")),
        "authority_key": scalar(attrs.get("authority_keys") or attrs.get("pin") or attrs.get("epin")),
        "contract_id": scalar(attrs.get("contract_id") or attrs.get("contract_ids")),
        "_pair_id": pair_id,
    }


def run(rows: list[dict[str, Any]], out_dir: Path) -> dict[str, Any]:
    try:
        import dedupe
        from dedupe import StaticGazetteer
    except ImportError as exc:  # pragma: no cover - exercised by opt-in envs
        raise SystemExit("Dedupe adapter requires entity_resolution/eval/optional-requirements.txt") from exc

    variables = [
        dedupe.variables.String("name"),
        dedupe.variables.String("stem", has_missing=True),
        dedupe.variables.String("family", has_missing=True),
        dedupe.variables.String("authority_key", has_missing=True),
        dedupe.variables.String("contract_id", has_missing=True),
    ]
    matcher = dedupe.Gazetteer(variables, num_cores=0, in_memory=True)
    canonical: dict[str, dict[str, Any]] = dict()
    incoming: dict[str, dict[str, Any]] = dict()
    labeled = dict(match=list(), distinct=list())
    for row in rows:
        pair_id = str(row["pair_id"])
        left = shaped(row["left"], row["features"], pair_id, "left_stem")
        right = shaped(row["right"], row["features"], pair_id, "right_stem")
        canonical[pair_id] = left
        incoming[pair_id] = right
        labeled["match" if row.get("label") == "same" else "distinct"].append((left, right))

    # Dedupe's public API requires prepare_training before mark_pairs; labels
    # are passed only to this optional scorer and are never written to product state.
    matcher.prepare_training(canonical, incoming, sample_size=max(1, min(1500, len(rows))))
    matcher.mark_pairs(labeled)
    matcher.train(recall=1.0, index_predicates=False)
    matcher.index(canonical)

    def match_map(match_groups: Any) -> dict[str, tuple[float, dict[str, Any]]]:
        result: dict[str, tuple[float, dict[str, Any]]] = dict()
        for match_group in match_groups:
            for (incoming_id, canonical_id), probability in match_group:
                pair_id = str(incoming_id)
                result[pair_id] = (
                    float(probability),
                    {
                        "engine": "dedupe",
                        "mode": "gazetteer",
                        "canonical_record_id": str(canonical_id),
                        "training": "gold_labels_in_input",
                    },
                )
        return result

    incremental_by_pair = match_map(matcher.search(incoming, threshold=0.0, n_matches=None))

    out_dir.mkdir(parents=True, exist_ok=True)
    settings_path = out_dir / "dedupe_settings.bin"
    with settings_path.open("wb") as handle:
        matcher.write_settings(handle)
    settings_hash = digest(settings_path.read_bytes())
    with settings_path.open("rb") as handle:
        rebuilt = StaticGazetteer(handle, num_cores=0, in_memory=True)
    rebuilt.index(canonical)
    full_by_pair = match_map(rebuilt.search(incoming, threshold=0.0, n_matches=None))
    incremental_mismatches = list()
    scores = list()
    for row in rows:
        pair_id = row["pair_id"]
        probability, evidence = incremental_by_pair.get(pair_id, (0.0, {"engine": "dedupe", "mode": "gazetteer"}))
        full_probability = full_by_pair.get(pair_id, (0.0, {}))[0]
        if abs(probability - full_probability) > 1e-9:
            incremental_mismatches.append({"pair_id": pair_id, "incremental": probability, "full": full_probability})
        scores.append({
            "pair_id": pair_id,
            "probability": probability,
            "evidence": {**evidence, "model_artifact_hash": settings_hash},
        })
    config_hash = digest(json.dumps({"variables": [v.__class__.__name__ for v in variables], "mode": "gazetteer"}, sort_keys=True).encode())
    return {
        "scorer": {
            "contract_version": "scorer_contract_v1",
            "name": "dedupe_gazetteer",
            "version": getattr(dedupe, "__version__", "dedupe"),
            "artifact_hash": settings_hash,
            "config_hash": config_hash,
            "supports_incremental": True,
        },
        "training_overlap": True,
        "incremental_consistency": {
            "supported": True,
            "status": "measured",
            "pairs_compared": len(rows),
            "mismatch_count": len(incremental_mismatches),
            "mismatches": incremental_mismatches,
        },
        "scores": scores,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    envelope = run(read_rows(args.input), args.out_dir)
    args.output.write_text(json.dumps(envelope, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"output": str(args.output), "settings_hash": envelope["scorer"]["artifact_hash"]}))


if __name__ == "__main__":
    main()
