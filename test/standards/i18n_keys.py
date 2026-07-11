#!/usr/bin/env python3
"""i18n key parity lint — fails if any shipping translated language in i18n.js
is missing keys that 'en' has. Wired into the CI unit job via .github/workflows/ci.yml.

Shipping languages (must have full key coverage): es
Stub languages (allowed to be empty {}): fr, ht, ru, bn, zh-Hans, zh-Hant, ko, ar, ur, pl
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


def _find_strings_block(src):
    """Return the content of the `const STRINGS = { ... }` block."""
    m = re.search(r'\bconst STRINGS\s*=\s*\{', src)
    if not m:
        return None
    start = src.index("{", m.start())
    depth = 0
    for i in range(start, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[start : i + 1]
    return None


def extract_lang_keys(src, lang):
    """Extract the set of string keys defined for `lang` inside STRINGS."""
    strings_block = _find_strings_block(src)
    if strings_block is None:
        return None

    # Inside STRINGS, find `lang: {` or `"lang": {`
    quoted = re.escape(lang)
    pattern = re.compile(
        r'(?:^|\n)\s+(?:"' + quoted + r'"|' + quoted + r')\s*:\s*\{',
        re.MULTILINE,
    )
    m = pattern.search(strings_block)
    if not m:
        return None

    open_brace = strings_block.index("{", m.start())
    depth = 0
    end = open_brace
    for i in range(open_brace, len(strings_block)):
        if strings_block[i] == "{":
            depth += 1
        elif strings_block[i] == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    lang_block = strings_block[open_brace : end + 1]

    # Extract property keys: `    key_name:` (identifiers only, not nested objects)
    keys = re.findall(r"^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:", lang_block, re.MULTILINE)
    return set(keys)


en_keys = extract_lang_keys(src, "en")
if en_keys is None:
    print("ERROR: 'en' block not found in i18n.js", file=sys.stderr)
    sys.exit(1)

# Languages that MUST have full key coverage (shipping languages)
REQUIRED_FULL = ["es"]

failures = []
for lang in REQUIRED_FULL:
    lang_keys = extract_lang_keys(src, lang)
    if lang_keys is None:
        failures.append(f"{lang}: block not found in STRINGS")
        continue
    missing = en_keys - lang_keys
    if missing:
        failures.append(
            f"{lang}: missing {len(missing)} key(s): {sorted(missing)}"
        )

if failures:
    print("i18n key parity lint FAILED:", file=sys.stderr)
    for f in failures:
        print(f"  {f}", file=sys.stderr)
    sys.exit(1)

print(f"i18n keys OK — en: {len(en_keys)} keys; es: full coverage ({len(en_keys)} keys)")
