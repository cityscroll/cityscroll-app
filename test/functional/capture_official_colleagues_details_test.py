"""Regression proof: official co-service capture opens collapsed details first.

tools/capture_official_colleagues.py walks from a subject profile to a named
colleague by Tab and Enter. The co-service section only ships the first few
colleagues in the initially visible list; the rest live inside a closed
``details.official-coservice-more``. After ordinary committee-graph refresh
churn, a preferred colleague can still qualify while landing past that visible
window. Tab then never reaches the link, Enter activates an unrelated control
(historically the Near You chrome), and wait_for_selector for
``[data-official-coservice]`` times out on the wrong page — the failure mode
from scheduled refresh run 42486717259.

reveal_colleague_if_needed must open that disclosure when the target link is
present but hidden, and refuse to continue when the link is absent entirely.
"""

from __future__ import annotations

import pathlib
import sys
import types
import unittest


playwright = types.ModuleType("playwright")
sync_api = types.ModuleType("playwright.sync_api")
sync_api.Page = object
sync_api.sync_playwright = lambda: None
sys.modules["playwright"] = playwright
sys.modules["playwright.sync_api"] = sync_api

TOOLS = pathlib.Path(__file__).resolve().parents[2] / "tools"
sys.path.insert(0, str(TOOLS))
from capture_official_colleagues import (  # noqa: E402
    COSERVICE_MORE,
    reveal_colleague_if_needed,
)


class FakeLocator:
    def __init__(self, *, count=0, visible=False, children=None):
        self._count = count
        self._visible = visible
        self._children = children or {}
        self.clicks = 0
        self.evaluate_calls = []

    def count(self):
        return self._count

    @property
    def first(self):
        return self

    def is_visible(self):
        return self._visible

    def click(self):
        self.clicks += 1
        self._visible = True

    def locator(self, selector):
        return self._children[selector]

    def evaluate(self, script):
        self.evaluate_calls.append(script)
        self._visible = True
        # Opening the parent details also reveals child targets that were
        # waiting on this disclosure.
        for child in self._children.values():
            child._visible = True


class FakePage:
    def __init__(self, locators):
        self.locators = locators
        self.locator_calls = []

    def locator(self, selector):
        self.locator_calls.append(selector)
        return self.locators[selector]


COLLEAGUE_ID = "7824"
COLLEAGUE_SELECTOR = (
    f'.official-coservice-colleague[data-coservice-official-id="{COLLEAGUE_ID}"] '
    '.official-coservice-official-link'
)


class RevealColleagueDetailsTest(unittest.TestCase):
    def test_opens_details_when_colleague_link_is_hidden(self):
        target = FakeLocator(count=1, visible=False)
        summary = FakeLocator(count=1, visible=True)
        disclosure = FakeLocator(count=1, visible=True, children={"summary": summary})
        # Clicking the summary reveals the target the same way a real <details>
        # open would; mirror that in the fake by tying the click to visibility.
        original_click = summary.click

        def open_details():
            original_click()
            target._visible = True

        summary.click = open_details
        page = FakePage({
            COLLEAGUE_SELECTOR: target,
            COSERVICE_MORE: disclosure,
        })

        returned = reveal_colleague_if_needed(page, COLLEAGUE_ID)

        self.assertIs(returned, target)
        self.assertEqual(summary.clicks, 1)
        self.assertTrue(target.is_visible())
        self.assertEqual(
            page.locator_calls,
            [COLLEAGUE_SELECTOR, COSERVICE_MORE],
        )

    def test_skips_details_when_colleague_link_is_already_visible(self):
        target = FakeLocator(count=1, visible=True)
        disclosure = FakeLocator(count=1, visible=True)
        page = FakePage({
            COLLEAGUE_SELECTOR: target,
            COSERVICE_MORE: disclosure,
        })

        returned = reveal_colleague_if_needed(page, COLLEAGUE_ID)

        self.assertIs(returned, target)
        self.assertEqual(disclosure.clicks, 0)
        self.assertEqual(page.locator_calls, [COLLEAGUE_SELECTOR])

    def test_raises_when_colleague_link_is_absent(self):
        target = FakeLocator(count=0, visible=False)
        page = FakePage({COLLEAGUE_SELECTOR: target})

        with self.assertRaisesRegex(RuntimeError, "is not in the rendered section"):
            reveal_colleague_if_needed(page, COLLEAGUE_ID)

    def test_raises_when_hidden_without_details_disclosure(self):
        target = FakeLocator(count=1, visible=False)
        disclosure = FakeLocator(count=0, visible=False)
        page = FakePage({
            COLLEAGUE_SELECTOR: target,
            COSERVICE_MORE: disclosure,
        })

        with self.assertRaisesRegex(RuntimeError, "no details.official-coservice-more"):
            reveal_colleague_if_needed(page, COLLEAGUE_ID)


if __name__ == "__main__":
    raise SystemExit(unittest.main())
