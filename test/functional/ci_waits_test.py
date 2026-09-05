"""Focused regression proof for route-state timeout diagnostics."""

import contextlib
import io
import json
import pathlib
import sys
import types
import unittest


class FakePlaywrightTimeoutError(Exception):
    pass


playwright = types.ModuleType("playwright")
sync_api = types.ModuleType("playwright.sync_api")
sync_api.Locator = object
sync_api.Page = object
sync_api.TimeoutError = FakePlaywrightTimeoutError
sys.modules["playwright"] = playwright
sys.modules["playwright.sync_api"] = sync_api

ASSETS = pathlib.Path(__file__).parent / "assets"
sys.path.insert(0, str(ASSETS))
from ci_waits import (  # noqa: E402
    ROUTE_STATE_DEFAULTS,
    wait_for_app_ready,
    wait_for_locator,
    wait_for_route_state,
)


class TimedOutPage:
    def __init__(self):
        self.wait_arguments = None
        self.snapshot_arguments = None

    def wait_for_function(self, expression, *, arg, timeout):
        self.wait_arguments = (expression, arg, timeout)
        raise FakePlaywrightTimeoutError("route did not settle")

    def evaluate(self, expression, arg):
        self.snapshot_arguments = (expression, arg)
        return {
            "pathname": "/browse/contracts/",
            "search": "",
            "hash": "",
            "document_ready_state": "complete",
            "active_pane_id": "tab-money",
            "expected_pane_active": False,
            "expected_heading_connected": True,
            "expected_heading_id": "career-browser-heading",
            "expected_heading_class": "lens-entry-heading",
            "expected_heading_focused": False,
            "active_element_id": "tab-money-button",
            "active_element_class": "tabbtn active",
            "route_module_ready": True,
        }


class ReadyPage:
    def __init__(self):
        self.expression = None

    def wait_for_function(self, expression, *, arg, timeout):
        self.expression = expression
        self.arguments = (arg, timeout)


class RouteStateReceiptTest(unittest.TestCase):
    def test_app_readiness_waits_for_the_completed_boot_barrier(self):
        page = ReadyPage()

        wait_for_app_ready(page, timeout=321)

        self.assertIn('document.body?.dataset.appReady === "true"', page.expression)
        self.assertEqual(page.arguments, (None, 321))

    def test_timeout_emits_bounded_metadata_then_reraises(self):
        page = TimedOutPage()
        output = io.StringIO()

        with contextlib.redirect_stdout(output):
            with self.assertRaisesRegex(FakePlaywrightTimeoutError, "did not settle"):
                wait_for_route_state(
                    page,
                    "/browse/staffing/",
                    tab="people",
                    require_focus=True,
                    timeout=123,
                    label="people settled route",
                )

        line = output.getvalue().strip()
        self.assertTrue(line.startswith("ROUTE_STATE_TIMEOUT "))
        receipt = json.loads(line.removeprefix("ROUTE_STATE_TIMEOUT "))
        self.assertEqual(receipt["event"], "route_state_timeout")
        self.assertEqual(receipt["label"], "people settled route")
        self.assertEqual(
            receipt["expected"],
            {"pathname": "/browse/staffing/", "tab": "people", "require_focus": True},
        )
        self.assertEqual(set(receipt["actual"]), set(ROUTE_STATE_DEFAULTS))
        self.assertEqual(receipt["actual"]["pathname"], "/browse/contracts/")
        self.assertEqual(receipt["actual"]["active_element_id"], "tab-money-button")
        self.assertIsNone(receipt["snapshot_error"])
        self.assertNotIn("textContent", line)
        self.assertNotIn("innerHTML", line)

        self.assertEqual(page.wait_arguments[1]["expectedPath"], "/browse/staffing/")
        self.assertEqual(page.wait_arguments[2], 123)
        self.assertEqual(page.snapshot_arguments[1]["tab"], "people")


class AlwaysTimingOutLocator:
    def __init__(self):
        self.attempts = 0

    def wait_for(self, *, state, timeout):
        self.attempts += 1
        raise FakePlaywrightTimeoutError("locator never became visible")


class ExhaustedRetryLabelTest(unittest.TestCase):
    """A wait that expires on every attempt is not transient, and says so."""

    def test_exhausted_retry_withdraws_the_transient_reading(self):
        locator = AlwaysTimingOutLocator()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            with self.assertRaises(FakePlaywrightTimeoutError):
                wait_for_locator(locator, timeout=5, attempts=2, label="attachment table")

        lines = output.getvalue().strip().splitlines()
        self.assertEqual(locator.attempts, 2)
        self.assertTrue(lines[0].startswith("TRANSIENT wait timeout for attachment table"))
        self.assertTrue(lines[-1].startswith("DETERMINISTIC wait failure for attachment table"))
        self.assertIn("did not hold", lines[-1])

    def test_single_attempt_wait_never_claims_a_retry_verdict(self):
        locator = AlwaysTimingOutLocator()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            with self.assertRaises(FakePlaywrightTimeoutError):
                wait_for_locator(locator, timeout=5, attempts=1, label="attachment table")

        self.assertEqual(locator.attempts, 1)
        self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
