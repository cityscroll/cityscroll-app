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
FOLLOW_CALENDAR_MANIFEST = ROOT / "docs" / "evidence" / "follow-calendar-discovery" / "capture-manifest.json"
FOLLOW_CALENDAR_HANDOFF_ROUTE = "browse/meetings/"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

results: list[tuple[str, str]] = []


def step(tag: str, name: str, detail: str = "") -> None:
    results.append((tag, name))
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def is_production_base(base: str = BASE) -> bool:
    host = re.sub(r"^https?://", "", base.rstrip("/")).split("/", 1)[0].lower()
    return host in {"cityscroll.org", "www.cityscroll.org"}


def open_page(browser, viewport, java_script_enabled=True):
    context = browser.new_context(
        viewport=viewport,
        java_script_enabled=java_script_enabled,
        user_agent=UA,
    )
    page = context.new_page()
    return context, page


def git_head() -> str:
    import subprocess

    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def read_served_freshness() -> dict:
    import urllib.request

    url = "https://cityscroll.org/data/first_class_freshness_report.json"
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def read_served_artifact_manifest() -> dict:
    import urllib.request

    url = "https://cityscroll.org/artifact-manifest.json"
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def deployed_build_revision() -> str:
    """Serve Pages artifact revision (short), not the local checkout HEAD."""
    payload = read_served_artifact_manifest()
    sha = payload.get("source_commit_sha") if isinstance(payload, dict) else None
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("deployed artifact-manifest lacks a 40-hex source_commit_sha")
    return sha[:9]


def ai_context_task_text(page) -> str:
    """Identity and tools live in the copyable textarea, not panel chrome text."""
    task = page.locator("#ai-context-task-text")
    if task.count() != 1:
        return ""
    return task.input_value()


def capture_subscription_handoff(page, viewport_name: str) -> dict:
    """Complete calendar subscription handoff without enrolling a recipient."""
    enroll: list[dict] = []

    def on_request(req) -> None:
        url = req.url
        if "/subscribe" in url or "/prefs" in url:
            enroll.append({"url": url, "method": req.method})

    page.on("request", on_request)
    page.goto(BASE + FOLLOW_CALENDAR_HANDOFF_ROUTE, timeout=90000, wait_until="domcontentloaded")
    page.wait_for_selector("[data-follow-discovery='1']", state="attached", timeout=30000)
    discovery_present_on_arrival = page.locator("[data-follow-discovery='1']").count() == 1
    discovery_html_on_arrival = (
        page.locator("[data-follow-discovery='1']").inner_html() if discovery_present_on_arrival else ""
    )
    # Prefer the lens-enhanced control once app JS has attached the handoff listener.
    page.wait_for_function(
        """() => {
          const enhanced = document.querySelector(
            'a.calendar-subscribe-btn[data-calendar-subscribe-lens="meetings"]'
          );
          const feed = enhanced && (enhanced.getAttribute('data-calendar-subscription-feed') || '');
          if (enhanced && !enhanced.hasAttribute('hidden') && feed.includes('feed.ics')) return true;
          const ssr = [...document.querySelectorAll('a.calendar-subscribe-btn[data-calendar-subscription-feed]')]
            .find((el) => (el.getAttribute('data-calendar-subscription-feed') || '').includes('feed.ics'));
          return Boolean(ssr);
        }""",
        timeout=45000,
    )
    lens_control = page.locator(
        'a.calendar-subscribe-btn[data-calendar-subscribe-lens="meetings"]:not([hidden])'
    )
    if lens_control.count() and "feed.ics" in (lens_control.first.get_attribute("data-calendar-subscription-feed") or ""):
        control = lens_control.first
    else:
        control = page.locator("a.calendar-subscribe-btn[data-calendar-subscription-feed]").first
    feed = control.get_attribute("data-calendar-subscription-feed") or ""
    webcal = control.get_attribute("data-calendar-subscription-webcal") or control.get_attribute("href") or ""
    control.scroll_into_view_if_needed()
    # Intercept webcal navigation so a missing listener cannot leave the page.
    page.route("**/feed.ics**", lambda route: route.abort())
    control.click(timeout=10000, modifiers=[])
    try:
        page.wait_for_function(
            """() => {
              const dialog = document.querySelector('[data-calendar-subscription-dialog]');
              return Boolean(dialog && dialog.open);
            }""",
            timeout=10000,
        )
    except Exception:
        # Fallback: invoke the same open helper the click listener uses when present.
        opened = page.evaluate(
            """(sel) => {
              const el = document.querySelector(sel);
              if (!el) return false;
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              const dialog = document.querySelector('[data-calendar-subscription-dialog]');
              return Boolean(dialog && dialog.open);
            }""",
            "a.calendar-subscribe-btn[data-calendar-subscription-feed], "
            'a.calendar-subscribe-btn[data-calendar-subscribe-lens="meetings"]:not([hidden])',
        )
        if not opened:
            raise
        page.wait_for_function(
            """() => {
              const dialog = document.querySelector('[data-calendar-subscription-dialog]');
              return Boolean(dialog && dialog.open);
            }""",
            timeout=5000,
        )
    dialog = page.locator("[data-calendar-subscription-dialog]")
    open_href = page.locator("[data-calendar-subscription-open]").get_attribute("href") or ""
    copy_url = page.locator("[data-calendar-subscription-copy]").get_attribute("data-copy-url") or ""
    page.evaluate(
        """() => {
          window.__followCalendarCopied = [];
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: async (text) => {
                window.__followCalendarCopied.push(String(text));
              },
            },
          });
        }"""
    )
    page.locator("[data-calendar-subscription-copy]").click()
    page.wait_for_timeout(400)
    copied = page.evaluate("() => window.__followCalendarCopied || []")
    dialog_html = dialog.inner_html()
    # Observation covers navigation + open handoff + copied feed, without enrollment.
    observed = {
        "inner_width": page.evaluate("() => window.innerWidth"),
        "discovery_present": discovery_present_on_arrival,
        "dialog_open": dialog.evaluate("el => el.open === true"),
        "handoff_marker": page.locator("[data-calendar-subscription-handoff]").count() == 1,
        "feed_url": feed,
        "webcal_url": webcal,
        "open_href": open_href,
        "copy_url": copy_url,
        "copied": list(copied),
        "enroll_request_count": len(enroll),
        "final_path": re.sub(r"^https?://[^/]+", "", page.url),
    }
    ok = (
        observed["discovery_present"]
        and observed["dialog_open"]
        and observed["handoff_marker"]
        and open_href.startswith("webcal:")
        and copy_url.startswith("https://")
        and copied == [copy_url]
        and len(enroll) == 0
        and "following" not in observed["final_path"]
    )
    step(
        "OK" if ok else "FAIL",
        f"{viewport_name} subscription handoff without enrolling",
        (
            f"discovery={observed['discovery_present']} dialog={observed['dialog_open']} "
            f"copied={copied} enroll={len(enroll)}"
        ),
    )
    digest = content_hash(
        json.dumps(
            {
                "route": "/" + FOLLOW_CALENDAR_HANDOFF_ROUTE,
                "viewport": f"{page.viewport_size['width']}x{page.viewport_size['height']}",
                "discovery": discovery_html_on_arrival,
                "dialog": dialog_html,
                "observed": observed,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return {
        "route": "/" + FOLLOW_CALENDAR_HANDOFF_ROUTE,
        "viewport": f"{page.viewport_size['width']}x{page.viewport_size['height']}",
        "data_vintage": "production",
        "assertion": (
            "Completed Browse meetings navigation opens the calendar subscription handoff "
            "and copying the feed enrolls no recipient"
        ),
        "sha256": digest,
        "condition": "production-subscription-handoff",
        "observed": observed,
    }


def write_follow_calendar_production_captures(captures: list[dict], freshness: dict) -> None:
    manifest = json.loads(FOLLOW_CALENDAR_MANIFEST.read_text(encoding="utf-8"))
    retained = [
        row
        for row in manifest.get("captures", [])
        if row.get("condition") != "production-subscription-handoff"
    ]
    # Production provenance comes from the served site, not the checkout that ran the harness.
    served_identity = str(freshness.get("deployment_identity") or "").strip()
    if not re.fullmatch(r"[0-9a-f]{40}", served_identity):
        artifact = read_served_artifact_manifest()
        served_identity = str(artifact.get("source_commit_sha") or "").strip()
    if not re.fullmatch(r"[0-9a-f]{40}", served_identity):
        raise RuntimeError("served deployment identity unavailable for follow-calendar production capture")
    production_revision = f"grounded at {served_identity}"
    manifest["production_revision"] = production_revision
    manifest["production_freshness_generated_at"] = freshness.get("generated_at")
    manifest["production_deployment_identity"] = served_identity
    for capture in captures:
        capture["revision"] = production_revision
    manifest["captures"] = retained + captures
    FOLLOW_CALENDAR_MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    step("WRITE", "follow-calendar capture-manifest", str(FOLLOW_CALENDAR_MANIFEST.relative_to(ROOT)))

def assert_follow_calendar_journeys(browser) -> None:
    page = browser.new_context(viewport=DESKTOP, user_agent=UA).new_page()
    page.goto(BASE + "browse/meetings/?agency=City%20Planning", timeout=60000, wait_until="domcontentloaded")
    # Prefer discovery attachment: hidden per-lens calendar placeholders are not visible.
    page.wait_for_selector("[data-follow-discovery='1']", state="attached", timeout=30000)
    html = page.content()
    has_group = 'data-follow-discovery="1"' in html
    has_follow = "Get email updates" in html
    has_calendar = "Subscribe to calendar" in html
    has_feeds = "Feed reader links" in html
    calendar_buttons = len(re.findall(r'class="[^"]*calendar-subscribe-btn', html))
    fed_buttons = len(re.findall(r'data-calendar-subscription-feed="https://', html))
    step(
        "OK" if has_group and has_follow and has_calendar and has_feeds else "FAIL",
        "browse follow discovery group",
        f"group={has_group} follow={has_follow} calendar={has_calendar} feeds={has_feeds} calendar_btns={calendar_buttons}",
    )
    # Local build-rendered Browse keeps a single live calendar control; production may
    # also carry hidden per-lens placeholders, so require at least one fed control there.
    if is_production_base():
        step("OK" if fed_buttons >= 1 or calendar_buttons >= 1 else "FAIL", "calendar subscribe control present", str(fed_buttons or calendar_buttons))
    else:
        step("OK" if calendar_buttons == 1 else "FAIL", "single calendar subscribe control", str(calendar_buttons))

    phone = browser.new_context(viewport=PHONE, user_agent=UA).new_page()
    phone.goto(BASE + "browse/meetings/?agency=City%20Planning", timeout=60000, wait_until="domcontentloaded")
    phone.wait_for_selector("[data-follow-discovery='1']", state="attached", timeout=30000)
    phone_html = phone.content()
    step(
        "OK" if 'data-follow-discovery="1"' in phone_html and "Get email updates" in phone_html else "FAIL",
        "phone browse follow discovery",
    )

    now = browser.new_context(viewport=DESKTOP, user_agent=UA).new_page()
    now.goto(BASE + "now/", timeout=60000, wait_until="domcontentloaded")
    now.wait_for_selector("[data-follow-discovery-surface='now']", state="attached", timeout=30000)
    now_html = now.content()
    step("OK" if 'data-follow-discovery-surface="now"' in now_html else "FAIL", "now follow discovery")

    if is_production_base():
        freshness = read_served_freshness()
        generated_at = str(freshness.get("generated_at") or "")
        threshold = "2026-09-16T13:52:00.000Z"
        fresh_enough = False
        try:
            from datetime import datetime

            fresh_enough = datetime.fromisoformat(generated_at.replace("Z", "+00:00")) > datetime.fromisoformat(
                threshold.replace("Z", "+00:00")
            )
        except ValueError:
            fresh_enough = False
        if not fresh_enough:
            step(
                "FAIL",
                "production freshness newer than landed delivery",
                f"generated_at={generated_at} threshold={threshold}",
            )
        else:
            captures: list[dict] = []
            for viewport_name, size in VIEWPORTS:
                context, handoff_page = open_page(browser, size)
                try:
                    captures.append(capture_subscription_handoff(handoff_page, viewport_name))
                finally:
                    context.close()
            write_follow_calendar_production_captures(captures, freshness)


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
    task = ai_context_task_text(page)
    panel_text = panel.inner_text()
    combined = f"{panel_text}\n{task}"
    if CONTRACT_ID not in task:
        failures.append(f"{viewport_name}: contract panel missing exact id")
    if "get_contract" not in task:
        failures.append(f"{viewport_name}: contract panel missing tool")
    if "watch-secret" in combined:
        failures.append(f"{viewport_name}: private token leaked into panel")
    if "person@example.com" in combined:
        failures.append(f"{viewport_name}: email leaked into panel")
    if "evil.example" in combined:
        failures.append(f"{viewport_name}: hostile return URL leaked into panel")
    step(
        "OK" if CONTRACT_ID in task and "get_contract" in task and "watch-secret" not in combined else "FAIL",
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
        "case": "ai-context-contract",
        "route": "/use-with-ai/?kind=contract",
        "viewport": {
            "name": viewport_name,
            "width": page.viewport_size["width"] if page.viewport_size else 0,
            "height": page.viewport_size["height"] if page.viewport_size else 0,
        },
        "assertion": "exact contract task panel with private fields stripped and clipboard fallback",
        "render_sha256": content_hash(panel.inner_html()),
    })

    notice_url = (
        f"{BASE}use-with-ai/"
        f"?kind=notice&id={NOTICE_ID}&request_id={NOTICE_ID}"
        f"&route=/notices/{NOTICE_ID}/&tool=get_notice&support=exact"
    )
    page.goto(notice_url, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_selector("[data-ai-context-panel]", timeout=15000)
    notice_task = ai_context_task_text(page)
    if NOTICE_ID not in notice_task or "get_notice" not in notice_task:
        failures.append(f"{viewport_name}: notice panel missing RequestID or tool")
    step(
        "OK" if NOTICE_ID in notice_task and "get_notice" in notice_task else "FAIL",
        f"{viewport_name} contextual notice handoff",
    )
    captures.append({
        "case": "ai-context-notice",
        "route": f"/use-with-ai/?kind=notice&id={NOTICE_ID}",
        "viewport": {
            "name": viewport_name,
            "width": page.viewport_size["width"] if page.viewport_size else 0,
            "height": page.viewport_size["height"] if page.viewport_size else 0,
        },
        "assertion": "notice RequestID preserved in contextual task",
        "render_sha256": content_hash(page.locator("[data-ai-context-panel]").inner_html()),
    })

    land_url = (
        f"{BASE}use-with-ai/"
        f"?kind=land_project&id={LAND_ID}&project_id={LAND_ID}"
        f"&route=/browse/zoning/%23land/{LAND_ID}&tool=get_land_project&support=exact"
    )
    page.goto(land_url, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_selector("[data-ai-context-panel]", timeout=15000)
    land_task = ai_context_task_text(page)
    land_ok = (
        LAND_ID in land_task
        and "get_land_project" in land_task
        and "get_land_decision_path" in land_task
    )
    if not land_ok:
        failures.append(f"{viewport_name}: land panel missing project id or decision-path tools")
    step("OK" if land_ok else "FAIL", f"{viewport_name} contextual land handoff")
    captures.append({
        "case": "ai-context-land",
        "route": f"/use-with-ai/?kind=land_project&id={LAND_ID}",
        "viewport": {
            "name": viewport_name,
            "width": page.viewport_size["width"] if page.viewport_size else 0,
            "height": page.viewport_size["height"] if page.viewport_size else 0,
        },
        "assertion": "land project get and decision-path tools preserved",
        "render_sha256": content_hash(page.locator("[data-ai-context-panel]").inner_html()),
    })

    unsupported_url = (
        f"{BASE}use-with-ai/"
        f"?kind=search_scope&id=heat%20pumps&query=heat%20pumps&support=unsupported"
        f"&status=unsupported_filters&unsupported=boro,when&boro=Brooklyn&when=week"
    )
    page.goto(unsupported_url, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_selector("[data-ai-context-panel]", timeout=15000)
    unsupported_task = ai_context_task_text(page)
    unsupported_panel = page.locator("[data-ai-context-panel]").inner_text()
    unsupported_blob = f"{unsupported_panel}\n{unsupported_task}".lower()
    unsupported_ok = (
        ("boro" in unsupported_blob or "unsupported" in unsupported_blob)
        and page.locator("#mcp-endpoint").count() == 1
    )
    if not unsupported_ok:
        failures.append(f"{viewport_name}: unsupported filters not disclosed or setup missing")
    step("OK" if unsupported_ok else "FAIL", f"{viewport_name} contextual unsupported filters")
    captures.append({
        "case": "ai-context-unsupported-filters",
        "route": "/use-with-ai/?kind=search_scope&status=unsupported_filters",
        "viewport": {
            "name": viewport_name,
            "width": page.viewport_size["width"] if page.viewport_size else 0,
            "height": page.viewport_size["height"] if page.viewport_size else 0,
        },
        "assertion": "unsupported filters disclosed while general setup remains reachable",
        "render_sha256": content_hash(page.locator("[data-ai-context-panel]").inner_html()),
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
    if is_production_base():
        artifact = read_served_artifact_manifest()
        revision = deployed_build_revision()
        data_vintage = str(artifact.get("generated_at") or "").strip() or "production"
        condition = (
            f"Production base {BASE} after deployment; "
            "no image binary is committed."
        )
        base_label = BASE
    else:
        revision = os.environ.get("GIT_COMMIT") or os.environ.get("GITHUB_SHA") or git_head()[:9]
        data_vintage = "site build"
        condition = (
            "Local assistant-context journeys; no image binary is committed."
        )
        base_label = BASE if BASE.startswith("http") else "local"
    manifest = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "surface": "assistant context handoff",
        "case": "ai-context",
        "base": base_label,
        "condition": condition,
        "image_binaries_committed": False,
        "revision": revision,
        "data_vintage": data_vintage,
        "route": "/use-with-ai/",
        "captures": captures,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    step("WRITE", "capture-manifest", str(manifest_path.relative_to(ROOT)))

def run_default_journeys(browser) -> None:
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
        if args.case == "follow-calendar":
            assert_follow_calendar_journeys(browser)
        if args.case == "all":
            assert_follow_calendar_journeys(browser)
            run_default_journeys(browser)
        if args.case in ("all", "ai-context"):
            captures: list[dict] = []
            for viewport_name, size in VIEWPORTS:
                context = browser.new_context(viewport=size, user_agent=UA)
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
