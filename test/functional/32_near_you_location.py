#!/usr/bin/env python3
"""Browser regression: address, place and location entry lead to local records.

Serves real Near You documents, record details and Browse through the Near You
capture server with its clock pinned, and drives the bound entry controls in
headless Chromium at a narrow touch width and a desktop width.

Successful typed address, place-name and explicit location entry opens the
selected neighborhood's Records surface. Every failure keeps the page the
reader already had and puts at most two working next steps beside the entry
controls. A location answer that arrives after a newer typed selection never
replaces it, while a map click keeps the Map. The Use my location button is
revealed only once its handler is bound, and nothing but that button asks for
location. From a selected place the reader can inspect a record, dismiss it,
open the full record and come Back to the same heading, category, scroll
offset and focus.

Every in-page checker is first run against a state built to fail it. Nothing
is written to the repository and no screenshots are taken.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
from urllib.parse import parse_qs, unquote, urlparse

from playwright.sync_api import Browser, BrowserContext, Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
CLOCK = "2026-09-28T16:00:00.000Z"
VIEWPORTS = (("narrow_touch", 390, 844), ("desktop", 1440, 900))
TARGET_SIZE_FLOOR_CSS_PX = 44

ASTORIA = {"latitude": 40.7644, "longitude": -73.9235}
OUTSIDE_NYC = {"latitude": 0, "longitude": 0}
COORDINATE_NEEDLES = ("40.7644", "73.9235")
MIDWOOD_ADDRESS = "810 East 16th Street"
SUBJECT_ADDRESS = "461 Coney Island Avenue"
ADDRESS_NEEDLES = ("810 East 16th", "810+East", "461 Coney", "461+Coney")

MIDWOOD_GEO = "nta2020:BK1403"
SUBJECT_GEO = "nta2020:BK1402"
ASTORIA_GEO = "nta2020:QN0103"
GREENPOINT_GEO = "nta2020:BK0101"
SEPT23_ID = (
    "meeting:community_board:https://cb14brooklyn.com/meeting/"
    "housing-and-land-use-committee-meeting-september-2026/"
)
SEPT23_DETAIL = (
    "/meetings/meeting%3Acommunity_board%3Ahttps%3A%2F%2Fcb14brooklyn.com%2Fmeeting%2F"
    "housing-and-land-use-committee-meeting-september-2026%2F"
)
SEPT23_TITLE = "Housing and Land Use Committee Meeting"
SEPT23_CARD = f'.near-results [data-record-id="{SEPT23_ID}"]:not(.near-broader-districts *)'

DENIED = "Location permission was not granted. Choose an area from the list."
UNAVAILABLE = "Location is not available in this browser. Choose an area from the list."
TIMED_OUT = "Location timed out. Try again or choose an area from the list."
OUTSIDE = "That location is outside the covered city land. Choose an area from the list."
PARCEL_UNAVAILABLE = (
    "That address was found, but its neighborhood map is not available yet. "
    "Choose an area from the list."
)
ENTER_ADDRESS = "Enter an address"
BROWSE_ALL = "Browse all NYC records"
RETRY = "Try again"

# Stubs navigator.geolocation from a per-context plan. Each request reports its
# options to the test through an exposed binding, which survives navigation.
# Steps: grant, deny, timeout, or hold (the callbacks wait for the test).
GEOLOCATION_STUB = """
(() => {
  const plan = %s;
  if (plan.unsupported) {
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: undefined });
    return;
  }
  let calls = 0;
  window.__heldGeolocation = [];
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition(success, error, options) {
        window.__geolocationRequested?.({
          enableHighAccuracy: options?.enableHighAccuracy ?? null,
          timeout: options?.timeout ?? null,
        });
        const step = plan.steps[Math.min(calls, plan.steps.length - 1)];
        calls += 1;
        if (step.kind === "grant") setTimeout(() => success({ coords: step.coords }), 0);
        else if (step.kind === "deny") setTimeout(() => error?.({ code: 1, message: "fixture denial" }), 0);
        else if (step.kind === "timeout") setTimeout(() => error?.({ code: 3, message: "fixture timeout" }), 0);
        else window.__heldGeolocation.push({ success, error });
      },
    },
  });
})();
"""

ENTRY_STATE_JS = """() => {
  const root = document.querySelector('[data-near-you-root]');
  const button = document.querySelector('[data-use-location]');
  const group = document.querySelector('[data-near-entry-recovery]');
  const status = document.querySelector('[data-map-status]');
  const controls = group ? [...group.querySelectorAll('[data-near-entry-recovery-action]')] : [];
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const statusRect = status?.getBoundingClientRect();
  const groupRect = group?.getBoundingClientRect();
  return {
    url: location.href,
    heading: document.querySelector('h1')?.textContent.trim() || '',
    surface: root?.dataset.nearSurface || null,
    status: status?.textContent.trim() || '',
    button_disabled: button ? button.disabled : null,
    button_visible: button ? visible(button) : false,
    group_after_status: Boolean(group && status && status.nextElementSibling === group),
    group_gap: statusRect && groupRect ? Math.round(groupRect.top - statusRect.bottom) : null,
    actions: controls.filter(visible).map((node) => ({
      action: node.dataset.nearEntryRecoveryAction,
      tag: node.tagName.toLowerCase(),
      label: node.textContent.trim(),
      href: node.getAttribute('href'),
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
    })),
    overflow_x: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    input_value: document.querySelector('#near-geo-search-input')?.value ?? null,
  };
}"""

RETURN_STATE_JS = """(card) => {
  const node = document.querySelector(card);
  const active = document.activeElement;
  return {
    heading: document.querySelector('h1')?.textContent.trim() || '',
    results_heading: document.querySelector('#near-results-heading')?.textContent.trim() || '',
    surface: document.querySelector('[data-near-you-root]')?.dataset.nearSurface || null,
    lens: document.querySelector('[data-near-you-root]')?.dataset.lens || null,
    scroll_y: Math.round(scrollY),
    focus_in_card: Boolean(node && active && node.contains(active)),
    focus_class: active?.className || active?.tagName || null,
  };
}"""


def query(url: str) -> dict[str, list[str]]:
    return parse_qs(urlparse(url).query)


def start_server() -> tuple[subprocess.Popen, str]:
    env = {
        **os.environ,
        "NODE_OPTIONS": " ".join(filter(None, [
            os.environ.get("NODE_OPTIONS"),
            f"--import={ROOT / 'test' / 'helpers' / 'test_clock_preload.mjs'}",
        ])),
        "CITYSCROLL_TEST_TIME_PIN": CLOCK,
    }
    server = subprocess.Popen(
        ["node", "tools/serve_near_you_capture.mjs"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        text=True,
        env=env,
    )
    base = (server.stdout.readline() if server.stdout else "").strip().rstrip("/")
    if not base.startswith("http://127.0.0.1:"):
        server.kill()
        raise RuntimeError("Near You capture server did not announce a base URL")
    return server, base


class Journey:
    """One browser context with a geolocation plan and a record of what it sent."""

    def __init__(self, browser: Browser, width: int, height: int, *, steps=None, unsupported=False,
                 javascript=True):
        self.context: BrowserContext = browser.new_context(
            viewport={"width": width, "height": height},
            has_touch=width < 500,
            java_script_enabled=javascript,
        )
        self.touch = width < 500
        self.requests: list[dict] = []
        self.sent: list[str] = []
        self.context.expose_binding(
            "__geolocationRequested", lambda _source, options: self.requests.append(options),
        )
        plan = {"unsupported": unsupported, "steps": steps or [{"kind": "deny"}]}
        self.context.add_init_script(GEOLOCATION_STUB % json.dumps(plan))
        # The clock is pinned in the server that renders record timing; the
        # browser keeps its real clock, which navigation timing depends on.
        self.page: Page = self.context.new_page()
        self.page.on("request", lambda request: self.sent.append(
            f"{request.url} {request.post_data or ''}"
        ))

    def close(self) -> None:
        self.context.close()

    def activate(self, locator) -> None:
        """Touch taps at the narrow width; keyboard activation at desktop."""
        if self.touch:
            locator.tap()
        else:
            locator.focus()
            locator.press("Enter")

    def open_entry(self, base: str, path: str = "/near-you/") -> None:
        self.page.goto(base + path, wait_until="domcontentloaded")
        self.page.locator("[data-use-location]:not([hidden])").wait_for(state="visible", timeout=30_000)

    def wait_records(self, geo: str, *, allow_unavailable: bool = False) -> None:
        """The place's Records surface has settled; some places publish no or only part of a local read."""
        self.page.wait_for_function(
            """([geo, allowed]) => {
              const url = new URL(location.href);
              const root = document.querySelector('[data-near-you-root]');
              const state = root?.dataset.nearDeferredState;
              return url.searchParams.get('geo') === geo && url.searchParams.get('surface') === 'records'
                && root?.dataset.nearSurface === 'records' && (state === 'ready' || (allowed && (state === 'error' || state === 'partial')));
            }""",
            arg=[geo, allow_unavailable],
            timeout=60_000,
        )

    def entry_state(self) -> dict:
        return self.page.evaluate(ENTRY_STATE_JS)

    def open_place_guide(self, *summaries: str) -> None:
        for summary in summaries:
            disclosure = self.page.locator(summary)
            if disclosure.count() and not disclosure.evaluate("node => node.parentElement.open"):
                disclosure.click()

    def search(self, text: str) -> None:
        field = self.page.locator("#near-geo-search-input")
        if not field.is_visible():
            self.open_place_guide(".near-place-guide > summary")
        field.fill(text)
        self.activate(self.page.locator("form.near-geo-search button[type='submit']"))

    def use_location(self) -> None:
        button = self.page.locator("[data-use-location]")
        if not button.is_visible():
            self.open_place_guide(".near-place-guide > summary", ".near-place-options > summary")
        self.activate(button)

    def storage(self) -> str:
        return self.page.evaluate(
            "() => JSON.stringify({ local: {...localStorage}, session: {...sessionStorage}, history: history.state })"
        )


def leaked(text: str, needles: tuple[str, ...]) -> list[str]:
    return [needle for needle in needles if needle.lower() in text.lower()]


def assert_no_leak(journey: Journey, needles: tuple[str, ...], *, label: str) -> None:
    """URL, history, storage and outbound payloads never carry the entry input."""
    surfaces = {
        "url": unquote(journey.page.url),
        "storage_and_history": journey.storage(),
        # Address shard reads are keyed by a street token, not the typed text;
        # every other request (documents, analytics, beacons) is checked whole.
        "requests": "\n".join(
            unquote(line) for line in journey.sent if "/data/address-index/" not in line
        ),
    }
    for name, text in surfaces.items():
        found = leaked(text, needles)
        assert not found, f"{label}: {name} carries {found}"


def assert_leak_checker_can_fail() -> None:
    assert leaked("/near-you/?lat=40.7644&lon=-73.9235", COORDINATE_NEEDLES), "coordinate leak checker"
    assert leaked("{'q': '810 East 16th Street'}", ADDRESS_NEEDLES), "address leak checker"
    assert not leaked("/near-you/?geo=nta2020%3AQN0103&surface=records", COORDINATE_NEEDLES)


def assert_recovery(state: dict, *, label: str, status: str, actions: list[str], touch: bool) -> None:
    assert state["status"].startswith(status), f"{label}: status {state['status']!r}"
    assert state["group_after_status"], f"{label}: recovery is not beside the entry status"
    assert state["group_gap"] is not None and 0 <= state["group_gap"] <= 32, f"{label}: {state['group_gap']}"
    assert [row["action"] for row in state["actions"]] == actions, f"{label}: {state['actions']}"
    assert len(state["actions"]) <= 2
    labels = {"retry": RETRY, "enter_address": ENTER_ADDRESS, "browse_all": BROWSE_ALL}
    for row in state["actions"]:
        assert row["label"] == labels[row["action"]], f"{label}: {row}"
        if row["action"] == "browse_all":
            assert row["tag"] == "a" and urlparse(row["href"]).path == "/browse/", f"{label}: {row}"
        else:
            assert row["tag"] == "button", f"{label}: {row}"
        if touch:
            assert row["height"] >= TARGET_SIZE_FLOOR_CSS_PX, f"{label}: small target {row}"
    assert state["button_disabled"] is False, f"{label}: Use my location stayed disabled"
    assert state["overflow_x"] <= 1, f"{label}: horizontal overflow {state['overflow_x']}"


def assert_recovery_checker_can_fail() -> None:
    retry, enter, browse = (
        {"action": "retry", "tag": "button", "label": RETRY, "href": None, "width": 90, "height": 44},
        {"action": "enter_address", "tag": "button", "label": ENTER_ADDRESS, "href": None, "width": 90, "height": 44},
        {"action": "browse_all", "tag": "a", "label": BROWSE_ALL, "href": "/browse/", "width": 90, "height": 44},
    )
    good = {
        "status": DENIED, "group_after_status": True, "group_gap": 4,
        "actions": [enter, browse], "button_disabled": False, "overflow_x": 0,
    }
    assert_recovery(good, label="control", status=DENIED, actions=["enter_address", "browse_all"], touch=True)
    for broken in (
        {**good, "actions": [retry, enter, browse]},
        {**good, "button_disabled": True},
        {**good, "group_after_status": False},
        {**good, "actions": [{**enter, "height": 20}, browse]},
        {**good, "actions": [enter, {**browse, "href": "/near-you/"}]},
    ):
        try:
            assert_recovery(broken, label="control", status=DENIED,
                            actions=["enter_address", "browse_all"], touch=True)
        except AssertionError:
            continue
        raise AssertionError(f"recovery checker accepted a broken state: {broken}")


def await_status(journey: Journey, prefix: str) -> dict:
    journey.page.wait_for_function(
        """(prefix) => (document.querySelector('[data-map-status]')?.textContent || '').trim().startsWith(prefix)
          && Boolean(document.querySelector('[data-near-entry-recovery]'))""",
        arg=prefix,
        timeout=30_000,
    )
    return journey.entry_state()


def check_enter_address_focuses_input(journey: Journey, *, label: str, typed: str | None = None) -> None:
    journey.activate(journey.page.locator('[data-near-entry-recovery-action="enter_address"]'))
    focused = journey.page.evaluate("() => document.activeElement?.id")
    assert focused == "near-geo-search-input", f"{label}: Enter an address focused {focused!r}"
    if typed is not None:
        assert journey.page.locator("#near-geo-search-input").input_value() == typed, f"{label}: typed text lost"


def check_typed_entries(browser: Browser, base: str, viewport: tuple[str, int, int]) -> list[dict]:
    name, width, height = viewport
    results = []
    journey = Journey(browser, width, height)
    try:
        journey.open_entry(base)
        before = journey.entry_state()
        # Converse state: the unselected entry is not a selected place's Records.
        assert "geo" not in query(before["url"]) and before["surface"] == "map", before
        journey.search(MIDWOOD_ADDRESS)
        journey.wait_records(MIDWOOD_GEO)
        page = journey.page
        after = journey.entry_state()
        assert after["heading"] == "Midwood", after
        assert "drawer" not in query(after["url"]) and "focus" not in query(after["url"]), after["url"]
        results_heading = page.locator("#near-results-heading")
        assert results_heading.is_visible() and "Meetings" in results_heading.inner_text()
        switch = page.locator("[data-near-surface-switch]").first
        assert switch.locator('[data-near-surface="map"]').is_visible(), "Map switch hidden"
        assert switch.locator('[data-near-surface="records"]').get_attribute("aria-current") == "true"
        assert page.locator('[data-near-surface-panel="map"]').is_hidden()
        card = page.locator(SEPT23_CARD).first
        card.wait_for(state="visible", timeout=30_000)
        assert card.locator('[data-record-timing="past"]').count() == 1, "September 23 is past at the pinned clock"
        assert "810 East 16th Street" in card.inner_text()
        assert urlparse(card.locator("a.near-record-full-record").get_attribute("href")).path == SEPT23_DETAIL
        assert_no_leak(journey, ADDRESS_NEEDLES, label=f"typed-{name}")
        results.append({"case": f"typed-address-records-{name}", "geo": MIDWOOD_GEO, "surface": "records"})
        results.append(check_record_return(journey, name=name))
        results.append(check_detail_failure_return(journey, name=name))

        journey.search(SUBJECT_ADDRESS)
        journey.wait_records(SUBJECT_GEO)
        assert journey.entry_state()["heading"].startswith("Flatbush"), journey.entry_state()
        results.append({"case": f"typed-subject-address-{name}", "geo": SUBJECT_GEO})
    finally:
        journey.close()
    return results


def check_record_return(journey: Journey, *, name: str) -> dict:
    """Scope set -> inspect -> dismiss -> full record -> Back -> continue."""
    page = journey.page
    card = page.locator(SEPT23_CARD).first
    inspect = card.locator(".near-record-inspect")
    inspect.scroll_into_view_if_needed()
    journey.activate(inspect)
    dialog = page.locator("dialog[open]")
    dialog.wait_for(state="visible")
    assert SEPT23_TITLE in dialog.inner_text()
    journey.activate(dialog.locator("[data-near-you-record-inspection-close]"))
    page.wait_for_function("() => !document.querySelector('dialog[open]')")
    dismissed = page.evaluate(RETURN_STATE_JS, SEPT23_CARD)
    assert dismissed["focus_in_card"] and "near-record-inspect" in dismissed["focus_class"], dismissed

    full = card.locator("a.near-record-full-record")
    full.scroll_into_view_if_needed()
    departure = page.evaluate(RETURN_STATE_JS, SEPT23_CARD)
    journey.activate(full)
    page.wait_for_url(f"**{SEPT23_DETAIL}", timeout=30_000)
    assert SEPT23_TITLE in page.locator("h1").first.inner_text()
    assert not page.locator("[data-near-you-root]").count(), "full record opened the Near You shell"

    page.go_back(wait_until="domcontentloaded")
    journey.wait_records(MIDWOOD_GEO)
    page.wait_for_function(
        """([card, y]) => {
          const node = document.querySelector(card);
          return Boolean(node && node.contains(document.activeElement)) && Math.abs(scrollY - y) <= 4;
        }""",
        arg=[SEPT23_CARD, departure["scroll_y"]],
        timeout=15_000,
    )
    returned = page.evaluate(RETURN_STATE_JS, SEPT23_CARD)
    assert returned["heading"] == "Midwood" and "Meetings" in returned["results_heading"], returned
    assert returned["surface"] == "records" and returned["lens"] == "meetings", returned
    assert "near-record-full-record" in returned["focus_class"], returned
    # Positive control: the same checker refuses the page once focus leaves the card.
    page.evaluate("() => document.activeElement?.blur()")
    assert not page.evaluate(RETURN_STATE_JS, SEPT23_CARD)["focus_in_card"]

    # Continue: the restored page still inspects its records.
    journey.activate(card.locator(".near-record-inspect"))
    page.locator("dialog[open]").wait_for(state="visible")
    journey.activate(page.locator("dialog[open] [data-near-you-record-inspection-close]"))
    page.wait_for_function("() => !document.querySelector('dialog[open]')")
    return {
        "case": f"record-return-{name}",
        "scroll_y": returned["scroll_y"],
        "departure_scroll_y": departure["scroll_y"],
        "focus": "full-record link",
    }


def check_detail_failure_return(journey: Journey, *, name: str) -> dict:
    """A full record that fails to load leaves the reader real links back in Midwood."""
    page = journey.page
    failed: list[int] = []

    def unavailable_detail(route: Route) -> None:
        failed.append(1)
        route.fulfill(status=503, content_type="text/html", body="<!doctype html><title>Unavailable</title>")

    page.route(f"**{SEPT23_DETAIL}", unavailable_detail)
    card = page.locator(SEPT23_CARD).first
    full = card.locator("a.near-record-full-record")
    full.scroll_into_view_if_needed()
    departure = page.evaluate(RETURN_STATE_JS, SEPT23_CARD)
    journey.activate(full)
    page.wait_for_url(f"**{SEPT23_DETAIL}", timeout=30_000)
    assert failed, "the full record was never made to fail"
    page.go_back(wait_until="domcontentloaded")
    journey.wait_records(MIDWOOD_GEO)
    page.wait_for_function(
        """([card, y]) => {
          const node = document.querySelector(card);
          return Boolean(node && node.contains(document.activeElement)) && Math.abs(scrollY - y) <= 4;
        }""",
        arg=[SEPT23_CARD, departure["scroll_y"]],
        timeout=15_000,
    )
    returned = page.evaluate(RETURN_STATE_JS, SEPT23_CARD)
    assert returned["heading"] == "Midwood" and "near-record-full-record" in returned["focus_class"], returned
    # Both the canonical full record and the publisher's own page stay linked.
    assert urlparse(full.get_attribute("href")).path == SEPT23_DETAIL
    journey.activate(card.locator(".near-record-inspect"))
    source = page.locator("dialog[open] [data-near-you-record-source]")
    assert urlparse(source.get_attribute("href")).hostname == "cb14brooklyn.com", source.get_attribute("href")
    assert urlparse(
        page.locator("dialog[open] [data-near-you-record-inspection-open]").get_attribute("href")
    ).path == SEPT23_DETAIL
    journey.activate(page.locator("dialog[open] [data-near-you-record-inspection-close]"))
    page.wait_for_function("() => !document.querySelector('dialog[open]')")
    page.unroute(f"**{SEPT23_DETAIL}", unavailable_detail)
    return {"case": f"detail-failure-return-{name}", "focus": "full-record link"}


def check_geolocation_entry(browser: Browser, base: str, viewport: tuple[str, int, int]) -> dict:
    name, width, height = viewport
    journey = Journey(browser, width, height, steps=[{"kind": "grant", "coords": ASTORIA}])
    try:
        journey.open_entry(base)
        journey.use_location()
        journey.wait_records(ASTORIA_GEO, allow_unavailable=True)
        state = journey.entry_state()
        assert state["heading"] == "Astoria (Central)", state
        assert journey.requests == [{"enableHighAccuracy": False, "timeout": 10000}], journey.requests
        assert_no_leak(journey, COORDINATE_NEEDLES, label=f"geolocation-{name}")
        return {"case": f"geolocation-records-{name}", "geo": ASTORIA_GEO, "requests": len(journey.requests)}
    finally:
        journey.close()


def check_location_failures(browser: Browser, base: str, viewport: tuple[str, int, int]) -> list[dict]:
    name, width, height = viewport
    touch = width < 500
    results = []
    cases = (
        ("denied", {"steps": [{"kind": "deny"}]}, DENIED, ["enter_address", "browse_all"]),
        ("unsupported", {"unsupported": True}, UNAVAILABLE, ["enter_address", "browse_all"]),
        ("outside", {"steps": [{"kind": "grant", "coords": OUTSIDE_NYC}]}, OUTSIDE,
         ["enter_address", "browse_all"]),
        ("timeout", {"steps": [{"kind": "timeout"}, {"kind": "grant", "coords": ASTORIA}]}, TIMED_OUT,
         ["retry", "enter_address"]),
    )
    for case, plan, status, actions in cases:
        label = f"{case}-{name}"
        journey = Journey(browser, width, height, **plan)
        try:
            journey.open_entry(base)
            before = journey.page.url
            journey.use_location()
            state = await_status(journey, status)
            assert_recovery(state, label=label, status=status, actions=actions, touch=touch)
            assert journey.page.url == before, f"{label}: scope changed to {journey.page.url}"
            if case == "timeout":
                # Retry is a second explicit request, and this time it answers.
                journey.activate(journey.page.locator('[data-near-entry-recovery-action="retry"]'))
                journey.wait_records(ASTORIA_GEO, allow_unavailable=True)
                assert len(journey.requests) == 2, journey.requests
            else:
                check_enter_address_focuses_input(journey, label=label)
            if case == "denied":
                journey.activate(journey.page.locator('[data-near-entry-recovery-action="browse_all"]'))
                journey.page.wait_for_url("**/browse/", timeout=30_000)
                journey.page.locator('[data-build-rendered="browse-landing"]').wait_for(state="attached")
            results.append({"case": f"location-{label}", "actions": actions})
        finally:
            journey.close()
    return results


def check_entry_failures(browser: Browser, base: str, viewport: tuple[str, int, int]) -> list[dict]:
    name, width, height = viewport
    touch = width < 500
    results = []

    # A missing parcel-geography shard: the typed address stays in the input.
    journey = Journey(browser, width, height)
    try:
        journey.page.route("**/data/parcel-geography/*.json", lambda route: (
            route.continue_() if route.request.url.endswith("/manifest.json")
            else route.fulfill(status=404, body="missing")
        ))
        journey.open_entry(base)
        before = journey.page.url
        journey.search(MIDWOOD_ADDRESS)
        state = await_status(journey, PARCEL_UNAVAILABLE)
        assert_recovery(state, label=f"parcel-{name}", status=PARCEL_UNAVAILABLE,
                        actions=["enter_address", "browse_all"], touch=touch)
        assert journey.page.url == before and state["input_value"] == MIDWOOD_ADDRESS, state
        check_enter_address_focuses_input(journey, label=f"parcel-{name}", typed=MIDWOOD_ADDRESS)
        results.append({"case": f"missing-parcel-shard-{name}"})
    finally:
        journey.close()

    # Resolution succeeds but the new document cannot be adopted: the prior
    # selected place stays usable, and Retry adopts the same place.
    journey = Journey(browser, width, height, steps=[{"kind": "grant", "coords": ASTORIA}])
    try:
        page = journey.page
        page.goto(f"{base}/near-you/?geo=nta2020%3ABK1403&surface=records&lens=meetings",
                  wait_until="domcontentloaded")
        journey.wait_records(MIDWOOD_GEO)
        page.locator("[data-use-location]").wait_for(state="attached")
        page.wait_for_function("() => !document.querySelector('[data-use-location]').hidden")
        before = page.url

        def broken_document(route: Route) -> None:
            if query(route.request.url).get("geo") == [ASTORIA_GEO] and "deferred.json" not in route.request.url:
                route.fulfill(status=500, body="unavailable")
            else:
                route.continue_()

        page.route("**/near-you/?*", broken_document)
        journey.use_location()
        state = await_status(journey, "Location matched Astoria (Central), but the page could not update.")
        assert_recovery(state, label=f"adoption-{name}", status="Location matched Astoria (Central)",
                        actions=["retry", "enter_address"], touch=touch)
        assert page.url == before and state["heading"] == "Midwood", state
        assert page.locator(SEPT23_CARD).count() == 1, "prior Midwood records were lost"
        page.unroute("**/near-you/?*", broken_document)
        journey.activate(page.locator('[data-near-entry-recovery-action="retry"]'))
        journey.wait_records(ASTORIA_GEO, allow_unavailable=True)
        assert len(journey.requests) == 1, "Retry after a failed update must not ask for location again"
        results.append({"case": f"failed-adoption-{name}", "kept": MIDWOOD_GEO, "retried": ASTORIA_GEO})
    finally:
        journey.close()
    return results


def check_stale_location_answer(browser: Browser, base: str) -> dict:
    hold = {"steps": [{"kind": "hold"}]}
    release = f"() => window.__heldGeolocation.shift().success({{ coords: {json.dumps(ASTORIA)} }})"

    # Converse control: an answer nothing superseded does select its place.
    control = Journey(browser, 1440, 900, **hold)
    try:
        control.open_entry(base)
        control.use_location()
        control.page.wait_for_function("() => window.__heldGeolocation.length === 1")
        control.page.evaluate(release)
        control.wait_records(ASTORIA_GEO, allow_unavailable=True)
    finally:
        control.close()

    journey = Journey(browser, 1440, 900, **hold)
    try:
        page = journey.page
        journey.open_entry(base)
        journey.use_location()
        page.wait_for_function("() => window.__heldGeolocation.length === 1")
        journey.search("Greenpoint")
        journey.wait_records(GREENPOINT_GEO, allow_unavailable=True)
        # Intermediate state: Greenpoint is adopted while the location answer waits.
        assert page.evaluate("() => window.__heldGeolocation.length") == 1
        greenpoint_url = page.url
        page.evaluate(release)
        page.wait_for_timeout(3_000)
        page.wait_for_load_state("networkidle")
        state = journey.entry_state()
        assert page.url == greenpoint_url and state["heading"] == "Greenpoint", state
        assert "Astoria" not in state["status"], state
        return {"case": "stale-location-after-typed-greenpoint", "kept": GREENPOINT_GEO}
    finally:
        journey.close()


MAP_INSTRUMENT = """(() => {
  window.__entryMaps = [];
  let lib;
  Object.defineProperty(window, 'maplibregl', {configurable: true,
    get: () => lib, set: (value) => { lib = value; value.Map = new Proxy(value.Map, {construct(T, args) {
      const map = Reflect.construct(T, args); window.__entryMaps.push(map); return map;
    }}); }
  });
})();"""


def check_map_click_keeps_map(browser: Browser, base: str) -> dict:
    journey = Journey(browser, 1440, 900)
    try:
        page = journey.page
        page.add_init_script(MAP_INSTRUMENT)
        journey.open_entry(base)
        page.wait_for_function("""() => {
          const host = document.querySelector('#near-map-enhanced');
          return host && !host.hidden && Number(host.dataset.renderedNeighborhoodLabelCount) > 0;
        }""", timeout=60_000)
        point = page.evaluate("""() => {
          const map = window.__entryMaps.filter((m) => m.getContainer().isConnected).at(-1);
          map.jumpTo({ center: [-73.9515, 40.7300], zoom: 13 });
          return map.project([-73.9515, 40.7300]);
        }""")
        page.locator("#near-map-enhanced canvas").click(position=point)
        page.wait_for_url("**geo=nta2020%3ABK0101**", timeout=30_000)
        selected = query(page.url)
        assert selected.get("surface") == ["map"] and selected.get("drawer") == ["open"], page.url
        return {"case": "map-click-keeps-map", "geo": GREENPOINT_GEO}
    finally:
        journey.close()


def check_location_request_gate(browser: Browser, base: str) -> list[dict]:
    results = []
    # The button stays hidden until the module that binds it has run.
    journey = Journey(browser, 390, 844)
    try:
        page = journey.page
        held: list[Route] = []
        page.route("**/app/map.mjs", lambda route: held.append(route))
        # Module scripts run before DOMContentLoaded, so wait only for parsing.
        page.goto(base + "/near-you/", wait_until="commit")
        page.wait_for_function("() => document.readyState === 'interactive'")
        page.locator("[data-use-location]").wait_for(state="attached")
        assert held, "map module request was not observed"
        assert not journey.entry_state()["button_visible"], "location button shown before its handler"
        for route in held:
            route.continue_()
        page.locator("[data-use-location]:not([hidden])").wait_for(state="visible", timeout=30_000)
        assert journey.requests == []
        journey.use_location()
        await_status(journey, DENIED)
        assert len(journey.requests) == 1, journey.requests
        results.append({"case": "location-button-revealed-after-binding"})
    finally:
        journey.close()

    # No JavaScript: no inert button; the place form and area links remain.
    journey = Journey(browser, 390, 844, javascript=False)
    try:
        page = journey.page
        page.goto(base + "/near-you/", wait_until="domcontentloaded")
        assert page.locator("[data-use-location]").count() == 1
        assert not page.locator("[data-use-location]").is_visible()
        assert page.locator("form.near-geo-search").is_visible()
        assert page.locator("#near-area-list a[href*='geo=']").count() > 0
        results.append({"case": "no-javascript-entry"})
    finally:
        journey.close()

    # Page load, retrying failed record data and changing category never ask.
    journey = Journey(browser, 1440, 900)
    try:
        page = journey.page
        failed: list[str] = []

        def fail_first_deferred(route: Route) -> None:
            if not failed:
                failed.append(route.request.url)
                route.fulfill(status=503, content_type="application/json", body="{}")
            else:
                route.continue_()

        page.route("**/near-you/deferred.json*", fail_first_deferred)
        page.goto(f"{base}/near-you/?geo=nta2020%3AMN0102&surface=records&lens=meetings",
                  wait_until="domcontentloaded")
        retry = page.locator('[data-near-deferred="results"] [data-near-recovery="retry"]')
        retry.wait_for(state="visible", timeout=30_000)
        retry.click()
        journey.wait_records("nta2020:MN0102")
        assert failed, "the record read was never made to fail"
        # Category navigation: choose another category in the place's filter form.
        page.locator("details.near-advanced > summary").first.click()
        form = page.locator("details.near-advanced form.near-form").first
        form.locator("select[name='lens']").select_option("land")
        form.locator("button[type='submit']").first.click()
        page.wait_for_url(lambda url: query(url).get("lens") == ["land"], timeout=30_000)
        page.wait_for_load_state("networkidle")
        category = ["land"]
        assert journey.requests == [], journey.requests
        results.append({"case": "no-request-on-load-retry-category", "category": category[0]})
    finally:
        journey.close()
    return results


def main() -> None:
    assert_leak_checker_can_fail()
    assert_recovery_checker_can_fail()
    server, base = start_server()
    results: list[dict] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for viewport in VIEWPORTS:
                results.extend(check_typed_entries(browser, base, viewport))
                results.append(check_geolocation_entry(browser, base, viewport))
                results.extend(check_location_failures(browser, base, viewport))
                results.extend(check_entry_failures(browser, base, viewport))
            results.append(check_stale_location_answer(browser, base))
            results.append(check_map_click_keeps_map(browser, base))
            results.extend(check_location_request_gate(browser, base))
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
    print(json.dumps({"near_you_location_entry": results}, indent=2))


if __name__ == "__main__":
    main()
