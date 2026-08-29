#!/usr/bin/env python3
"""Unit proof that the required land canary rejects a broken land page."""

import unittest

from capture_qr_share import LAND_CANARY_COPY, assert_land_page_rendered


class _Locator:
    def __init__(self, text: str = ""):
        self._text = text

    def wait_for(self, *, state: str) -> None:
        assert state == "visible"

    def inner_text(self) -> str:
        return self._text


class _Page:
    def __init__(self, text: str):
        self._text = text

    def locator(self, selector: str) -> _Locator:
        return _Locator(self._text if selector == "body" else "fixture copy")


class LandCanaryTest(unittest.TestCase):
    def test_fixture_backed_land_page_passes(self):
        text = " ".join(LAND_CANARY_COPY)
        assert_land_page_rendered(_Page(text))

    def test_missing_land_copy_fails(self):
        text = " ".join(LAND_CANARY_COPY[:-1])
        with self.assertRaisesRegex(AssertionError, "missing fixture copy"):
            assert_land_page_rendered(_Page(text))


if __name__ == "__main__":
    unittest.main()
