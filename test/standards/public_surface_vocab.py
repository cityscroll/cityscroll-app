#!/usr/bin/env python3
"""Public-surface internal-vocabulary lint.

Flags reader-facing i18n English strings (and optional HTML data-i18n fallbacks)
that leak internal engineering terms — warehouse join language, pipeline/payload
jargon, edge-materialization, or narration of the site's own data-handling
methodology. Owner discovery of "warehouse join resolves" on a notice card is
the standing failure this gate is meant to catch earlier.

Allowlist (public_surface_vocab_allowlist.txt) is the explicit tracked register
of remaining known product phrasing that still uses a listed term intentionally
(e.g. staffing "precomputed" schedule copy). Prefer fixing copy over growing
the allowlist.
"""
from __future__ import annotations

import argparse
from html.parser import HTMLParser
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SITE = REPO / "site"
I18N = SITE / "i18n.js"
ALLOWLIST = Path(__file__).with_name("public_surface_vocab_allowlist.txt")
LOCALE_DIR = SITE / "i18n" / "lang"

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
    ("methodology: kept visible", re.compile(r"\bkept\s+visible\b", re.I)),
    ("methodology: guessed", re.compile(r"\b(?:instead\s+of|rather\s+than)\s+(?:guess(?:ed|ing)?|dropp(?:ed|ing))\b", re.I)),
    ("methodology: guesses", re.compile(r"\bguesses\b", re.I)),
    ("methodology: invented", re.compile(r"\b(?:(?:not|never|nothing\s+is)\s+(?:invented|fabricated)|(?:do|does)\s+not\s+invent)\b", re.I)),
    ("methodology: not venue", re.compile(r"\bnot\s+venue\b", re.I)),
    ("methodology: site virtue", re.compile(r"\b(?:we\s+do\s+not\s+(?:fabricate|guess)|honest(?:ly)?)\b", re.I)),
]

# Architecture vocabulary and implementation narration should stay in code and
# tests. Lens is intentionally absent: it is established product language.
PUBLIC_COPY_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("architecture jargon: facet", re.compile(r"\bfacets?\b", re.I)),
    (
        "architecture jargon: scope",
        re.compile(
            r"\b(?:active|saved|shared|place|district|map|this|one)\s+scopes?\b"
            r"|\b(?:apply|preview|pick|watch|share|update|keep)\s+(?:this\s+|the\s+|an?\s+)?scopes?\b"
            r"|\bsets?\s+of\s+scopes?\b",
            re.I,
        ),
    ),
    (
        "architecture jargon: island",
        re.compile(r"\b(?:client|enhancement|personal|route[- ]only)\s+island\b", re.I),
    ),
    ("architecture jargon: document route", re.compile(r"\bdocument\s+route\b", re.I)),
    ("mechanics narration: without JavaScript", re.compile(r"\bwithout\s+JavaScript\b", re.I)),
    ("mechanics narration: no-JS", re.compile(r"\bno[- ]?JS\b", re.I)),
    ("mechanics narration: scope object", re.compile(r"\bscope\s+object\b", re.I)),
    ("mechanics narration: server-rendered", re.compile(r"\bserver[- ]rendered\b", re.I)),
    ("mechanics narration: static-first", re.compile(r"\bstatic[- ]first\b", re.I)),
]

# Join provenance belongs in a disclosure, expressed in reader language. These
# patterns guard every locale catalog because untranslated fallbacks can otherwise
# leak the same implementation copy outside the English catalog.
JOIN_MECHANICS_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "join mechanics: joined count",
        re.compile(r"\bjoined\s+(?:\{[A-Za-z0-9_]+\}|\d+)(?=\s)", re.I),
    ),
    (
        "join mechanics: namespaced key",
        re.compile(
            r"\b(?:franchise|disposition|party|solicitation|concession|plan|rules|bbl|taxlot):"
            r"[a-z0-9][a-z0-9:_-]*\b",
            re.I,
        ),
    ),
    (
        "join mechanics: method identifier",
        re.compile(r"(?<![A-Za-z0-9])(?:exact|fuzzy)_[a-z0-9_]+", re.I),
    ),
    (
        "join mechanics: parenthesized method placeholder",
        re.compile(r"\(\{method\}\)", re.I),
    ),
    (
        "join mechanics: domain coverage count",
        re.compile(
            r"\b(?:\{[A-Za-z0-9_]+\}|\d+)\s+of\s+(?:\{[A-Za-z0-9_]+\}|\d+)\s+"
            r"domains?\s+(?:have|with)\s+linked\s+objects?\b",
            re.I,
        ),
    ),
]

# Catch the original dynamic leak even when the catalog contains only a
# placeholder: internal values must first pass through a reader-language label.
DIRECT_RENDER_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "join mechanics: direct method rendering",
        re.compile(r"escUiHtml\(\s*join\.method\b", re.I),
    ),
    (
        "join mechanics: direct subject rendering",
        re.compile(r"escUiHtml\(\s*spine\.subject_ref\b", re.I),
    ),
]

# Contrastive negation is especially harmful in compact naming surfaces: labels
# and badges should say what a thing is, not what alternative the site rejected.
LABEL_BADGE_KEY = re.compile(r"(?:^|_)(?:label|lbl|badge|tag|lead)(?:_|$)", re.I)
CONTRASTIVE_NEGATION = re.compile(r"\b(?:not\s+\w+|instead\s+of|rather\s+than)\b", re.I)


class ReaderTextParser(HTMLParser):
    """Collect reader-visible copy and accessibility text from built HTML."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = list()
        self.hidden_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style"}:
            self.hidden_depth += 1
            return
        for name, value in attrs:
            if not value:
                continue
            if name in {"aria-label", "placeholder", "title"} or name.startswith(("data-message-", "data-msg-")):
                self.parts.append(value)
            elif tag == "meta" and name == "content":
                self.parts.append(value)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"} and self.hidden_depth:
            self.hidden_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self.hidden_depth and data.strip():
            self.parts.append(data.strip())


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


def extract_catalog_strings(catalog_text: str) -> dict[str, str]:
    """Pull simple key/string pairs from one locale module."""
    out: dict[str, str] = {}  # source: parsed key/string pairs in one locale module
    for match in re.finditer(
        r"([A-Za-z0-9_]+)\s*:\s*(\"([^\"\\]|\\.)*\"|'([^'\\]|\\.)*')",
        catalog_text,
    ):
        key = match.group(1)
        raw = match.group(2)
        try:
            value = json.loads(raw) if raw.startswith('"') else raw[1:-1]
        except json.JSONDecodeError:
            value = raw[1:-1]
        out[key] = value
    return out


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

    # Hits against the public catalogs (source, key, term, excerpt). Empty until scan.
    hits = []  # source: site/i18n.js STRINGS.en + INTERNAL_PATTERNS
    catalogs = [("site/i18n.js:en", en, INTERNAL_PATTERNS + JOIN_MECHANICS_PATTERNS + PUBLIC_COPY_PATTERNS)]  # source: public i18n catalogs
    for path in sorted(LOCALE_DIR.glob("*.js")):
        catalogs.append(
            (
                str(path.relative_to(REPO)),
                extract_catalog_strings(path.read_text(encoding="utf-8")),
                JOIN_MECHANICS_PATTERNS,
            )
        )
    for source, catalog, patterns in catalogs:
        for key, value in sorted(catalog.items()):
            if not isinstance(value, str) or not value.strip():
                continue
            for term, pat in patterns:
                if not pat.search(value):
                    continue
                allow_token = key + ":" + term  # allowlist form key:term (not a secret)
                if allow_token in allow or key in allow:
                    continue
                hits.append(
                    {
                        "source": source,
                        "key": key,
                        "term": term,
                        "excerpt": value[:180],
                    }
                )
            if source == "site/i18n.js:en" and LABEL_BADGE_KEY.search(key) and CONTRASTIVE_NEGATION.search(value):
                term = "contrastive negation in label/badge"
                allow_token = key + ":" + term
                if allow_token not in allow and key not in allow:
                    hits.append({"source": source, "key": key, "term": term, "excerpt": value[:180]})
    public_render_files = [
        *sorted((SITE / "app").glob("*.mjs")),
        *sorted(SITE.glob("*.mjs")),
        *sorted(SITE.glob("*.js")),
        *sorted(SITE.glob("*.html")),
    ]
    for path in public_render_files:
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for term, pattern in DIRECT_RENDER_PATTERNS:
                if not pattern.search(line):
                    continue
                hits.append(
                    {
                        "source": f"{path.relative_to(REPO)}:{line_number}",
                        "key": "rendered_source",
                        "term": term,
                        "excerpt": line.strip()[:180],
                    }
                )
    built_documents = [
        SITE / "following" / "index.html",
        *sorted((SITE / "near-you").rglob("*.html")),
    ]
    for path in built_documents:
        parser = ReaderTextParser()
        parser.feed(path.read_text(encoding="utf-8"))
        reader_text = "\n".join(parser.parts)
        for term, pattern in PUBLIC_COPY_PATTERNS:
            match = pattern.search(reader_text)
            if not match:
                continue
            hits.append(
                {
                    "source": str(path.relative_to(REPO)),
                    "key": "visible_copy",
                    "term": term,
                    "excerpt": reader_text[max(0, match.start() - 60) : match.end() + 100].replace("\n", " ")[:180],
                }
            )
    findings = hits

    if args.json:
        print(json.dumps({"findings": findings, "count": len(findings)}, indent=2))
    elif findings:
        print(f"public_surface_vocab: {len(findings)} internal-vocabulary hit(s) in en i18n:")
        for f in findings[:40]:
            print(
                f"  - {f.get('source', 'site/i18n.js:en')}:{f['key']}: "
                f"term={f['term']!r} excerpt={f['excerpt']!r}"
            )
        if len(findings) > 40:
            print(f"  … +{len(findings) - 40} more")
        print(
            "Fix the reader-facing copy, or add an explicit allowlist line "
            f"(key or key:term) in {ALLOWLIST.name}."
        )
    else:
        print(
            f"public_surface_vocab OK — scanned {len(en)} en strings, "
            f"{len(catalogs) - 1} locale catalogs, and {len(public_render_files)} render files; 0 hits."
        )

    if args.gate and findings:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
