#!/usr/bin/env python3
"""Require shipped documents to consume the civic tokens and reject legacy beige palettes."""

from __future__ import annotations

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "site"

# Source: the pre-token :root palette at 626a6ed3^ (before the single token sheet landed),
# plus the warm-paper variants copied into the R2 document renderers in 02595c58/0528e75a.
LEGACY_PALETTE = frozenset({
    "#f4efe4", "#efe7d6", "#1a1714", "#3b342c", "#5c5349", "#cdbfa6",
    "#8a7c64", "#fbf7ed", "#1f3a5f", "#6b4e16", "#2f4a32", "#7a1f1f",
    "#f5f0e6", "#fffdf8", "#231f1b", "#675f56", "#d8cdbd", "#d6aa5a",
    "#315f45", "#fff5d9", "#f4efe6", "#f6efe4",
})
HEX = re.compile(r"#[0-9a-fA-F]{6}\b")
SHARED_STYLESHEET_LINK = re.compile(
    r'<link\b(?=[^>]*\brel=["\']stylesheet["\'])(?=[^>]*\bhref=["\'][^"\']*brand\.css(?:\?[^"\']*)?["\'])[^>]*>',
    re.IGNORECASE,
)


def legacy_values(text: str) -> list[str]:
    return sorted({match.group(0).lower() for match in HEX.finditer(text)} & LEGACY_PALETTE)


def main() -> int:
    failures = list()
    for path in sorted(SITE.rglob("*.html")):
        text = path.read_text(encoding="utf-8")
        relative = path.relative_to(ROOT)
        if not SHARED_STYLESHEET_LINK.search(text):
            failures.append(f"{relative}: missing shared brand.css token sheet")
        values = legacy_values(text)
        if values:
            failures.append(f"{relative}: legacy palette values {', '.join(values)}")

    for path in sorted(SITE.rglob("*.css")):
        values = legacy_values(path.read_text(encoding="utf-8"))
        if values:
            failures.append(f"{path.relative_to(ROOT)}: legacy palette values {', '.join(values)}")

    if failures:
        print("Civic token contract failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("Civic token contract passed: all shipped documents consume brand.css and are legacy-palette clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
