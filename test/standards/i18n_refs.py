#!/usr/bin/env python3
"""Standards gate: no raw i18n key can ever reach a user's screen.

Two failure classes, both seen in production on 2026-07-11:
1. A referenced key missing from the dictionary → t() falls back to the key name
   (rendered UPPERCASE by CSS: "SEARCH_LABEL").
2. Cache skew: index.html references i18n.js unversioned, so a deploy can pair a
   NEW index.html with a CACHED old dictionary (max-age=600) — every new key
   renders raw for up to ten minutes. Fix: the script tag must carry ?v=<hash8>
   of the current i18n.js, so changing the dictionary changes the URL.

Checks (all six pages since crol-subpages-es, 2026-07-13 — every page loads i18n.js now):
  A. every key referenced via data-i18n / data-i18n-html / data-i18n-placeholder
     or a real t("…") call exists in the en dictionary (parity with es is
     i18n_keys.py's job);
  B. dynamically-constructed keys (t("prefix_" + x)) are listed so a human knows
     the static check can't see them — they're covered by the runtime check in
     test/functional/12_language.py;
  C. every page loads i18n.js with ?v= equal to sha256(i18n.js)[:8] — one shared
     file today, so all pages carry the SAME hash; this still catches a page whose
     script tag was left stale after an i18n.js edit.
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
# t("key") calls — lookbehind kills createElement('div') / split('_') style false matches.
for src in list(pages.values()) + [lib]:
    refs |= set(re.findall(r"""(?<![A-Za-z0-9_$.])t\(\s*['"]([A-Za-z0-9_.]+)['"]\s*[,)]""", src))

missing = sorted(r for r in refs if r not in dict_keys)
dynamic = sorted(set(re.findall(
    r"""(?<![A-Za-z0-9_$.])t\(\s*['"]([A-Za-z0-9_.]+)['"]\s*\+""", pages["index.html"])))

print(f"dictionary: {len(dict_keys)} keys · static references: {len(refs)} (across {len(PAGES)} pages)")
if dynamic:
    print(f"note: {len(dynamic)} dynamically-constructed key prefix(es) — runtime-checked only: {dynamic}")
if missing:
    for m in missing:
        print(f"FAIL missing from dictionary: {m}")
    sys.exit(f"i18n_refs gate: {len(missing)} referenced key(s) not in the dictionary")

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
print(f"✅ i18n_refs gate green (v={want}, {len(PAGES)} pages)")
