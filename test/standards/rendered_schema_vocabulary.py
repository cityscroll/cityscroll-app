#!/usr/bin/env python3
"""Catalog implementation vocabulary on rendered resident surfaces.

The catalog has two independent surface passes:

* ``default_document`` covers every current ``site/**/*.html`` build product.
* ``route_state`` covers the finite document, route, tab, facet, and scope matrix.

Each pass records default reader copy separately from text behind a closed ``details``
affordance. Findings are grouped by surface family and leak category. A finding is an
error unless it matches a reviewed, named entry in the adjacent exception register.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import pathlib
import re
import sys
from collections import Counter
from typing import Any

from playwright.sync_api import Page, sync_playwright

ROOT = pathlib.Path(__file__).parents[2]
SITE = ROOT / "site"
DEFAULT_ALLOWLIST = pathlib.Path(__file__).with_name("resident_surface_allowlist.json")
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402

BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/")
if not BASE.endswith("/"):
    BASE += "/"

_AGENCY_LOOKUP = json.loads((SITE / "data" / "agency_constellation_lookup.json").read_text(encoding="utf-8"))
_BUILT_AGENCY_IDS = frozenset(_AGENCY_LOOKUP.get("by_id", {}))


def is_current_built_document(path: pathlib.Path) -> bool:
    relative = path.relative_to(SITE).parts
    return not (
        len(relative) == 3
        and relative[0] == "agencies"
        and relative[2] == "index.html"
        and relative[1] not in _BUILT_AGENCY_IDS
    )


STATIC_DOCUMENTS = tuple(
    "" if path.relative_to(SITE).as_posix() == "index.html" else path.relative_to(SITE).as_posix()
    for path in sorted(SITE.rglob("*.html"))
    if is_current_built_document(path)
)

# Source: DOCUMENT_FACET_HASHES, DOCUMENT_CONCEPT_ROUTES, and documentRouteRaw() in
# site/app/routing.mjs. These are edge-rendered documents backed by the shell locally.
DOCUMENT_ROUTES = (
    "now/",
    "browse/",
    "browse/people/",
    "browse/places/",
    "browse/contracts/",
    "browse/staffing/",
    "browse/zoning/",
    "browse/property/",
    "browse/rules/",
    "browse/meetings/",
    "notices/20260701099",
    "notices/20260527036",
    "agencies/housing-preservation-and-development/?tab=forecast",
    "vendors/CAMBA/",
    "officials/7801/",
    "community-boards/bronx-cb-01/",
    "agencies/office-of-the-mayor/",
    "parcels/1000730008/",
    "community-boards/bronx-cb-02/",
)

# Source: the finite hash grammar in applyHash() and the scope controls declared by
# site/index.html. Query variants exercise states that are not represented by a bare tab.
ROOT_HASH_STATES = (
    ("tab:money-default", "#money"),
    ("tab:money-awards", "#money?mode=award&agency=Housing%20Preservation%20and%20Development"),
    ("tab:money-location", "#money?mode=allrfp&basis=contract_action_address&boro=Brooklyn&cd=K02&council=35"),
    ("tab:people-guide", "#people?view=guide&interest=technology&eligibility=open_competitive&window=actionable"),
    ("tab:people-agency", "#people?agency=Housing%20Preservation%20and%20Development&q=engineer"),
    ("tab:people-history", "#people?window=closed&format=written&salary=45k_60k&fee=low&experience=no"),
    ("tab:land-status", "#land?status=hearings&boro=Queens&cd=Q07&council=26&closing=week"),
    ("tab:land-project", "#land/2024M0193"),
    ("tab:property-scope", "#property?agency=Housing%20Preservation%20and%20Development&boro=Brooklyn&process=disposition&view=archive"),
    ("tab:property-parcel", "#property?facet=%7B%22entity_refs_all%22%3A%5B%22bbl%3A3025180036%22%5D%7D"),
    ("tab:rules-scope", "#rules?agency=Housing%20Preservation%20and%20Development&q=rent"),
    ("tab:meetings-place", "#meetings?when=all&boro=Brooklyn&cd=K02&council=35&process=outcomes&group=place"),
    ("route:notice", "#notice/20260701099"),
    ("route:notice-focus", "#notice/20260701099?focus=follow-the-dollars"),
    ("route:exam", "#exam/6001"),
    ("route:vendor", "#vendor/CAMBA"),
    ("route:agency", "#agency/Housing%20Preservation%20and%20Development?tab=forecast"),
    ("route:official", "#official/7801?event=22526&notice=20260706036"),
    ("route:matter", "#matter/84124P0003001"),
    ("route:investigation", "#investigation"),
    ("route:investigation-shared", "#investigation/shared/INV-1"),
    ("route:task-bid", "#task/can-i-bid"),
    ("route:task-change", "#task/what-will-change"),
    ("route:legacy-alerts", "#alerts"),
    ("route:legacy-map", "#map?level=borough&parent=Brooklyn&lens=meetings"),
    ("route:legacy-staffing", "#staffing?view=guide"),
)

NEAR_YOU_STATES = (
    ("near-you:default", "near-you/"),
    ("near-you:meetings", "near-you/#meetings"),
    ("near-you:money", "near-you/#money"),
    ("near-you:map-city", "near-you/#map?level=citywide&lens=meetings"),
    ("near-you:map-borough", "near-you/#map?level=borough&parent=Brooklyn&lens=money"),
    ("near-you:map-community-district", "near-you/#map?level=community_district&parent=Brooklyn&id=K02&lens=meetings"),
    ("near-you:map-council-district", "near-you/#map?level=council_district&parent=Brooklyn&id=35&lens=property"),
)

FOLLOWING_STATES = (
    ("following:default", "following/"),
    ("following:create", "following/#create"),
    ("following:your-following", "following/#your-following"),
)

SNAKE_CASE = re.compile(r"\b[a-z]+(?:_[a-z0-9]+)+\b")
LEAK_PATTERNS = (
    (
        "unavailable_debug_copy",
        re.compile(
            r"(?:\b(?:Source|Source record|Source fields|Join method)\b[^<]{0,100}\bUnavailable\b|\bUnavailable\b\s*</(?:dd|span|p|div)>)",
            re.I,
        ),
    ),
    ("reconciliation_disclaimer", re.compile(r"This check compares claims", re.I)),
)
LEAK_CATEGORIES = ("implementation_schema", *(category for category, _ in LEAK_PATTERNS))

FAMILY_BY_PREFIX = {
    "agencies": "agency",
    "browse": "browse",
    "community-boards": "community_board",
    "districts": "district",
    "exams": "exam",
    "following": "following",
    "mandates": "mandate",
    "near-you": "near_you",
    "notices": "notice",
    "now": "now",
    "packs": "pack",
    "parcels": "parcel",
    "search": "search",
    "vendors": "vendor",
    "officials": "official",
}


def classify_surface_family(source: str, state: str = "") -> str:
    """Map a built path or runtime state to one stable reader-surface family."""
    normalized = source.lstrip("/")
    prefix = normalized.split("/", 1)[0].split("?", 1)[0]
    if state.startswith("root:tab:"):
        return "browse"
    if state.startswith("root:route:"):
        route_name = state.removeprefix("root:route:").split("-", 1)[0]
        return {
            "agency": "agency",
            "exam": "exam",
            "notice": "notice",
            "official": "official",
            "vendor": "vendor",
        }.get(route_name, "workspace")
    if state.startswith("near-you:"):
        return "near_you"
    if state.startswith("following:"):
        return "following"
    if normalized in {"", "index.html"}:
        return "home"
    if normalized in {"about.html", "api.html", "changelog.html", "data.html", "standards.html", "stats.html"}:
        return "reference"
    return FAMILY_BY_PREFIX.get(prefix, "other")


def load_allowlist(path: pathlib.Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema") != "cityscroll.resident_surface_allowlist.v1":
        raise ValueError(f"{path}: unsupported or missing schema")
    entries = data.get("exceptions")
    if not isinstance(entries, list):
        raise ValueError(f"{path}: exceptions must be a list")
    ids: set[str] = set()
    for entry in entries:
        required = {"id", "category", "terms", "surface_family", "content_mode", "reason"}
        if not isinstance(entry, dict) or not required.issubset(entry):
            raise ValueError(f"{path}: each exception requires {', '.join(sorted(required))}")
        if entry["id"] in ids:
            raise ValueError(f"{path}: duplicate exception id {entry['id']}")
        if entry["category"] not in LEAK_CATEGORIES:
            raise ValueError(f"{path}: unknown category {entry['category']}")
        if not isinstance(entry["terms"], list) or not entry["terms"]:
            raise ValueError(f"{path}: exception {entry['id']} must name at least one exact term")
        if not all(isinstance(value, str) and value for value in entry["terms"]):
            raise ValueError(f"{path}: exception terms must be non-empty strings")
        if not isinstance(entry["reason"], str) or not entry["reason"].strip():
            raise ValueError(f"{path}: exception {entry['id']} requires a reason")
        ids.add(entry["id"])
    return entries


def matching_exception(finding: dict[str, str], entries: list[dict[str, Any]]) -> str | None:
    for entry in entries:
        if entry["category"] != finding["category"]:
            continue
        if finding["term"] not in entry["terms"]:
            continue
        if not fnmatch.fnmatchcase(finding["surface_family"], entry["surface_family"]):
            continue
        if not fnmatch.fnmatchcase(finding["content_mode"], entry["content_mode"]):
            continue
        if "surface_kind" in entry and not fnmatch.fnmatchcase(finding["surface_kind"], entry["surface_kind"]):
            continue
        if "surface" in entry and not fnmatch.fnmatchcase(finding["surface"], entry["surface"]):
            continue
        return str(entry["id"])
    return None


def findings_for_text(text: str, surface: dict[str, str], entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for term in sorted(set(SNAKE_CASE.findall(text))):
        finding: dict[str, Any] = {**surface, "category": "implementation_schema", "term": term}
        finding["exception_id"] = matching_exception(finding, entries)
        findings.append(finding)
    for category, pattern in LEAK_PATTERNS:
        for match in pattern.finditer(text):
            term = " ".join(match.group(0).split())[:180]
            finding = {**surface, "category": category, "term": term}
            finding["exception_id"] = matching_exception(finding, entries)
            findings.append(finding)
    return findings


def default_reader_text(page: Page) -> str:
    return page.locator("body").inner_text()


def opt_in_disclosure_text(page: Page) -> str:
    """Return closed-details content without changing the default reader pass."""
    return page.evaluate(
        """
        () => Array.from(document.querySelectorAll('details:not([open]):not([hidden])'))
          .map((details) => {
            const clone = details.cloneNode(true);
            clone.querySelectorAll('summary, script, style, template, [hidden]').forEach((node) => node.remove());
            return clone.textContent || '';
          })
          .join('\\n')
        """
    )


def add_surface_records(
    page: Page,
    records: list[dict[str, Any]],
    entries: list[dict[str, Any]],
    *,
    surface_id: str,
    source: str,
    surface_kind: str,
    family: str,
) -> None:
    base = {
        "surface": surface_id,
        "source": source,
        "surface_kind": surface_kind,
        "surface_family": family,
    }
    default = {**base, "content_mode": "default_reader"}
    records.append({**default, "findings": findings_for_text(default_reader_text(page), default, entries)})
    disclosure_text = opt_in_disclosure_text(page)
    if disclosure_text.strip():
        disclosure = {**base, "content_mode": "opt_in_disclosure"}
        records.append({**disclosure, "findings": findings_for_text(disclosure_text, disclosure, entries)})


def visit(
    page: Page,
    records: list[dict[str, Any]],
    errors: list[dict[str, str]],
    entries: list[dict[str, Any]],
    *,
    surface_id: str,
    source: str,
    surface_kind: str,
    family: str,
    wait_ms: int,
) -> None:
    try:
        page.goto(BASE + source, wait_until="load", timeout=30_000)
        page.wait_for_timeout(wait_ms)
        add_surface_records(
            page,
            records,
            entries,
            surface_id=surface_id,
            source=source,
            surface_kind=surface_kind,
            family=family,
        )
    except Exception as exc:
        errors.append({"surface": surface_id, "error": f"{type(exc).__name__}: {str(exc)[:180]}"})


def visit_source(
    page: Page,
    records: list[dict[str, Any]],
    errors: list[dict[str, str]],
    entries: list[dict[str, Any]],
    *,
    surface_id: str,
    source: str,
    surface_kind: str = "default_document",
) -> None:
    html = pathlib.Path(source).read_text(encoding="utf-8") if surface_id.startswith("fixture:") else (SITE / (source or "index.html")).read_text(encoding="utf-8")
    html = re.sub(r"<script\b[\s\S]*?</script\s*>", "", html, flags=re.I)
    html = re.sub(r"<style\b[\s\S]*?</style\s*>", "", html, flags=re.I)
    try:
        page.set_content(html, wait_until="domcontentloaded", timeout=15_000)
        add_surface_records(
            page,
            records,
            entries,
            surface_id=surface_id,
            source=source,
            surface_kind=surface_kind,
            family=classify_surface_family(pathlib.Path(source).name if surface_id.startswith("fixture:") else source, surface_id),
        )
    except Exception as exc:
        errors.append({"surface": surface_id, "error": f"{type(exc).__name__}: {str(exc)[:180]}"})


def summarize(records: list[dict[str, Any]], errors: list[dict[str, str]]) -> dict[str, Any]:
    all_findings = [finding for record in records for finding in record["findings"]]
    unreviewed = [finding for finding in all_findings if not finding["exception_id"]]
    reviewed = [finding for finding in all_findings if finding["exception_id"]]
    default_records = [record for record in records if record["content_mode"] == "default_reader"]

    def category_counts(items: list[dict[str, Any]]) -> dict[str, int]:
        counter = Counter(item["category"] for item in items)
        return {category: counter[category] for category in LEAK_CATEGORIES}

    def nested_counts(
        items: list[dict[str, Any]],
        first: str,
        second: str,
        *,
        expected_values: tuple[str, ...] = (),
    ) -> dict[str, dict[str, int]]:
        counter = Counter((item[first], item[second]) for item in items)
        first_values = sorted({item[first] for item in items} | set(expected_values))
        return {
            value: {category: counter[(value, category)] for category in LEAK_CATEGORIES}
            for value in first_values
        }

    surface_counts = Counter(record["surface_family"] for record in default_records)
    return {
        "schema": "cityscroll.resident_surface_catalog.v1",
        "surface_counts": {
            "default_documents": sum(record["surface_kind"] == "default_document" for record in default_records),
            "route_states": sum(record["surface_kind"] == "route_state" for record in default_records),
            "opt_in_disclosures": sum(record["content_mode"] == "opt_in_disclosure" for record in records),
            "by_family": dict(sorted(surface_counts.items())),
        },
        "leak_counts": {
            "detected": category_counts(all_findings),
            "unreviewed": category_counts(unreviewed),
            "reviewed": category_counts(reviewed),
            "by_family": nested_counts(
                all_findings,
                "surface_family",
                "category",
                expected_values=tuple(surface_counts),
            ),
            "by_content_mode": nested_counts(
                all_findings,
                "content_mode",
                "category",
                expected_values=("default_reader", "opt_in_disclosure"),
            ),
        },
        "records": records,
        "errors": errors,
        "unreviewed_findings": unreviewed,
        "reviewed_findings": reviewed,
    }


def print_report(report: dict[str, Any]) -> None:
    counts = report["surface_counts"]
    failed = len(report["unreviewed_findings"]) + len(report["errors"])
    status = "FAILED" if failed else "OK"
    print(f"resident-surface catalog {status}")
    print(f"  default documents: {counts['default_documents']}")
    print(f"  route/state surfaces: {counts['route_states']}")
    print(f"  opt-in disclosure surfaces: {counts['opt_in_disclosures']}")
    for family, count in counts["by_family"].items():
        categories = report["leak_counts"]["by_family"].get(family, {})
        detail = ", ".join(f"{category}={categories.get(category, 0)}" for category in LEAK_CATEGORIES)
        print(f"  FAMILY {family}: surfaces={count}; {detail}")
    for mode, categories in report["leak_counts"]["by_content_mode"].items():
        detail = ", ".join(f"{category}={categories.get(category, 0)}" for category in LEAK_CATEGORIES)
        print(f"  MODE {mode}: {detail}")
    for finding in report["unreviewed_findings"][:40]:
        print(
            f"  LEAK {finding['category']} {finding['surface']} [{finding['content_mode']}]: "
            f"{finding['term']!r}",
            file=sys.stderr,
        )
    for error in report["errors"]:
        print(f"  ERROR {error['surface']}: {error['error']}", file=sys.stderr)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allowlist", type=pathlib.Path, default=DEFAULT_ALLOWLIST)
    parser.add_argument("--json", action="store_true", help="Write the complete catalog to stdout.")
    parser.add_argument("--report", type=pathlib.Path, help="Write the complete catalog to this path.")
    parser.add_argument("--fixture", type=pathlib.Path, action="append", default=[], help="Catalog a standalone HTML fixture instead of the public surface inventory.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        entries = load_allowlist(args.allowlist)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"resident-surface allowlist error: {exc}", file=sys.stderr)
        return 2

    records: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context()
        page = context.new_page()
        install_routes(page)

        if args.fixture:
            for fixture in args.fixture:
                visit_source(
                    page,
                    records,
                    errors,
                    entries,
                    surface_id=f"fixture:{fixture.name}",
                    source=str(fixture),
                )
        else:
            for path in STATIC_DOCUMENTS:
                visit_source(
                    page,
                    records,
                    errors,
                    entries,
                    surface_id=f"built:{path or 'index.html'}",
                    source=path,
                )
            for path in DOCUMENT_ROUTES:
                state = f"document:{path}"
                visit(
                    page,
                    records,
                    errors,
                    entries,
                    surface_id=state,
                    source=path,
                    surface_kind="route_state",
                    family=classify_surface_family(path, state),
                    wait_ms=500,
                )
            for state_name, fragment in ROOT_HASH_STATES:
                state = f"root:{state_name}"
                visit(
                    page,
                    records,
                    errors,
                    entries,
                    surface_id=state,
                    source=fragment,
                    surface_kind="route_state",
                    family=classify_surface_family(fragment, state),
                    wait_ms=800,
                )
            for state_name, path in NEAR_YOU_STATES + FOLLOWING_STATES:
                visit(
                    page,
                    records,
                    errors,
                    entries,
                    surface_id=state_name,
                    source=path,
                    surface_kind="route_state",
                    family=classify_surface_family(path, state_name),
                    wait_ms=500,
                )

        context.close()
        browser.close()

    report = summarize(records, errors)
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(rendered, encoding="utf-8")
    if args.json:
        print(rendered, end="")
    else:
        print_report(report)
    return 1 if report["unreviewed_findings"] or report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
