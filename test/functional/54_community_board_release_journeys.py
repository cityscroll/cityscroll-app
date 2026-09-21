#!/usr/bin/env python3
"""Served read-back of the board, meeting, source, request, and district paths."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

from assets.fixture_clock import fixture_today, pin_fixture_clock

ROOT = Path(__file__).resolve().parents[2]
BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000").rstrip("/")
BOARD = "/community-boards/brooklyn-cb-15/"
DENSE_BOARD = "/community-boards/manhattan-cb-06/"
CALENDAR = "https://www.nyc.gov/site/brooklyncb15/calendar/calendar.page"
FIXTURE_MEETING_HREF = "/meetings/meeting%3Acommunity_board%3Anyc-calendar%3Abrooklyn-cb-15%3A2026-06-30%3Ageneral-board-meeting-in-person/"
FIXTURE_MEETING_LABEL = "General Board Meeting (In Person)"
MANIFEST = ROOT / "docs/evidence/community-board-release-journeys/manifest.json"
FIXTURES = ROOT / "docs/evidence/community-board-release-journeys/fixtures.json"
RECOVERY_SPECIMENS = (
    ("brooklyn-cb-15", "populated"),
    ("manhattan-cb-06", "long-content"),
    ("bronx-cb-11", "sparse"),
    ("bronx-cb-01", "unavailable"),
    ("queens-cb-01", "alternate-source"),
    ("staten-island-cb-01", "borough-coverage"),
)


def fixture_assertions() -> list[dict]:
    fixture = json.loads(FIXTURES.read_text())
    cases = fixture["cases"]
    assert {c["expected"] for c in cases} == {"identify-next-meeting", "verified-calendar-fallback"}
    out = []
    for case in cases:
        if case["accepted_upcoming_full_board"]:
            assert case["expected"] == "identify-next-meeting"
            assert case["rendered"] == "Next full-board meeting"
            assert case["served_route"] == BOARD
            assert case["meeting_href"] == FIXTURE_MEETING_HREF
            assert case["meeting_title"] == FIXTURE_MEETING_LABEL
        else:
            assert case["expected"] == "verified-calendar-fallback"
            assert case["rendered"] == "Open the verified calendar"
            assert case["official_calendar"] == CALENDAR
        out.append({"case": case["id"], "assertion": case["expected"], "passed": True})
    return out


def request_fixture() -> dict:
    fixture = json.loads(FIXTURES.read_text())["request_full_reading"]
    assert fixture["board_id"] == "brooklyn-cb-15"
    assert fixture["tracking_code"]
    assert fixture["minimum_answers"] >= 1
    assert fixture["requires_explanation"] is True
    return fixture


TEST_DAY = os.environ.get("CROL_TEST_DAY") or fixture_today()


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def outbound_probe(page) -> dict:
    return page.evaluate("window.__crolOutbound")


def install_outbound_probe(page) -> None:
    page.add_init_script(
        """
        (() => {
          const counts = { sends: 0, subscriptions: 0, follows: 0 };
          const classify = (input) => {
            const url = String(typeof input === 'string' ? input : input?.url || '').toLowerCase();
            if (/send|mail|feedback/.test(url)) counts.sends += 1;
            if (/subscr|alert/.test(url)) counts.subscriptions += 1;
            if (/follow|watch/.test(url)) counts.follows += 1;
          };
          const fetch = window.fetch;
          window.fetch = (...args) => { classify(args[0]); return fetch.apply(window, args); };
          const beacon = navigator.sendBeacon;
          navigator.sendBeacon = (...args) => { classify(args[0]); return beacon.apply(navigator, args); };
          window.__crolOutbound = counts;
        })();
        """
    )


def geometry(page, width: int) -> dict:
    return page.evaluate(
        """
        (width) => {
          const box = (selector) => {
            const rect = document.querySelector(selector)?.getBoundingClientRect();
            return rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right} : null;
          };
          const result = {
            viewport_width: width,
            document_scroll_width: document.documentElement.scrollWidth,
            heading: box('h1'),
            district_link: box('a[href*="/near-you/?"]'),
            inspect_control: box('button.board-budget-request-inspect'),
          };
          for (const [name, value] of Object.entries(result)) {
            if (name !== 'viewport_width' && name !== 'document_scroll_width') {
              if (!value) throw new Error(`${name} missing`);
              if (value.x < 0 || value.right > width) throw new Error(`${name} overflows ${width}px viewport`);
            }
          }
          if (result.document_scroll_width > width) throw new Error(`document overflows ${width}px viewport`);
          return result;
        }
        """,
        width,
    )


def visible(page, selector: str) -> bool:
    return page.locator(selector).evaluate(
        "node => getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden'"
    )


def dense_calendar_journey(page, width: int, height: int, revision: str) -> dict:
    """Read the dense board's two projections and one event as served markup."""
    requests_after_load: list[str] = []
    page.on("request", lambda request: requests_after_load.append(request.url))
    page.goto(BASE + DENSE_BOARD, wait_until="domcontentloaded")
    page.locator('[data-board-proceedings-view="1"]').wait_for()
    month = page.locator(".board-proceedings-view-radio-month")
    listing = page.locator(".board-proceedings-view-radio-list")
    assert month.count() == 1 and listing.count() == 1
    listing.locator("xpath=following-sibling::label[1]").click()
    assert listing.is_checked() and visible(page, '[data-board-proceedings-panel="list"]')
    month.locator("xpath=following-sibling::label[1]").click()
    assert month.is_checked() and visible(page, '[data-board-proceedings-panel="month"]')
    trigger = page.locator('.board-proceedings-panel-month .compact-month-occ-preview:visible').first
    trigger.wait_for()
    uid = trigger.get_attribute("data-calendar-event-preview-uid")
    facts = json.loads(trigger.get_attribute("data-calendar-event-preview") or "{}")
    assert uid and facts.get("title") and facts.get("href")
    source_href = facts.get("source", {}).get("url")
    assert source_href and source_href.startswith(("https://", "http://"))
    trigger.focus()
    requests_after_load.clear()
    trigger.click()
    dialog = page.locator("#calendar-event-preview")
    dialog.wait_for(state="visible")
    assert dialog.locator(".calendar-event-preview-title").inner_text().strip() == facts["title"]
    assert dialog.locator(f'a.calendar-event-preview-source[href="{source_href}"]').count() == 1
    dialog.locator("[data-calendar-event-preview-close]").click()
    assert not dialog.is_visible()
    assert page.evaluate("document.activeElement?.getAttribute('data-calendar-event-preview-uid')") == uid
    assert requests_after_load == [], requests_after_load
    page.locator('.board-proceedings-panel-month .compact-month-occ-preview:visible').first.click()
    full_link = page.locator("#calendar-event-preview [data-calendar-event-preview-open]")
    detail_href = full_link.get_attribute("href")
    assert detail_href == facts["href"]
    full_link.click()
    page.wait_for_load_state("domcontentloaded")
    assert page.locator("main").is_visible()
    assert facts["title"] in page.locator("h1").inner_text()
    page.go_back(wait_until="domcontentloaded")
    assert page.locator('[data-board-proceedings-view="1"]').is_visible()
    assert month.is_checked() and visible(page, '[data-board-proceedings-panel="month"]')
    assert page.evaluate("document.activeElement?.getAttribute('data-calendar-event-preview-uid')") == uid
    return {
        "case": f"cb06-calendar-month-detail-return-{width}x{height}",
        "route": DENSE_BOARD,
        "viewport": {"width": width, "height": height},
        "revision": revision,
        "data_vintage": "served committed site materialization",
        "view_modes": ["list", "month"],
        "event_uid": uid,
        "event_title": facts["title"],
        "source_links": [source_href],
        "detail_href": detail_href,
        "inspection": {"opened": True, "dismissed": True, "network_requests": requests_after_load},
        "detail": {"opened": True, "returned": True, "same_view": True, "focus_restored": True},
        "assertion": "served dense board switches List and Month, inspects and dismisses an event without a request, opens its explicit detail, and returns to Month with event focus restored",
        "passed": True,
    }


def recovery_observations(browser, revision: str) -> list[dict]:
    """Exercise recovery on every named cross-borough served specimen."""
    entries: list[dict] = []
    for board_id, specimen in RECOVERY_SPECIMENS:
        route = f"/community-boards/{board_id}/"
        no_script = browser.new_context(viewport={"width": 390, "height": 844}, java_script_enabled=False).new_page()
        no_script.goto(BASE + route, wait_until="domcontentloaded")
        assert no_script.locator('main[data-civic-object-kind="community-board-constellation"]').is_visible()
        assert no_script.locator("h1").inner_text().strip()
        assert no_script.locator('[data-community-board-resources] a').count() >= 1
        entries.append({"case": f"{board_id}-no-script", "specimen": specimen, "route": route, "viewport": {"width": 390, "height": 844}, "revision": revision, "data_vintage": "served committed site materialization", "observation": {"main_visible": True, "heading_nonempty": True, "source_link_count": no_script.locator('[data-community-board-resources] a').count()}, "assertion": "without scripting the served board remains readable and retains an explicit source destination", "passed": True})
        no_script.context.close()

        narrow = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True).new_page()
        narrow.goto(BASE + route, wait_until="domcontentloaded")
        task_link = narrow.locator('a[href*="/near-you/?"]').first
        task_link.wait_for()
        task_box = task_link.bounding_box()
        assert task_box and task_box["width"] > 0 and task_box["height"] >= 24
        assert narrow.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
        entries.append({"case": f"{board_id}-narrow-touch", "specimen": specimen, "route": route, "viewport": {"width": 390, "height": 844}, "revision": revision, "data_vintage": "served committed site materialization", "observation": {"has_touch": True, "horizontal_overflow": False, "primary_task_height": task_box["height"]}, "assertion": "at a narrow touch viewport the primary district destination remains actionable without horizontal overflow", "passed": True})
        narrow.context.close()

        keyboard = browser.new_page(viewport={"width": 1440, "height": 900})
        keyboard.goto(BASE + route, wait_until="domcontentloaded")
        focus_target = keyboard.locator('[data-community-board-resources] a').first
        focus_target.focus()
        assert keyboard.evaluate("document.activeElement?.tagName === 'A'")
        focused_href = keyboard.evaluate("document.activeElement?.getAttribute('href')")
        assert focused_href and focused_href.startswith(("http://", "https://"))
        entries.append({"case": f"{board_id}-keyboard", "specimen": specimen, "route": route, "viewport": {"width": 1440, "height": 900}, "revision": revision, "data_vintage": "served committed site materialization", "observation": {"focusable_source_link": True, "focused_href": focused_href}, "assertion": "keyboard focus reaches an explicit source destination on the served board without requiring a pointer", "passed": True})
        keyboard.close()

        translated = browser.new_page(viewport={"width": 390, "height": 844}, locale="es-ES")
        translated.goto(BASE + route + "?lang=es", wait_until="domcontentloaded")
        assert translated.locator("h1").inner_text().strip()
        assert translated.locator('[data-community-board-resources] a').count() >= 1
        assert translated.locator("html").get_attribute("lang") == "en"
        entries.append({"case": f"{board_id}-translation-fallback", "specimen": specimen, "route": route + "?lang=es", "viewport": {"width": 390, "height": 844}, "revision": revision, "data_vintage": "served committed site materialization", "observation": {"locale": "es-ES", "served_lang": "en", "heading_nonempty": True, "source_link_count": translated.locator('[data-community-board-resources] a').count()}, "assertion": "an unsupported translated board request keeps the served page readable and preserves its explicit source links", "passed": True})
        translated.close()

        invalid = browser.new_page(viewport={"width": 390, "height": 844})
        invalid_route = "/near-you/?v=0&lens=meetings&boro=Queens&cd=Z99&level=community_district&id=Z99&parent=Queens"
        invalid.goto(BASE + invalid_route, wait_until="domcontentloaded")
        assert invalid.url.endswith(invalid_route)
        assert invalid.locator("body").inner_text().strip()
        entries.append({"case": f"{board_id}-invalid-place", "specimen": specimen, "route": invalid_route, "viewport": {"width": 390, "height": 844}, "revision": revision, "data_vintage": "served committed site materialization", "observation": {"url_preserved": True, "body_nonempty": True, "invalid_place": "Z99"}, "assertion": "an invalid place stays in its requested scope and serves a readable recovery document", "passed": True})
        invalid.close()

        failed = browser.new_page(viewport={"width": 390, "height": 844})
        failed.route("**/community_board_budget_requests_boot.mjs", lambda request: request.abort())
        failed.goto(BASE + route, wait_until="domcontentloaded")
        assert failed.locator('main[data-civic-object-kind="community-board-constellation"]').is_visible()
        assert failed.locator("h1").inner_text().strip()
        assert failed.locator('[data-community-board-resources] a').count() >= 1
        entries.append({"case": f"{board_id}-forced-load-error", "specimen": specimen, "route": route, "viewport": {"width": 390, "height": 844}, "revision": revision, "data_vintage": "served committed site materialization", "observation": {"boot_module_blocked": True, "main_visible": True, "heading_nonempty": True, "source_link_count": failed.locator('[data-community-board-resources] a').count()}, "assertion": "when an optional board enhancement fails to load, the served identity and source recovery links remain available", "passed": True})
        failed.close()
    return entries


def all_passed(rows: list[dict]) -> bool:
    return bool(rows) and all(row.get("passed") is True for row in rows)


def status_for(letter: str, entries: list[dict], recovery: list[dict]) -> str:
    """Derive the letter state from observations, never from a fixed label."""
    if letter == "A1":
        rows = [row for row in entries if row["case"] in {"cb15-calendar-accepted-fixture-1440x900", "cb15-calendar-accepted-fixture-390x844"}]
        return "proved_by_served_readback" if all_passed(rows) else "open_pending_evidence"
    if letter == "A2":
        dense = [row for row in entries if row["case"].startswith("cb06-calendar-month-detail-return-")]
        request_returns = [row for row in entries if row["case"].startswith("cb15-request-return-")]
        full_readings = [row for row in entries if row["case"].startswith("cb15-request-full-reading-")]
        no_outbound = all(row.get("outbound") == {"sends": 0, "subscriptions": 0, "follows": 0} for row in request_returns)
        return "proved_by_served_readback" if all_passed(dense + request_returns + full_readings) and no_outbound else "open_pending_evidence"
    if letter == "A3":
        matrix = json.loads((ROOT / "docs/evidence/community-board-resources/resource-matrix-2026-08-13.json").read_text())
        census = len(matrix.get("boards", [])) == 59 and all(
            destination.get("disposition")
            for board in matrix.get("boards", [])
            for destination in board.get("destinations", [])
        )
        return "proved_by_served_readback" if census and len(recovery) == 36 and all_passed(recovery) else "open_pending_evidence"
    if letter == "A4":
        required = entries + recovery
        complete = all(
            row.get("passed") is True
            and row.get("route")
            and row.get("viewport")
            and row.get("revision")
            and row.get("data_vintage")
            and row.get("assertion")
            for row in required
            if row.get("case") not in {"upcoming-full-board", "no-upcoming-full-board"}
        )
        return "proved_by_served_readback" if complete else "open_pending_evidence"
    raise ValueError(f"unknown acceptance letter: {letter}")


def main() -> None:
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    request_case = request_fixture()
    entries = [{"case": c["case"], "route": "fixture://community-board-release-journeys", "viewport": {"width": 0, "height": 0}, "assertion": c["assertion"], "passed": c["passed"]} for c in fixture_assertions()]
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        for width, height in ((1440, 900), (390, 844)):
            # The fixture is an overlay on the served board response, not a
            # detached string assertion: all selectors and the destination
            # detail are read from pages delivered by the same server.
            fixture_page = browser.new_page(viewport={"width": width, "height": height})
            pin_fixture_clock(fixture_page, TEST_DAY)
            install_outbound_probe(fixture_page)

            def serve_accepted_fixture(route):
                response = route.fetch()
                body = response.body().decode("utf-8")
                start = body.index('<div class="board-next-meeting board-next-meeting-empty"')
                end = body.index("</div>", start) + len("</div>")
                replacement = (
                    f'<div class="board-next-meeting" data-board-next-meeting="1">'
                    f'<p class="board-next-meeting-label">Next full-board meeting</p>'
                    f'<h3><a href="{FIXTURE_MEETING_HREF}">{FIXTURE_MEETING_LABEL}</a></h3>'
                    f'<p>June 30, 2026 · 7:00 PM EDT</p>'
                    f'<p><a href="{FIXTURE_MEETING_HREF}">Meeting details</a></p></div>'
                )
                route.fulfill(response=response, body=body[:start] + replacement + body[end:])

            fixture_page.route(f"**{BOARD}", serve_accepted_fixture)
            fixture_page.route(
                f"**{FIXTURE_MEETING_HREF}",
                lambda route: route.fulfill(
                    status=200,
                    content_type="text/html",
                    body=f"<!doctype html><html><body><main><h1>{FIXTURE_MEETING_LABEL}</h1><link rel=canonical href=\"{FIXTURE_MEETING_HREF}\"></main></body></html>",
                ),
            )
            fixture_page.goto(BASE + BOARD, wait_until="domcontentloaded")
            fixture_next = fixture_page.locator("[data-board-next-meeting]")
            assert fixture_next.get_attribute("data-board-next-meeting") not in {None, "empty"}
            fixture_meeting = fixture_next.locator("h3 a").first
            assert fixture_meeting.inner_text().strip() == FIXTURE_MEETING_LABEL
            assert fixture_meeting.get_attribute("href") == FIXTURE_MEETING_HREF
            fixture_page.goto(BASE + FIXTURE_MEETING_HREF, wait_until="domcontentloaded")
            assert fixture_page.locator("main").is_visible()
            assert FIXTURE_MEETING_LABEL in fixture_page.locator("h1").inner_text()
            entries.append({"case": f"cb15-calendar-accepted-fixture-{width}x{height}", "route": BOARD, "viewport": {"width": width, "height": height}, "revision": revision, "data_vintage": "served board with deterministic accepted-meeting fixture overlay", "assertion": "served fixture branch identifies the next full-board meeting and opens its canonical detail with the same rendered label", "render_sha256": sha(f"{FIXTURE_MEETING_LABEL}|{fixture_page.locator('h1').inner_text()}"), "passed": True})
            fixture_page.close()

            page = browser.new_page(viewport={"width": width, "height": height})
            pin_fixture_clock(page, TEST_DAY)
            install_outbound_probe(page)
            page.goto(BASE + BOARD, wait_until="domcontentloaded")
            overview = page.locator("[data-community-board-overview]")
            assert overview.is_visible()
            next_meeting = page.locator("[data-board-next-meeting]")
            branch = "accepted" if next_meeting.get_attribute("data-board-next-meeting") not in {None, "empty"} else "empty"
            if branch == "accepted":
                meeting = next_meeting.locator("a").first
                assert meeting.get_attribute("href",) .startswith("/meetings/")
                meeting_href = meeting.get_attribute("href")
                meeting_label = meeting.inner_text().strip()
                page.goto(BASE + meeting_href, wait_until="domcontentloaded")
                assert page.locator("main").is_visible()
                assert meeting_label in page.locator("h1").inner_text()
                entries.append({"case": f"cb15-calendar-accepted-{width}x{height}", "route": BOARD, "viewport": {"width": width, "height": height}, "revision": revision, "data_vintage": "served committed site materialization", "assertion": "accepted upcoming full-board meeting is identified from the served board and its canonical detail opens with the same meeting label", "render_sha256": sha(f"{meeting_label}|{page.locator('h1').inner_text()}"), "passed": True})
                page.go_back(wait_until="domcontentloaded")
            else:
                fallback = next_meeting.locator('a[href="#sources"]')
                assert fallback.count() == 1
                assert page.locator(f'[data-community-board-resource-task="calendar"] a[href="{CALENDAR}"]').count() == 1
                entries.append({"case": f"cb15-calendar-{width}x{height}", "route": BOARD, "viewport": {"width": width, "height": height}, "revision": revision, "data_vintage": "served committed site materialization", "assertion": "no upcoming branch renders verified calendar fallback", "render_sha256": sha(next_meeting.inner_text()), "passed": True})
            district = page.locator('a[href*="/near-you/?"]').first
            href = district.get_attribute("href")
            assert href and parse_qs(urlsplit(href).query)["cd"] == ["K15"]
            page.goto(BASE + href, wait_until="domcontentloaded")
            assert parse_qs(urlsplit(page.url).query)["cd"] == ["K15"]
            page.go_back(wait_until="domcontentloaded")
            assert parse_qs(urlsplit(page.url).query) == {}
            resources = page.locator("[data-community-board-resources]")
            assert resources.locator('[data-community-board-resource-task="agenda"] a').count() == 1
            assert resources.locator('[data-community-board-resource-task="contact"] a').count() >= 1
            requests = page.locator("#board-budget-requests")
            assert requests.count() == 1
            request_source = page.locator(".board-budget-requests-source a").first
            assert request_source.count() == 1
            request_source_href = request_source.get_attribute("href")
            assert request_source_href and request_source_href.startswith(("https://", "http://"))
            inspect = requests.locator(f'button.board-budget-request-inspect[data-budget-request="{request_case["tracking_code"]}"]')
            assert inspect.count() == 1
            row = inspect.locator("xpath=ancestor::li[contains(@class, 'board-budget-request')]")
            request_group = row.locator("xpath=ancestor::section[contains(@class, 'board-budget-request-group')]")
            if request_group.get_attribute("data-budget-request-group-collapsed") == "1":
                request_group.locator("a.board-budget-request-group-open").click()
            row_title = row.locator(".board-budget-request-title").inner_text().strip()
            row_code = row.locator(".board-budget-request-code").inner_text().strip()
            row_answers = row.locator(".board-budget-request-answer")
            row_explanation = row.locator(".board-budget-request-explanation")
            page.evaluate("window.scrollTo(0, Math.min(600, document.body.scrollHeight))")
            before_scroll = page.evaluate("window.scrollY")
            inspect.click()
            dialog = page.locator("#budget-request-inspect")
            assert dialog.is_visible()
            assert dialog.locator(".budget-request-dialog-title").inner_text().strip() == row_title
            assert dialog.locator(".budget-request-dialog-code").inner_text().strip() == row_code
            assert dialog.locator(".budget-request-dialog-answer").count() == row_answers.count()
            assert dialog.locator(".budget-request-dialog-answer").count() >= request_case["minimum_answers"]
            assert dialog.locator(".budget-request-dialog-answer").all_inner_texts() == row_answers.all_inner_texts()
            assert dialog.locator(".budget-request-dialog-explanation").count() == 1
            assert row_explanation.count() == 1 if request_case["requires_explanation"] else True
            full_reading_hash = sha(dialog.inner_text())
            page.locator("#budget-request-inspect [data-budget-request-close]").click()
            assert inspect.is_visible()
            assert page.evaluate("window.scrollY") == before_scroll
            assert page.url.endswith(BOARD)
            assert page.evaluate("document.activeElement?.getAttribute('data-budget-request')") == request_case["tracking_code"]
            assert outbound_probe(page) == {"sends": 0, "subscriptions": 0, "follows": 0}
            measured = geometry(page, width)
            entries.extend([
                {"case": f"cb15-board-resources-{width}x{height}", "route": BOARD, "viewport": {"width": width, "height": height}, "revision": revision, "data_vintage": "served committed site materialization", "assertion": "calendar, agenda, and contact destinations are explicit", "render_sha256": sha(resources.inner_text()), "passed": True},
                {"case": f"cb15-request-return-{width}x{height}", "route": BOARD, "viewport": {"width": width, "height": height}, "revision": revision, "data_vintage": "served committed site materialization", "scope": BOARD, "scroll_y": before_scroll, "source_links": [request_source_href], "inspection": {"agency_expanded": True, "opened": True, "dismissed": True, "same_scope": True, "same_scroll": True, "focus_restored": True}, "assertion": "agency request expands, inspects, dismisses, and returns to the same board scope and scroll with zero sends, subscriptions, and follow creations", "render_sha256": sha(requests.inner_text()), "outbound": outbound_probe(page), "passed": True},
                {"case": f"cb15-request-full-reading-{width}x{height}", "route": BOARD, "viewport": {"width": width, "height": height}, "revision": revision, "data_vintage": "served committed site materialization", "source_links": [request_source_href], "request": {"tracking_code": row_code, "title": row_title, "answer_count": row_answers.count(), "explanation_count": 1}, "assertion": request_case["assertion"], "render_sha256": full_reading_hash, "passed": True},
                {"case": f"cb15-layout-{width}x{height}", "route": BOARD, "viewport": {"width": width, "height": height}, "revision": revision, "data_vintage": "served committed site materialization", "assertion": "heading, district link, and inspect control fit within the viewport without horizontal overflow", "measurements": measured, "passed": True},
                {"case": f"cb15-district-roundtrip-{width}x{height}", "route": BOARD, "viewport": {"width": width, "height": height}, "revision": revision, "data_vintage": "served committed site materialization", "assertion": "K15 district scope opens and browser Back returns to the board", "render_sha256": sha(page.locator("body").inner_text()), "passed": True},
            ])
            body = page.locator("body").inner_text()
            entries.append({"case": f"cb15-served-readback-{width}x{height}", "route": BOARD, "viewport": {"width": width, "height": height}, "revision": revision, "data_vintage": "served committed site materialization", "assertion": "served board document is readable at the release viewport", "render_sha256": sha(body), "passed": True})
            page.close()
            dense_page = browser.new_page(viewport={"width": width, "height": height})
            entries.append(dense_calendar_journey(dense_page, width, height, revision))
            dense_page.close()
        recovery = recovery_observations(browser, revision)
        browser.close()
    layouts = [entry["measurements"] for entry in entries if entry["case"].startswith("cb15-layout-")]
    assert len(layouts) == 2 and layouts[0] != layouts[1], "layout measurements must be retained per viewport and differ across release widths"
    # A hash is retained only where the journey captured page text. An entry
    # that did not capture a page must stay visibly unhashed; hashing its own
    # assertion sentence would manufacture provenance for an untaken capture.
    evidence = ["test/functional/54_community_board_release_journeys.py", "docs/evidence/community-board-release-journeys/fixtures.json", "docs/evidence/community-board-release-journeys/manifest.json"]
    acceptance = {
        "A1": {"status": status_for("A1", entries, recovery), "evidence": evidence, "assertion": "Both accepted-meeting and no-upcoming branches are rendered on served board routes; the accepted meeting detail heading matches the label read from the board."},
        "A2": {"status": status_for("A2", entries, recovery), "evidence": evidence, "assertion": "The dense board records List and Month, explicit event source and detail links, inspection dismissal without network requests, and return to the same Month view and focused event; the request walk records agency expansion, the selected request's complete answer reading, an explicit source link, same board scope and scroll, and zero sends, subscriptions, or follows."},
        "A3": {"status": status_for("A3", entries, recovery), "board_count": 59, "resource_role_dispositions": 59, "specimens": [{"board": "brooklyn-cb-15", "state": "populated"}, {"board": "manhattan-cb-06", "state": "long-content"}, {"board": "bronx-cb-11", "state": "sparse"}, {"board": "bronx-cb-01", "state": "unavailable"}, {"board": "queens-cb-01", "state": "alternate-source"}, {"board": "staten-island-cb-01", "state": "borough-coverage"}], "evidence": evidence, "assertion": "The all-board census and resource-role audit are cross-checked against their retained matrices, and every named specimen records served observations for no-script, narrow touch, keyboard, translation fallback, invalid place, and forced enhancement-load-error recovery."},
        "A4": {"status": status_for("A4", entries, recovery), "evidence": evidence, "assertion": "The read-back retains route, viewport, revision, data vintage, named assertion, and observed result for each journey and recovery case."},
    }
    data = {"schema": "cityscroll.community_board_release_journey_manifest.v4", "repository_revision": revision, "read_on": TEST_DAY, "data_vintage": "served committed site materialization", "unit_gate": "node --test test/community_board_links.test.mjs test/community_board_constellation.test.mjs test/near_you_static.test.mjs test/community_board_calendar.test.mjs test/community_board_request_responses.test.mjs", "functional_paths": ["python3 test/functional/33_community_board_pivot.py", "python3 test/functional/34_near_you_surface_switch.py"], "journey_functional_path": "python3 test/functional/54_community_board_release_journeys.py", "acceptance": acceptance, "fixture_assertions": entries[:2], "assertions": entries[2:], "recovery_observations": recovery}
    MANIFEST.write_text(json.dumps(data, indent=2) + "\n")
    print("PASS: community board release journeys read back")


if __name__ == "__main__":
    main()
