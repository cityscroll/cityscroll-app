"""Regression proof: capture_walks does not hang when FINANCE leaves the window.

tools/capture_committee_shared_members_evidence.py reads the committee graph's
shared-membership data back from the committed read models it is built from.
Legislative committee rosters are a rolling publisher window: capture_positive's
NAMED_CONNECTIONS loop and capture_reciprocal both check whether a committee's
row is still present before opening it, and treat its absence as a signal rather
than a failure. capture_walks did not have that check before this fix -- it
clicked the FINANCE committee's open link unconditionally, so once a refresh
stopped connecting FINANCE to the subcommittee the click had nothing to find
and Playwright's Page.click hung for the full default timeout, which is exactly
what failed the scheduled dataset refresh's "Rebuild the committed read models"
step (cityscroll/cityscroll-app#2728).
"""

import pathlib
import sys
import types
import unittest


class FakePlaywrightTimeoutError(Exception):
    pass


playwright = types.ModuleType("playwright")
sync_api = types.ModuleType("playwright.sync_api")
sync_api.sync_playwright = lambda: None
sync_api.TimeoutError = FakePlaywrightTimeoutError
sys.modules["playwright"] = playwright
sys.modules["playwright.sync_api"] = sync_api

TOOLS = pathlib.Path(__file__).resolve().parents[2] / "tools"
sys.path.insert(0, str(TOOLS))
from capture_committee_shared_members_evidence import FINANCE, capture_walks  # noqa: E402


class ClickReached(Exception):
    """Raised by FakePage.click so a test can prove a click was attempted."""


class FakePage:
    def __init__(self, *, raise_on_click=False):
        self.raise_on_click = raise_on_click
        self.goto_calls = []
        self.click_calls = []
        self.closed = False

    def goto(self, url, wait_until=None):
        self.goto_calls.append((url, wait_until))

    def click(self, selector):
        self.click_calls.append(selector)
        if self.raise_on_click:
            raise ClickReached(selector)

    def evaluate(self, *args, **kwargs):
        raise AssertionError("evaluate should not run once click is reached in this test")

    def wait_for_url(self, *args, **kwargs):
        raise AssertionError("wait_for_url should not run once click is reached in this test")

    def close(self):
        self.closed = True


class FakeBrowser:
    def __init__(self, page):
        self._page = page

    def new_page(self, viewport=None):
        return self._page


class FakeRun:
    def __init__(self):
        self.signals = []

    def signal(self, message):
        self.signals.append(message)


FINANCE_FIXTURE_ROW = {"committee_id": FINANCE, "people": ["placeholder"], "overlaps": []}


class CaptureWalksWindowTest(unittest.TestCase):
    def test_skips_and_signals_when_finance_has_left_the_window(self):
        landmarks_expect = {"as_of": "2026-11-04", "rows": [{"committee_id": "19"}]}
        run = FakeRun()
        page = FakePage(raise_on_click=True)
        capture_walks(FakeBrowser(page), "http://example.test/", run, landmarks_expect, {"committee_count": 1})

        self.assertEqual(page.click_calls, [], "a committee no longer in the window must not be clicked")
        self.assertTrue(page.closed)
        self.assertEqual(len(run.signals), 1)
        self.assertIn(FINANCE, run.signals[0])

    def test_still_opens_the_walk_when_finance_is_in_the_window(self):
        landmarks_expect = {"as_of": "2026-11-04", "rows": [FINANCE_FIXTURE_ROW]}
        run = FakeRun()
        page = FakePage(raise_on_click=True)
        with self.assertRaises(ClickReached):
            capture_walks(FakeBrowser(page), "http://example.test/", run, landmarks_expect, {"committee_count": 1})

        self.assertEqual(len(page.click_calls), 1)
        self.assertIn(f"committee-shared-membership-{FINANCE}", page.click_calls[0])
        self.assertEqual(run.signals, [])


if __name__ == "__main__":
    unittest.main()
