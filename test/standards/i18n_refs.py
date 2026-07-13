#!/usr/bin/env python3
"""Standards gate: no raw i18n key can ever reach a user's screen.

Failure classes, all seen in production:
1. A referenced key missing from the dictionary → t() falls back to the key name
   (rendered UPPERCASE by CSS: "SEARCH_LABEL") — 2026-07-11.
2. Cache skew: index.html references i18n.js unversioned, so a deploy can pair a
   NEW index.html with a CACHED old dictionary (max-age=600) — every new key
   renders raw for up to ten minutes. Fix: the script tag must carry ?v=<hash8>
   of the current i18n.js, so changing the dictionary changes the URL.
3. Split-architecture skew (w8-01): en lives inline in i18n.js (the core file); every
   other shipping language's dictionary lives in its own i18n/lang/<lang>.js, loaded on
   demand. LANG_FILE_HASHES in i18n.js pins each shipping language's file hash — if that
   drifts from the file's actual hash, a stale per-language dictionary can ship even
   though the core file's own hash (check C, below) is current.

Checks (all six pages since crol-subpages-es, 2026-07-13 — every page loads i18n.js now):
  A. every key referenced via data-i18n / data-i18n-html / data-i18n-placeholder
     or a real t("…") call exists in the en dictionary (parity with shipping languages is
     i18n_keys.py's job);
  B. dynamically-constructed keys (t("prefix_" + x)) are listed so a human knows
     the static check can't see them — they're covered by the runtime check in
     test/functional/12_language.py. tn("base", n) plural calls are listed the same way:
     the static check can't evaluate which suffix (_one/_few/_many/_other) will be
     selected at runtime, so it only verifies "<base>_other" exists (the universal
     fallback every language must define) rather than every category.
  C. every page loads i18n.js (the core file) with ?v= equal to sha256(i18n.js)[:8] —
     one shared file today, so all pages carry the SAME hash; this still catches a page
     whose script tag was left stale after an i18n.js edit;
  D. every shipping language's LANG_FILE_HASHES entry in i18n.js matches
     sha256(i18n/lang/<lang>.js)[:8] — the per-file cache-skew guard for the split
     dictionaries (w8-01 AC #1). A language's own file changing is the ONLY thing that
     should change its own hash entry.
"""
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PAGES = ["index.html", "about.html", "data.html", "stats.html", "api.html", "changelog.html"]
pages = {p: (ROOT / p).read_text() for p in PAGES}
lib = (ROOT / "i18n.js").read_text()

en_block = re.search(r"en:\s*{(.*?)\n  },", lib, re.S)
if not en_block:
    sys.exit("i18n_refs: could not parse the en dictionary block")
dict_keys = set(re.findall(r"([A-Za-z0-9_.]+):", en_block.group(1)))

refs = set()
for src in pages.values():
    refs |= set(re.findall(r'data-i18n(?:-html|-placeholder|-aria)?="([A-Za-z0-9_.]+)"', src))
# t("key") calls — lookbehind kills createElement('div') / split('_') style false matches,
# and (?!n) keeps tn("...") calls (handled separately below) from matching this pattern too.
for src in list(pages.values()) + [lib]:
    refs |= set(re.findall(r"""(?<![A-Za-z0-9_$.])t\(\s*['"]([A-Za-z0-9_.]+)['"]\s*[,)]""", src))

missing = sorted(r for r in refs if r not in dict_keys)
dynamic = sorted(set(re.findall(
    r"""(?<![A-Za-z0-9_$.])t\(\s*['"]([A-Za-z0-9_.]+)['"]\s*\+""", pages["index.html"])))

# tn("base", n, ...) plural calls (w8-01): verify the universal "<base>_other" fallback
# exists in en — every shipping language must define at least "_other" too, but that's
# i18n_keys.py's parity job, not this gate's.
tn_bases = sorted(set(re.findall(
    r"""(?<![A-Za-z0-9_$.])tn\(\s*['"]([A-Za-z0-9_.]+)['"]\s*,""", pages["index.html"])))
tn_missing = sorted(b for b in tn_bases if (b + "_other") not in dict_keys)

print(f"dictionary: {len(dict_keys)} keys · static references: {len(refs)} (across {len(PAGES)} pages)")
if dynamic:
    print(f"note: {len(dynamic)} dynamically-constructed key prefix(es) — runtime-checked only: {dynamic}")
if tn_bases:
    print(f"note: {len(tn_bases)} tn() plural base(s) — category selection is runtime-checked only: {tn_bases}")
if missing:
    for m in missing:
        print(f"FAIL missing from dictionary: {m}")
    sys.exit(f"i18n_refs gate: {len(missing)} referenced key(s) not in the dictionary")
if tn_missing:
    for m in tn_missing:
        print(f"FAIL tn() base missing its '_other' fallback: {m}")
    sys.exit(f"i18n_refs gate: {len(tn_missing)} tn() base(s) missing an '_other' key")

want = hashlib.sha256((ROOT / "i18n.js").read_bytes()).hexdigest()[:8]
stale = []
for page, src in pages.items():
    m = re.search(r'src="i18n\.js\?v=([0-9a-f]{8})"', src)
    if not m:
        sys.exit(f"i18n_refs gate: {page} must load i18n.js with ?v=<hash8> (cache-skew guard)")
    if m.group(1) != want:
        stale.append((page, m.group(1)))
if stale:
    for page, got in stale:
        print(f"FAIL stale version param — {page} has v={got}, i18n.js hashes to {want}")
    sys.exit("i18n_refs gate: update the script tag(s) above (this is what prevents the "
             "raw-key cache-skew window).")
print(f"✅ i18n_refs gate green (core v={want}, {len(PAGES)} pages)")

# ---- check D: per-language dictionary file hashes (w8-01 AC #1) ----
shipping_block = re.search(r'SHIPPING_LANGS\s*=\s*\[(.*?)\]', lib, re.S)
if not shipping_block:
    sys.exit("i18n_refs gate: could not parse SHIPPING_LANGS in i18n.js")
shipping = sorted(set(re.findall(r'"([^"]+)"', shipping_block.group(1))))
hashes_block = re.search(r"const LANG_FILE_HASHES\s*=\s*\{(.*?)\n\};", lib, re.S)
if not hashes_block:
    sys.exit("i18n_refs gate: could not parse LANG_FILE_HASHES in i18n.js")
declared = dict(re.findall(r'"?([A-Za-z0-9-]+)"?\s*:\s*"([0-9a-f]{8})"', hashes_block.group(1)))

lang_stale = []
for lang in shipping:
    lang_file = ROOT / "i18n" / "lang" / f"{lang}.js"
    if not lang_file.exists():
        sys.exit(f"i18n_refs gate: shipping language {lang!r} has no i18n/lang/{lang}.js file")
    want_lang = hashlib.sha256(lang_file.read_bytes()).hexdigest()[:8]
    got_lang = declared.get(lang)
    if got_lang != want_lang:
        lang_stale.append((lang, got_lang, want_lang))
if lang_stale:
    for lang, got_lang, want_lang in lang_stale:
        print(f"FAIL LANG_FILE_HASHES[{lang!r}] = {got_lang!r}, but i18n/lang/{lang}.js hashes to {want_lang!r}")
    sys.exit("i18n_refs gate: update LANG_FILE_HASHES in i18n.js to match the file(s) above "
             "(shasum -a 256 i18n/lang/<lang>.js | cut -c1-8).")
print(f"✅ per-language cache-skew gate green ({len(shipping)} shipping language file(s): {shipping})")
