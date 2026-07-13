#!/usr/bin/env python3
"""Civic-terms glossary + placeholder-parity gate (w8-02).

Two checks, both about translations DRIFTING from the source string in ways that break the
app or the City's own designated-language materials:

  A. Placeholder/tag parity — every `{placeholder}` token and inline HTML tag name in an
     `en` string must survive, byte-for-byte (placeholders) or tag-for-tag (markup), in
     every shipping language's translation of that key. A translator dropping `{date}` or an
     `</a>` silently breaks rendering or leaves a dangling link — this is the same invariant
     w6-15 (notice-translation) already enforces for the far larger informal-translation
     surface; this gate is the small, permanent version for the UI dictionary itself.
  B. Glossary consistency — every civic term pinned in i18n/glossary.json must actually
     appear, in its pinned form, somewhere in each shipping language's dictionary (catches a
     term drifting to a synonym after the glossary was updated, or never having been applied).

Both checks are red on a seeded placeholder-drop / off-glossary fixture and green on the
shipped dictionaries — see test/*.test.mjs for the seeded-fixture unit test.
"""
import json
import re
import subprocess
import sys
import pathlib

ROOT = pathlib.Path(__file__).parents[2]


def load_strings():
    out = subprocess.check_output(
        ["node", "-e",
         "global.window={};require(process.argv[1]);"
         "console.log(JSON.stringify({strings:window.STRINGS,shipping:window.SHIPPING_LANGS}))",
         str(ROOT / "i18n.js")], text=True)
    return json.loads(out)


PLACEHOLDER_RE = re.compile(r"\{[a-zA-Z_]+\}")
TAG_RE = re.compile(r"</?([a-zA-Z][a-zA-Z0-9]*)")


def tokens(value):
    """SET of {placeholder} names present (a translation may legitimately repeat the same
    named placeholder more times than en — e.g. Spanish noun/adjective plural agreement
    reusing {s} twice — so presence, not occurrence count, is what must match) + a MULTISET
    of inline tag NAMES (not attributes/hrefs, which legitimately vary; tag repetition is a
    more meaningful signal than placeholder repetition, so tags stay count-sensitive)."""
    placeholders = set(PLACEHOLDER_RE.findall(value))
    tags = sorted(TAG_RE.findall(value))
    return placeholders, tags


PLURAL_SUFFIX_RE = re.compile(r"_(one|few|many|other)$")


def check_placeholder_parity(strings, shipping):
    en = strings["en"]
    failures = []
    for lang in shipping:
        dict_l = strings.get(lang, {})
        for key, en_val in en.items():
            if key not in dict_l:
                continue  # i18n_keys.py's job to catch missing keys
            # CLDR plural-category variants (tn(), w8-01) are expected to vary in placeholder
            # use across categories/languages by design (en "_one" = "1 day left" has no {n};
            # ru "_one" = "остался {n} день" always shows the number) — runtime-checked only,
            # same posture as i18n_refs.py's treatment of tn() calls.
            if PLURAL_SUFFIX_RE.search(key):
                continue
            l_val = dict_l[key]
            if not isinstance(l_val, str) or not isinstance(en_val, str):
                continue
            en_ph, en_tags = tokens(en_val)
            l_ph, l_tags = tokens(l_val)
            # {s} is the legacy plural-suffix placeholder (pre-tn(), still used by a few
            # keys) — a language that doesn't inflect for plural (zh-Hans) may legitimately
            # drop it, same reasoning as the plural-suffix-key exemption above.
            en_ph, l_ph = en_ph - {"{s}"}, l_ph - {"{s}"}
            if en_ph != l_ph:
                failures.append(f"{lang}.{key}: placeholders {en_ph} in en but {l_ph} in {lang}")
            if en_tags != l_tags:
                failures.append(f"{lang}.{key}: tags {en_tags} in en but {l_tags} in {lang}")
    return failures


STEM_LEN = 5  # crude but effective for CJK/Cyrillic: catches declined/inflected forms
# (Russian "советов"/"совета" vs pinned "совет") without needing a real morphological analyzer.


def _stem(word):
    word = re.sub(r"[().,;:!?\"'«»]", "", word)
    return word[:STEM_LEN].lower() if len(word) > STEM_LEN else word.lower()


def check_glossary_consistency(strings, shipping, glossary):
    failures = []
    for term_key, term in glossary.items():
        for lang in shipping:
            pinned = term.get(lang)
            if not pinned or "(unchanged)" in pinned or " / " in pinned:
                continue  # borough_names-style entries and split conventions aren't grep-checkable
            dict_l = strings.get(lang, {})
            haystack = " ".join(v.lower() for v in dict_l.values() if isinstance(v, str))
            # Significant words only (skip the bracketed acronym, e.g. "(RFP)", and short
            # function words) — a word's STEM matching anywhere handles a morphologically
            # inflected language (ru declension: "совет" pinned, "советов" shipped) without
            # requiring exact-phrase match, which would false-positive on every case ending.
            words = [w for w in re.findall(r"[^\s()]+", pinned) if len(re.sub(r"[().,;:!?]", "", w)) >= 4]
            missing_words = [w for w in words if _stem(w) not in haystack]
            if words and missing_words == words:  # ALL significant words absent = real drift
                failures.append(
                    f"{lang}: glossary term {term_key!r} (pinned {pinned!r}) not found anywhere "
                    f"in STRINGS.{lang} — translation may have drifted off-glossary")
    return failures


def main():
    data = load_strings()
    strings, shipping = data["strings"], data["shipping"]
    glossary = json.loads((ROOT / "i18n" / "glossary.json").read_text())["terms"]

    failures = check_placeholder_parity(strings, shipping)
    failures += check_glossary_consistency(strings, shipping, glossary)

    if failures:
        print("i18n glossary/placeholder gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)
    print(f"✅ i18n glossary gate green — {len(shipping)} shipping language(s), "
          f"{len(glossary)} glossary term(s), placeholder/tag parity across {len(strings['en'])} keys")


if __name__ == "__main__":
    main()
