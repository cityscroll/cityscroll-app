"""Descriptive-link-text lint — NYC Web Content Style Guide:
link text must make sense out of context (no naked "click here" / "read more" / "here").

Static, deterministic: extracts every <a ...>...</a> from the HTML pages (both plain
markup and HTML template literals built in JS), resolves any t("key") call in the link
text to its English dictionary value (i18n.js is the source of truth for what actually
renders), and flags any link whose resolved text collapses to a generic phrase. An
aria-label on the anchor overrides the visible-text judgement.

Baseline: fails on NEW generic-text findings; ALLOWLIST is the tracked register for
anything deliberately kept generic.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Optional, Sequence

from . import _util

GENERIC_PHRASES = {
    "click here", "click", "here", "read more", "more", "more info", "more information",
    "learn more", "see more", "this link", "this", "link", "details", "view", "info",
    "go", "continue",
}

# (page, verbatim link inner text) pairs allowed to stay generic, with a reason on file.
ALLOWLIST = set()

A_TAG_RE = re.compile(r"<a\b([^>]*)>(.*?)</a>", re.DOTALL)
ARIA_LABEL_RE = re.compile(r'aria-label=["\']([^"\']*)["\']')
T_CALL_RE = re.compile(r"""\$\{t\(\s*["']([a-zA-Z0-9_]+)["'](?:\s*,[^)]*)?\)\}""")
DYNAMIC_RE = re.compile(r"\$\{[^}]*\}")
TAG_RE = re.compile(r"<[^<>]*>")


def resolve_text(inner, strings_en):
    had_dynamic = False

    def sub_t(m):
        return strings_en.get(m.group(1), m.group(1))
    inner = T_CALL_RE.sub(sub_t, inner)
    if DYNAMIC_RE.search(inner):
        had_dynamic = True
        inner = DYNAMIC_RE.sub(" ", inner)
    inner = TAG_RE.sub(" ", inner)
    inner = re.sub(r"[↗←→]", " ", inner)
    inner = re.sub(r"\s+", " ", inner).strip()
    return inner, had_dynamic


def check(
    site_root: Path,
    pages: Optional[Sequence[str]] = None,
    allowlist: Optional[set] = None,
) -> list[str]:
    """Return findings (empty list means pass)."""
    site_root = Path(site_root)
    pages = _util.resolve_pages(pages)
    allow = allowlist if allowlist is not None else ALLOWLIST
    strings_en = _util.load_strings_en(site_root)
    findings = []
    for page in pages:
        src = (site_root / page).read_text(encoding="utf-8")
        for m in A_TAG_RE.finditer(src):
            attrs, inner = m.group(1), m.group(2)
            aria = ARIA_LABEL_RE.search(attrs)
            if aria and aria.group(1).strip():
                continue
            text, had_dynamic = resolve_text(inner, strings_en)
            if had_dynamic and not text:
                continue
            if not text:
                continue
            if text.lower() in GENERIC_PHRASES and (page, text) not in allow:
                findings.append(f"{page}: generic link text {text!r}")
    return findings


def run(
    site_root: Path,
    pages: Optional[Sequence[str]] = None,
    allowlist: Optional[set] = None,
) -> int:
    findings = check(site_root, pages=pages, allowlist=allowlist)
    page_count = len(_util.resolve_pages(pages))
    if findings:
        print(
            "link-text lint FAILED — link text must make sense out of context "
            "(NYC Web Content Style Guide):",
            file=sys.stderr,
        )
        for f in findings:
            print(f"  {f}", file=sys.stderr)
        return 1
    print(f"link-text lint OK — no generic link text across {page_count} page(s)")
    return 0


def main(argv: Optional[Sequence[str]] = None, site_root: Optional[Path] = None) -> int:
    import argparse
    p = argparse.ArgumentParser(description="Descriptive link-text lint")
    p.add_argument("--root", type=Path, default=site_root, help="Site root containing HTML + i18n.js")
    p.add_argument("pages", nargs="*", help="Optional page list (default: standard public pages)")
    args = p.parse_args(list(argv) if argv is not None else None)
    if not args.root:
        p.error("--root is required (or pass site_root to main())")
    return run(args.root, pages=args.pages or None)


if __name__ == "__main__":
    raise SystemExit(main())
