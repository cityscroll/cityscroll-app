#!/usr/bin/env python3
"""Materialize dated capital-project comparisons for procurement research.

Acquisition-time builder. Reader surfaces consume the artifact this writes and
never query the publisher themselves.

The publisher reissues every project each release, so "what changed" is only
answerable by differencing two releases under a stable identity. This script
acquires the managing agency's rows, admits only releases retained completely,
and writes the comparison plus the two original observations behind it.

  python3 warehouse/scripts/capital_project_history_run.py
  python3 warehouse/scripts/capital_project_history_run.py --check
  python3 warehouse/scripts/capital_project_history_run.py --rows snapshot.json
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from warehouse.lib.capital_project_history import (  # noqa: E402
    COMPARED,
    FINANCIAL_FIELDS,
    RELEASE_FLOOR,
    SCHEDULE_FIELDS,
    build_series,
    clean,
    compare_observations,
    financial_identity,
    has_change,
    history_depth,
    reconcile_releases,
    schedule_identity,
    transition_releases,
)

SCHEMA = "cityscroll.procurement_project_history.v1"
DATASET_ID = "fb86-vt7u"
DATASET = f"https://data.cityofnewyork.us/resource/{DATASET_ID}.json"
SOURCE_URL = f"https://data.cityofnewyork.us/d/{DATASET_ID}"
SOURCE_CONTRACT_ID = "capital-projects-dashboard"
MANAGING_AGENCY = "DDC"
OUTPUT = ROOT / "site/data/procurement_project_history.json"
PAGE_SIZE = 5000
RETAINED_PAYLOAD = ROOT / "site/data/procurement_planning_payload"
USER_AGENT = "cityscroll-materializer (+https://cityscroll.org; capital-project history)"


def fetch_json(url: str) -> object:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.loads(response.read().decode("utf-8"))


def publisher_release_counts() -> dict[str, int]:
    """The publisher's own row count per release, used to prove completeness."""
    query = urllib.parse.urlencode({
        "$select": "reporting_period,count(*) as row_count",
        "$group": "reporting_period",
        "$order": "reporting_period",
    })
    return {
        clean(row["reporting_period"]): int(row["row_count"])
        for row in fetch_json(f"{DATASET}?{query}")
    }


def retained_release_counts() -> dict[str, int]:
    """Row count per release in this repository's retained capital materialization.

    History is published from what the repository actually retains, so the retained
    materialization is the side that has to be proven complete against the
    publisher. Its own pull is capped rather than paged, which truncates the oldest
    releases; differencing against a truncated release would report projects as
    disappearing when only the request stopped early.
    """
    counts: dict[str, int] = {}
    for shard in sorted(RETAINED_PAYLOAD.glob("capital-projects-*.json")):
        for row in json.loads(shard.read_text())["rows"]:
            period = clean(row.get("reporting_period"))
            counts[period] = counts.get(period, 0) + 1
    return counts


def fetch_agency_rows(agency: str) -> list[dict]:
    """Page through every published row for one managing agency.

    Paging matters: a single capped request silently truncates the oldest
    releases, which would read as projects disappearing rather than as rows the
    request never asked for.
    """
    rows: list[dict] = []
    offset = 0
    while True:
        query = urllib.parse.urlencode({
            "$where": f"managing_agency='{agency}'",
            "$order": "reporting_period,pid,fms_id",
            "$limit": PAGE_SIZE,
            "$offset": offset,
        })
        page = fetch_json(f"{DATASET}?{query}")
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE


def project_entry(identity, series_for_identity, before_period, after_period, admitted, id_field):
    comparison = compare_observations(
        series_for_identity.get(before_period),
        series_for_identity.get(after_period),
    )
    published = [period for period in admitted if period in series_for_identity]
    return {
        id_field: identity[1],
        "managing_agency": identity[0],
        "identity_state": comparison["identity_state"],
        "changed": has_change(comparison),
        "history_depth": history_depth(series_for_identity, admitted),
        "first_observed_release": published[0] if published else None,
        "last_observed_release": published[-1] if published else None,
        "before": comparison["before"],
        "after": comparison["after"],
        "changes": comparison["changes"],
    }


def build(
    rows: list[dict],
    publisher_counts: dict[str, int],
    retained_counts: dict[str, int],
    agency: str,
) -> dict:
    # Completeness is a property of the whole release, not of one agency's slice:
    # a truncated pull can retain every row for one agency and still be partial.
    reconciliation = reconcile_releases(publisher_counts, retained_counts, RELEASE_FLOOR)
    admitted = reconciliation["admitted_releases"]
    acquired_periods = {clean(row.get("reporting_period")) for row in rows}
    missing_releases = [period for period in admitted if period not in acquired_periods]
    if missing_releases:
        raise SystemExit(f"acquisition missing admitted releases: {missing_releases}")
    before_period, after_period = transition_releases(admitted)

    financial_series, financial_quarantine = build_series(
        rows, financial_identity, FINANCIAL_FIELDS, admitted,
    )
    schedule_series, schedule_quarantine = build_series(
        rows, schedule_identity, SCHEDULE_FIELDS, admitted,
    )

    financial = [
        project_entry(identity, series, before_period, after_period, admitted, "fms_id")
        for identity, series in sorted(financial_series.items())
    ]
    schedule = [
        project_entry(identity, series, before_period, after_period, admitted, "pid")
        for identity, series in sorted(schedule_series.items(), key=lambda item: (item[0][0], int(item[0][1]) if item[0][1].isdigit() else 0, item[0][1]))
    ]

    def tally(entries: list[dict]) -> dict[str, int]:
        return {
            "identities": len(entries),
            "compared": sum(1 for entry in entries if entry["identity_state"] == COMPARED),
            "changed": sum(1 for entry in entries if entry["changed"]),
            "unchanged": sum(1 for entry in entries if entry["identity_state"] == COMPARED and not entry["changed"]),
            "disappeared": sum(1 for entry in entries if entry["identity_state"] == "disappeared"),
            "first_observed": sum(1 for entry in entries if entry["identity_state"] == "first_observed"),
            "single_observation": sum(1 for entry in entries if entry["history_depth"] == 1),
        }

    return {
        "schema": SCHEMA,
        "source": "capital_projects_dashboard",
        "source_contract_id": SOURCE_CONTRACT_ID,
        "dataset_id": DATASET_ID,
        "source_url": SOURCE_URL,
        "managing_agency": agency,
        "scope": (
            "Whole-project budgets, recorded project spending and project forecasts published by "
            "the capital projects dashboard. Not solicitation values, bid deadlines or contract terms."
        ),
        "financial_identity_rule": "managing_agency + fms_id",
        "schedule_identity_rule": "managing_agency + nonempty pid",
        "release_reconciliation": reconciliation,
        "transition": {"before": before_period, "after": after_period},
        "counts": {
            "acquired_rows": len(rows),
            "admitted_agency_rows": sum(
                1 for row in rows if clean(row.get("reporting_period")) in set(admitted)
            ),
            "financial": tally(financial),
            "schedule": tally(schedule),
            "quarantined_financial": len(financial_quarantine),
            "quarantined_schedule": len(schedule_quarantine),
        },
        "financial_projects": financial,
        "schedule_projects": schedule,
        "quarantine": {
            "financial": sorted(financial_quarantine, key=lambda item: (item["identity"], item["reporting_period"])),
            "schedule": sorted(schedule_quarantine, key=lambda item: (item["identity"], item["reporting_period"])),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="compare against the committed artifact")
    parser.add_argument("--rows", type=Path, help="materialize from a local acquisition snapshot")
    parser.add_argument("--publisher-counts", type=Path, help="local publisher release counts for offline runs")
    parser.add_argument("--agency", default=MANAGING_AGENCY)
    parser.add_argument("--out", type=Path, default=OUTPUT)
    args = parser.parse_args()

    retained_counts = retained_release_counts()
    if args.rows:
        rows = json.loads(args.rows.read_text())
        publisher_counts = json.loads(args.publisher_counts.read_text()) if args.publisher_counts else retained_counts
    else:
        publisher_counts = publisher_release_counts()
        rows = fetch_agency_rows(args.agency)

    payload = build(rows, publisher_counts, retained_counts, args.agency)
    rendered = json.dumps(payload, indent=2, sort_keys=True) + "\n"

    if args.check:
        if not args.out.exists():
            print(f"missing artifact: {args.out}", file=sys.stderr)
            return 1
        if args.out.read_text() != rendered:
            print(f"stale artifact: {args.out}", file=sys.stderr)
            return 1
        print(f"current: {args.out}")
        return 0

    args.out.write_text(rendered)
    print(f"wrote {args.out} ({len(rendered)} bytes) at {datetime.now(timezone.utc).isoformat()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
