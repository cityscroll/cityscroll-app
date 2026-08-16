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
    parser.add_argument("--fixture", type=pathlib.Path, action="append", required=True)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
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
