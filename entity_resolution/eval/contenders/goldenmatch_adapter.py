#!/usr/bin/env python3
"""Optional GoldenMatch adapter for the scorer-contract bake-off (eval-only spike).

This adapter is deliberately outside the site and Worker build. It scores the
candidate pairs from ``candidate_pairs.jsonl`` with an explicit vendor-shaped
matchkey, measures full-vs-incremental score consistency, and exercises the
IdentityStore merge/split control-plane API. Results feed ``run_bakeoff.mjs``
and never update policy, review, or link materialization.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from pathlib import Path
from typing import Any


ADAPTER_VERSION = "goldenmatch_adapter_v1"
# Explicit matchkey — zero-config auto-configure fails on this gold shape
# (falls back to bibliographic __title_key__ and errors). Same field set as
# the Splink/Dedupe adapters so contender comparisons stay field-fair.
FIELD_SPEC = (
    {"field": "display_name", "scorer": "jaro_winkler", "weight": 0.5},
    {"field": "stem", "scorer": "exact", "weight": 0.2},
    {"field": "authority_key", "scorer": "exact", "weight": 0.3},
)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_rows(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def scalar(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    return str(value)


def shaped(side: dict[str, Any], features: dict[str, Any], stem_key: str) -> dict[str, str]:
    attrs = side.get("attrs") or {}
    return {
        "display_name": scalar(side.get("display_name")),
        "stem": scalar(features.get(stem_key)),
        "authority_key": scalar(
            attrs.get("authority_keys") or attrs.get("pin") or attrs.get("epin")
        ),
        "contract_id": scalar(attrs.get("contract_id") or attrs.get("contract_ids")),
        "family": scalar(features.get("family")),
    }


def build_fields(gm: Any) -> list[Any]:
    return [
        gm.MatchkeyField(
            field=spec["field"],
            scorer=spec["scorer"],
            weight=spec["weight"],
            transforms=["lowercase", "strip"],
        )
        for spec in FIELD_SPEC
    ]


def measure_zero_config(gm: Any, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Record whether zero-config dedupe_df can run on the gold-shaped corpus."""
    try:
        import polars as pl
    except ImportError as exc:  # pragma: no cover
        return {"attempted": True, "ok": False, "error": f"polars missing: {exc}"}

    records: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        for side, tag, stem_key in (
            (row["left"], "L", "left_stem"),
            (row["right"], "R", "right_stem"),
        ):
            shaped_row = shaped(side, row["features"], stem_key)
            shaped_row["__row_id__"] = index * 2 + (0 if tag == "L" else 1) + 1
            records.append(shaped_row)
    try:
        result = gm.dedupe_df(
            pl.DataFrame(records),
            exclude_columns=["__row_id__", "contract_id", "family"],
        )
        return {
            "attempted": True,
            "ok": True,
            "total_records": getattr(result, "total_records", None),
            "total_clusters": getattr(result, "total_clusters", None),
            "match_rate": getattr(result, "match_rate", None),
        }
    except Exception as exc:  # noqa: BLE001 — spike records failure honestly
        return {
            "attempted": True,
            "ok": False,
            "error_type": type(exc).__name__,
            "error": str(exc)[:500],
            "note": (
                "Zero-config auto-configure did not complete on the gold-shaped "
                "vendor corpus. Pair scoring uses the explicit FIELD_SPEC matchkey."
            ),
        }


def measure_merge_split(gm: Any) -> dict[str, Any]:
    """Exercise the identity control-plane merge/split API (not gold accuracy)."""
    with tempfile.TemporaryDirectory(prefix="gm-spike-") as tmp:
        store = gm.IdentityStore(
            backend="sqlite",
            path=str(Path(tmp) / "identity.db"),
        )
        try:
            keep_id = gm.new_entity_id()
            absorb_id = gm.new_entity_id()
            store.upsert_identity(
                gm.IdentityNode(
                    entity_id=keep_id,
                    golden_record={"display_name": "Acme Keep"},
                )
            )
            store.upsert_identity(
                gm.IdentityNode(
                    entity_id=absorb_id,
                    golden_record={"display_name": "Acme Absorb"},
                )
            )
            for record_id, entity_id, name in (
                ("spike-r1", keep_id, "Acme Keep"),
                ("spike-r2", keep_id, "Acme Keep Inc"),
                ("spike-r3", absorb_id, "Acme Absorb"),
            ):
                store.upsert_record(
                    gm.SourceRecord(
                        record_id=record_id,
                        source="eval_spike",
                        source_pk=record_id,
                        record_hash=gm.record_fingerprint({"display_name": name}),
                        entity_id=entity_id,
                        payload={"display_name": name},
                    )
                )
            merge_result = gm.manual_merge(
                store,
                keep_id,
                absorb_id,
                reason="bakeoff-spike",
                actor="eval",
            )
            after_merge = [r.record_id for r in store.get_records_for_entity(keep_id)]
            absorbed_status = store.get_identity(absorb_id).status
            split_result = gm.manual_split(
                store,
                keep_id,
                ["spike-r3"],
                reason="bakeoff-spike",
                actor="eval",
            )
            after_split = [r.record_id for r in store.get_records_for_entity(keep_id)]
            split_entity = store.find_entity_by_record("spike-r3")
            ok = (
                sorted(after_merge) == ["spike-r1", "spike-r2", "spike-r3"]
                and absorbed_status == "merged_into"
                and sorted(after_split) == ["spike-r1", "spike-r2"]
                and split_entity == split_result.get("new_entity_id")
            )
            return {
                "supported": True,
                "status": "measured" if ok else "failed",
                "ok": ok,
                "merge": merge_result,
                "split": split_result,
                "after_merge_record_ids": after_merge,
                "after_split_record_ids": after_split,
                "absorbed_status": absorbed_status,
                "note": (
                    "Control-plane API smoke only. Merge/split does not score gold "
                    "pairs; accuracy claims still come from pair metrics."
                ),
            }
        finally:
            store.close()


def run(rows: list[dict[str, Any]], out_dir: Path) -> dict[str, Any]:
    try:
        import goldenmatch as gm
        import polars as pl
    except ImportError as exc:  # pragma: no cover - exercised by opt-in envs
        raise SystemExit(
            "GoldenMatch adapter requires goldenmatch+polars from "
            "entity_resolution/eval/optional-requirements.txt"
        ) from exc

    fields = build_fields(gm)
    # Decision threshold stays 0.9 for bake-off policy routing. Incremental
    # match_one uses threshold 0 so every pair still returns a score rather
    # than being dropped as a non-candidate (that would invent false mismatches).
    decision_matchkey = gm.MatchkeyConfig(
        name="vendor_pair",
        type="weighted",
        threshold=0.9,
        fields=fields,
    )
    incremental_matchkey = gm.MatchkeyConfig(
        name="vendor_pair_incremental",
        type="weighted",
        threshold=0.0,
        fields=fields,
    )
    package_version = getattr(gm, "__version__", "goldenmatch")
    config_payload = {
        "adapter_version": ADAPTER_VERSION,
        "field_spec": list(FIELD_SPEC),
        "decision_threshold": decision_matchkey.threshold,
        "incremental_match_threshold": incremental_matchkey.threshold,
        "package_version": package_version,
    }
    config_hash = sha256_bytes(
        json.dumps(config_payload, sort_keys=True, separators=(",", ":")).encode()
    )
    artifact_hash = sha256_bytes(
        json.dumps(
            {"package": "goldenmatch", "version": package_version, "config_hash": config_hash},
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    )

    scores: list[dict[str, Any]] = []
    incremental_mismatches: list[dict[str, Any]] = []
    explanations: list[dict[str, Any]] = []

    for row in rows:
        pair_id = str(row["pair_id"])
        left = shaped(row["left"], row["features"], "left_stem")
        right = shaped(row["right"], row["features"], "right_stem")
        full_probability = float(gm.score_pair(left, right, fields))

        # Incremental path: score the left record against a two-row frame that
        # contains both sides (match_one), and compare the right-side score.
        frame = pl.DataFrame(
            [
                {**left, "__row_id__": 1},
                {**right, "__row_id__": 2},
            ]
        )
        match_hits = gm.match_one(left, frame, incremental_matchkey)
        by_row = {int(row_id): float(prob) for row_id, prob in match_hits}
        incremental_probability = by_row.get(2)
        if incremental_probability is None:
            incremental_mismatches.append(
                {"pair_id": pair_id, "reason": "missing_incremental_hit"}
            )
            incremental_probability = full_probability
        elif abs(full_probability - incremental_probability) > 1e-9:
            incremental_mismatches.append(
                {
                    "pair_id": pair_id,
                    "full": full_probability,
                    "incremental": incremental_probability,
                }
            )

        evidence = {
            "engine": "goldenmatch",
            "package_version": package_version,
            "adapter_version": ADAPTER_VERSION,
            "matchkey": "vendor_pair_weighted",
            "field_spec": list(FIELD_SPEC),
            "full_probability": full_probability,
            "incremental_probability": incremental_probability,
            "model_artifact_hash": artifact_hash,
        }
        scores.append(
            {
                "pair_id": pair_id,
                "probability": full_probability,
                "evidence": evidence,
            }
        )
        explanations.append({"pair_id": pair_id, **evidence})

    out_dir.mkdir(parents=True, exist_ok=True)
    explanation_path = out_dir / "goldenmatch_explanations.json"
    explanation_path.write_text(json.dumps(explanations, indent=2, sort_keys=True) + "\n")
    zero_config = measure_zero_config(gm, rows)
    merge_split = measure_merge_split(gm)
    claim_receipt = {
        "claims_under_test": [
            "accuracy_on_messy_customer_records",
            "incremental_resolution",
            "merge_split_control_plane",
        ],
        "zero_config": zero_config,
        "merge_split": merge_split,
        "scoring_path": "explicit_score_pair_plus_match_one",
        "gold_pair_count": len(rows),
    }
    claim_path = out_dir / "goldenmatch_claims_receipt.json"
    claim_path.write_text(json.dumps(claim_receipt, indent=2, sort_keys=True) + "\n")

    return {
        "scorer": {
            "contract_version": "scorer_contract_v1",
            "name": "goldenmatch",
            "version": f"goldenmatch@{package_version}/{ADAPTER_VERSION}",
            "artifact_hash": artifact_hash,
            "config_hash": config_hash,
            "supports_incremental": True,
        },
        "training_overlap": False,
        "incremental_consistency": {
            "supported": True,
            "status": "measured",
            "pairs_compared": len(rows),
            "mismatch_count": len(incremental_mismatches),
            "mismatches": incremental_mismatches,
            "method": "score_pair_vs_match_one",
        },
        "merge_split": merge_split,
        "zero_config": zero_config,
        "scores": scores,
        "explanation_artifact": str(explanation_path),
        "claims_receipt": str(claim_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    envelope = run(read_rows(args.input), args.out_dir)
    args.output.write_text(json.dumps(envelope, indent=2, sort_keys=True) + "\n")
    print(
        json.dumps(
            {
                "output": str(args.output),
                "artifact_hash": envelope["scorer"]["artifact_hash"],
                "incremental_mismatches": envelope["incremental_consistency"]["mismatch_count"],
                "merge_split_ok": envelope.get("merge_split", {}).get("ok"),
                "zero_config_ok": envelope.get("zero_config", {}).get("ok"),
            }
        )
    )


if __name__ == "__main__":
    main()
