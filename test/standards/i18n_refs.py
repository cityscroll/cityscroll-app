#!/usr/bin/env python3
"""Standards gate: no raw i18n key can ever reach a user's screen.

Failure classes, all seen in production:
1. A referenced key missing from the dictionary → t() falls back to the key name
   (rendered UPPERCASE by CSS: "SEARCH_LABEL") — 2026-07-11.
2. Cache skew: index.html once referenced i18n.js unversioned, so a deploy could
   pair a NEW index.html with a CACHED old dictionary (max-age=600) — every new
   key rendered raw for up to ten minutes.
3. Split-architecture skew (w8-01): en lives inline in i18n.js (the core file); every
   other shipping language's dictionary lives in its own i18n/lang/<lang>.js, loaded on
   demand. The deploy build now derives one content address from the core and every
   shipping dictionary. Pages load the core with that stamp, and the core propagates it
   to each dictionary request.

Checks (all six pages since 2026-07-13 — every page loads i18n.js now):
  A. every key referenced via data-i18n / data-i18n-html / data-i18n-placeholder
     or a real t("…") call exists in the en dictionary (parity with shipping languages is
     i18n_keys.py's job);
  B. dynamically-constructed keys (t("prefix_" + x)) are listed so a human knows
     the static check can't see them — they're covered by the runtime check in
     test/functional/12_language.py. tn("base", n) plural calls are listed the same way:
     the static check can't evaluate which suffix (_one/_few/_many/_other) will be
     selected at runtime, so it only verifies "<base>_other" exists (the universal
     fallback every language must define) rather than every category.
  C. source pages carry the merge-stable build token, while a built artifact carries
     the exact content address derived from i18n.js plus all shipping dictionaries.
     `--built` verifies the artifact and fails if any i18n content changed after stamping.
"""
import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ROOT = REPO_ROOT / "site"
sys.path.insert(0, str(REPO_ROOT / "tools"))
from stamp_i18n_assets import PAGES, StampError, verify_built, verify_source  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
parser.add_argument("--built", action="store_true")
args = parser.parse_args()

ROOT = args.root.resolve()
pages = {p: (ROOT / p).read_text() for p in PAGES}
lib = (ROOT / "i18n.js").read_text()
RUNTIME_SURFACES = ["parcel_biography_ui.mjs", "app/property.mjs"]  # source: parcel biography route call sites
runtime_sources = {
    path: (ROOT / path).read_text()
    for path in RUNTIME_SURFACES
    if (ROOT / path).exists()
}

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
for src in runtime_sources.values():
    refs |= set(re.findall(r'"(property_xd_[A-Za-z0-9_]+)"', src))

missing = sorted(r for r in refs if r not in dict_keys)
dynamic = sorted(set(re.findall(
    r"""(?<![A-Za-z0-9_$.])t\(\s*['"]([A-Za-z0-9_.]+)['"]\s*\+""", pages["index.html"])))

# tn("base", n, ...) plural calls (w8-01): verify the universal "<base>_other" fallback
# exists in en — every shipping language must define at least "_other" too, but that's
# i18n_keys.py's parity job, not this gate's.
tn_bases = sorted(set(re.findall(
    r"""(?<![A-Za-z0-9_$.])tn\(\s*['"]([A-Za-z0-9_.]+)['"]\s*,""", pages["index.html"])))
tn_missing = sorted(b for b in tn_bases if (b + "_other") not in dict_keys)

print(f"dictionary: {len(dict_keys)} keys · static references: {len(refs)} (across {len(PAGES)} pages + {len(runtime_sources)} route surfaces)")
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

try:
    version = verify_built(ROOT) if args.built else verify_source(ROOT)
except (OSError, StampError) as error:
    sys.exit(f"i18n_refs gate: {error}")

surface = "built artifact" if args.built else "merge-stable source"
print(f"✅ i18n cache-skew gate green ({surface}, derived v={version}, {len(PAGES)} pages)")
