#!/usr/bin/env python3
"""Re-measure RC-1 plan → PASSPort bridges with product PIN/EPIN prefix joins.

Reads committed plan shards + procurement_spine_sources passport rows (no live
publisher pull). Gates on the identifier-bearing plan denominator, reuses the
product passport join strategies, and publishes bridge edges only when a path
clears ≥30% usefulness and ≥95% precision.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "warehouse" / "lib"))
sys.path.insert(0, str(REPO_ROOT / "warehouse" / "scripts"))

from procurement_plans import (  # noqa: E402
    PRECISION_THRESHOLD,
    USEFULNESS_THRESHOLD,
    build_bridge_measurement,
    identifier_key,
)
from procurement_plans_run import (  # noqa: E402
    build_payload,
    publish_public_payload,
    write_json,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_plan_rows(site_data: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    manifest = json.loads((site_data / "procurement_planning_payload.json").read_text(encoding="utf-8"))
    plans: list[dict[str, Any]] = []
    for shard in manifest["collections"]["plans"]["shards"]:
        path = REPO_ROOT / shard["path"]
        payload = json.loads(path.read_text(encoding="utf-8"))
        plans.extend(payload.get("rows") or [])
    capital: list[dict[str, Any]] = []
    for shard in manifest["collections"]["capital_projects"]["shards"]:
        path = REPO_ROOT / shard["path"]
        payload = json.loads(path.read_text(encoding="utf-8"))
        capital.extend(payload.get("rows") or [])
    return plans + capital, manifest


def load_passport_targets(site_data: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    spine = json.loads((site_data / "procurement_spine_sources.json").read_text(encoding="utf-8"))
    rows = spine.get("rows", {}).get("passport_contracts") or []
    targets: list[dict[str, Any]] = []
    for row in rows:
        epin = row.get("epin") or row.get("epin_norm")
        key = identifier_key(epin)
        if not key:
            continue
        ctr_id = row.get("ctr_id")
        targets.append({
            "source": "passport_contract",
            "target_id": str(ctr_id or key),
            "source_url": "https://a0333-passportpublic.nyc.gov/",
            "agency": row.get("agency"),
            "title": row.get("vendor") or row.get("contract_id") or key,
            "date": row.get("registration_date") or row.get("start_date"),
            "identifiers": [key],
            "vendor": row.get("vendor"),
            "status": row.get("status"),
        })
    receipt = {
        "rows": len(targets),
        "source": "site/data/procurement_spine_sources.json",
        "spine_observed_on": spine.get("observed_on"),
        "sha256": hashlib.sha256(
            (site_data / "procurement_spine_sources.json").read_bytes()
        ).hexdigest(),
    }
    return targets, receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publish", action="store_true", help="write site payload + receipt")
    parser.add_argument("--receipt-date", default=datetime.now(timezone.utc).date().isoformat())
    parser.add_argument(
        "--sample-size",
        type=int,
        default=0,
        help="cap per source (0 = all identifier-bearing plans)",
    )
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args(argv)

    site_data = REPO_ROOT / "site" / "data"
    plans, manifest = load_plan_rows(site_data)
    targets, passport_receipt = load_passport_targets(site_data)
    generated_at = utc_now()

    id_bearing = [
        p for p in plans
        if p.get("source") in ("mocs_ll63", "mocs_ll1")
        and any(identifier_key(v) for v in (p.get("published_identifiers") or []))
    ]
    if args.sample_size > 0:
        sample_size = args.sample_size
    else:
        sample_size = max(
            sum(1 for p in id_bearing if p.get("source") == "mocs_ll63"),
            sum(1 for p in id_bearing if p.get("source") == "mocs_ll1"),
            1,
        )

    measurement, edges = build_bridge_measurement(
        plans,
        targets,
        sample_size=sample_size,
        usefulness_threshold=USEFULNESS_THRESHOLD,
        precision_threshold=PRECISION_THRESHOLD,
        sample_method="both_report",
        materialize_population=True,
    )

    class _Args:
        fiscal_year = int(manifest.get("fiscal_year") or 2027)

    payload = build_payload(
        _Args(),
        list(manifest.get("sources") or []),
        [p for p in plans if p.get("source") in ("mocs_ll63", "mocs_ll1")],
        [p for p in plans if p.get("source") == "capital_projects_dashboard"],
        edges,
        generated_at,
    )

    out = args.output_dir or (
        REPO_ROOT / "warehouse" / "raw" / "procurement-plans" / f"prefix-remeasure-{args.receipt_date}"
    )
    out = out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    write_json(out / "procurement_planning_payload.json", payload)

    passport_path = measurement["paths"].get("mocs_ll63_to_passport", {})
    ll1_path = measurement["paths"].get("mocs_ll1_to_passport", {})
    any_materialize = any(p.get("materialize") for p in measurement["paths"].values())

    receipt = {
        "schema": "cityscroll.procurement_plans.receipt.v1",
        "proof_scope": "production_materialization",
        "production_data_claimed": True,
        "observed_at": generated_at,
        "fiscal_year": payload["fiscal_year"],
        "mode": "committed_remeasure",
        "remeasure": {
            "reason": (
                "Prior fixed-sorted exact-identifier kill sample undersampled PIN-bearing "
                "renewal rows and omitted product passport prefix joins "
                "(pin_prefix_of_epin / epin_prefix_of_pin)."
            ),
            "prior_receipt": (
                "site/data/procurement_plan_sources/verification_receipts/"
                "procurement_plans_2026-08-04.json"
            ),
            "denominator": "identifier_bearing_plan_rows",
            "join_strategies": measurement["sample"]["join_strategies"],
            "product_join_reuse": measurement["sample"]["product_join_reuse"],
        },
        "sources": {
            "plans": "site/data/procurement_planning_payload/",
            "passport_contracts": "site/data/procurement_spine_sources.json",
        },
        "collection": {
            "host_side": True,
            "checkpointed": True,
            "from_committed_artifacts": True,
            "live_publisher_pull": False,
        },
        "normalization": {
            "mocs_plan_rows": len(payload["plans"]),
            "capital_project_rows": len(payload["capital_projects"]),
            "identifier_bearing_plan_rows": len(id_bearing),
            "fields": [
                "agency", "description", "procurement_method", "industry",
                "term_start", "term_end", "quarter", "budget", "published_identifiers",
            ],
            "honest_absent": True,
        },
        "bridge_targets": {
            "passport_contracts": passport_receipt,
        },
        "join_measurement": measurement,
        "payload_contract": {
            "schema": "cityscroll.procurement_planning.manifest.v1",
            "path": "site/data/procurement_planning_payload.json",
            "thread_lookup_path": "site/data/procurement_planning_thread_lookup.json",
            "reader_surface_included": False,
            "unmatched_rows_remain_unmatched": True,
            "infer_budget_from_agency_total": False,
            "production_materialized": True,
            "production_bridge_edges": len(edges),
            "fixture_bridge_edges": 0,
        },
        "headline": {
            "mocs_ll63_to_passport": {
                "joined": passport_path.get("joined"),
                "total": passport_path.get("total"),
                "rate": passport_path.get("rate"),
                "precision": passport_path.get("precision"),
                "materialize": passport_path.get("materialize"),
                "method_counts": passport_path.get("method_counts"),
            },
            "mocs_ll1_to_passport": {
                "joined": ll1_path.get("joined"),
                "total": ll1_path.get("total"),
                "rate": ll1_path.get("rate"),
                "precision": ll1_path.get("precision"),
                "materialize": ll1_path.get("materialize"),
                "method_counts": ll1_path.get("method_counts"),
            },
            "bridge_edges": len(edges),
            "shipped": any_materialize and len(edges) > 0,
        },
    }
    receipt_path = out / "procurement_plans_receipt.json"
    write_json(receipt_path, receipt)

    if args.publish:
        public_receipt = (
            site_data / "procurement_plan_sources" / "verification_receipts" /
            f"procurement_plans_{args.receipt_date}.json"
        )
        publish_public_payload(payload, site_data)
        # Keep collections metadata on the receipt in lockstep with the published manifest.
        published_manifest = json.loads(
            (site_data / "procurement_planning_payload.json").read_text(encoding="utf-8")
        )
        receipt["payload_contract"]["collections"] = published_manifest["collections"]
        receipt["payload_contract"]["shard_schema"] = published_manifest["shard_contract"]["schema"]
        receipt["payload_contract"]["shard_directory"] = "site/data/procurement_planning_payload"
        receipt["payload_contract"]["max_shard_bytes"] = published_manifest["shard_contract"]["max_bytes"]
        write_json(receipt_path, receipt)
        write_json(public_receipt, receipt)
        print(f"published {public_receipt.relative_to(REPO_ROOT)}")
        print(f"published site/data/procurement_planning_payload.json")
        print(f"published site/data/procurement_planning_thread_lookup.json")

    print(json.dumps({
        "identifier_bearing_plans": len(id_bearing),
        "passport_targets": len(targets),
        "bridge_edges": len(edges),
        "ll63_passport": receipt["headline"]["mocs_ll63_to_passport"],
        "ll1_passport": receipt["headline"]["mocs_ll1_to_passport"],
        "shipped": receipt["headline"]["shipped"],
        "receipt": str(receipt_path),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
