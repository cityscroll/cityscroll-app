#!/usr/bin/env python3
"""Capture before/after changelog media from real repository revisions.

The script resolves a PR's merge commit, checks out that commit and its first parent into
temporary worktrees, serves each worktree over a local static HTTP server, and drives the
same feature flow in Playwright. Every remote request is intercepted with deterministic
fixtures. In particular, the subscription request is fulfilled in the browser and never
reaches a production write endpoint.

Media-fit doctrine (apply this judgment when adding a scenario): a screen recording teaches a
FLOW — a sequence of clicks/typing/confirmation, best shown in motion. A 390px before/after
pair teaches a MOBILE-FIRST change — something whose point only lands on a phone-sized screen
(arriving from a digest link, a layout fix). A 1440px before/after pair teaches a DENSE DESKTOP
surface — a table, dashboard, or side-by-side arrangement that only reads at width. Default to
ONE form per entry; add a second only when the change genuinely has two distinct teaching
points. A SCENARIOS entry's "forms" list declares which form(s) it captures — most scenarios
should list exactly one.

    python3 tools/capture_changelog_media.py --pr 80
    python3 tools/capture_changelog_media.py --pr 80 --merge-commit 11947c9   # explicit revision
    python3 tools/capture_changelog_media.py --pr 80 --forms recording       # capture a subset

Outputs are written to media/changelog/pr-<n>/. Screenshot pairs are captured at the viewport(s)
the scenario declares (390x844 and/or 1440x900). A recording's 780x620 capture is transcoded to
compact, silent VP9 WebM and must remain below 3 MB. Add another entry to SCENARIOS when a
future changelog item needs a different route or interaction.

Requires Python Playwright with Chromium plus ffmpeg. The repository's CI setup command is:

    pip install playwright && playwright install chromium
"""

from __future__ import annotations

import argparse
import functools
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
MAX_VIDEO_BYTES = 3 * 1024 * 1024

# Shared across the pr-80 (award-watch) and pr-74 (deep-link) scenarios — both are captured
# against the same notice, since PR 74 shipped before PR 80 and a single realistic fixture
# keeps the two scenarios' fixtures from drifting apart for no reason.
ELEVATOR_NOTICE = {
    "request_id": "20260717080",
    "start_date": "2026-07-17T09:00:00.000",
    "agency_name": "Housing Authority",
    "type_of_notice_description": "Solicitation",
    "category_description": "Construction Services",
    "short_title": "ELEVATOR MODERNIZATION AT EAST RIVER HOUSES",
    "pin": "RFQ-2026-080",
    "due_date": "2026-08-14T17:00:00.000",
    "address_to_request": "90 Church Street, New York, NY 10007",
    "contact_name": "Procurement Office",
    "contact_phone": "(212) 555-0100",
    "email": "procurement@example.nyc.gov",
    "selection_method_description": "Competitive Sealed Bids",
    "additional_description_1": "The Housing Authority seeks bids for elevator modernization at East River Houses.",
    "section_name": "Procurement",
}

# A plausible, fabricated fixture for the pr-50 (typing a sentence into an alert) recording —
# an Award-type row so the resolved "$200K, education" query has something real to preview.
EDUCATION_AWARD = {
    "request_id": "20260615041",
    "start_date": "2026-06-15T09:00:00.000",
    "agency_name": "Department of Education",
    "type_of_notice_description": "Award",
    "category_description": "Human Services",
    "short_title": "SPECIAL EDUCATION RELATED SERVICES",
    "pin": "85026R0012001",
    "vendor_name": "Example Learning Services LLC",
    "contract_amount": 450000,
    "additional_description_1": "Related services for students receiving special education instruction.",
    "section_name": "Procurement",
}

STATS_FIXTURE = {
    "generated": "2026-07-16T12:00:00.000Z",
    "subscriptions": {"active": 214},
    "digests": {
        "sent_last7d": 58,
        "sent_today": 9,
        "sent_all_time": 611,
        "by_category": {
            "Procurement": 210,
            "Human Services": 140,
            "Construction Services": 95,
            "Goods": 88,
            "Services (Other than Human Services)": 52,
            "Construction/Construction Services": 26,
        },
    },
    "digest_clicks": {"last7d": 37},
    "feeds": {"fetches_last7d": 812},
    "batch": {"calls_last7d": 64},
    "shared_investigations": {"created_last7d": 5},
    "nl_search": {
        "calls_last7d": 143,
        "calls_today": 21,
        "calls_all_time": 960,
        "by_category_last7d": {"money": 63, "people": 24, "land": 19, "property": 14, "rules": 12, "meetings": 11},
        "by_category": {"money": 420, "people": 180, "land": 140, "property": 90, "rules": 70, "meetings": 60},
    },
    "history": {
        "digests": {"live_from": "2026-06-01", "by_day": {"2026-07-14": 8, "2026-07-15": 9, "2026-07-16": 9}},
        "nl_search": {"live_from": "2026-06-01", "by_day": {"2026-07-14": 19, "2026-07-15": 22, "2026-07-16": 21}},
        "watches_active": {"live_from": "2026-07-16", "by_day": {"2026-07-16": 214}},
    },
}

SCENARIOS = {
    80: {
        "kind": "notice-award-watch",
        "forms": ["recording"],
        "notice_id": "20260717080",
        "notice": ELEVATOR_NOTICE,
    },
    74: {
        "kind": "notice-deeplink",
        "forms": ["screens"],
        "viewport": (390, 844),
        "notice_id": "20260717080",
        "notice": ELEVATOR_NOTICE,
        "watch": {"lens": "money", "filter": {"keywords": ["elevator"]}},
    },
    62: {
        "kind": "stats-page",
        "forms": ["screens"],
        "viewport": (1440, 900),
        "stats_payload": STATS_FIXTURE,
    },
    50: {
        "kind": "quiz-nl",
        "forms": ["recording"],
        "query_text": "education contracts over $200K due in 3 months",
        "award_row": EDUCATION_AWARD,
        "nl_filter": {"keywords": ["education"], "minAmount": 200000, "months": 3},
    },
}


def run(*args: str, cwd: Path = ROOT, capture: bool = False) -> str:
    result = subprocess.run(
        args,
        cwd=cwd,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else ""


def resolve_merge_commit(pr: int, explicit: str | None) -> str:
    if explicit:
        return run("git", "rev-parse", f"{explicit}^{{commit}}", capture=True)
    rows = run("git", "log", "--all", "--format=%H%x09%s", capture=True).splitlines()
    suffix = f"(#{pr})"
    matches = [row.split("\t", 1)[0] for row in rows if row.rsplit("\t", 1)[-1].endswith(suffix)]
    if not matches:
        raise SystemExit(f"Could not find a merge commit ending in {suffix}; pass --merge-commit.")
    return matches[0]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path):
        handler = functools.partial(QuietHandler, directory=str(directory))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def json_response(route: Route, body: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def install_common_routes(page: Page) -> None:
    """Fixtures shared by every scenario: abort anything not explicitly stubbed, and abort the
    third-party hosts a capture should never actually reach. Playwright applies the most
    recently registered matching route first, so a scenario's own more specific routes must be
    registered AFTER calling this, not before."""
    page.route("https://**", lambda route: route.abort())
    page.route("https://data.cityofnewyork.us/**", lambda route: json_response(route, []))
    page.route("https://api.crol-list.org/**", lambda route: json_response(route, {}))
    page.route("https://crol-worker.crol-worker.workers.dev/**", lambda route: json_response(route, {}))
    page.route("https://challenges.cloudflare.com/**", lambda route: route.abort())
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
    page.route("https://static.cloudflareinsights.com/**", lambda route: route.abort())
    page.route("https://unpkg.com/**", lambda route: route.abort())
    page.add_init_script(
        "window.turnstile = {getResponse: () => 'local-capture-token', reset: () => {}};"
    )


def install_notice_routes(page: Page, notice: dict) -> None:
    install_common_routes(page)

    def soda(route: Route) -> None:
        query = {key: values[0] for key, values in parse_qs(urlparse(route.request.url).query).items()}
        select = query.get("$select", "")
        where = query.get("$where", "")
        if "request_id='" in where:
            body = [notice]
        elif "pin='" in where:
            body = [notice]
        elif "max(start_date) as m" in select:
            body = [{"m": "2026-07-17T09:00:00.000"}]
        elif "count(1) as n" in select:
            body = [{"n": "0"}]
        else:
            body = []
        json_response(route, body)

    def api(route: Route) -> None:
        path = urlparse(route.request.url).path
        if path == "/externalaward":
            json_response(route, {"coverage": "exact", "matches": [], "ok": True})
        elif path == "/subscribe":
            json_response(route, {"ok": True})
        elif path.startswith("/priorcycle/"):
            json_response(route, {"strict": [], "near": [], "eligibleCount": 0, "ok": True})
        elif path.startswith("/inv/"):
            json_response(route, {"forecasts": []})
        else:
            json_response(route, {})

    page.route("https://data.cityofnewyork.us/**", lambda route: json_response(route, []))
    page.route("https://data.cityofnewyork.us/resource/dg92-zbpx.json*", soda)
    page.route("https://api.crol-list.org/**", api)
    page.route("https://crol-worker.crol-worker.workers.dev/**", api)


def install_stats_routes(page: Page, payload: dict) -> None:
    install_common_routes(page)

    def stats(route: Route) -> None:
        json_response(route, payload)

    page.route("https://api.crol-list.org/stats", stats)
    page.route("https://crol-worker.crol-worker.workers.dev/stats", stats)


def install_quiz_routes(page: Page, award_row: dict, nl_filter: dict) -> None:
    install_common_routes(page)

    def soda(route: Route) -> None:
        query = {key: values[0] for key, values in parse_qs(urlparse(route.request.url).query).items()}
        where = query.get("$where", "")
        body = [award_row] if "type_of_notice_description='Award'" in where else []
        json_response(route, body)

    def api(route: Route) -> None:
        req = route.request
        path = urlparse(req.url).path
        if path == "/nl" and req.method == "POST":
            json_response(route, {"filter": nl_filter, "degraded": False})
        else:
            json_response(route, {})

    page.route("https://data.cityofnewyork.us/**", lambda route: json_response(route, []))
    page.route("https://data.cityofnewyork.us/resource/dg92-zbpx.json*", soda)
    page.route("https://api.crol-list.org/**", api)
    page.route("https://crol-worker.crol-worker.workers.dev/**", api)


def open_notice(page: Page, base_url: str, hash_suffix: str, expect_offer: bool | None = None) -> None:
    page.goto(f"{base_url}#notice/{hash_suffix}", wait_until="networkidle")
    page.locator(".rolename").wait_for(state="visible")
    if expect_offer is True:
        page.locator("[data-award-watch-offer]").wait_for(state="visible")
    elif expect_offer is False:
        if page.locator("[data-award-watch-offer]").count():
            raise AssertionError("The before revision unexpectedly rendered the award-watch offer.")
    page.evaluate("document.fonts && document.fonts.ready")


def center_feature(page: Page, selector: str) -> None:
    page.locator(selector).scroll_into_view_if_needed()
    page.evaluate(
        """(sel) => {
          const el = document.querySelector(sel);
          window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - innerHeight * .48));
        }""",
        selector,
    )
    page.wait_for_timeout(300)


# ===== pr-80: notice-award-watch (recording only) =====

def capture_award_watch_recording(browser, after_tree: Path, scenario: dict, output: Path, scratch: Path) -> None:
    raw_dir = scratch / "raw-video"
    raw_dir.mkdir()
    with StaticServer(after_tree) as base_url:
        context = browser.new_context(
            viewport={"width": 780, "height": 620},
            record_video_dir=raw_dir,
            record_video_size={"width": 780, "height": 620},
        )
        page = context.new_page()
        install_notice_routes(page, scenario["notice"])
        open_notice(page, base_url, scenario["notice_id"], expect_offer=True)
        center_feature(page, "#nexternal")
        page.screenshot(path=output / "poster-780.png", animations="disabled")
        page.wait_for_timeout(2200)
        page.locator("[data-award-watch-offer]").click()
        page.locator("#adest").wait_for(state="visible")
        page.wait_for_timeout(2600)
        page.locator("#adest").fill("reader@example.com")
        page.wait_for_timeout(2200)
        page.locator("#asubscribe").click()
        page.locator("#asubmsg").filter(has_text="Check your inbox").wait_for(state="visible")
        page.wait_for_timeout(4000)
        video = page.video
        page.close()
        context.close()
        raw = scratch / "award-watch-raw.webm"
        video.save_as(raw)
    transcode_video(raw, output / "award-watch.webm")


# ===== pr-74: notice-deeplink (390px before/after pair) =====

def capture_deeplink_screens(browser, before_tree: Path, after_tree: Path, scenario: dict, output: Path) -> None:
    width, height = scenario["viewport"]
    notice_id = scenario["notice_id"]
    encoded = urllib.parse.quote(
        json.dumps({"lens": scenario["watch"]["lens"], "filter": scenario["watch"]["filter"]}, separators=(",", ":")),
        safe="",
    )
    hash_by_state = {"before": notice_id, "after": f"{notice_id}?w={encoded}"}
    trees = {"before": before_tree, "after": after_tree}
    for state in ("before", "after"):
        with StaticServer(trees[state]) as base_url:
            context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
            page = context.new_page()
            install_notice_routes(page, scenario["notice"])
            open_notice(page, base_url, hash_by_state[state])
            page.evaluate("window.scrollTo(0, 0)")
            page.wait_for_timeout(250)
            page.screenshot(path=output / f"{state}-{width}.png", animations="disabled")
            context.close()


# ===== pr-62: stats-page (1440px before/after pair) =====

def capture_stats_screens(browser, before_tree: Path, after_tree: Path, scenario: dict, output: Path) -> None:
    width, height = scenario["viewport"]
    trees = {"before": before_tree, "after": after_tree}
    for state in ("before", "after"):
        with StaticServer(trees[state]) as base_url:
            context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
            page = context.new_page()
            install_stats_routes(page, scenario["stats_payload"])
            page.goto(f"{base_url}stats.html", wait_until="networkidle")
            page.locator("#grid").wait_for(state="visible")
            page.evaluate(
                """() => {
                  const el = document.querySelector('#gridAllTime');
                  if (el) window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - 24));
                }"""
            )
            page.wait_for_timeout(300)
            page.screenshot(path=output / f"{state}-{width}.png", animations="disabled")
            context.close()


# ===== pr-50: quiz-nl (recording only) =====

def capture_quiz_nl_recording(browser, after_tree: Path, scenario: dict, output: Path, scratch: Path) -> None:
    raw_dir = scratch / "raw-video"
    raw_dir.mkdir()
    with StaticServer(after_tree) as base_url:
        context = browser.new_context(
            viewport={"width": 780, "height": 620},
            record_video_dir=raw_dir,
            record_video_size={"width": 780, "height": 620},
        )
        page = context.new_page()
        install_quiz_routes(page, scenario["award_row"], scenario["nl_filter"])
        page.goto(f"{base_url}#alerts", wait_until="networkidle")
        page.locator("#quizpanel").wait_for(state="visible")
        page.locator("#quizpanel").scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        page.screenshot(path=output / "poster-780.png", animations="disabled")
        page.wait_for_timeout(1400)
        page.locator('#quizwhat .chip[data-w="rfpkw"]').click()
        page.wait_for_timeout(1000)
        page.locator("#quiznarrow").click()
        page.locator("#quiznarrow").fill(scenario["query_text"])
        page.wait_for_timeout(1500)
        page.locator("#quizgo").click()
        page.locator("#apreviewbox .emailmock").wait_for(state="visible")
        page.wait_for_timeout(3500)
        video = page.video
        page.close()
        context.close()
        raw = scratch / "quiz-nl-raw.webm"
        video.save_as(raw)
    transcode_video(raw, output / "quiz-nl.webm")


def transcode_video(raw: Path, destination: Path) -> None:
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg is required to produce the compact WebM recording.")
    command = [
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-an",
        "-c:v", "libvpx-vp9", "-crf", "39", "-b:v", "0", "-deadline", "good",
        "-cpu-used", "4", "-row-mt", "1", str(destination),
    ]
    run(*command)
    if destination.stat().st_size > MAX_VIDEO_BYTES:
        command[command.index("39")] = "45"
        command[command.index("-an"):command.index("-an") + 1] = ["-vf", "scale=640:-2", "-an"]
        run(*command)
    if destination.stat().st_size > MAX_VIDEO_BYTES:
        raise SystemExit(f"Recording is {destination.stat().st_size} bytes; the 3 MB budget was exceeded.")


def capture_changelog_verification(browser, output: Path) -> None:
    """Capture the generated changelog page itself at the two required review widths."""
    with StaticServer(ROOT) as base_url:
        for width, height in ((390, 844), (1440, 900)):
            context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
            page = context.new_page()
            page.route("https://**", lambda route: route.abort())
            page.goto(f"{base_url}changelog.html", wait_until="domcontentloaded")
            media = page.locator(".chg-media").first
            media.wait_for(state="visible")
            page.evaluate(
                """const el=document.querySelector('.chg-media');
                window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - 12));"""
            )
            page.wait_for_timeout(300)
            if page.evaluate("document.documentElement.scrollWidth !== innerWidth"):
                raise AssertionError(f"changelog.html overflows horizontally at {width}px")
            page.screenshot(path=output / f"verification-changelog-{width}.png", animations="disabled")
            context.close()


def add_worktree(path: Path, revision: str) -> None:
    run("git", "worktree", "add", "--detach", str(path), revision)


def remove_worktree(path: Path) -> None:
    run("git", "worktree", "remove", "--force", str(path))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pr", type=int, required=True, help="Changelog PR number to capture")
    parser.add_argument("--merge-commit", help="Merge revision; auto-resolved from the PR suffix when omitted")
    parser.add_argument(
        "--forms",
        nargs="+",
        choices=["recording", "screens", "verify"],
        help="Capture only these forms (default: every form the scenario declares, plus verify)",
    )
    args = parser.parse_args()

    scenario = SCENARIOS.get(args.pr)
    if not scenario:
        raise SystemExit(f"No capture scenario is registered for PR {args.pr}.")

    forms = args.forms or (scenario["forms"] + ["verify"])
    needs_recording = "recording" in forms and "recording" in scenario["forms"]
    needs_screens = "screens" in forms and "screens" in scenario["forms"]
    needs_verify = "verify" in forms

    merge = resolve_merge_commit(args.pr, args.merge_commit)
    before = run("git", "rev-parse", f"{merge}^1", capture=True)
    output = ROOT / "media" / "changelog" / f"pr-{args.pr}"
    output.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix=f"crol-pr-{args.pr}-") as temp:
        scratch = Path(temp)
        after_tree = scratch / "after"
        add_worktree(after_tree, merge)
        before_tree = None
        if needs_screens:
            before_tree = scratch / "before"
            add_worktree(before_tree, before)
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                kind = scenario["kind"]
                if needs_recording:
                    if kind == "notice-award-watch":
                        capture_award_watch_recording(browser, after_tree, scenario, output, scratch)
                    elif kind == "quiz-nl":
                        capture_quiz_nl_recording(browser, after_tree, scenario, output, scratch)
                    else:
                        raise SystemExit(f"PR {args.pr}'s scenario ({kind}) has no recording capture.")
                if needs_screens:
                    if kind == "notice-deeplink":
                        capture_deeplink_screens(browser, before_tree, after_tree, scenario, output)
                    elif kind == "stats-page":
                        capture_stats_screens(browser, before_tree, after_tree, scenario, output)
                    else:
                        raise SystemExit(f"PR {args.pr}'s scenario ({kind}) has no screens capture.")
                if needs_verify:
                    capture_changelog_verification(browser, output)
                browser.close()
        finally:
            remove_worktree(after_tree)
            if before_tree is not None:
                remove_worktree(before_tree)

    print(f"Captured PR {args.pr} ({scenario['kind']}) from {before[:12]} (before) and {merge[:12]} (after):")
    for asset in sorted(output.iterdir()):
        print(f"  {asset.relative_to(ROOT)}  {asset.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
