#!/usr/bin/env python3
"""i18n key parity lint — fails if any shipping language is missing keys that 'en' has.
Wired into the CI unit job via .github/workflows/ci.yml.

w8-01: shipping languages now live in i18n.js's SHIPPING_LANGS declaration (the ONE place
this list is authored — the selector, the guard's CI matrix, and this gate all read it,
directly or by convention) and their dictionaries live in i18n/lang/<lang>.js, not inline
in i18n.js (only 'en' stays inline there). Stub languages (LANG_META entries not in
SHIPPING_LANGS) are allowed to have no file / an empty dictionary at all.
"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).parents[2]
I18N = ROOT / "i18n.js"

if not I18N.exists():
    print(f"ERROR: {I18N} not found", file=sys.stderr)
    sys.exit(1)

src = I18N.read_text(encoding="utf-8")


def extract_en_keys(src):
    """Return the set of string keys in i18n.js's inline `en: { ... }` block (inside
    `const STRINGS = {...}` — NOT LANG_META's `en: { locale: ..., ... }`, a different object
    that also happens to have an `en:` property)."""
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


def extract_shipping_langs(src):
    m = re.search(r"SHIPPING_LANGS\s*=\s*\[(.*?)\]", src, re.S)
    if not m:
        return None
    return re.findall(r'"([^"]+)"', m.group(1))


def extract_lang_file_keys(lang):
    """Extract the set of keys assigned in i18n/lang/<lang>.js's Object.assign(...) call."""
    path = ROOT / "i18n" / "lang" / f"{lang}.js"
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


en_keys = extract_en_keys(src)
if en_keys is None:
    print("ERROR: 'en' block not found in i18n.js", file=sys.stderr)
    sys.exit(1)

REQUIRED_FULL = extract_shipping_langs(src)
if REQUIRED_FULL is None:
    print("ERROR: SHIPPING_LANGS not found in i18n.js", file=sys.stderr)
    sys.exit(1)

failures = []
report = []
for lang in REQUIRED_FULL:
    lang_keys = extract_lang_file_keys(lang)
    if lang_keys is None:
        failures.append(f"{lang}: i18n/lang/{lang}.js not found or unparseable")
        continue
    missing = en_keys - lang_keys
    if missing:
        failures.append(f"{lang}: missing {len(missing)} key(s): {sorted(missing)}")
    else:
        report.append(f"{lang}: full coverage ({len(lang_keys)} keys)")

if failures:
    print("i18n key parity lint FAILED:", file=sys.stderr)
    for f in failures:
        print(f"  {f}", file=sys.stderr)
    sys.exit(1)

print(f"i18n keys OK — en: {len(en_keys)} keys; " + "; ".join(report))
