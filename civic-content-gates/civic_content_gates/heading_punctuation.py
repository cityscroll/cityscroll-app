"""Heading-punctuation lint — NYC Web Content Style Guide Headings: "Don't
include punctuation (such as colons, periods...) in headings. The exception is question
marks."
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Optional, Sequence

from . import _util

H_TAG_RE = re.compile(r"<(h[1-3])\b([^>]*)>(.*?)</h[1-3]>", re.DOTALL)
DATA_I18N_RE = re.compile(r'data-i18n(?:-html)?="([a-zA-Z0-9_]+)"')
T_CALL_RE = re.compile(r"""^\$\{t\(\s*["']([a-zA-Z0-9_]+)["'](?:\s*,[^)]*)?\)\}$""")
DYNAMIC_RE = re.compile(r"\$\{")
TAG_RE = re.compile(r"<[^<>]*>")
BANNED_PUNCT_RE = re.compile(r"[:.](?!\.\.)")  # colon or period; '?' is the guide's own exception

ARCHIVAL_KEY_PREFIX = "chg_"


def resolve_heading(inner, strings_en):
    """Return (text, skip) — skip=True for dataset-value headings out of copy-lint scope."""
    inner = inner.strip()
    m = T_CALL_RE.match(inner)
    if m:
        return strings_en.get(m.group(1), inner), False
    if DYNAMIC_RE.search(inner):
        return inner, True
    return re.sub(r"\s+", " ", TAG_RE.sub(" ", inner)).strip(), False


def check(site_root: Path, pages: Optional[Sequence[str]] = None) -> list[str]:
    site_root = Path(site_root)
    pages = _util.resolve_pages(pages)
    strings_en = _util.load_strings_en(site_root)
    failures = []

    for page in pages:
        src = (site_root / page).read_text(encoding="utf-8")
        for m in H_TAG_RE.finditer(src):
            attrs, inner = m.group(2), m.group(3)
            key_m = DATA_I18N_RE.search(attrs)
            if key_m:
                key = key_m.group(1)
                if page == "changelog.html" and key.startswith(ARCHIVAL_KEY_PREFIX):
                    continue
                text = strings_en.get(key, inner)
                text = re.sub(r"\s+", " ", TAG_RE.sub(" ", text)).strip()
            else:
                text, skip = resolve_heading(inner, strings_en)
                if skip:
                    continue
            if not text:
                continue
            if BANNED_PUNCT_RE.search(text):
                failures.append(f"{page}: heading has banned punctuation (colon/period): {text!r}")
    return failures


def run(site_root: Path, pages: Optional[Sequence[str]] = None) -> int:
    pages = _util.resolve_pages(pages)
    failures = check(site_root, pages=pages)
    if failures:
        print("heading-punctuation gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print(f"heading-punctuation gate OK — h1/h2/h3 across {len(pages)} page(s) clean "
          f"(changelog's archival release titles carved out)")
    return 0


def main(argv=None, site_root=None) -> int:
    import argparse
    p = argparse.ArgumentParser(description="Heading punctuation lint")
    p.add_argument("--root", type=Path, default=site_root)
    p.add_argument("pages", nargs="*")
    args = p.parse_args(list(argv) if argv is not None else None)
    if not args.root:
        p.error("--root is required")
    return run(args.root, pages=args.pages or None)


if __name__ == "__main__":
    raise SystemExit(main())
