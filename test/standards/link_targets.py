#!/usr/bin/env python3
"""External-link presentation gate (w10-03) — NYC Web Content Style Guide:
"Set links to open in the same tab or window" (B18) and "We do not use external link
icons... use text that describes where it goes" (B19).

House decision: CONFORM strictly rather than carve out new-tab behavior for external
data sources. All 42 `target="_blank"` instances (PASSPort, Checkbook NYC, NYC Open Data,
ZAP, ACRIS, ZoLa, GitHub-adjacent city sites, Google Maps) and all 4 decorative "external
link" arrow icons (↗) were removed — link text alone now names the destination (e.g.
"View in City Record", "Checkbook NYC"), matching the guide's own recommended pattern.
The one remaining ↗ (view_on_crol / "View on CROL-List") is an INTERNAL same-page hash
link back into CROL-List's own detail view, not a link to an external site — outside the
scope of a rule that is explicitly about links leaving NYC government's own properties —
so it's allowlisted below rather than removed.

Pure-text lint over the six pages' raw source (covers both static markup and the
JS-templated anchors index.html builds at runtime) — no browser needed.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parents[2]
PAGES = ["index.html", "about.html", "data.html", "stats.html", "api.html", "changelog.html"]

# Resolved anchor text allowed to keep an arrow — internal navigation, not an external link.
ALLOWED_ICON_TEXT = {"View on CROL-List", "Ver en CROL-List"}

A_TAG_RE = re.compile(r"<a\b([^>]*)>(.*?)</a>", re.DOTALL)
TARGET_BLANK_RE = re.compile(r'target\s*=\s*"_blank"')
TAG_RE = re.compile(r"<[^<>]*>")


def main():
    failures = []
    for page in PAGES:
        src = (ROOT / page).read_text(encoding="utf-8")

        blanks = TARGET_BLANK_RE.findall(src)
        if blanks:
            failures.append(f"{page}: {len(blanks)} target=\"_blank\" link(s) — "
                             "links must open in the same tab (NYC Web Content Style Guide)")

        for m in A_TAG_RE.finditer(src):
            inner = m.group(2)
            text = re.sub(r"\s+", " ", TAG_RE.sub(" ", inner)).strip()
            if "↗" in text and text not in ALLOWED_ICON_TEXT:
                failures.append(f"{page}: external-link icon (↗) in link text {text!r} — "
                                 "we do not use external link icons; the link text should "
                                 "describe the destination instead")

    if failures:
        print("link-targets gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)
    print(f"link-targets gate OK — 0 target=\"_blank\" links, 0 unallowlisted external-link "
          f"icons across {len(PAGES)} page(s)")


if __name__ == "__main__":
    main()
