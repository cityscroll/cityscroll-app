#!/usr/bin/env python3
"""Page-metadata gate (w10-02) — NYC Web Content Style Guide "Meta titles and descriptions":
a meta description on every page, 120-160 characters; a title under 60 characters with one
consistent separator across the site.

House decision (documented per the guide's own "or conform, and document the deviation"
option): CROL-List keeps the middle dot ("·") as its title separator rather than switching to
the guide's literal hyphen — it's already the site's brand mark (used in the header, footer,
and every non-home page's "Page · CROL-List" title) and switching only the five-page dash format
while leaving the brand's own middle-dot usage everywhere else would be the inconsistent choice.
index.html's title previously broke the pattern entirely (a colon, "CROL-List: track RFPs…");
this gate ensures every page uses "·", not that every page match the same word order — a
homepage brand-first title ("CROL-List · tagline") is standard SEO practice and unlike the five
inner pages, needn't read "Page · CROL-List".

Pure-text lint (title/meta tag only), no browser — unit job.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parents[2]
PAGES = ["index.html", "about.html", "data.html", "stats.html", "api.html", "changelog.html"]

TITLE_RE = re.compile(r"<title>([^<]*)</title>")
DESC_RE = re.compile(r'<meta name="description" content="([^"]*)">')

MIN_DESC, MAX_DESC = 120, 160
MAX_TITLE = 60
SEPARATOR = "·"


def main():
    failures = []
    for page in PAGES:
        src = (ROOT / page).read_text(encoding="utf-8")

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

    if failures:
        print("page-metadata gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)
    print(f"page-metadata gate OK — {len(PAGES)} page(s), all titles <{MAX_TITLE} chars with "
          f"{SEPARATOR!r} separator, all descriptions {MIN_DESC}-{MAX_DESC} chars")


if __name__ == "__main__":
    main()
