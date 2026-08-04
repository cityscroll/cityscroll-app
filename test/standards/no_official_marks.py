#!/usr/bin/env python3
"""Non-affiliation gate.

CityScroll is an independent, unofficial interface to public data. This lint makes that boundary
mechanical so it cannot erode over time:

  1. No official-mark assets. No government seal, coat of arms, agency logo, or official lockup may
     enter the repo. Only CityScroll's own brand marks are allowed under site/assets/brand.
  2. No embedded raster in any shipped SVG (a common way an official logo would be smuggled in).
  3. The unofficial-source disclaimer stays present on the About page.
  4. No committed public text claims that CityScroll itself is an official government service, and no
     shipped surface attributes the design to an external design system.

Describing the city, its agencies, and its public records is the whole point of the product and is
never flagged; the line is impersonating an official channel, not naming one.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "site"
DOCS = ROOT / "docs"

# Asset basenames (or path fragments) that would imply an official government mark.
FORBIDDEN_ASSET = re.compile(
    r"seal|coat[-_]?of[-_]?arms|crest|official[-_]?logo|govt?[-_]?logo|"
    r"nyc[-_]?logo|cityseal|city[-_]?seal|agency[-_]?logo|dept[-_]?logo|department[-_]?logo|"
    r"nypd|fdny|dsny|mta[-_]?logo|emblem[-_]?official",
    re.IGNORECASE,
)
# Brand assets must be CityScroll's own family.
ALLOWED_ASSET = re.compile(
    r"^(cityscroll[-a-z0-9]*|favicon[-a-z0-9]*|icon-\d+|apple-touch-icon)\.(svg|png)$"
    r"|^candidates/[-a-z0-9]+\.svg$",
    re.IGNORECASE,
)

# Self-affiliation claims about CityScroll (narrow, to avoid flagging legitimate references to the
# city's own official documents such as "the official requirements" or "the official guide").
SELF_CLAIM = re.compile(
    r"CityScroll\s+is\s+(?:an?\s+)?(?:the\s+)?official|"
    r"official\s+(?:nyc\s+|new york city\s+)?(?:government\s+)?(?:web ?site|site|service|portal|channel)\s+"
    r"(?:of|for)\s+(?:the\s+)?(?:city|nyc|new york)|"
    r"(?:endorsed|operated|run|maintained)\s+by\s+(?:the\s+)?(?:city of new york|nyc government|city government)",
    re.IGNORECASE,
)
# No shipped surface may attribute the design to an external design system.
EXTERNAL_DS = re.compile(r"designsystem\.nyc|nyc\s+digital\s+design\s+system", re.IGNORECASE)

SVG_IMAGE = re.compile(r"<image\b", re.IGNORECASE)
DISCLAIMER_PAGE = SITE / "about.html"


def iter_text_files():
    for base in (SITE, DOCS):
        for path in base.rglob("*"):
            if path.suffix.lower() in {".html", ".md", ".mjs", ".js", ".css", ".json", ".txt"}:
                yield path


def main() -> None:
    failures: list[str] = []

    # 1 + 2: assets.
    brand_dir = SITE / "assets" / "brand"
    if brand_dir.is_dir():
        for path in brand_dir.rglob("*"):
            if path.is_dir():
                continue
            rel = path.relative_to(brand_dir).as_posix()
            if FORBIDDEN_ASSET.search(rel):
                failures.append(f"forbidden official-mark asset name: assets/brand/{rel}")
            elif not ALLOWED_ASSET.match(rel):
                failures.append(
                    f"unrecognized brand asset (not a CityScroll mark): assets/brand/{rel}"
                )
    for svg in SITE.rglob("*.svg"):
        if SVG_IMAGE.search(svg.read_text(encoding="utf-8", errors="ignore")):
            failures.append(f"{svg.relative_to(ROOT)}: embedded raster <image> not allowed in SVG")

    # 3: disclaimer present.
    about = DISCLAIMER_PAGE.read_text(encoding="utf-8")
    if not re.search(r"unofficial|independent", about, re.IGNORECASE):
        failures.append("about.html: unofficial/independent disclaimer text is missing")

    # 4: self-claims and external design-system attribution across shipped text.
    for path in iter_text_files():
        text = path.read_text(encoding="utf-8", errors="ignore")
        rel = path.relative_to(ROOT)
        if rel.name == Path(__file__).name:
            continue
        m = SELF_CLAIM.search(text)
        if m:
            failures.append(f"{rel}: possible official-affiliation self-claim: {m.group(0)!r}")
        m = EXTERNAL_DS.search(text)
        if m:
            failures.append(f"{rel}: external design-system attribution not allowed: {m.group(0)!r}")

    if failures:
        print("non-affiliation gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        raise SystemExit(1)
    print("non-affiliation gate OK — brand marks, SVGs, disclaimer, and shipped text are clean")


if __name__ == "__main__":
    main()
