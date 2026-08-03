#!/usr/bin/env python3
"""Public-surface internal-vocabulary lint.

Flags reader-facing i18n English strings (and optional HTML data-i18n fallbacks)
that leak internal engineering terms — warehouse join language, pipeline/payload
jargon, edge-materialization, etc. Owner discovery of "warehouse join resolves"
on a notice card is the standing failure this gate is meant to catch earlier.

Allowlist (public_surface_vocab_allowlist.txt) is the explicit tracked register
of remaining known product phrasing that still uses a listed term intentionally
(e.g. staffing "precomputed" schedule copy). Prefer fixing copy over growing
the allowlist.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SITE = REPO / "site"
I18N = SITE / "i18n.js"
ALLOWLIST = Path(__file__).with_name("public_surface_vocab_allowlist.txt")

# Word / phrase patterns that should not appear on public reader surfaces.
# Keep these mechanical and low-noise; product words like "matched" are fine.
INTERNAL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("warehouse", re.compile(r"\bwarehouse\b", re.I)),
    ("warehouse join", re.compile(r"warehouse\s+join", re.I)),
    ("join resolves", re.compile(r"join\s+resolves", re.I)),
    ("payload", re.compile(r"\bpayload\b", re.I)),
    ("pipeline", re.compile(r"\bpipeline\b", re.I)),
    ("precompute", re.compile(r"\bpre-?comput(?:e|ed|es|ing)\b", re.I)),
    ("edge-materialized", re.compile(r"\bedge[- ]materializ", re.I)),
    ("edge cache", re.compile(r"\bedge\s+cache\b", re.I)),
    ("dual-write", re.compile(r"\bdual[- ]write\b", re.I)),
    ("materialization", re.compile(r"\bmaterialization\b", re.I)),
    ("SODA", re.compile(r"\bSODA\b")),
    ("KV ", re.compile(r"\bKV\b")),
    ("prebuilt ZAP warehouse", re.compile(r"prebuilt\s+ZAP\s+warehouse", re.I)),
]


def load_allowlist(path: Path) -> set[str]:
    if not path.exists():
        return set()
    out: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out.add(line)
    return out


def extract_en_strings(i18n_text: str) -> dict[str, str]:
    """Pull STRINGS.en key: value pairs from site/i18n.js (string literals only)."""
    # Prefer the runtime catalog (`const STRINGS = { en: { ... } }`), not LANG_META.en.
    m = re.search(r"const\s+STRINGS\s*=\s*\{[\s\S]*?\ben\s*:\s*\{", i18n_text)
    if not m:
        m = re.search(r"STRINGS\s*=\s*\{[\s\S]*?\ben\s*:\s*\{", i18n_text)
    if not m:
        raise SystemExit("public_surface_vocab: could not find STRINGS.en block in i18n.js")
    start = m.end()
    # Brace match from first char inside STRINGS.en
    depth = 1
    i = start
    while i < len(i18n_text) and depth:
        c = i18n_text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif c in "\"'":
            quote = c
            i += 1
            while i < len(i18n_text):
                if i18n_text[i] == "\\":
                    i += 2
                    continue
                if i18n_text[i] == quote:
                    break
                i += 1
        elif c == "`":
            # Skip template literals (rare in en catalog).
            i += 1
            while i < len(i18n_text):
                if i18n_text[i] == "\\":
                    i += 2
                    continue
                if i18n_text[i] == "`":
                    break
                i += 1
        i += 1
    block = i18n_text[start : i - 1]
    # Parsed en catalog entries (key -> display string). Empty until the loop below.
    en_catalog = {}  # source: site/i18n.js STRINGS.en
    for km in re.finditer(
        r"([A-Za-z0-9_]+)\s*:\s*(\"([^\"\\]|\\.)*\"|'([^'\\]|\\.)*')",
        block,
    ):
        key = km.group(1)
        raw = km.group(2)
        try:
            val = json.loads(raw) if raw.startswith('"') else raw[1:-1]
        except json.JSONDecodeError:
            val = raw[1:-1]
        en_catalog[key] = val
    if len(en_catalog) < 100:
        raise SystemExit(
            f"public_surface_vocab: only parsed {len(en_catalog)} en strings — parser likely wrong"
        )
    return en_catalog


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--gate",
        action="store_true",
        help="Exit non-zero on any non-allowlisted hit (CI default).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print machine-readable findings.",
    )
    args = parser.parse_args(argv)

    allow = load_allowlist(ALLOWLIST)
    text = I18N.read_text(encoding="utf-8")
    en = extract_en_strings(text)

    # Hits against the public en catalog (key, term, excerpt). Empty until scan.
    hits = []  # source: site/i18n.js STRINGS.en + INTERNAL_PATTERNS
    for key, value in sorted(en.items()):
        if not isinstance(value, str) or not value.strip():
            continue
        for term, pat in INTERNAL_PATTERNS:
            if not pat.search(value):
                continue
            allow_token = key + ":" + term  # allowlist form key:term (not a secret)
            if allow_token in allow or key in allow:
                continue
            # Allowlist may name "key:term" or whole key
            hits.append(
                {
                    "key": key,
                    "term": term,
                    "excerpt": value[:180],
                }
            )
    findings = hits

    if args.json:
        print(json.dumps({"findings": findings, "count": len(findings)}, indent=2))
    elif findings:
        print(f"public_surface_vocab: {len(findings)} internal-vocabulary hit(s) in en i18n:")
        for f in findings[:40]:
            print(f"  - {f['key']}: term={f['term']!r} excerpt={f['excerpt']!r}")
        if len(findings) > 40:
            print(f"  … +{len(findings) - 40} more")
        print(
            "Fix the reader-facing copy, or add an explicit allowlist line "
            f"(key or key:term) in {ALLOWLIST.name}."
        )
    else:
        print(f"public_surface_vocab OK — scanned {len(en)} en strings, 0 hits.")

    if args.gate and findings:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
