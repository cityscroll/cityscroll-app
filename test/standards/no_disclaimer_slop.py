#!/usr/bin/env python3
"""Stable repository entrypoint for the positive plain-language copy gate.

Patterns live in civic_content_gates.disclaimer_slop. They include a
provenance-restatement class for copy that repeats what per-link markers
already say (City Record awards, Checkbook live-on, timeline-lead search).
Do not allowlist that class — put the source on the link and drop the wall.

This wrapper also adds product-specific search patterns for standing coverage
self-deprecation, per-collection debug breakdowns, and implementation labels.
"""
import re
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_PKG = _REPO / "civic-content-gates"
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from civic_content_gates import disclaimer_slop  # noqa: E402


# Repository-calibrated patterns extend the shared gate with product-specific
# regressions that previously rendered on every search, regardless of query.
disclaimer_slop.PATTERNS += (
    disclaimer_slop.Pattern(
        "standing_coverage_self_deprecation",
        "standing coverage self-deprecation",
        re.compile(
            r"\b(?:search\s+)?coverage\s+is\s+incomplete\b|"
            r"\bresults\s+may\s+be\s+incomplete\b",
            re.IGNORECASE,
        ),
    ),
    disclaimer_slop.Pattern(
        "collection_coverage_debug_breakdown",
        "per-collection coverage debug breakdown",
        re.compile(r"\bcoverage\s+by\s+collection\b", re.IGNORECASE),
    ),
    disclaimer_slop.Pattern(
        "search_implementation_label",
        "search implementation label",
        re.compile(
            r"\bkeyword\s+fallback\b|\bhow\s+results\s+match\b|"
            r"\bgenerated_in_memory\b",
            re.IGNORECASE,
        ),
    ),
    disclaimer_slop.Pattern(
        "provisional_destination_disclaimer",
        "provisional destination disclaimer",
        re.compile(
            r"\b(?:provisional:\s*)?destination not verified\b",
            re.IGNORECASE,
        ),
    ),
)


if __name__ == "__main__":
    raise SystemExit(disclaimer_slop.main(
        site_root=_REPO / "site",
        allowlist_file=Path(__file__).with_name("no_disclaimer_slop_allowlist.txt"),
    ))
