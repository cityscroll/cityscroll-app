#!/usr/bin/env python3
"""Capture before/after changelog media from real repository revisions.

The script resolves a PR's merge commit, checks out that commit and its first parent into
temporary worktrees, serves each worktree over a local static HTTP server, and drives the
same feature flow in Playwright. Every remote request is intercepted with deterministic
fixtures. In particular, the subscription request is fulfilled in the browser and never
reaches a production write endpoint.

PR 80 is the first supported scenario:

    python3 tools/capture_changelog_media.py --pr 80

To reproduce a capture from an explicit revision:

    python3 tools/capture_changelog_media.py --pr 80 --merge-commit 11947c9

Outputs are written to media/changelog/pr-<n>/. The four PNG files are captured from
390x844 and 1440x900 browser viewports. The 780x620 interaction recording is transcoded
to compact, silent VP9 WebM and must remain below 3 MB. Add another entry to SCENARIOS
when a future changelog item needs a different route or interaction.

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
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
MAX_VIDEO_BYTES = 3 * 1024 * 1024

SCENARIOS = {
    80: {
        "notice_id": "20260717080",
        "notice": {
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
        },
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


def install_routes(page: Page, scenario: dict[str, object]) -> None:
    notice = scenario["notice"]

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

    # Playwright applies the most recently registered matching route first, so broad fallbacks
    # are registered before the deterministic routes that must win.
    page.route("https://**", lambda route: route.abort())
    page.route("https://data.cityofnewyork.us/**", lambda route: json_response(route, []))
    page.route("https://data.cityofnewyork.us/resource/dg92-zbpx.json*", soda)
    page.route("https://api.crol-list.org/**", api)
    page.route("https://crol-worker.crol-worker.workers.dev/**", api)
    page.route("https://challenges.cloudflare.com/**", lambda route: route.abort())
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
    page.route("https://static.cloudflareinsights.com/**", lambda route: route.abort())
    page.route("https://unpkg.com/**", lambda route: route.abort())
    page.add_init_script(
        "window.turnstile = {getResponse: () => 'local-capture-token', reset: () => {}};"
    )


def open_notice(page: Page, base_url: str, scenario: dict[str, object], expect_offer: bool) -> None:
    install_routes(page, scenario)
    page.goto(f"{base_url}#notice/{scenario['notice_id']}", wait_until="networkidle")
    page.locator("#nexternal .note").wait_for(state="visible")
    if expect_offer:
        page.locator("[data-award-watch-offer]").wait_for(state="visible")
    else:
        if page.locator("[data-award-watch-offer]").count():
            raise AssertionError("The before revision unexpectedly rendered the award-watch offer.")
    page.evaluate("document.fonts && document.fonts.ready")


def center_feature(page: Page) -> None:
    page.locator("#nexternal").scroll_into_view_if_needed()
    page.evaluate(
        """const el=document.querySelector('#nexternal');
        window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - innerHeight * .48));"""
    )
    page.wait_for_timeout(300)


def capture_screenshots(browser, worktree: Path, state: str, scenario: dict[str, object], output: Path) -> None:
    with StaticServer(worktree) as base_url:
        for width, height in ((390, 844), (1440, 900)):
            context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
            page = context.new_page()
            open_notice(page, base_url, scenario, expect_offer=state == "after")
            center_feature(page)
            page.screenshot(path=output / f"{state}-{width}.png", animations="disabled")
            context.close()


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


def capture_recording(browser, worktree: Path, scenario: dict[str, object], output: Path, scratch: Path) -> None:
    raw_dir = scratch / "raw-video"
    raw_dir.mkdir()
    with StaticServer(worktree) as base_url:
        context = browser.new_context(
            viewport={"width": 780, "height": 620},
            record_video_dir=raw_dir,
            record_video_size={"width": 780, "height": 620},
        )
        page = context.new_page()
        open_notice(page, base_url, scenario, expect_offer=True)
        center_feature(page)
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


def capture_changelog_verification(browser, output: Path) -> None:
    """Capture the generated changelog page itself at the two required review widths."""
    with StaticServer(ROOT) as base_url:
        for width, height in ((390, 844), (1440, 900)):
            context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
            page = context.new_page()
            page.route("https://**", lambda route: route.abort())
            page.goto(f"{base_url}changelog.html", wait_until="domcontentloaded")
            media = page.locator(".chg-media")
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pr", type=int, required=True, help="Changelog PR number to capture")
    parser.add_argument("--merge-commit", help="Merge revision; auto-resolved from the PR suffix when omitted")
    args = parser.parse_args()

    scenario = SCENARIOS.get(args.pr)
    if not scenario:
        raise SystemExit(f"No capture scenario is registered for PR {args.pr}.")

    merge = resolve_merge_commit(args.pr, args.merge_commit)
    before = run("git", "rev-parse", f"{merge}^1", capture=True)
    output = ROOT / "media" / "changelog" / f"pr-{args.pr}"
    output.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix=f"crol-pr-{args.pr}-") as temp:
        scratch = Path(temp)
        before_tree = scratch / "before"
        after_tree = scratch / "after"
        add_worktree(before_tree, before)
        add_worktree(after_tree, merge)
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                capture_screenshots(browser, before_tree, "before", scenario, output)
                capture_screenshots(browser, after_tree, "after", scenario, output)
                capture_recording(browser, after_tree, scenario, output, scratch)
                capture_changelog_verification(browser, output)
                browser.close()
        finally:
            remove_worktree(before_tree)
            remove_worktree(after_tree)

    print(f"Captured PR {args.pr} from {before[:12]} (before) and {merge[:12]} (after):")
    for asset in sorted(output.iterdir()):
        print(f"  {asset.relative_to(ROOT)}  {asset.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
