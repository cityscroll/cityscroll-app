#!/usr/bin/env python3
"""Build the textual verification evidence for dated project comparisons.

Render proof for this work is textual on purpose: no image binaries are
committed. This records what the materialized comparison asserts, the provenance
and vintage behind it, and content hashes for the files that produce it, so a
reader can re-derive every number rather than take a picture's word for it.

  python3 tools/build_project_history_evidence.py
  python3 tools/build_project_history_evidence.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HISTORY = ROOT / "site/data/procurement_project_history.json"
OUTPUT = ROOT / "docs/evidence/procurement-project-history/verification-manifest.json"

SOURCES = {
    "materialization": "site/data/procurement_project_history.json",
    "comparison_contract": "warehouse/lib/capital_project_history.py",
    "materializer": "warehouse/scripts/capital_project_history_run.py",
    "reader": "site/procurement_project_history.mjs",
}


def sha256(relative: str) -> str:
    return hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()


def build() -> dict:
    history = json.loads(HISTORY.read_text())
    financial = {entry["fms_id"]: entry for entry in history["financial_projects"]}
    schedule = {entry["pid"]: entry for entry in history["schedule_projects"]}

    return {
        "schema": "cityscroll.procurement_project_history_verification.v1",
        "note": (
            "Reproducible textual verification of the dated project comparisons. No image "
            "binaries are committed. This record proves the materialized comparison, its "
            "provenance and its arithmetic. It does not assert a rendered reader surface: the "
            "comparison is published here as data, a read model and an export, and the panel that "
            "displays it arrives with the project summary it attaches to."
        ),
        "artifacts": {
            name: {"path": path, "sha256": sha256(path)}
            for name, path in sorted(SOURCES.items())
        },
        "data_vintage": {
            "source": "capital_projects_dashboard",
            "dataset_id": history["dataset_id"],
            "source_url": history["source_url"],
            "managing_agency": history["managing_agency"],
            "release_floor": history["release_reconciliation"]["release_floor"],
            "admitted_releases": history["release_reconciliation"]["admitted_releases"],
            "excluded_releases": history["release_reconciliation"]["excluded_releases"],
            "compared_transition": history["transition"],
        },
        "reproduce": [
            "python3 warehouse/scripts/capital_project_history_run.py --check",
            "python3 tools/build_project_history_evidence.py --check",
            "node --test test/ddc_project_history.test.mjs",
        ],
        "assertions": [
            {
                "identity": "managing agency DDC + FMS identifier ACEDCA215",
                "identity_rule": history["financial_identity_rule"],
                "assertion": (
                    "Whole-project budget rose $18,061,485.81 to $19,905,485.81, a $1,844,000.00 "
                    "change, and recorded whole-project spending rose $426,525.36, between the "
                    "January 2026 and May 2026 releases."
                ),
                "observed": {
                    "total_budget": financial["ACEDCA215"]["changes"]["total_budget"],
                    "spend_to_date": financial["ACEDCA215"]["changes"]["spend_to_date"],
                },
            },
            {
                "identity": "managing agency DDC + project identifier 4369",
                "identity_rule": history["schedule_identity_rule"],
                "assertion": (
                    "Published phase moved Design to Construction Procurement while the project "
                    "forecast completion held at 2029-06-25."
                ),
                "observed": {
                    "current_phase": schedule["4369"]["changes"]["current_phase"],
                    "forecast_completion": schedule["4369"]["changes"]["forecast_completion"],
                },
            },
            {
                "identity": "managing agency DDC + project identifier 5730",
                "identity_rule": history["schedule_identity_rule"],
                "assertion": (
                    "Project forecast completion moved 175 days earlier, from 2028-09-29 to "
                    "2028-04-07. The movement is a project forecast and is not attributed to any "
                    "contractor."
                ),
                "observed": {"forecast_completion": schedule["5730"]["changes"]["forecast_completion"]},
            },
            {
                "identity": "managing agency DDC + FMS identifier HH112CGIU",
                "identity_rule": history["financial_identity_rule"],
                "assertion": (
                    "Budget, recorded spending and project forecast completion were all unchanged. "
                    "A later release existing is not itself a change."
                ),
                "observed": {
                    "changed": financial["HH112CGIU"]["changed"],
                    "total_budget": financial["HH112CGIU"]["changes"]["total_budget"],
                },
            },
            {
                "identity": "managing agency DDC + FMS identifier PV669-NPC, project identifier 4205",
                "identity_rule": history["schedule_identity_rule"],
                "assertion": (
                    "The shared project forecast completion moved 102 days later, from 2026-07-31 "
                    "to 2026-11-10. This is a whole-project forecast shared by three separately "
                    "awarded trade contracts. It is not a contract extension and assigns no "
                    "contractor responsibility."
                ),
                "observed": {"forecast_completion": schedule["4205"]["changes"]["forecast_completion"]},
            },
            {
                "identity": "observation identity",
                "assertion": (
                    "The publisher's own record identifier omits managing agency and collides on 96 "
                    "retained rows. Adding managing agency to the observation identity resolves "
                    "every collision."
                ),
                "observed": {
                    "retained_rows": 50000,
                    "colliding_excess_source_ids": 96,
                    "colliding_excess_agency_qualified": 0,
                },
            },
            {
                "identity": "release completeness",
                "assertion": (
                    "History is published only from releases retained completely, at or after "
                    "January 2024. The two older releases are excluded and reported: one is absent "
                    "entirely and one is retained short of the publisher's own count, because the "
                    "retained pull is capped rather than paged."
                ),
                "observed": history["release_reconciliation"]["excluded_releases"],
            },
            {
                "identity": "component agreement",
                "assertion": (
                    "Repeated rows sharing one identity are components of one project. Agreeing "
                    "components collapse to their single agreed value and are never summed. "
                    "Disagreeing components are quarantined and the field is reported as "
                    "unpublished rather than resolved to one side."
                ),
                "observed": {
                    "quarantined_financial": history["counts"]["quarantined_financial"],
                    "quarantined_schedule": history["counts"]["quarantined_schedule"],
                },
            },
        ],
        "population": history["counts"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    rendered = json.dumps(build(), indent=2, sort_keys=True) + "\n"
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text() != rendered:
            print(f"stale evidence: {OUTPUT}")
            return 1
        print(f"current: {OUTPUT}")
        return 0
    OUTPUT.write_text(rendered)
    print(f"wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
