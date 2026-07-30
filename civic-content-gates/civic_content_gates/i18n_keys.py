"""i18n key parity lint — fails if any shipping language is missing keys that 'en' has.

Shipping languages live in i18n.js's SHIPPING_LANGS declaration (the one place this
list is authored) and their dictionaries live in i18n/lang/<lang>.js; only 'en' stays
inline in i18n.js. Stub languages (LANG_META entries not in SHIPPING_LANGS) may have
no file / an empty dictionary.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Optional, Sequence


def extract_en_keys(src: str):
    """Return the set of string keys in i18n.js's inline `en: { ... }` block inside
    `const STRINGS = {...}` — not LANG_META's `en: { locale: ..., ... }`."""
    strings_m = re.search(r"\bconst STRINGS\s*=\s*\{", src)
    if not strings_m:
        return None
    strings_start = src.index("{", strings_m.start())
    m = re.search(r"(?:^|\n)\s+en\s*:\s*\{", src[strings_start:])
    if not m:
        return None
    m_start = strings_start + m.start()
    open_brace = src.index("{", m_start)
    depth = 0
    end = open_brace
    for i in range(open_brace, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    block = src[open_brace:end + 1]
    return set(re.findall(r"^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:", block, re.MULTILINE))


def extract_shipping_langs(src: str):
    m = re.search(r"SHIPPING_LANGS\s*=\s*\[(.*?)\]", src, re.S)
    if not m:
        return None
    return re.findall(r'"([^"]+)"', m.group(1))


def extract_lang_file_keys(site_root: Path, lang: str):
    """Extract keys assigned in i18n/lang/<lang>.js's Object.assign(...) call."""
    path = Path(site_root) / "i18n" / "lang" / f"{lang}.js"
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8")
    m = re.search(r"Object\.assign\(W\.STRINGS\[[^\]]+\],\s*\{", text)
    if not m:
        return None
    open_brace = text.index("{", m.start())
    depth = 0
    end = open_brace
    for i in range(open_brace, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    block = text[open_brace:end + 1]
    keys = re.findall(r'^\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))\s*:', block, re.MULTILINE)
    return {a or b for a, b in keys}


def check(site_root: Path) -> tuple[list[str], list[str], Optional[int]]:
    """Return (failures, report_lines, en_key_count)."""
    site_root = Path(site_root)
    i18n = site_root / "i18n.js"
    if not i18n.exists():
        return [f"ERROR: {i18n} not found"], [], None
    src = i18n.read_text(encoding="utf-8")
    en_keys = extract_en_keys(src)
    if en_keys is None:
        return ["ERROR: 'en' block not found in i18n.js"], [], None
    required = extract_shipping_langs(src)
    if required is None:
        return ["ERROR: SHIPPING_LANGS not found in i18n.js"], [], None

    failures = []
    report = []
    for lang in required:
        lang_keys = extract_lang_file_keys(site_root, lang)
        if lang_keys is None:
            failures.append(f"{lang}: i18n/lang/{lang}.js not found or unparseable")
            continue
        missing = en_keys - lang_keys
        if missing:
            failures.append(f"{lang}: missing {len(missing)} key(s): {sorted(missing)}")
        else:
            report.append(f"{lang}: full coverage ({len(lang_keys)} keys)")
    return failures, report, len(en_keys)


def run(site_root: Path) -> int:
    failures, report, en_count = check(site_root)
    if failures and en_count is None and failures[0].startswith("ERROR:"):
        print(failures[0], file=sys.stderr)
        return 1
    if failures:
        print("i18n key parity lint FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print(f"i18n keys OK — en: {en_count} keys; " + "; ".join(report))
    return 0


def main(argv: Optional[Sequence[str]] = None, site_root: Optional[Path] = None) -> int:
    import argparse
    p = argparse.ArgumentParser(description="i18n key parity lint")
    p.add_argument("--root", type=Path, default=site_root, help="Site root containing i18n.js + i18n/lang/")
    args = p.parse_args(list(argv) if argv is not None else None)
    if not args.root:
        p.error("--root is required (or pass site_root to main())")
    return run(args.root)


if __name__ == "__main__":
    raise SystemExit(main())
