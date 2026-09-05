"""Regression proof: a missing panel is a named precondition, never a TypeError.

The contract-detail panel is repainted asynchronously by the Contracts route. When
a layout fixture installed into it is replaced -- or when the shell is not on the
page the check opened at all -- the failure has to say which precondition went
missing and at which URL. Before this boundary existed, the same situation reached
CI as `TypeError: Cannot read properties of null (reading 'scrollWidth')` or as a
bounded visibility wait expiring, both of which read as mobile-layout failures.
"""

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
from detail_panel_fixture import (  # noqa: E402
    DetailPanelPrecondition,
    attachment_fixture_state,
    require_attachment_fixture,
    require_measured_fixture,
    wait_for_detail_panel_settled,
)


SHELL_URL = "http://127.0.0.1:45437/#money"


class ScriptedPage:
    """A page whose evaluate() answers from a queue of prepared observations."""

    def __init__(self, *observations):
        self.observations = list(observations)
        self.calls = []
        self.wait_calls = []
        self.wait_timeout = False

    def evaluate(self, expression, arg=None):
        self.calls.append((expression, arg))
        return self.observations.pop(0) if self.observations else None

    def wait_for_function(self, expression, *, arg, timeout):
        self.wait_calls.append((expression, arg, timeout))
        if self.wait_timeout:
            raise FakePlaywrightTimeoutError("panel never settled")


class SettleWaitTest(unittest.TestCase):
    def test_absent_shell_is_named_before_any_wait_is_attempted(self):
        page = ScriptedPage(
            {
                "observing": False,
                "reason": "panel-absent",
                "selector": "#detail",
                "url": SHELL_URL,
                "title": "CityScroll",
                "ready_state": "complete",
            }
        )
        with self.assertRaises(DetailPanelPrecondition) as raised:
            wait_for_detail_panel_settled(page)
        message = str(raised.exception)
        self.assertIn("PRECONDITION UNMET", message)
        self.assertIn("#detail", message)
        self.assertIn("is not on the page", message)
        self.assertIn(SHELL_URL, message)
        self.assertIn("panel-absent", message)
        self.assertEqual(page.wait_calls, [])

    def test_panel_that_never_stops_repainting_is_named_with_its_observation(self):
        page = ScriptedPage(
            {"observing": True, "selector": "#detail", "url": SHELL_URL, "title": "CityScroll"},
            {
                "selector": "#detail",
                "url": SHELL_URL,
                "title": "CityScroll",
                "ready_state": "complete",
                "panel_present": True,
                "child_element_count": 9,
                "mutations": 41,
                "quiet_for_ms": 12,
                "observed_for_ms": 30_000,
            },
            None,
        )
        page.wait_timeout = True
        with self.assertRaises(DetailPanelPrecondition) as raised:
            wait_for_detail_panel_settled(page, quiet_ms=1_500, timeout_ms=30_000)
        message = str(raised.exception)
        self.assertIn("never settled", message)
        self.assertIn('"mutations": 41', message)
        self.assertIn('"quiet_window_ms": 1500', message)
        self.assertIn('"settle_timeout_ms": 30000', message)

    def test_the_wait_is_bounded_by_the_caller_not_by_a_timer_in_the_page(self):
        page = ScriptedPage(
            {"observing": True, "selector": "#detail", "url": SHELL_URL, "title": "CityScroll"},
            None,
        )
        wait_for_detail_panel_settled(page, quiet_ms=1_500, timeout_ms=20_000)
        self.assertEqual(len(page.wait_calls), 1)
        _expression, arg, timeout = page.wait_calls[0]
        self.assertEqual(arg, {"selector": "#detail", "quietMs": 1_500})
        self.assertEqual(timeout, 20_000)

    def test_the_observer_is_disconnected_on_both_paths(self):
        settled = ScriptedPage(
            {"observing": True, "selector": "#detail", "url": SHELL_URL, "title": "CityScroll"},
            None,
        )
        wait_for_detail_panel_settled(settled)
        self.assertIn("__detailPanelWatch", settled.calls[-1][0])
        self.assertIn("disconnect", settled.calls[-1][0])

        timed_out = ScriptedPage(
            {"observing": True, "selector": "#detail", "url": SHELL_URL, "title": "CityScroll"},
            {"url": SHELL_URL, "panel_present": True, "mutations": 3},
            None,
        )
        timed_out.wait_timeout = True
        with self.assertRaises(DetailPanelPrecondition):
            wait_for_detail_panel_settled(timed_out)
        self.assertIn("disconnect", timed_out.calls[-1][0])


class MeasurementPreconditionTest(unittest.TestCase):
    def test_unmeasurable_fixture_is_named_not_a_type_error(self):
        for reason in ("panel-absent", "fixture-markup-missing", "fixture-body-missing"):
            with self.subTest(reason=reason):
                with self.assertRaises(DetailPanelPrecondition) as raised:
                    require_measured_fixture(
                        {
                            "measured": False,
                            "reason": reason,
                            "url": SHELL_URL,
                            "title": "CityScroll",
                        }
                    )
                message = str(raised.exception)
                self.assertIn("PRECONDITION UNMET", message)
                self.assertIn("not measurable in #detail", message)
                self.assertIn(reason, message)
                self.assertIn(SHELL_URL, message)
                self.assertNotIn("TypeError", message)

    def test_measured_fixture_returns_its_layout_metrics(self):
        outcome = {
            "measured": True,
            "url": SHELL_URL,
            "contained": True,
            "headHeight": 61.78125,
            "documentOverflow": 0,
        }
        self.assertEqual(require_measured_fixture(outcome), outcome)

    def test_replaced_fixture_is_reported_against_its_stage(self):
        page = ScriptedPage(
            {
                "url": SHELL_URL,
                "title": "CityScroll",
                "panel_present": True,
                "panel_child_elements": 9,
                "fixture_root_present": False,
                "fixture_body_present": False,
                "fixture_table_present": False,
                "fixture_inside_panel": False,
            }
        )
        with self.assertRaises(DetailPanelPrecondition) as raised:
            require_attachment_fixture(page, "immediately after installation")
        message = str(raised.exception)
        self.assertIn("was replaced inside #detail", message)
        self.assertIn("immediately after installation", message)

    def test_intact_fixture_passes_its_stage_check(self):
        observed = {
            "url": SHELL_URL,
            "title": "CityScroll",
            "panel_present": True,
            "panel_child_elements": 1,
            "fixture_root_present": True,
            "fixture_body_present": True,
            "fixture_table_present": True,
            "fixture_inside_panel": True,
        }
        page = ScriptedPage(observed)
        self.assertEqual(require_attachment_fixture(page, "after measurement"), observed)


class ObservationShapeTest(unittest.TestCase):
    def test_state_read_is_structural_and_carries_no_page_content(self):
        page = ScriptedPage({"url": SHELL_URL})
        attachment_fixture_state(page)
        expression, arg = page.calls[0]
        self.assertNotIn("innerHTML", expression)
        self.assertNotIn("textContent", expression)
        self.assertEqual(
            arg,
            {
                "panelSelector": "#detail",
                "rootSelector": ".attachment-tables",
                "bodySelector": ".attachment-tables-body",
                "tableSelector": "table.attachment-table",
            },
        )


if __name__ == "__main__":
    unittest.main()
