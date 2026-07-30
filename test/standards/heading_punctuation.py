#!/usr/bin/env python3
"""Heading-punctuation lint — thin wrapper over civic_content_gates.heading_punctuation."""
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_PKG = _REPO / "civic-content-gates"
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from civic_content_gates.heading_punctuation import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main(site_root=_REPO / "site"))
