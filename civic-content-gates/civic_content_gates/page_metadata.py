"""Page-metadata gate — NYC Web Content Style Guide "Meta titles and descriptions":
a meta description on every page, 120-160 characters; a title under 60 characters with one
consistent separator across the site.

House decision (documented per the guide's own "or conform, and document the deviation"
option): CityScroll keeps the middle dot ("·") as its title separator rather than switching to
the guide's literal hyphen — it's already the site's brand mark.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Optional, Sequence

from . import _util

TITLE_RE = re.compile(r"<title>([^<]*)</title>")
DESC_RE = re.compile(r'<meta name="description" content="([^"]*)">')

MIN_DESC, MAX_DESC = 120, 160
MAX_TITLE = 60
SEPARATOR = "·"


def check(site_root: Path, pages: Optional[Sequence[str]] = None) -> list[str]:
    site_root = Path(site_root)
    pages = _util.resolve_pages(pages)
    failures = []
    for page in pages:
        src = (site_root / page).read_text(encoding="utf-8")

        title_m = TITLE_RE.search(src)
        if not title_m:
            failures.append(f"{page}: missing <title>")
        else:
            title = title_m.group(1)
            if len(title) > MAX_TITLE:
                failures.append(f"{page}: title is {len(title)} chars (must be <{MAX_TITLE}): {title!r}")
            if SEPARATOR not in title:
                failures.append(f"{page}: title missing the house separator {SEPARATOR!r}: {title!r}")

        desc_m = DESC_RE.search(src)
        if not desc_m:
            failures.append(f"{page}: missing <meta name=\"description\">")
        else:
            desc = desc_m.group(1)
            if not (MIN_DESC <= len(desc) <= MAX_DESC):
                failures.append(
                    f"{page}: meta description is {len(desc)} chars "
                    f"(must be {MIN_DESC}-{MAX_DESC}): {desc!r}")
    return failures


def run(site_root: Path, pages: Optional[Sequence[str]] = None) -> int:
    pages = _util.resolve_pages(pages)
    failures = check(site_root, pages=pages)
    if failures:
        print("page-metadata gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print(f"page-metadata gate OK — {len(pages)} page(s), all titles <{MAX_TITLE} chars with "
          f"{SEPARATOR!r} separator, all descriptions {MIN_DESC}-{MAX_DESC} chars")
    return 0


def main(argv=None, site_root=None) -> int:
    import argparse
    p = argparse.ArgumentParser(description="Page metadata gate")
    p.add_argument("--root", type=Path, default=site_root)
    p.add_argument("pages", nargs="*")
    args = p.parse_args(list(argv) if argv is not None else None)
    if not args.root:
        p.error("--root is required")
    return run(args.root, pages=args.pages or None)


if __name__ == "__main__":
    raise SystemExit(main())
