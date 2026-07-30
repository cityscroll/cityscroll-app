#!/usr/bin/env python3
"""Reading-level gate — consolidated path over readable-or-else.

Verify (hard max grade):
  python3 test/standards/reading_level.py --max-grade 7 about.html

CI ratchet (current production mode):
  python3 test/standards/reading_level.py --mode ratchet \
    --baseline site/reading-level-baseline.json --format gh-annotations \
    about.html api.html changelog.html data.html index.html stats.html standards.html

Implementation lives in civic_content_gates.reading_level; this path is the stable
house entrypoint next to the other standards gates.
"""
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_PKG = _REPO / "civic-content-gates"
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from civic_content_gates.reading_level import main  # noqa: E402

if __name__ == "__main__":
    # Default --root to site/ so `python3 test/standards/reading_level.py --max-grade 7 about.html`
    # works from the repo root without an extra flag.
    argv = sys.argv[1:]
    if "--root" not in argv:
        argv = ["--root", str(_REPO / "site"), *argv]
    raise SystemExit(main(argv))
