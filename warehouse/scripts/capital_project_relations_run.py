#!/usr/bin/env python3
"""Materialize the exact published-project-code relation for reader surfaces.

The join runs here, once, over retained source projections. `site/data/`
receives only the result, so a procurement page never asks a publisher anything
at read time and never re-derives a match in the browser.

Inputs are the two retained projections under
`warehouse/fixtures/procurement-project-context/`: the City Record procurement
notices this agency published, and the agency's published capital project code
roster with the detail rows the roster resolves to. Both carry their own source
URL, scope and observation dates, which are copied into the output so a reader
can see exactly what was observed and when.

Usage:
    python3 warehouse/scripts/capital_project_relations_run.py           # write
    python3 warehouse/scripts/capital_project_relations_run.py --check   # verify
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "warehouse"))

from lib.capital_project_relations import (  # noqa: E402
    MATERIALIZATION_SCHEMA,
    MINIMUM_CODE_LENGTH,
    RELATION_METHOD,
    build_capital_project_relations,
    build_contract_relations,
)

FIXTURE_DIR = REPO_ROOT / "warehouse" / "fixtures" / "procurement-project-context"
NOTICES = FIXTURE_DIR / "city-record-ddc-notices.json"
CAPITAL = FIXTURE_DIR / "capital-ddc-project-index.json"
CONTRACTS = FIXTURE_DIR / "registered-ddc-contracts.json"
OUTPUT = REPO_ROOT / "site" / "data" / "procurement_project_context.json"

MANAGING_AGENCY = "DDC"


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def build() -> dict:
    notices = load(NOTICES)
    capital = load(CAPITAL)
    contracts = load(CONTRACTS)
    result = build_capital_project_relations(
        notices["rows"],
        capital["rows"],
        managing_agency=capital["managing_agency"],
        code_roster=capital["code_roster"],
    )
    # Registered contracts are a third entity, not a property of either of the
    # other two. They are carried as their own typed edges so a later surface
    # can read them without a solicitation relation implying a contract, or a
    # contract edge implying the package is covered.
    contract_relations = build_contract_relations(
        contracts["rows"],
        capital["rows"],
        managing_agency=capital["managing_agency"],
        code_roster=capital["code_roster"],
    )
    return {
        "schema": MATERIALIZATION_SCHEMA,
        "relation_method": RELATION_METHOD,
        "managing_agency": MANAGING_AGENCY,
        "policy": {
            # The review policy travels with the data: a reader that cannot see
            # these statements is not entitled to present the relation.
            "join": "managing agency plus a whole published project code carried in the notice text",
            "agency_match_alone_is_not_a_relation": True,
            "unresolved_candidates_remain_unlinked": True,
            "identifier_conflicts_preserved_unrepaired": True,
            "amounts_are_project_scope": "project budget and recorded project spending, never a solicitation value",
            "dates_are_project_scope": "project forecast, never a bid deadline or a binding contract term",
            "scope_is_wider_project": "published project scope, never verified requirements of the advertised package",
            "minimum_code_length": MINIMUM_CODE_LENGTH,
        },
        "source_scope": {
            "solicitations": {
                "source": notices["source"],
                "source_url": notices["source_url"],
                "landing_url": notices["landing_url"],
                "scope": notices["scope"],
                "observed_window": notices["observed_window"],
                "extract_date": notices["extract_date"],
                "rows": notices["row_count"],
            },
            "registered_contracts": {
                "source": contracts["source"],
                "derived_from": contracts["derived_from"],
                "observed_on": contracts["observed_on"],
                "managing_agency": contracts["managing_agency"],
                "rows": contracts["row_count"],
            },
            "capital_projects": {
                "source": capital["source"],
                "source_url": capital["source_url"],
                "landing_url": capital["landing_url"],
                "reporting_period": capital["reporting_period"],
                "managing_agency": capital["managing_agency"],
                "published_project_codes": capital["roster_count"],
            },
        },
        "counts": {
            **result["counts"],
            "registered_contracts_considered": contracts["row_count"],
            "registered_contracts_related": len({
                edge["registered_contract"]["contract_id"] for edge in contract_relations
            }),
            "registered_contract_relations": len(contract_relations),
        },
        "relations": result["relations"],
        "registered_contract_relations": contract_relations,
        "unlinked_solicitations": result["unlinked_solicitations"],
        "unresolved_component_codes": result["unresolved_component_codes"],
    }


def serialize(payload: dict) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the committed artifact is stale")
    args = parser.parse_args(argv)

    text = serialize(build())
    if args.check:
        if not OUTPUT.is_file():
            print(f"missing materialization: {OUTPUT.relative_to(REPO_ROOT)}", file=sys.stderr)
            return 1
        if OUTPUT.read_text(encoding="utf-8") != text:
            print(
                f"{OUTPUT.relative_to(REPO_ROOT)} is stale; rerun "
                "python3 warehouse/scripts/capital_project_relations_run.py",
                file=sys.stderr,
            )
            return 1
        print(f"{OUTPUT.relative_to(REPO_ROOT)} is current")
        return 0

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
