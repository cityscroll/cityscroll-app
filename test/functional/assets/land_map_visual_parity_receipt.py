"""Compare a freshly measured LM-13 receipt against the committed one.

Split out from 51_land_map_visual_parity_fixtures.py so this logic -- the part
that decides whether the committed evidence still describes what a run just
measured -- can be unit-tested without a browser. See that script's module
docstring for the run-local/committed-receipt contract this implements.
"""

from __future__ import annotations

import copy
import difflib
import json


def normalize_receipt(receipt: dict) -> dict:
    """Strip fields that vary run to run without describing a behavior change.

    app_commit names whatever HEAD a run happened to measure at -- comparing it would
    fail the gate on every push regardless of whether anything the fixtures assert about
    moved. Each screenshot's byte count and sha256 vary with font hinting and rendering
    timing even for a pixel-identical capture, and the raw document-wide `overflow`
    reading is a known pre-existing measurement (see panel_no_overflow's docstring in the
    functional test) that nothing here asserts against directly.
    """
    normalized = copy.deepcopy(receipt)
    normalized.get("provenance", {}).pop("app_commit", None)
    for fixture in normalized.get("fixtures", []):
        for file_entry in fixture.get("files", []):
            file_entry.pop("bytes", None)
            file_entry.pop("sha256", None)
        for reading in fixture.get("readings", {}).values():
            reading.get("state", {}).pop("overflow", None)
    return normalized


def diff_receipts(committed: dict, fresh: dict, *, committed_label: str, fresh_label: str) -> str:
    committed_lines = json.dumps(normalize_receipt(committed), indent=2, sort_keys=True).splitlines()
    fresh_lines = json.dumps(normalize_receipt(fresh), indent=2, sort_keys=True).splitlines()
    return "\n".join(
        difflib.unified_diff(
            committed_lines,
            fresh_lines,
            fromfile=committed_label,
            tofile=fresh_label,
            lineterm="",
        )
    )
