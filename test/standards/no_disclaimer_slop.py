#!/usr/bin/env python3
"""Stable repository entrypoint for the positive plain-language copy gate."""
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_PKG = _REPO / "civic-content-gates"
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from civic_content_gates.disclaimer_slop import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main(
        site_root=_REPO / "site",
        allowlist_file=Path(__file__).with_name("no_disclaimer_slop_allowlist.txt"),
    ))
