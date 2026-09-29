"""Browser journey for the Near You local recovery link.

Serves real Near You documents through the same capture server as the
geography navigation release journey and drives them in headless Chromium at
the two binding viewports. Each failure fixture must show the All NYC link for
the current category next to the result state, outside any collapsed
disclosure, reachable without horizontal scrolling and visibly focused by
keyboard. The link must also work as an ordinary anchor without JavaScript,
open separately on a modified click, and let Back return to the local scope.

Every in-page checker is first run against a control element built to fail
it, so a checker that cannot fail refuses the run. Nothing is written to the
repository; no screenshots are taken.
"""

from __future__ import annotations

import json
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from browser_support import launched_chromium  # noqa: E402
from geography_navigation_release import serve_near_you  # noqa: E402

VIEWPORTS = (("desktop", 1440, 900), ("narrow_touch", 390, 844))
PLACE_PARAMS = ("geo", "boro", "cd", "council", "neighborhood", "scope")
# A well-formed neighborhood key with no published slice: the server answers
# with its records-unavailable document regardless of the data refresh.
FAILED_READ_QUERY = "geo=nta2020%3ABK9999&lens=meetings&q=hearing"
# A published neighborhood whose deferred records read is made to fail in-page.
DEFERRED_FAILURE_QUERY = "geo=nta2020%3AMN0102&lens=meetings&q=hearing&surface=records"
TARGET_SIZE_FLOOR_CSS_PX = 44

INSPECT_JS = """(selector) => {
  const describe = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const hidden = node.closest('[hidden]');
    return {
      inside_details: Boolean(node.closest('details')),
      inside_closed_details: Boolean(node.closest('details:not([open])')),
      hidden: Boolean(hidden) || style.display === 'none' || style.visibility === 'hidden'
        || rect.width === 0 || rect.height === 0,
      left: rect.left + scrollX,
      right: rect.right + scrollX,
      width: rect.width,
      height: rect.height,
      href: node.getAttribute('href'),
      text: (node.textContent || '').trim(),
      focused: document.activeElement === node,
      focus_visible: node.matches(':focus-visible'),
      outline: { style: style.outlineStyle, width: parseFloat(style.outlineWidth) || 0 },
      box_shadow: style.boxShadow,
    };
  };
  return {
    target: describe(document.querySelector(selector)),
    inner_width: innerWidth,
    scroll_x: scrollX,
    overflow_x: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  };
}"""

CONTROL_JS = """() => {
  const details = document.createElement('details');
  details.innerHTML = '<summary>control</summary><a data-recovery-control href="#control">control</a>';
  document.body.append(details);
}"""


def focus_indicator_visible(observed: dict) -> bool:
    outline = observed["outline"]
    ring = outline["style"] not in ("none", "") and outline["width"] > 0
    shadow = observed["box_shadow"] not in ("none", "")
    return bool(observed["focused"] and observed["focus_visible"] and (ring or shadow))


def placement_ok(snapshot: dict) -> bool:
    target = snapshot["target"]
    return bool(
        target
        and not target["hidden"]
        and not target["inside_details"]
        and target["left"] >= 0
        and target["right"] <= snapshot["inner_width"] + 1
        and snapshot["overflow_x"] <= 1
    )


def tab_to(page, selector: str, *, max_tabs: int = 160) -> int:
    page.evaluate(
        """() => {
          document.activeElement?.blur?.();
          document.body.setAttribute('tabindex', '-1');
          document.body.focus();
        }"""
    )
    for step in range(1, max_tabs + 1):
        page.keyboard.press("Tab")
        if page.evaluate("(selector) => document.activeElement?.matches(selector) === true", selector):
            return step
    raise AssertionError(f"keyboard never reached {selector} within {max_tabs} Tab presses")


def assert_checkers_can_fail(page) -> None:
    """Positive controls: each checker must reject an element built to fail it."""
    page.evaluate(CONTROL_JS)
    control = page.evaluate(INSPECT_JS, "[data-recovery-control]")
    if placement_ok(control):
        raise AssertionError(f"placement checker accepted a link inside collapsed details: {control}")
    if focus_indicator_visible(control["target"]):
        raise AssertionError(f"focus checker accepted an unfocused link: {control}")
    page.evaluate("() => document.querySelector('[data-recovery-control]')?.closest('details')?.remove()")


def assert_all_nyc_href(href: str, *, label: str) -> dict:
    url = urllib.parse.urlsplit(href)
    params = urllib.parse.parse_qs(url.query)
    if url.path != "/browse/meetings/":
        raise AssertionError(f"{label}: All NYC link opens {url.path}, not the Meetings collection")
    leaked = [name for name in PLACE_PARAMS if name in params]
    if leaked:
        raise AssertionError(f"{label}: All NYC link keeps local place parameters {leaked}")
    if params.get("q") != ["hearing"]:
        raise AssertionError(f"{label}: All NYC link dropped the topic: {params}")
    return {"path": url.path, "params": {key: values for key, values in sorted(params.items())}}


def check_recovery(page, *, surface: str, label: str, retry_expected: bool) -> dict:
    scope = f'[data-near-surface-panel="{surface}"]'
    all_nyc = f'{scope} [data-near-recovery="all-nyc"]'
    page.locator(all_nyc).first.wait_for(state="visible", timeout=15_000)
    if page.locator(all_nyc).count() != 1:
        raise AssertionError(f"{label}: expected exactly one All NYC link in the {surface} surface")
    assert_checkers_can_fail(page)
    before = page.evaluate(INSPECT_JS, all_nyc)
    if not placement_ok(before):
        raise AssertionError(f"{label}: All NYC link is hidden, collapsed or off-screen: {before}")
    target = before["target"]
    if min(target["width"], target["height"]) < TARGET_SIZE_FLOOR_CSS_PX:
        raise AssertionError(f"{label}: All NYC link target is below {TARGET_SIZE_FLOOR_CSS_PX}px: {target}")
    if target["text"] != "All NYC meetings":
        raise AssertionError(f"{label}: unexpected All NYC link text {target['text']!r}")
    href = assert_all_nyc_href(target["href"], label=label)
    retry = page.locator(f'{scope} [data-near-recovery="retry"]').count()
    if retry_expected and retry != 1:
        raise AssertionError(f"{label}: transient failure should offer exactly one Retry, found {retry}")
    tabs = tab_to(page, all_nyc)
    focused = page.evaluate(INSPECT_JS, all_nyc)
    if not focus_indicator_visible(focused["target"]):
        raise AssertionError(f"{label}: keyboard focus on the All NYC link is not visible: {focused['target']}")
    if focused["scroll_x"] != 0 or focused["overflow_x"] > 1:
        raise AssertionError(f"{label}: reaching the All NYC link scrolled horizontally: {focused}")
    return {
        "label": label,
        "surface": surface,
        "all_nyc_href": href,
        "retry_links": retry,
        "tabs_to_link": tabs,
        "target_css_px": {"width": round(target["width"], 1), "height": round(target["height"], 1)},
    }


def run(base: str) -> list[dict]:
    results: list[dict] = []
    with launched_chromium() as browser:
        for viewport_name, width, height in VIEWPORTS:
            for surface in ("map", "records"):
                context = browser.new_context(viewport={"width": width, "height": height}, has_touch=width < 500)
                page = context.new_page()
                try:
                    response = page.goto(
                        f"{base}/near-you/?{FAILED_READ_QUERY}&surface={surface}",
                        wait_until="domcontentloaded",
                        timeout=30_000,
                    )
                    if response is None or response.status != 503:
                        raise AssertionError(f"failed-read fixture answered {response and response.status}, expected 503")
                    results.append(check_recovery(
                        page,
                        surface=surface,
                        label=f"failed-read-{surface}-{viewport_name}",
                        retry_expected=True,
                    ))
                finally:
                    context.close()

            context = browser.new_context(viewport={"width": width, "height": height}, has_touch=width < 500)
            page = context.new_page()
            try:
                page.route(
                    "**/near-you/deferred.json*",
                    lambda route: route.fulfill(status=503, content_type="application/json", body="{}"),
                )
                page.goto(f"{base}/near-you/?{DEFERRED_FAILURE_QUERY}", wait_until="domcontentloaded", timeout=30_000)
                page.locator('[data-near-deferred="results"][data-near-deferred-state="error"]').wait_for(timeout=15_000)
                results.append(check_recovery(
                    page,
                    surface="records",
                    label=f"deferred-failure-records-{viewport_name}",
                    retry_expected=True,
                ))
            finally:
                context.close()

        # Ordinary anchor navigation without JavaScript, then Back to the local scope.
        context = browser.new_context(viewport={"width": 1440, "height": 900}, java_script_enabled=False)
        page = context.new_page()
        try:
            local = f"{base}/near-you/?{FAILED_READ_QUERY}&surface=records"
            page.goto(local, wait_until="domcontentloaded", timeout=30_000)
            link = page.locator('[data-near-surface-panel="records"] [data-near-recovery="all-nyc"]')
            link.click()
            page.wait_for_url("**/browse/meetings/**", timeout=15_000)
            assert_all_nyc_href(page.url.replace(base, ""), label="no-javascript navigation")
            page.go_back(wait_until="domcontentloaded")
            if urllib.parse.parse_qs(urllib.parse.urlsplit(page.url).query).get("geo") != ["nta2020:BK9999"]:
                raise AssertionError(f"Back did not restore the local scope: {page.url}")
            results.append({"label": "no-javascript-anchor-and-back", "returned_to": page.url.replace(base, "")})
        finally:
            context.close()

        # A modified click opens the broader collection separately and keeps this page.
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        try:
            local = f"{base}/near-you/?{DEFERRED_FAILURE_QUERY}"
            page.route(
                "**/near-you/deferred.json*",
                lambda route: route.fulfill(status=503, content_type="application/json", body="{}"),
            )
            page.goto(local, wait_until="domcontentloaded", timeout=30_000)
            link = page.locator('[data-near-surface-panel="records"] [data-near-recovery="all-nyc"]').first
            link.wait_for(state="visible", timeout=15_000)
            modifier = "Meta" if sys.platform == "darwin" else "Control"
            with context.expect_page(timeout=15_000) as opened:
                link.click(modifiers=[modifier])
            popup = opened.value
            # The new page starts at about:blank; wait for the anchor's navigation to commit.
            popup.wait_for_url("**/browse/meetings/**", timeout=15_000)
            assert_all_nyc_href(popup.url.replace(base, ""), label="modified click")
            if page.url != local:
                raise AssertionError(f"modified click navigated the local page away: {page.url}")
            results.append({"label": "modified-click-new-page", "kept": page.url.replace(base, "")})
        finally:
            context.close()
    return results


def main() -> int:
    process, base = serve_near_you()
    try:
        results = run(base)
    finally:
        process.terminate()
        process.wait(timeout=10)
    print(json.dumps({"near_you_local_recovery": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
