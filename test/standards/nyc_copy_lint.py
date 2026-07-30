#!/usr/bin/env python3
"""NYC Web Content Style Guide copy lint — thin wrapper over civic_content_gates.nyc_copy_lint.

The house allowlist remains beside this wrapper so existing CI paths and allowlist
edits stay in test/standards/.
"""
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_PKG = _REPO / "civic-content-gates"
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from civic_content_gates.nyc_copy_lint import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main(
        site_root=_REPO / "site",
        allowlist_file=Path(__file__).with_name("nyc_copy_lint_allowlist.txt"),
    ))
