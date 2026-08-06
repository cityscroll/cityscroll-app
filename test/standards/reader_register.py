#!/usr/bin/env python3
"""Positive-register lint for the parcel biography's reader-facing gap copy."""
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
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        return 1
    print("reader-register OK — parcel biography gap copy is positive and covered")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
