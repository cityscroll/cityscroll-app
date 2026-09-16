#!/usr/bin/env python3
"""Capability discovery browser journeys against public pages.

Covers:
- Follow/calendar discovery on Browse and Now (landed sibling surface).
- Assistant introduction and shared Ask-with-AI entry at desktop and phone
  viewports, with keyboard, translated query, no-JS, and failed-enhancement
  paths.
- Contextual assistant handoffs for exact records and scoped searches, with
  clipboard fallback, hostile URL stripping, and both desktop/phone viewports.
- Research utility discovery on an eligible notice (More tools / research
  navigation) plus API research task entrances.

Environment:
  CROL_BASE  Base URL (default http://localhost:8000/). Production runs set
             https://cityscroll.org/.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
if not BASE.endswith("/"):
    BASE += "/"

DESKTOP = {"width": 1440, "height": 1000}
PHONE = {"width": 390, "height": 844}
_ARGS = (
    ["--host-resolver-rules=MAP api.cityscroll.org " + os.environ["CROL_DNS_IP"]]
    if os.environ.get("CROL_DNS_IP")
    else []
)
CONTRACT_ID = "procurement:contract:CT107120258801626"
NOTICE_ID = "20240829105"
LAND_ID = "2024Q0356"
VIEWPORTS = (
    ("desktop", DESKTOP),
    ("phone", PHONE),
)

results: list[tuple[str, str]] = []


def step(tag: str, name: str, detail: str = "") -> None:
    results.append((tag, name))
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def open_page(browser, viewport, java_script_enabled=True):
    context = browser.new_context(viewport=viewport, java_script_enabled=java_script_enabled)
    page = context.new_page()
    return context, page


def assert_follow_calendar_journeys(browser) -> None:
    page = browser.new_context(viewport=DESKTOP).new_page()
    page.goto(BASE + "browse/meetings/?agency=City%20Planning", timeout=30000)
    page.wait_for_selector("[data-follow-discovery='1'], .calendar-subscribe-btn, .browse-build-view", timeout=20000)
    html = page.content()
    has_group = 'data-follow-discovery="1"' in html
    has_follow = "Get email updates" in html
    has_calendar = "Subscribe to calendar" in html
    has_feeds = "Feed reader links" in html
    calendar_buttons = len(re.findall(r'class="calendar-subscribe-btn"', html))
    step(
        "OK" if has_group and has_follow and has_calendar and has_feeds else "FAIL",
        "browse follow discovery group",
        f"group={has_group} follow={has_follow} calendar={has_calendar} feeds={has_feeds} calendar_btns={calendar_buttons}",
    )
    step("OK" if calendar_buttons == 1 else "FAIL", "single calendar subscribe control", str(calendar_buttons))

    phone = browser.new_context(viewport=PHONE).new_page()
    phone.goto(BASE + "browse/meetings/?agency=City%20Planning", timeout=30000)
    phone.wait_for_selector("[data-follow-discovery='1'], .browse-build-view", timeout=20000)
    phone_html = phone.content()
    step(
        "OK" if 'data-follow-discovery="1"' in phone_html and "Get email updates" in phone_html else "FAIL",
        "phone browse follow discovery",
    )

    now = browser.new_context(viewport=DESKTOP).new_page()
    now.goto(BASE + "now/", timeout=30000)
    now.wait_for_selector("[data-follow-discovery-surface='now'], .now-surface", timeout=20000)
    now_html = now.content()
    step("OK" if 'data-follow-discovery-surface="now"' in now_html else "FAIL", "now follow discovery")


def assert_introduction_journey(page, label: str) -> None:
    page.goto(BASE + "use-with-ai/", timeout=30000)
    page.wait_for_selector("#mcp-endpoint, main#main", timeout=20000)
    html = page.content()
    endpoint = page.locator("#mcp-endpoint")
    copy_btn = page.locator("[data-copy-endpoint]")
    has_endpoint = endpoint.count() == 1 and "api.cityscroll.org/mcp" in (endpoint.input_value() if endpoint.count() else "")
    has_copy = copy_btn.count() == 1
    has_examples = "CT107120258801626" in html and "2024Q0356" in html
    has_recovery = "/api.html#mcp" in html and ("no account" in html.lower() or "no key" in html.lower())
    step(
        "OK" if has_endpoint and has_copy and has_examples and has_recovery else "FAIL",
        f"{label} introduction route-to-task",
        f"endpoint={has_endpoint} copy={has_copy} examples={has_examples} recovery={has_recovery}",
    )


def assert_home_ask_link(page, label: str) -> None:
    page.goto(BASE, timeout=30000)
    page.wait_for_selector("body", timeout=20000)
    link = page.locator('a[href*="use-with-ai"]')
    step("OK" if link.count() >= 1 else "FAIL", f"{label} home Ask with AI entry", str(link.count()))
    if link.count() >= 1:
        href = link.first.get_attribute("href") or ""
        step("OK" if "use-with-ai" in href else "FAIL", f"{label} home Ask href", href)


def assert_keyboard_copy_fallback(page, label: str) -> None:
    page.goto(BASE + "use-with-ai/", timeout=30000)
    page.wait_for_selector("#mcp-endpoint", timeout=20000)
    page.locator("#mcp-endpoint").focus()
    page.keyboard.press("Tab")
    focused = page.evaluate("() => document.activeElement && document.activeElement.getAttribute('data-copy-endpoint')")
    page.locator("[data-copy-endpoint]").click()
    selected = page.evaluate(
        """() => {
          const input = document.querySelector('#mcp-endpoint');
          if (!input) return false;
          return input.selectionStart === 0 && input.selectionEnd === input.value.length
            || document.activeElement === input;
        }"""
    )
    step(
        "OK" if focused is not None or selected else "FAIL",
        f"{label} keyboard and copy recovery",
        f"focused_copy={focused} selected_or_focused={selected}",
    )


def assert_translated_layout(page, label: str) -> None:
    page.goto(BASE + "use-with-ai/?lang=es", timeout=30000)
    page.wait_for_selector("#mcp-endpoint, main#main", timeout=20000)
    html = page.content()
    ok = "api.cityscroll.org/mcp" in html and ('href="/"' in html or "CityScroll home" in html or "href='/'" in html)
    step("OK" if ok else "FAIL", f"{label} translated introduction keeps endpoint and home recovery")


def assert_no_js(browser, label: str) -> None:
    context, page = open_page(browser, DESKTOP, java_script_enabled=False)
    try:
        page.goto(BASE + "use-with-ai/", timeout=30000)
        html = page.content()
        ok = "api.cityscroll.org/mcp" in html and "CT107120258801626" in html and "data-copy-endpoint" in html
        step("OK" if ok else "FAIL", f"{label} no-JS introduction still shows endpoint and examples")
        page.goto(BASE + "about.html", timeout=30000)
        about = page.content()
        step("OK" if "use-with-ai" in about else "FAIL", f"{label} no-JS about still links to introduction")
    finally:
        context.close()


def assert_failed_enhancement(browser, label: str) -> None:
    context = browser.new_context(viewport=DESKTOP)
    context.add_init_script(
        "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {"
        " writeText: () => Promise.reject(new Error('denied')) } });"
    )
    page = context.new_page()
    try:
        page.goto(BASE + "use-with-ai/", timeout=30000)
        page.wait_for_selector("#mcp-endpoint", timeout=20000)
        page.locator("[data-copy-endpoint]").click()
        value = page.locator("#mcp-endpoint").input_value()
        selected = page.evaluate(
            """() => {
              const input = document.querySelector('#mcp-endpoint');
              return Boolean(input) && input.selectionStart === 0 && input.selectionEnd === input.value.length;
            }"""
        )
        step(
            "OK" if value.endswith("/mcp") and selected else "FAIL",
            f"{label} failed enhancement keeps endpoint recoverable",
            f"value={value} selected={selected}",
        )
    finally:
        context.close()


def maybe_sibling_surface(page, route: str, selector: str, name: str, required_text: str | None = None) -> None:
    """Bind when a sibling surface is present; skip plainly when it is not."""
    page.goto(BASE + route, timeout=30000)
    page.wait_for_selector("body", timeout=20000)
    count = page.locator(selector).count()
    if count == 0:
        step("SKIP", name, "sibling surface not on this tree; soft-depend")
        return
    html = page.content()
    text_ok = required_text is None or required_text in html
    step("OK" if text_ok else "FAIL", name, f"count={count} text_ok={text_ok}")



NOTICE_ROUTE = "notices/20260810048/"


def assert_research_tools_journey(page, label: str) -> None:
    """Notice More tools region plus API research task entrances."""
    page.set_default_timeout(20000)
    page.goto(BASE + NOTICE_ROUTE, timeout=30000)
    page.wait_for_selector("#noticeview .route-item, [data-edge-rendered='notice']", timeout=20000)
    page.wait_for_selector("[data-more-tools-region], [data-research-navigation]", timeout=20000)
    more = page.locator("[data-more-tools-region]")
    research = page.locator("[data-research-navigation] [data-research-tool]")
    if more.count():
        step(
            "OK" if more.count() == 1 and more.get_attribute("open") in (None, "") else "FAIL",
            f"{label} notice More tools starts closed",
            f"count={more.count()} open={more.get_attribute('open')}",
        )
        summary = more.locator("summary")
        if summary.count() == 1:
            summary.focus()
            page.keyboard.press("Enter")
            opened = more.evaluate("el => el.open")
            step("OK" if opened else "FAIL", f"{label} notice More tools keyboard open")
        for control_id in ("ncopy", "nqr", "nxlsx", "nprint"):
            step(
                "OK" if page.locator(f"#{control_id}").count() == 1 else "FAIL",
                f"{label} notice control #{control_id}",
            )
    else:
        step(
            "OK" if research.count() >= 1 else "FAIL",
            f"{label} notice research navigation without More tools shell",
            f"research={research.count()}",
        )
    if research.count():
        hrefs = research.evaluate_all("nodes => nodes.map(node => node.getAttribute('href') || '')")
        onsite = all(href.startswith("/") for href in hrefs)
        step("OK" if onsite else "FAIL", f"{label} notice research entrances stay on-site", str(len(hrefs)))

    page.goto(BASE + "api.html#research-task-entrances", timeout=30000)
    page.wait_for_selector("#research-task-entrances, body", timeout=20000)
    api_html = page.content()
    step(
        "OK" if 'id="research-task-entrances"' in api_html and "data-research-task=" in api_html else "FAIL",
        f"{label} API research task entrances",
    )


def run_ai_context(page, viewport_name: str, failures: list[str]) -> list[dict]:
    captures: list[dict] = []

    contract_url = (
        f"{BASE}use-with-ai/"
        f"?kind=contract&id={CONTRACT_ID}&procurement_id={CONTRACT_ID}"
        f"&route=/procurements/{CONTRACT_ID}&tool=get_contract&support=exact"
        f"&token=watch-secret&email=person@example.com&return=https://evil.example/x"
    )
    page.goto(contract_url, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_selector("[data-ai-context-panel]", timeout=15000)
    panel = page.locator("[data-ai-context-panel]")
    text = panel.inner_text()
    if CONTRACT_ID not in text:
        failures.append(f"{viewport_name}: contract panel missing exact id")
    if "get_contract" not in text:
        failures.append(f"{viewport_name}: contract panel missing tool")
    if "watch-secret" in text:
        failures.append(f"{viewport_name}: private token leaked into panel")
    if "person@example.com" in text:
        failures.append(f"{viewport_name}: email leaked into panel")
    if "evil.example" in text:
        failures.append(f"{viewport_name}: hostile return URL leaked into panel")
    step(
        "OK" if CONTRACT_ID in text and "get_contract" in text and "watch-secret" not in text else "FAIL",
        f"{viewport_name} contextual contract handoff",
    )

    page.evaluate(
        """() => {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async () => { throw new Error('denied'); } },
          });
        }"""
    )
    page.click("[data-copy-ai-context-task]")
    selected = page.evaluate(
        """() => {
          const el = document.querySelector('#ai-context-task-text');
          if (!el) return false;
          return document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === el.value.length;
        }"""
    )
    if not selected:
        failures.append(f"{viewport_name}: clipboard failure did not select task text")
    step("OK" if selected else "FAIL", f"{viewport_name} contextual clipboard fallback")
    captures.append({
        "route": "/use-with-ai/?kind=contract",
        "viewport": viewport_name,
        "assertion": "exact contract task panel with private fields stripped and clipboard fallback",
        "sha256": content_hash(panel.inner_html()),
    })

    notice_url = (
        f"{BASE}use-with-ai/"
        f"?kind=notice&id={NOTICE_ID}&request_id={NOTICE_ID}"
        f"&route=/notices/{NOTICE_ID}/&tool=get_notice&support=exact"
    )
    page.goto(notice_url, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_selector("[data-ai-context-panel]", timeout=15000)
    notice_text = page.locator("[data-ai-context-panel]").inner_text()
    if NOTICE_ID not in notice_text or "get_notice" not in notice_text:
        failures.append(f"{viewport_name}: notice panel missing RequestID or tool")
    step(
        "OK" if NOTICE_ID in notice_text and "get_notice" in notice_text else "FAIL",
        f"{viewport_name} contextual notice handoff",
    )
    captures.append({
        "route": f"/use-with-ai/?kind=notice&id={NOTICE_ID}",
        "viewport": viewport_name,
        "assertion": "notice RequestID preserved in contextual task",
        "sha256": content_hash(page.locator("[data-ai-context-panel]").inner_html()),
    })

    land_url = (
        f"{BASE}use-with-ai/"
        f"?kind=land_project&id={LAND_ID}&project_id={LAND_ID}"
        f"&route=/browse/zoning/%23land/{LAND_ID}&tool=get_land_project&support=exact"
    )
    page.goto(land_url, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_selector("[data-ai-context-panel]", timeout=15000)
    land_text = page.locator("[data-ai-context-panel]").inner_text()
    land_ok = LAND_ID in land_text and "get_land_project" in land_text and "get_land_decision_path" in land_text
    if not land_ok:
        failures.append(f"{viewport_name}: land panel missing project id or decision-path tools")
    step("OK" if land_ok else "FAIL", f"{viewport_name} contextual land handoff")
    captures.append({
        "route": f"/use-with-ai/?kind=land_project&id={LAND_ID}",
        "viewport": viewport_name,
        "assertion": "land project get and decision-path tools preserved",
        "sha256": content_hash(page.locator("[data-ai-context-panel]").inner_html()),
    })

    unsupported_url = (
        f"{BASE}use-with-ai/"
        f"?kind=search_scope&id=heat%20pumps&query=heat%20pumps&support=unsupported"
        f"&status=unsupported_filters&unsupported=boro,when&boro=Brooklyn&when=week"
    )
    page.goto(unsupported_url, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_selector("[data-ai-context-panel]", timeout=15000)
    unsupported_text = page.locator("[data-ai-context-panel]").inner_text()
    unsupported_ok = (
        ("boro" in unsupported_text.lower() or "unsupported" in unsupported_text.lower())
        and page.locator("#mcp-endpoint").count() == 1
    )
    if not unsupported_ok:
        failures.append(f"{viewport_name}: unsupported filters not disclosed or setup missing")
    step("OK" if unsupported_ok else "FAIL", f"{viewport_name} contextual unsupported filters")
    captures.append({
        "route": "/use-with-ai/?kind=search_scope&status=unsupported_filters",
        "viewport": viewport_name,
        "assertion": "unsupported filters disclosed while general setup remains reachable",
        "sha256": content_hash(page.locator("[data-ai-context-panel]").inner_html()),
    })

    page.focus("#ai-context-task-text")
    focused = page.evaluate("() => document.activeElement && document.activeElement.id === 'ai-context-task-text'")
    if not focused:
        failures.append(f"{viewport_name}: task textarea not keyboard-focusable")
    step("OK" if focused else "FAIL", f"{viewport_name} contextual task keyboard focus")
    return captures


def write_ai_context_manifest(captures: list[dict]) -> None:
    manifest_path = ROOT / "docs" / "evidence" / "assistant-context" / "ai-context-capture-manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    revision = os.environ.get("GIT_COMMIT") or os.environ.get("GITHUB_SHA") or "local"
    manifest = {
        "schema": "cityscroll.assistant_context_capture_manifest.v1",
        "case": "ai-context",
        "revision": f"grounded at {revision}",
        "data_vintage": "site build",
        "captures": captures,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    step("WRITE", "capture-manifest", str(manifest_path.relative_to(ROOT)))


def run_default_journeys(browser) -> None:
    assert_follow_calendar_journeys(browser)

    desktop_ctx, desktop = open_page(browser, DESKTOP)
    assert_introduction_journey(desktop, "desktop")
    assert_home_ask_link(desktop, "desktop")
    assert_keyboard_copy_fallback(desktop, "desktop")
    assert_translated_layout(desktop, "desktop")
    desktop_ctx.close()

    assert_failed_enhancement(browser, "desktop")

    desktop_ctx, desktop = open_page(browser, DESKTOP)
    assert_research_tools_journey(desktop, "desktop")
    maybe_sibling_surface(
        desktop,
        "browse/meetings/?agency=City%20Planning",
        "[data-ai-context-handoff], a[href*='use-with-ai'][data-ai-context]",
        "contextual AI handoff control",
    )
    desktop_ctx.close()

    phone_ctx, phone = open_page(browser, PHONE)
    assert_introduction_journey(phone, "phone")
    assert_home_ask_link(phone, "phone")
    assert_research_tools_journey(phone, "phone")
    phone_ctx.close()

    assert_no_js(browser, "desktop")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--case",
        choices=["all", "follow-calendar", "ai-context"],
        default="all",
        help="Discovery journey set to exercise (default: all).",
    )
    args = parser.parse_args()
    failures: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=_ARGS)
        if args.case in ("all", "follow-calendar"):
            run_default_journeys(browser)
        if args.case in ("all", "ai-context"):
            captures: list[dict] = []
            for viewport_name, size in VIEWPORTS:
                context = browser.new_context(viewport=size)
                page = context.new_page()
                step("RUN", "ai-context", viewport_name)
                captures.extend(run_ai_context(page, viewport_name, failures))
                context.close()
            write_ai_context_manifest(captures)
        browser.close()

    for item in failures:
        step("FAIL", item)

    failed = [name for tag, name in results if tag == "FAIL"]
    skipped = [name for tag, name in results if tag == "SKIP"]
    print(
        f"summary pass={sum(1 for tag, _ in results if tag == 'OK')} fail={len(failed)} skip={len(skipped)}",
        flush=True,
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
