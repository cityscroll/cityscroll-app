#!/usr/bin/env python3
"""Negative controls for Chelsea scoped failed-detail + diagnostic evaluators.

Root correction: Live scoped failed-detail recovery must be production-answered (continue-redirect to a
nonexistent meeting id). Fulfill with authored or replayed body never passes live scoped failed-detail recovery.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

repo = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
sys.path.insert(0, str(repo / "tools"))

from capture_chelsea_served_surface_production_read import (  # noqa: E402
    evaluate_abort_retained_page_diagnostic,
    evaluate_scoped_failed_detail_result,
    intercept_matches_exact_target,
)

SOURCE = "https://cityscroll.org/near-you/?geo=nta2020%3AMN0401&lens=meetings&surface=records"
FAILED = "https://cityscroll.org/meetings/meeting%3Aexample/"
NONEXISTENT = (
    "https://cityscroll.org/meetings/meeting%3Acapture-probe-missing-chelsea-scoped/"
)


def _pass_shape(**overrides):
    base = {
        "failure_injection": {
            "method": "playwright-route-continue-redirect-nonexistent",
            "injected_status": 404,
            "expected_production_status": 404,
            "target_href": "/meetings/meeting%3Aexample/",
            "target_abs_href": FAILED,
            "expected_resource_type": "document",
            "continued_to_url": NONEXISTENT,
            "nonexistent_meeting_url": NONEXISTENT,
            "intercepted_requests": [
                {
                    "url": FAILED,
                    "resource_type": "document",
                    "method": "GET",
                    "continued_to_url": NONEXISTENT,
                    "production_status": 404,
                    "status": 404,
                }
            ],
            "intercept_hit_count": 1,
        },
        "visible_product_control_activated": True,
        "control_was_invisible": False,
        "recovery_controls_invisible": False,
        "source_url": SOURCE,
        "failed_detail_url": NONEXISTENT,
        "url_actually_requested": NONEXISTENT,
        "production_response_status": 404,
        "recovery_controls": {
            "try_again_visible": True,
            "browse_meetings_visible": True,
            "from_production_response": True,
            "production_copy_marker": True,
        },
        "browser_back_outcome": {
            "from_url": NONEXISTENT,
            "restored_chelsea_geo": True,
            "restored_chelsea_surface": True,
            "returned_near_you": True,
            "restored_surface": True,
            "unrelated_history_accepted": False,
        },
        "return_control_outcome": {
            "method": "browser-back",
            "restored_chelsea_geo": True,
            "restored_chelsea_surface": True,
            "returned_near_you": True,
        },
    }
    base.update(overrides)
    return base


assert intercept_matches_exact_target(
    {"url": FAILED, "resource_type": "document"}, target_abs_href=FAILED
)

v = evaluate_scoped_failed_detail_result(_pass_shape())
assert v["check_result"] == "pass", v
assert v["satisfies_real_scoped_journey"] is True

# Authored / replay fulfill never live scoped failed-detail recovery
for method in (
    "playwright-route-fulfill-http-error",
    "playwright-route-fulfill-authored-html",
    "playwright-route-fulfill-replay-deployed-error",
):
    v = evaluate_scoped_failed_detail_result(
        _pass_shape(
            failure_injection={
                "method": method,
                "injected_status": 404,
                "expected_production_status": 404,
                "target_abs_href": FAILED,
                "expected_resource_type": "document",
                "continued_to_url": NONEXISTENT,
                "nonexistent_meeting_url": NONEXISTENT,
                "intercepted_requests": [
                    {
                        "url": FAILED,
                        "resource_type": "document",
                        "status": 404,
                        "production_status": 404,
                        "continued_to_url": NONEXISTENT,
                    }
                ],
                "intercept_hit_count": 1,
            }
        )
    )
    assert v["check_result"] == "fail", (method, v)
    assert "fulfill-body-is-not-production-answered-error" in v["missing_steps"], (method, v)
    assert "not-production-answered-via-continue-redirect" in v["missing_steps"], (method, v)

# Zero hits
v = evaluate_scoped_failed_detail_result(
    _pass_shape(
        failure_injection={
            "method": "playwright-route-continue-redirect-nonexistent",
            "injected_status": 404,
            "expected_production_status": 404,
            "target_abs_href": FAILED,
            "expected_resource_type": "document",
            "continued_to_url": NONEXISTENT,
            "nonexistent_meeting_url": NONEXISTENT,
            "intercepted_requests": [],
            "intercept_hit_count": 0,
        }
    )
)
assert "zero-intercepted-requests" in v["missing_steps"]

# Invisible recovery / not from production
v = evaluate_scoped_failed_detail_result(
    _pass_shape(
        recovery_controls={
            "try_again_visible": False,
            "browse_meetings_visible": False,
            "from_production_response": False,
        },
        recovery_controls_invisible=True,
    )
)
assert "try-again-not-visible" in v["missing_steps"]
assert "recovery-controls-not-from-production-response" in v["missing_steps"]

# Noop Chelsea
v = evaluate_scoped_failed_detail_result(
    _pass_shape(
        failed_detail_url=SOURCE,
        browser_back_outcome={"skipped": True, "restored_chelsea_geo": False},
        return_control_outcome={},
    )
)
assert "noop-stayed-on-chelsea-url" in v["missing_steps"]

# Abort diagnostic never live scoped failed-detail recovery
diag = evaluate_abort_retained_page_diagnostic(
    {
        "source_url": SOURCE,
        "after_url": SOURCE,
        "failure_injection": {
            "method": "playwright-route-abort",
            "target_abs_href": FAILED,
            "expected_resource_type": "document",
            "intercepted_requests": [
                {"url": FAILED, "resource_type": "document", "aborted": True, "abort_error": None}
            ],
            "intercept_hit_count": 1,
        },
    }
)
assert diag["check_result"] == "pass"
assert diag["satisfies_real_scoped_journey"] is False

print(
    json.dumps(
        {
            "ok": True,
            "controls": [
                "zero-intercept",
                "invisible-recovery-controls",
                "noop-stayed-on-chelsea-url",
                "fulfill-body-never-live-scoped",
                "requires-continue-redirect-production-answer",
                "abort-diagnostic-never-satisfies-live-scoped",
            ],
        }
    )
)
