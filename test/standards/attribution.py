#!/usr/bin/env python3
"""Attribution-presence gate (w7-06) — open-data citation, Local Law 11/2012.

The site republishes City Record Open Data; a copy edit that drops the citation set is how
the audit's original "thin citation" state arose. This is a pure static text check (no
browser) so it belongs in the fast unit job.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).parents[2]

DATASET_IDS = ["dg92-zbpx", "k397-673e", "vx8i-nprf", "hgx4-8ukb"]


def main():
    failures = []

    about = (ROOT / "about.html").read_text(encoding="utf-8")
    for dsid in DATASET_IDS:
        if dsid not in about:
            failures.append(f"about.html: missing dataset id {dsid!r}")
            continue
        # Must be cited with a link to its canonical open-data page, not just named.
        idx = about.find(dsid)
        window = about[max(0, idx - 300):idx]
        if "data.cityofnewyork.us" not in window or "<a href=" not in window:
            failures.append(f"about.html: {dsid!r} present but not linked to its canonical open-data page")

    index = (ROOT / "index.html").read_text(encoding="utf-8")
    if 'data-i18n="footer_lede"' not in index:
        failures.append("index.html: footer source lede (footer_lede) missing")
    if "<footer" not in index:
        failures.append("index.html: <footer> element missing")

    data_html = (ROOT / "data.html").read_text(encoding="utf-8")
    if "data.cityofnewyork.us" not in data_html:
        failures.append("data.html: no link to the source open-data page")

    if failures:
        print("attribution gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)
    print(f"attribution gate OK — all {len(DATASET_IDS)} dataset IDs cited in about.html, "
          "footer lede present, data.html source-linked")


if __name__ == "__main__":
    main()
