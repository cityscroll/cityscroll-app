"""Shared fail-closed browser setup for retained journeys."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

try:
    from playwright.sync_api import Browser, sync_playwright
except ImportError as exc:  # pragma: no cover - exercised by the prerequisite guard
    raise RuntimeError(
        "Browser journey cannot run: Python Playwright is unavailable. "
        "Install the repository-pinned browser environment before running this journey."
    ) from exc


@contextmanager
def launched_chromium() -> Iterator[Browser]:
    """Launch Chromium or fail with a diagnosis instead of silently skipping."""

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch(headless=True)
        except Exception as exc:  # pragma: no cover - depends on host browser state
            raise RuntimeError(
                "Browser journey cannot run: Playwright Chromium could not launch. "
                "Install the repository-pinned browser and system dependencies, then retry."
            ) from exc
        try:
            yield browser
        finally:
            browser.close()
