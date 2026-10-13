#!/usr/bin/env python3
"""Negative controls for Chelsea keyboard-journey evaluators.

EXIT0 here is fine as a hermetic control but does NOT substitute
for a keyboard journey on the deployed Near You route.

Keyboard journey records place-link destination (map-first surface difference
is labeled, not a sole fail). Native browser shortcut is not required for this
journey. History API Back retention is a separate evaluator.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

repo = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
sys.path.insert(0, str(repo / "tools"))

from capture_chelsea_served_surface_production_read import (  # noqa: E402
    evaluate_history_back_return_result,
    evaluate_keyboard_journey_result,
    is_near_you_full_record_control,
    is_near_you_inspect_control,
    is_near_you_lens_control,
)

expected = "nta2020:MN0401"
controls: list[str] = []

assert (
    is_near_you_inspect_control(
        {
            "tag": "BUTTON",
            "role": "button",
            "text": "Use my location",
            "className": "geo-btn",
            "ariaLabel": "Use my location",
            "inspectUid": None,
            "isInspectControl": False,
        }
    )
    is False
), "unrelated button must not count as Inspect"
controls.append("reject-unrelated-inspect")

assert (
    is_near_you_inspect_control(
        {
            "tag": "BUTTON",
            "text": "Dewitt",
            "className": "near-record-inspect near-record-title",
            "ariaLabel": "Inspect: Dewitt Clinton Park North",
            "inspectUid": "2023M0213",
            "isInspectControl": True,
        }
    )
    is True
), "observed Inspect control must match"
controls.append("accept-inspect-control")

assert is_near_you_lens_control(
    {
        "href": "/near-you/?geo=nta2020%3AMN0401&lens=land&surface=records",
        "tag": "A",
    }
), "lens control"
assert is_near_you_full_record_control(
    {
        "tag": "A",
        "href": "/browse/zoning/#land/2023M0213",
        "className": "near-record-full-record",
    }
), "full-record control"
controls.append("accept-lens-and-full-record")

base = {
    "category_transition_observed": True,
    "inspect_control_focused": True,
    "inspect_dialog_opened": True,
    "inspect_dialog_named_title": True,
    "inspect_dialog_closed": True,
    "inspect_focus_restored": True,
    "full_record_opened": True,
    "settled_named_record": {"settled": True, "named_heading": "Dewitt"},
    "back_completed": True,
    "back_return_method": "place-link",
    "browser_back_keyboard_status": "playwright-chromium-no-keyboard-history-nav",
    "end_geo": expected,
    "used_non_keyboard_navigation": False,
    "requested_return_state": {"geo": expected, "lens": "land", "surface": "records"},
    "place_link_destination": {
        "recorded": True,
        "method": "place-link",
        "geo": expected,
        "lens": "land",
        "surface": "map",
        "url": "https://cityscroll.org/near-you/?lens=land&geo=nta2020%3AMN0401",
    },
    "return_state": {
        "geo": expected,
        "lens": "land",
        "surface": "map",
        "url": "https://cityscroll.org/near-you/?lens=land&geo=nta2020%3AMN0401",
    },
}
verdict = evaluate_keyboard_journey_result(base, expected_geo=expected)
assert verdict["check_result"] == "pass", verdict
assert verdict.get("place_link_surface_difference") is not None
assert verdict["place_link_surface_difference"]["returned_surface"] == "map"
assert verdict["native_browser_shortcut"]["required"] is False
assert verdict["native_browser_shortcut"]["claimed"] is False
controls.append("place-link-map-first-passes-with-surface-difference")

# Native shortcut NO_NAV alone must not fail when place-link destination is recorded.
native_only = dict(base)
native_only["browser_back_keyboard_status"] = "playwright-chromium-no-keyboard-history-nav"
verdict = evaluate_keyboard_journey_result(native_only, expected_geo=expected)
assert verdict["check_result"] == "pass", verdict
assert "back-completed" not in verdict["missing_steps"]
controls.append("native-shortcut-no-nav-not-sole-fail")

for key, missing in [
    ("inspect_dialog_opened", "inspect-dialog-opened"),
    ("inspect_dialog_closed", "inspect-dialog-closed"),
    ("inspect_focus_restored", "inspect-focus-restored"),
    ("full_record_opened", "full-record-opened"),
]:
    mutant = dict(base)
    mutant[key] = False
    verdict = evaluate_keyboard_journey_result(mutant, expected_geo=expected)
    assert verdict["check_result"] == "fail", key
    assert missing in verdict["missing_steps"], (key, verdict["missing_steps"])
controls.append("missing-keyboard-steps-fail")

wrong = dict(base, end_geo="nta2020:MN0402")
wrong["place_link_destination"] = dict(base["place_link_destination"], geo="nta2020:MN0402")
verdict = evaluate_keyboard_journey_result(wrong, expected_geo=expected)
assert verdict["check_result"] == "fail"
assert "place-link-geo" in verdict["missing_steps"] or "restored-chelsea-geo" in verdict["missing_steps"]
controls.append("wrong-geo-fails")

# Missing place-link destination fails keyboard journey.
no_place = dict(base)
no_place["place_link_destination"] = {"recorded": False}
no_place["back_return_method"] = "none"
no_place["back_completed"] = False
verdict = evaluate_keyboard_journey_result(no_place, expected_geo=expected)
assert verdict["check_result"] == "fail"
assert "place-link-destination-recorded" in verdict["missing_steps"]
controls.append("missing-place-link-destination-fails")

attempt = {
    "category_transition_observed": True,
    "inspect_control_focused": True,
    "inspect_dialog_opened": False,
    "inspect_dialog_named_title": False,
    "inspect_dialog_closed": False,
    "inspect_focus_restored": False,
    "full_record_opened": False,
    "settled_named_record": None,
    "back_completed": False,
    "end_geo": None,
    "used_non_keyboard_navigation": False,
    "place_link_destination": {"recorded": False},
}
verdict = evaluate_keyboard_journey_result(attempt, expected_geo=expected)
assert verdict["check_result"] == "fail"
assert "inspect-dialog-opened" in verdict["missing_steps"]
assert "full-record-opened" in verdict["missing_steps"]
assert "place-link-destination-recorded" in verdict["missing_steps"]
controls.append("incomplete-attempt-fails")

non_kb = dict(base, used_non_keyboard_navigation=True)
verdict = evaluate_keyboard_journey_result(non_kb, expected_geo=expected)
assert verdict["check_result"] == "fail"
assert "keyboard-only-violated" in verdict["missing_steps"]
controls.append("non-keyboard-violates")

# History API Back evaluator: full retention required.
history_ok = {
    "method": "page.go_back",
    "history_back_completed": True,
    "end_geo": expected,
    "requested_return_state": {"geo": expected, "lens": "land", "surface": "records"},
    "return_state": {
        "geo": expected,
        "lens": "land",
        "surface": "records",
        "url": "https://cityscroll.org/near-you/?geo=nta2020%3AMN0401&lens=land&surface=records",
    },
}
verdict = evaluate_history_back_return_result(history_ok, expected_geo=expected)
assert verdict["check_result"] == "pass", verdict
assert verdict["not_keyboard_evidence"] is True
controls.append("history-back-full-retention-pass")

history_map = dict(history_ok)
history_map["return_state"] = {
    "geo": expected,
    "lens": "land",
    "surface": "map",
    "url": "https://cityscroll.org/near-you/?geo=nta2020%3AMN0401&lens=land",
}
verdict = evaluate_history_back_return_result(history_map, expected_geo=expected)
assert verdict["check_result"] == "fail"
assert "retained-requested-surface" in verdict["missing_steps"]
controls.append("history-back-surface-gap-fails")

history_missing = {
    "method": "page.go_back",
    "history_back_completed": False,
    "end_geo": None,
    "requested_return_state": {"geo": expected, "lens": "land", "surface": "records"},
    "return_state": None,
}
verdict = evaluate_history_back_return_result(history_missing, expected_geo=expected)
assert verdict["check_result"] == "fail"
assert "history-back-completed" in verdict["missing_steps"]
controls.append("history-back-incomplete-fails")

print(json.dumps({"ok": True, "controls": controls}, sort_keys=True))
