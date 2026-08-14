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


def wait_for_app_ready(
    page: Page,
    *,
    timeout: int = DEFAULT_WAIT_TIMEOUT_MS,
) -> None:
    """Wait for the app boot contract, rather than the document load event."""
    wait_for_function(
        page,
        """() => document.readyState !== "loading"
            && typeof globalThis.showTab === "function"
            && globalThis.CrolRouteModules !== undefined""",
        timeout=timeout,
        attempts=1,
        label="application boot",
    )


def goto_and_wait_for_app(
    page: Page,
    url: str,
    *,
    timeout: int = DEFAULT_WAIT_TIMEOUT_MS,
) -> None:
    """Navigate past parsing, then observe the app's own boot readiness."""
    page.goto(url, wait_until="domcontentloaded", timeout=timeout)
    wait_for_app_ready(page, timeout=timeout)


def wait_for_route_module(
    page: Page,
    tab: str,
    *,
    timeout: int = DEFAULT_WAIT_TIMEOUT_MS,
) -> None:
    """Await the app's route-module promise before clicking its tab."""
    wait_for_app_ready(page, timeout=timeout)
    page.evaluate(
        """async ({tab, timeout}) => {
            const ensure = globalThis.CrolRouteModules?.ensure;
            if (!ensure) return;
            await Promise.race([
                ensure(tab),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error(`route module readiness timed out: ${tab}`)),
                    timeout,
                )),
            ]);
        }""",
        {"tab": tab, "timeout": timeout},
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
    # A parsed document is the stable boundary for a URL observation. Callers that
    # need rendered content still add a locator/readiness wait after this helper.
    settled_wait_until = wait_until or "domcontentloaded"
    _retry(
        lambda: page.wait_for_url(url, wait_until=settled_wait_until, timeout=timeout),
        label=label,
        attempts=attempts,
    )


def wait_for_route_state(
    page: Page,
    expected_path: str,
    *,
    tab: str | None = None,
    require_focus: bool = False,
    timeout: int = DEFAULT_WAIT_TIMEOUT_MS,
    label: str = "document route",
) -> None:
    """Observe a settled route and pane, without waiting for a load event.

    Tab links are same-document history transitions. A route is settled when its
    canonical URL is present, the document is no longer parsing, and (for an SPA
    tab) the expected pane and heading are active. Focus is included when the
    caller needs the complete tab-entry contract.
    """
    wait_for_function(
        page,
        """({expectedPath, tab, requireFocus}) => {
            if (location.pathname !== expectedPath
                || location.search !== ""
                || location.hash !== ""
                || document.readyState === "loading") return false;
            if (!tab) return true;
            const pane = document.querySelector(`#tab-${tab}.tabpane.active`);
            const heading = pane?.querySelector(".lens-entry-heading");
            return Boolean(
                pane && heading?.isConnected
                && (!requireFocus || document.activeElement === heading)
            );
        }""",
        arg={
            "expectedPath": expected_path,
            "tab": tab,
            "requireFocus": require_focus,
        },
        timeout=timeout,
        attempts=1,
        label=label,
    )


def click_and_wait_for_url(
    page: Page,
    selector: str,
    url: str,
    *,
    wait_until: str | None = None,
    timeout: int = DEFAULT_WAIT_TIMEOUT_MS,
) -> None:
    """Pair a click with a URL and parsed-document observation."""
    settled_wait_until = wait_until or "domcontentloaded"
    with page.expect_navigation(url=url, wait_until=settled_wait_until, timeout=timeout):
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
    wait_for_route_state(
        page,
        expected_path,
        tab=tab,
        require_focus=True,
        timeout=timeout,
        label=f"{tab} settled route",
    )
