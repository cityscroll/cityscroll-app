"""Preconditions for the contract-detail panel that mobile layout checks measure.

The Contracts route owns `#detail` and repaints it from an asynchronous selection
that keeps running after the notice list is on screen: the auto-selected row's
render lands again once its lineage chain and agency statistics resolve.

Rendering the fixture and reading its geometry on one evaluation turn closes the
window between those two steps. It does not close the window before the fixture
is rendered, nor the one after it, where the surface assertions read the panel
again -- and a panel replaced in either window leaves the check reporting
something that is not about mobile layout at all: a null element during a layout
read, or a bounded wait expiring on a table that was erased before it could be
observed.

This module owns both remaining edges: waiting for the route's render to settle
before the fixture goes in, and confirming the fixture is still the thing being
measured afterwards. Everything here observes structure only (presence, counts,
geometry), never page content, and every null is handled in Python so an absent
shell produces a named precondition failure instead of an exception from inside
the browser.
"""

from __future__ import annotations

import json
from typing import Any

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError

from ci_waits import wait_for_function


DETAIL_SELECTOR = "#detail"
FIXTURE_ROOT_SELECTOR = ".attachment-tables"
FIXTURE_BODY_SELECTOR = ".attachment-tables-body"
FIXTURE_TABLE_SELECTOR = "table.attachment-table"

# The observed application tail is tens of milliseconds unthrottled and a few
# hundred under heavy CPU contention. A quiet window an order of magnitude above
# that is the settle boundary; the budget bounds the wait when it never arrives.
DEFAULT_QUIET_MS = 1_500
DEFAULT_SETTLE_TIMEOUT_MS = 30_000


class DetailPanelPrecondition(AssertionError):
    """The page never reached the state a mobile layout assertion measures.

    Distinct from a layout regression: this says the measurement never had its
    subject in front of it, so nothing about the 360px contract was tested.
    """


def _fail(precondition: str, observed: dict[str, Any]) -> None:
    raise DetailPanelPrecondition(
        f"PRECONDITION UNMET: {precondition}: "
        f"{json.dumps(observed, sort_keys=True, default=str)}"
    )


_OBSERVE_JS = """
({selector}) => {
  const panel = document.querySelector(selector);
  if (!panel) {
    return {observing: false, reason: 'panel-absent', selector, url: location.href,
            title: document.title, ready_state: document.readyState};
  }
  globalThis.__detailPanelWatch?.observer?.disconnect();
  const watch = {last: performance.now(), started: performance.now(), mutations: 0};
  watch.observer = new MutationObserver(() => {
    watch.mutations += 1;
    watch.last = performance.now();
  });
  watch.observer.observe(panel, {
    childList: true, subtree: true, attributes: true, characterData: true,
  });
  globalThis.__detailPanelWatch = watch;
  return {observing: true, selector, url: location.href, title: document.title};
}
"""

_QUIET_JS = """
({selector, quietMs}) => {
  const panel = document.querySelector(selector);
  const watch = globalThis.__detailPanelWatch;
  if (!panel || !watch) return false;
  return panel.childElementCount > 0 && performance.now() - watch.last >= quietMs;
}
"""

_WATCH_STATE_JS = """
({selector}) => {
  const panel = document.querySelector(selector);
  const watch = globalThis.__detailPanelWatch;
  return {
    selector,
    url: location.href,
    title: document.title,
    ready_state: document.readyState,
    panel_present: Boolean(panel),
    child_element_count: panel ? panel.childElementCount : null,
    mutations: watch ? watch.mutations : null,
    quiet_for_ms: watch ? Math.round(performance.now() - watch.last) : null,
    observed_for_ms: watch ? Math.round(performance.now() - watch.started) : null,
  };
}
"""

_STOP_OBSERVING_JS = """
() => {
  globalThis.__detailPanelWatch?.observer?.disconnect();
  delete globalThis.__detailPanelWatch;
}
"""


def wait_for_detail_panel_settled(
    page: Page,
    *,
    quiet_ms: int = DEFAULT_QUIET_MS,
    timeout_ms: int = DEFAULT_SETTLE_TIMEOUT_MS,
) -> dict[str, Any]:
    """Wait until the route has finished repainting the contract detail panel.

    A mutation observer in the page records when the panel last changed, and a
    bounded wait polls for a quiet window. The bound lives on this side rather
    than in a timer inside a promise the caller would have to trust, so a page
    that stops running timers expires the wait instead of hanging it.

    Raises DetailPanelPrecondition naming the missing precondition and the URL
    when the panel is absent, never renders, or never stops mutating.
    """
    observing = page.evaluate(_OBSERVE_JS, {"selector": DETAIL_SELECTOR})
    if not observing.get("observing"):
        _fail(
            f"the contract detail shell ({DETAIL_SELECTOR}) is not on the page the "
            f"layout fixture was to be installed into",
            observing,
        )
    try:
        wait_for_function(
            page,
            _QUIET_JS,
            arg={"selector": DETAIL_SELECTOR, "quietMs": quiet_ms},
            timeout=timeout_ms,
            attempts=1,
            label="contract detail panel settled",
        )
    except PlaywrightTimeoutError:
        observed = page.evaluate(_WATCH_STATE_JS, {"selector": DETAIL_SELECTOR})
        observed["quiet_window_ms"] = quiet_ms
        observed["settle_timeout_ms"] = timeout_ms
        _fail(
            f"the contract detail shell ({DETAIL_SELECTOR}) never settled before "
            f"the layout fixture was installed",
            observed,
        )
    finally:
        page.evaluate(_STOP_OBSERVING_JS)
    return observing


_FIXTURE_STATE_JS = """
({panelSelector, rootSelector, bodySelector, tableSelector}) => {
  const panel = document.querySelector(panelSelector);
  return {
    url: location.href,
    title: document.title,
    panel_present: Boolean(panel),
    panel_child_elements: panel ? panel.childElementCount : null,
    fixture_root_present: Boolean(document.querySelector(rootSelector)),
    fixture_body_present: Boolean(document.querySelector(bodySelector)),
    fixture_table_present: Boolean(document.querySelector(tableSelector)),
    fixture_inside_panel: Boolean(panel && panel.querySelector(rootSelector)),
  };
}
"""


def attachment_fixture_state(page: Page) -> dict[str, Any]:
    """Report the structural state the layout measurement depends on."""
    return page.evaluate(
        _FIXTURE_STATE_JS,
        {
            "panelSelector": DETAIL_SELECTOR,
            "rootSelector": FIXTURE_ROOT_SELECTOR,
            "bodySelector": FIXTURE_BODY_SELECTOR,
            "tableSelector": FIXTURE_TABLE_SELECTOR,
        },
    )


def require_attachment_fixture(page: Page, stage: str) -> dict[str, Any]:
    """Confirm the injected table is still the thing the next read will measure."""
    observed = attachment_fixture_state(page)
    if not observed.get("panel_present"):
        _fail(
            f"the contract detail shell ({DETAIL_SELECTOR}) is absent {stage}",
            observed,
        )
    if not observed.get("fixture_inside_panel"):
        _fail(
            f"the injected attachment table ({FIXTURE_ROOT_SELECTOR}) was replaced "
            f"inside {DETAIL_SELECTOR} {stage}",
            observed,
        )
    return observed


def require_measured_fixture(outcome: dict[str, Any]) -> dict[str, Any]:
    """Turn the atomic install-and-measure result into metrics or a named failure.

    The evaluation renders the fixture and reads its geometry on one turn, so it
    can report exactly which element was missing instead of dereferencing it.
    This side names that precondition, with the URL the evaluation ran against,
    so a page that never reached the expected state is never mistaken for a page
    that reached it and overflowed.
    """
    if not outcome.get("measured"):
        _fail(
            f"the attachment-table fixture was not measurable in {DETAIL_SELECTOR}",
            outcome,
        )
    return outcome
