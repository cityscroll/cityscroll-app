"""GenAI content-disclosure presence gate — NYC Web Content Style Guide GenAI
tools section: "You should also disclose the use of generative AI to your audience."
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional, Sequence

from . import _util


def check(site_root: Path, about_page: str = "about.html") -> list[str]:
    site_root = Path(site_root)
    failures = []
    about = (site_root / about_page).read_text(encoding="utf-8")

    if 'data-i18n="about_h_content"' not in about:
        failures.append(f"{about_page}: missing the \"About our content\" section (about_h_content)")
    if 'data-i18n-html="about_p_content_html"' not in about:
        failures.append(f"{about_page}: missing the content-disclosure paragraph (about_p_content_html)")

    strings = _util.load_strings(site_root)
    for lang in ("en", "es"):
        text = strings.get(lang, {}).get("about_p_content_html", "")
        if not text:
            failures.append(f"i18n.js: about_p_content_html missing for lang={lang!r}")
        elif "Claude" not in text and "IA" not in text and "AI" not in text:
            failures.append(f"i18n.js: about_p_content_html ({lang}) doesn't name the AI assistant used")
    return failures


def run(site_root: Path, about_page: str = "about.html") -> int:
    failures = check(site_root, about_page=about_page)
    if failures:
        print("genai-disclosure gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print("genai-disclosure gate OK — about.html discloses AI-drafted site copy (en+es)")
    return 0


def main(argv=None, site_root=None) -> int:
    import argparse
    p = argparse.ArgumentParser(description="GenAI content-disclosure presence gate")
    p.add_argument("--root", type=Path, default=site_root)
    p.add_argument("--about", default="about.html")
    args = p.parse_args(list(argv) if argv is not None else None)
    if not args.root:
        p.error("--root is required")
    return run(args.root, about_page=args.about)


if __name__ == "__main__":
    raise SystemExit(main())
