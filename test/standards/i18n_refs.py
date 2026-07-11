#!/usr/bin/env python3
"""Standards gate: no raw i18n key can ever reach a user's screen.

Two failure classes, both seen in production on 2026-07-11:
1. A referenced key missing from the dictionary → t() falls back to the key name
   (rendered UPPERCASE by CSS: "SEARCH_LABEL").
2. Cache skew: index.html references i18n.js unversioned, so a deploy can pair a
   NEW index.html with a CACHED old dictionary (max-age=600) — every new key
   renders raw for up to ten minutes. Fix: the script tag must carry ?v=<hash8>
   of the current i18n.js, so changing the dictionary changes the URL.

Checks:
  A. every key referenced via data-i18n / data-i18n-html / data-i18n-placeholder
     or a real t("…") call exists in the en dictionary (parity with es is
     i18n_keys.py's job);
  B. dynamically-constructed keys (t("prefix_" + x)) are listed so a human knows
     the static check can't see them — they're covered by the runtime check in
     test/functional/12_language.py;
  C. index.html loads i18n.js with ?v= equal to sha256(i18n.js)[:8].
"""
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
idx = (ROOT / "index.html").read_text()
lib = (ROOT / "i18n.js").read_text()

en_block = re.search(r"en:\s*{(.*?)\n  },", lib, re.S)
if not en_block:
    sys.exit("i18n_refs: could not parse the en dictionary block")
dict_keys = set(re.findall(r"([A-Za-z0-9_.]+):", en_block.group(1)))

refs = set(re.findall(r'data-i18n(?:-html|-placeholder)?="([A-Za-z0-9_.]+)"', idx))
# t("key") calls — lookbehind kills createElement('div') / split('_') style false matches.
for src in (idx, lib):
    refs |= set(re.findall(r"""(?<![A-Za-z0-9_$.])t\(\s*['"]([A-Za-z0-9_.]+)['"]\s*[,)]""", src))

missing = sorted(r for r in refs if r not in dict_keys)
dynamic = sorted(set(re.findall(r"""(?<![A-Za-z0-9_$.])t\(\s*['"]([A-Za-z0-9_.]+)['"]\s*\+""", idx)))

print(f"dictionary: {len(dict_keys)} keys · static references: {len(refs)}")
if dynamic:
    print(f"note: {len(dynamic)} dynamically-constructed key prefix(es) — runtime-checked only: {dynamic}")
if missing:
    for m in missing:
        print(f"FAIL missing from dictionary: {m}")
    sys.exit(f"i18n_refs gate: {len(missing)} referenced key(s) not in the dictionary")

want = hashlib.sha256((ROOT / "i18n.js").read_bytes()).hexdigest()[:8]
m = re.search(r'src="i18n\.js\?v=([0-9a-f]{8})"', idx)
if not m:
    sys.exit("i18n_refs gate: index.html must load i18n.js with ?v=<hash8> (cache-skew guard)")
if m.group(1) != want:
    sys.exit(f"i18n_refs gate: stale version param — index has v={m.group(1)}, i18n.js hashes to {want}. "
             f"Update the script tag (this is what prevents the raw-key cache-skew window).")
print(f"✅ i18n_refs gate green (v={want})")
