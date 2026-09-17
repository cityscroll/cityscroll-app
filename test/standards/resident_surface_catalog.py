#!/usr/bin/env python3
"""Pure resident-surface catalog rules and dependency-free fixture entrypoint."""

from __future__ import annotations

import argparse
import fnmatch
from html.parser import HTMLParser
import json
import pathlib
import re
import sys
from collections import Counter
from typing import Any

DEFAULT_ALLOWLIST = pathlib.Path(__file__).with_name("resident_surface_allowlist.json")
DEFAULT_BROWSE_INSPECTION_CATALOG = pathlib.Path(__file__).with_name("browse_inspection_catalog.json")

BROWSE_INSPECTION_CATALOG_SCHEMA = "cityscroll.browse_inspection_catalog.v1"
BROWSE_PRIMARY_INTENTS = ("inspect", "directory_navigation", "act")
BROWSE_CLASSIFICATIONS = ("conforming", "legacy", "directory_navigation")
BROWSE_DETAIL_HOSTS = ("modal_preview", "selection_panel", "inline_detail", "day_agenda", "none_directory")
BROWSE_REQUIRED_PRINCIPLES = (
    "overview",
    "useful_inspection",
    "explicit_navigation_and_actions",
    "coherent_restoration",
    "identity",
    "failure",
    "accessibility",
)
COMPACT_CALENDAR_HOST_IDS = (
    "calendar-host-now",
    "calendar-host-community-boards",
    "calendar-host-rules",
    "calendar-host-land-projects",
    "calendar-host-legislative-matters",
    "calendar-host-exams",
    "calendar-host-procurement",
    "calendar-host-property",
)

SNAKE_CASE = re.compile(r"\b[a-z]+(?:_[a-z0-9]+)+\b")
PUBLIC_URL = re.compile(r"\bhttps?://[^\s<>\"\']+", re.I)
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
    if normalized in {"about.html", "api.html", "changelog.html", "data.html", "standards.html", "stats.html", "data-health/index.html"}:
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
        if not isinstance(entry["id"], str) or not entry["id"].strip():
            raise ValueError(f"{path}: each exception requires a non-empty id")
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


def load_browse_inspection_catalog(path: pathlib.Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    problems = validate_browse_inspection_catalog(data)
    if problems:
        raise ValueError(f"{path}: " + "; ".join(problems))
    return data


def validate_browse_inspection_catalog(data: Any) -> list[str]:
    """Validate browse-inspection declarations carried beside the surface catalog."""
    problems: list[str] = []
    if not isinstance(data, dict):
        return ["browse inspection catalog must be an object"]
    if data.get("schema") != BROWSE_INSPECTION_CATALOG_SCHEMA:
        problems.append("unsupported or missing browse inspection catalog schema")
    principles = data.get("principles")
    if not isinstance(principles, dict):
        problems.append("principles must be an object")
    else:
        for key in BROWSE_REQUIRED_PRINCIPLES:
            if not isinstance(principles.get(key), str) or not principles[key].strip():
                problems.append(f"principle missing prose: {key}")
    surfaces = data.get("surfaces")
    baseline = data.get("legacy_baseline")
    if not isinstance(surfaces, list) or not surfaces:
        problems.append("surfaces must be a non-empty list")
        surfaces = []
    if not isinstance(baseline, list):
        problems.append("legacy_baseline must be a list")
        baseline = []
    baseline_ids = {
        entry.get("id")
        for entry in baseline
        if isinstance(entry, dict) and isinstance(entry.get("id"), str)
    }
    surface_ids: set[str] = set()
    for surface in surfaces:
        if not isinstance(surface, dict):
            problems.append("each browsing surface must be an object")
            continue
        surface_id = surface.get("surface_id")
        if not isinstance(surface_id, str) or not surface_id.strip():
            problems.append("each browsing surface requires surface_id")
            continue
        if surface_id in surface_ids:
            problems.append(f"duplicate browsing surface: {surface_id}")
        surface_ids.add(surface_id)
        for field in (
            "primary_intent",
            "classification",
            "domain_adapter",
            "render_owner",
            "canonical_destination_policy",
            "detail_host",
            "journey_owner",
        ):
            if not isinstance(surface.get(field), str) or not str(surface.get(field)).strip():
                problems.append(f"{surface_id} missing {field}")
        if surface.get("primary_intent") not in BROWSE_PRIMARY_INTENTS:
            problems.append(f"{surface_id} has unsupported primary intent")
        if surface.get("classification") not in BROWSE_CLASSIFICATIONS:
            problems.append(f"{surface_id} has unsupported classification")
        if surface.get("detail_host") not in BROWSE_DETAIL_HOSTS:
            problems.append(f"{surface_id} has unsupported detail host")
        if surface.get("classification") == "legacy":
            baseline_id = surface.get("baseline_id")
            if not isinstance(baseline_id, str) or baseline_id not in baseline_ids:
                problems.append(f"legacy surface lacks baseline entry: {surface_id}")
        elif surface.get("baseline_id"):
            problems.append(f"non-legacy surface must not claim a baseline id: {surface_id}")
        if surface.get("classification") == "directory_navigation":
            if not isinstance(surface.get("semantic_reason"), str) or not surface["semantic_reason"].strip():
                problems.append(f"directory navigation lacks semantic reason: {surface_id}")
            if not isinstance(surface.get("positive_fixture"), str) or not surface["positive_fixture"].strip():
                problems.append(f"directory navigation lacks positive fixture: {surface_id}")
    for host_id in COMPACT_CALENDAR_HOST_IDS:
        if host_id not in surface_ids:
            problems.append(f"compact calendar host missing from inventory: {host_id}")
    for entry in baseline:
        if not isinstance(entry, dict):
            problems.append("each baseline entry must be an object")
            continue
        for field in ("id", "path", "reason", "marker", "fingerprint"):
            if not isinstance(entry.get(field), str) or not entry[field].strip():
                problems.append(f"baseline entry missing {field}")
    private_blob = json.dumps(data, sort_keys=True)
    for banned in (
        "needs_james",
        "card_standard",
        "richness_profile",
        "autodispatch",
        "realization_gate",
    ):
        if banned in private_blob:
            problems.append(f"public catalog contains private planning token: {banned}")
    return problems


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
    # Published URLs contain identifiers too; those are destinations, not UI schema labels.
    schema_text = PUBLIC_URL.sub("", text)
    for term in sorted(set(SNAKE_CASE.findall(schema_text))):
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


class FixtureText(HTMLParser):
    """Collect the reader text of a small fixture without a browser dependency."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.default_parts: list[str] = []
        self.disclosure_parts: list[str] = []
        self.detail_open: list[bool] = []
        self.summary_owners: list[int] = []
        self.hidden_markers: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = dict(attrs)
        if tag in {"script", "style", "template"} or "hidden" in attrs_map:
            self.hidden_markers.append(tag)
        if tag == "details":
            self.detail_open.append("open" in attrs_map)
        elif tag == "summary":
            self.summary_owners.append(len(self.detail_open))

    def handle_endtag(self, tag: str) -> None:
        if tag == "summary" and self.summary_owners:
            self.summary_owners.pop()
        elif tag == "details" and self.detail_open:
            self.detail_open.pop()
        if self.hidden_markers and self.hidden_markers[-1] == tag:
            self.hidden_markers.pop()

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if not text or self.hidden_markers:
            return
        closed = [index for index, is_open in enumerate(self.detail_open) if not is_open]
        summary_is_visible = bool(self.summary_owners) and closed == [self.summary_owners[-1] - 1]
        if not closed or summary_is_visible:
            self.default_parts.append(text)
        if closed and not self.summary_owners:
            self.disclosure_parts.append(text)


def fixture_records(path: pathlib.Path, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    parser = FixtureText()
    parser.feed(path.read_text(encoding="utf-8"))
    surface_id = f"fixture:{path.name}"
    base = {
        "surface": surface_id,
        "source": path.name,
        "surface_kind": "default_document",
        "surface_family": classify_surface_family(path.name, surface_id),
    }
    default = {**base, "content_mode": "default_reader"}
    records = [{**default, "findings": findings_for_text("\n".join(parser.default_parts), default, entries)}]
    disclosure_text = "\n".join(parser.disclosure_parts)
    if disclosure_text:
        disclosure = {**base, "content_mode": "opt_in_disclosure"}
        records.append({**disclosure, "findings": findings_for_text(disclosure_text, disclosure, entries)})
    return records


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allowlist", type=pathlib.Path, default=DEFAULT_ALLOWLIST)
    parser.add_argument(
        "--browse-inspection-catalog",
        type=pathlib.Path,
        default=None,
        help="Validate browse-inspection declarations (defaults to the sibling catalog when --check-browse-inspection is set).",
    )
    parser.add_argument(
        "--check-browse-inspection",
        action="store_true",
        help="Validate only the browse-inspection catalog projection and exit.",
    )
    parser.add_argument("--fixture", type=pathlib.Path, action="append", required=False)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    if args.check_browse_inspection or args.browse_inspection_catalog is not None:
        catalog_path = args.browse_inspection_catalog or DEFAULT_BROWSE_INSPECTION_CATALOG
        try:
            catalog = load_browse_inspection_catalog(catalog_path)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"browse-inspection catalog error: {exc}", file=sys.stderr)
            return 2
        if args.check_browse_inspection and not args.fixture:
            payload = {
                "schema": BROWSE_INSPECTION_CATALOG_SCHEMA,
                "ok": True,
                "surface_count": len(catalog["surfaces"]),
                "baseline_count": len(catalog["legacy_baseline"]),
                "compact_calendar_host_count": sum(
                    1 for row in catalog["surfaces"] if row.get("kind") == "compact_calendar_host"
                ),
            }
            if args.json:
                print(json.dumps(payload, indent=2, sort_keys=True))
            else:
                print(
                    "browse-inspection catalog OK "
                    f"(surfaces={payload['surface_count']}, "
                    f"baseline={payload['baseline_count']}, "
                    f"calendar_hosts={payload['compact_calendar_host_count']})"
                )
            return 0

    if not args.fixture:
        parser.error("--fixture is required unless --check-browse-inspection is set")

    try:
        entries = load_allowlist(args.allowlist)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"resident-surface allowlist error: {exc}", file=sys.stderr)
        return 2
    records = [record for fixture in args.fixture for record in fixture_records(fixture, entries)]
    report = summarize(records, [])
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print_report(report)
    return 1 if report["unreviewed_findings"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
