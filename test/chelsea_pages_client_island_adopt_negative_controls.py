#!/usr/bin/env python3
"""Hermetic negatives for Pages-client island-adopt evaluator.

Focused no-op (Chelsea stuck) and full-document (marker died) shapes must
fail. A complete adopt shape must pass. EXIT0 here does not substitute for
a live production island-adopt cycle.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

repo = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
sys.path.insert(0, str(repo / "tools"))

from capture_chelsea_served_surface_production_read import (  # noqa: E402
    classify_pages_client_adopt_settle,
    evaluate_pages_client_island_adopt_result,
)


def _phase(
    *,
    adopted: bool,
    marker_survived: bool,
    marker_died_full_document: bool = False,
    target_geo_rendered: bool = False,
    root_replaced: bool = False,
    fetch_ok: bool = False,
    skipped: bool = False,
    phase: str = "island-away",
    rendered_geo: str = "nta2020:MN0401",
) -> dict:
    return {
        "phase": phase,
        "adopted": adopted,
        "skipped": skipped,
        "marker_survived": marker_survived,
        "marker_died_full_document": marker_died_full_document,
        "target_geo_rendered": target_geo_rendered,
        "rendered_geo": rendered_geo,
        "root_replacement": {"root_replaced": root_replaced},
        "html_fetch": {"fetch_ok": fetch_ok},
    }


controls: list[str] = []

# --- no-op: click left Chelsea geo unchanged; no fetch / root replacement ---
noop = evaluate_pages_client_island_adopt_result(
    {
        "island_adopt_proven": False,
        "away": _phase(
            adopted=False,
            marker_survived=True,
            target_geo_rendered=False,
            root_replaced=False,
            fetch_ok=False,
            rendered_geo="nta2020:MN0401",
        ),
        "back": _phase(
            adopted=False,
            marker_survived=True,
            skipped=True,
            phase="history-back-chelsea",
        ),
    }
)
assert noop["check_result"] == "fail", noop
assert "away-adopted" in noop["missing_steps"], noop
assert noop["island_adopt_proven"] is False
controls.append("noop-chelsea-stuck")

# --- full-document: marker died on away (document navigation, not adoptDocument) ---
full_doc = evaluate_pages_client_island_adopt_result(
    {
        "island_adopt_proven": False,
        "away": _phase(
            adopted=False,
            marker_survived=False,
            marker_died_full_document=True,
            target_geo_rendered=True,
            root_replaced=True,
            fetch_ok=False,
            rendered_geo="community_district:M04",
        ),
        "back": _phase(
            adopted=False,
            marker_survived=False,
            marker_died_full_document=True,
            target_geo_rendered=True,
            root_replaced=True,
            fetch_ok=False,
            phase="history-back-chelsea",
            rendered_geo="nta2020:MN0401",
        ),
    }
)
assert full_doc["check_result"] == "fail", full_doc
assert "away-full-document" in full_doc["missing_steps"], full_doc
assert "away-marker" in full_doc["missing_steps"], full_doc
assert full_doc["island_adopt_proven"] is False
controls.append("full-document-marker-died")

# --- pushState-only / incomplete: marker + geo, missing fetch and root replace ---
push_only = evaluate_pages_client_island_adopt_result(
    {
        "island_adopt_proven": True,  # falsely claimed; evaluator must still fail
        "away": _phase(
            adopted=True,
            marker_survived=True,
            target_geo_rendered=True,
            root_replaced=False,
            fetch_ok=False,
            rendered_geo="community_district:M04",
        ),
        "back": _phase(
            adopted=True,
            marker_survived=True,
            target_geo_rendered=True,
            root_replaced=False,
            fetch_ok=False,
            phase="history-back-chelsea",
            rendered_geo="nta2020:MN0401",
        ),
    }
)
assert push_only["check_result"] == "fail", push_only
assert "away-html-fetch" in push_only["missing_steps"], push_only
assert "away-root-replacement" in push_only["missing_steps"], push_only
assert push_only["island_adopt_proven"] is False
controls.append("pushstate-only-incomplete")

# --- complete adopt shape must pass ---
complete = evaluate_pages_client_island_adopt_result(
    {
        "island_adopt_proven": True,
        "away": _phase(
            adopted=True,
            marker_survived=True,
            target_geo_rendered=True,
            root_replaced=True,
            fetch_ok=True,
            rendered_geo="community_district:M04",
        ),
        "back": _phase(
            adopted=True,
            marker_survived=True,
            target_geo_rendered=True,
            root_replaced=True,
            fetch_ok=True,
            phase="history-back-chelsea",
            rendered_geo="nta2020:MN0401",
        ),
    }
)
assert complete["check_result"] == "pass", complete
assert complete["island_adopt_proven"] is True
assert complete["missing_steps"] == []
controls.append("complete-adopt-pass")

# --- classify: no-op settle (Chelsea stuck after click) ---
before = {
    "deferred_generation": "1",
    "sentinel_present": True,
    "level": "nta",
    "geo_param": "nta2020:MN0401",
}
after_noop = {
    "marker": {"id": "pc-test"},
    "geo_param": "nta2020:MN0401",
    "deferred_generation": "1",
    "sentinel_present": True,
    "level": "nta",
    "enhanced": "true",
    "in_page_near_you_fetches": [],
}
noop_settle = classify_pages_client_adopt_settle(
    before=before,
    after=after_noop,
    marker_id="pc-test",
    target_geo_substr="community_district:M04",
    phase="island-away",
)
assert noop_settle["adopted"] is False
assert noop_settle["marker_survived"] is True
assert noop_settle["target_geo_rendered"] is False
assert noop_settle["html_fetch"]["fetch_ok"] is False
assert noop_settle["root_replacement"]["root_replaced"] is False
controls.append("classify-noop-settle")

# --- classify: full-document settle (marker gone) ---
after_full = {
    "marker": None,
    "geo_param": "community_district:M04",
    "deferred_generation": "3",
    "sentinel_present": False,
    "level": "community_district",
    "enhanced": "true",
    "in_page_near_you_fetches": [],
}
full_settle = classify_pages_client_adopt_settle(
    before=before,
    after=after_full,
    marker_id="pc-test",
    target_geo_substr="community_district:M04",
    phase="island-away",
)
assert full_settle["adopted"] is False
assert full_settle["marker_died_full_document"] is True
assert full_settle["marker_survived"] is False
controls.append("classify-full-document-settle")

# --- classify: complete adopt settle ---
after_ok = {
    "marker": {"id": "pc-test"},
    "geo_param": "community_district:M04",
    "deferred_generation": "3",
    "sentinel_present": False,
    "level": "community_district",
    "enhanced": "true",
    "in_page_near_you_fetches": [
        {"url": "/near-you/?geo=community_district%3AM04", "at": 1000}
    ],
}
ok_settle = classify_pages_client_adopt_settle(
    before=before,
    after=after_ok,
    marker_id="pc-test",
    target_geo_substr="community_district:M04",
    phase="island-away",
    fetch_log_after_ms=500,
)
assert ok_settle["adopted"] is True, ok_settle
assert ok_settle["html_fetch"]["fetch_ok"] is True
assert ok_settle["root_replacement"]["root_replaced"] is True
controls.append("classify-complete-settle")

print(
    json.dumps(
        {
            "ok": True,
            "controls": controls,
            "evaluator": "evaluate_pages_client_island_adopt_result",
            "classifier": "classify_pages_client_adopt_settle",
        },
        sort_keys=True,
    )
)
