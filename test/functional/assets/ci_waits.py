"""Bounded Playwright waits for CI-only browser scheduling variance."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from playwright.sync_api import Locator, Page, TimeoutError as PlaywrightTimeoutError


DEFAULT_WAIT_TIMEOUT_MS = 45_000
DEFAULT_WAIT_ATTEMPTS = 2


def _retry_message(label: str, attempt: int, attempts: int) -> None:
    print(
        f"TRANSIENT wait timeout for {label}; retrying "
        f"(attempt {attempt + 1}/{attempts})",
        flush=True,
    )


def _retry(
    operation: Callable[[], Any],
    *,
    label: str,
    attempts: int,
) -> Any:
    if attempts < 1:
        raise ValueError("attempts must be at least 1")
    for attempt in range(attempts):
        try:
            return operation()
        except PlaywrightTimeoutError:
            if attempt + 1 >= attempts:
                raise
            _retry_message(label, attempt, attempts)
    raise AssertionError("unreachable retry loop")


def wait_for_function(
    page: Page,
    expression: str | Callable,
    *,
    arg: Any = None,
    timeout: int = DEFAULT_WAIT_TIMEOUT_MS,
    attempts: int = DEFAULT_WAIT_ATTEMPTS,
    label: str = "page condition",
) -> Any:
    return _retry(
        lambda: page.wait_for_function(expression, arg=arg, timeout=timeout),
        label=label,
        attempts=attempts,
    )


def wait_for_locator(
    locator: Locator,
    *,
    state: str = "visible",
    timeout: int = DEFAULT_WAIT_TIMEOUT_MS,
    attempts: int = DEFAULT_WAIT_ATTEMPTS,
    label: str = "locator",
) -> None:
    _retry(
        lambda: locator.wait_for(state=state, timeout=timeout),
        label=label,
        attempts=attempts,
    )


def wait_for_url(
    page: Page,
    url: str,
    *,
    wait_until: str | None = None,
    timeout: int = DEFAULT_WAIT_TIMEOUT_MS,
    attempts: int = DEFAULT_WAIT_ATTEMPTS,
    label: str = "navigation",
) -> None:
    _retry(
        lambda: page.wait_for_url(url, wait_until=wait_until, timeout=timeout),
        label=label,
        attempts=attempts,
    )


def click_and_wait_for_url(
    page: Page,
    selector: str,
    url: str,
    *,
    wait_until: str | None = None,
    timeout: int = DEFAULT_WAIT_TIMEOUT_MS,
) -> None:
    """Pair a click with its navigation event so the event cannot be missed."""
    with page.expect_navigation(url=url, wait_until=wait_until, timeout=timeout):
        page.click(selector, timeout=timeout)


def click_and_wait_for_route(
    page: Page,
    selector: str,
    expected_path: str,
    *,
    tab: str,
    timeout: int = DEFAULT_WAIT_TIMEOUT_MS,
) -> None:
    """Click an SPA tab and wait for its same-document route to be ready.

    A history.pushState route has no navigation commit to observe. The click is
    synchronous from Playwright's perspective, so observe the resulting URL and
    active pane after it instead of waiting for a document navigation event.
    """
    page.click(selector, timeout=timeout)
    wait_for_function(
        page,
        """({expectedPath, tab}) => {
            const pane = document.querySelector(`#tab-${tab}.tabpane.active`);
            return location.pathname === expectedPath
                && location.search === ""
                && location.hash === ""
                && pane?.querySelector(".lens-entry-heading") != null;
        }""",
        arg={"expectedPath": expected_path, "tab": tab},
        timeout=timeout,
        attempts=1,
        label=f"{tab} same-document route",
    )
