#!/usr/bin/env python3
"""Positive-register lint for reader-facing gaps and methodology copy."""
from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
I18N = (ROOT / "site" / "i18n.js").read_text(encoding="utf-8")
PARCEL_UI = (ROOT / "site" / "parcel_biography_ui.mjs").read_text(encoding="utf-8")
EXPECTED = {
    "property_xd_tax_lien_empty": "Not on the published lien list we have for this cycle.",
    "property_xd_date_unknown": "Date not published in this catalog",
}

# Implementation details answer an engineer's debugging question, not a
# reader's question about source, freshness, or coverage. Keep these patterns
# narrow: "Join online" and the public API reference are legitimate copy.
DEVELOPER_REGISTER_PATTERNS = [
    ("API/cache narration", re.compile(r"\b(?:worker\s+cache|cached\s+portal|portal\s+project\s+API|live\s+portal\s+call)\b", re.I)),
    ("join mechanics", re.compile(r"\b(?:join(?:ed|s|able|ing)?|graph\s+slice|linked\s+corpus|join\s+window)\b", re.I)),
    ("identifier mechanics", re.compile(r"\b(?:exact[- ]?(?:project[_ -]?id|BBL)|current\s+exact[- ]?BBL|by\s+exact\s+BBL|source\s+vintage|contract\s+id)\b", re.I)),
    ("debugger note", re.compile(r"\b(?:cannot\s+be\s+measured|rate\s+not\s+measured)\b", re.I)),
]

PUBLIC_ACTION_OR_REFERENCE_KEYS = {
    "rule_guide_join_step_html",
    "land_guide_join_step_html",
    "hearing_guide_join_step_html",
    "join_online",
    "meeting_action_join_online",
    "property_commercial_join_hearing_html",
    "career_step4_title",
    "award_guide_contract_label",
    "api_p_upstream_html",
}


def english_strings() -> dict[str, str]:
    """Read the English catalog without importing the browser bundle."""
    values = dict()
    for match in re.finditer(r'^\s+([A-Za-z0-9_]+):\s*("(?:\\.|[^"\\])*")', I18N, re.MULTILINE):
        raw = match.group(2)
        try:
            values[match.group(1)] = bytes(raw[1:-1], "utf-8").decode("unicode_escape")
        except UnicodeDecodeError:
            values[match.group(1)] = raw[1:-1]
    return values


def main() -> int:
    failures = []  # source: EXPECTED mirrors the English dictionary entries under test
    for key, expected in EXPECTED.items():
        match = re.search(rf"^\s+{re.escape(key)}:\s*\"([^\"]*)\"", I18N, re.MULTILINE)
        if not match:
            failures.append(f"missing English dictionary key: {key}")
            continue
        value = match.group(1)
        if value != expected:
            failures.append(f"{key} is not positive gap copy: {value!r}")
        if re.search(r"not\s+(?:observed|proof)|\bnot\s+[^.]+\bbut\b", value, re.I):
            failures.append(f"{key} uses hedging register: {value!r}")
    if "property_xd_tax_lien_empty" not in PARCEL_UI or "property_xd_date_unknown" not in PARCEL_UI:
        failures.append("parcel biography renderer is not included in reader-register coverage")
    for key, value in english_strings().items():
        if key in PUBLIC_ACTION_OR_REFERENCE_KEYS:
            continue
        for label, pattern in DEVELOPER_REGISTER_PATTERNS:
            if pattern.search(value):
                failures.append(f"{key} uses developer-register {label}: {value!r}")
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        return 1
    print("reader-register OK — parcel biography gap copy is positive and covered")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
