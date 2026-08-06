#!/usr/bin/env python3
"""Capture before/after account-session agreement across three public surfaces.

Four contact sheets cover Home, Following, and preferences for signed-out and
recognized-session readers. "Before" uses the repository's launch revision plus
the reported split-session responses; "after" uses the current renderers and
Worker fixtures. All browser frames are deterministic and local.

    python3 tools/capture_session_coherence.py
"""

from __future__ import annotations

import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import tempfile
import threading
from urllib.parse import urlsplit

from PIL import Image, ImageDraw, ImageFont, ImageOps
from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "session-coherence"
TEST_EMAIL = "@".join(("reader", "example.test"))
VIEWPORT = dict(width=760, height=900)
# Account-session baseline captured before the shared-cookie architecture change.
BASELINE_REV = "ce9a25eed3e6"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def git_source(path: str) -> str:
    result = subprocess.run(
        ["git", "show", f"{BASELINE_REV}:{path}"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def worker_fixtures() -> dict[str, str]:
    script = r"""
import { signToken } from "./worker/node_modules/optin-token/index.mjs";
import { handleFollowing } from "./worker/src/following.mjs";
import { handlePrefs } from "./worker/src/prefs.mjs";
import { sessionPayload } from "./worker/src/lib/session.mjs";

const secret = "capture-session-secret-placeholder";
const email = ["reader", "example.test"].join("@");
const values = new Map([["sub:capture", JSON.stringify({
  email,
  lens: "meetings",
  filter: { borough: "Queens", agency: "Transportation" },
  freq: "weekly",
  createdAt: "2026-08-01T12:00:00.000Z",
})]]);
const kv = {
  async get(key) { return values.get(key) ?? null; },
  async put(key, value) { values.set(key, String(value)); },
  async delete(key) { values.delete(key); },
  async list({ prefix = "" } = {}) {
    return { keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  },
};
const env = { TOKEN_SECRET: secret, SUBS: kv, ALERT_STATE: { ...kv } };
const session = await signToken(secret, sessionPayload(email), { ttlSeconds: 3600 });
const headers = { Cookie: `cs_session=${session}`, Origin: "https://cityscroll.org" };
const personalIn = await handleFollowing(new Request("https://api.cityscroll.org/following/personal", { headers }), env);
const personalOut = await handleFollowing(new Request("https://api.cityscroll.org/following/personal"), env);
const prefsIn = await handlePrefs(new Request("https://cityscroll.org/prefs", { headers }), env);
const prefsOut = await handlePrefs(new Request("https://cityscroll.org/prefs"), env);
console.log(JSON.stringify({
  personalIn: await personalIn.text(),
  personalOut: await personalOut.text(),
  prefsIn: await prefsIn.text(),
  prefsOut: await prefsOut.text(),
}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def install_routes(
    page: Page,
    *,
    base: str,
    phase: str,
    signed_in: bool,
    before_home: str,
    before_following: str,
    fixtures: dict[str, str],
) -> tuple[str, str]:
    home_url = f"{base}/__session_{phase}_home"
    following_url = f"{base}/__session_{phase}_following"
    page.route(home_url, lambda route: route.fulfill(status=200, content_type="text/html", body=before_home if phase == "before" else (ROOT / "site/index.html").read_text()))
    page.route(following_url, lambda route: route.fulfill(status=200, content_type="text/html", body=before_following if phase == "before" else (ROOT / "site/following/index.html").read_text()))

    def api(route: Route) -> None:
        path = urlsplit(route.request.url).path
        if path == "/session":
            recognized = signed_in and phase == "after"
            body: dict[str, object] = dict(ok=True, recognized=recognized)
            if recognized:
                body.update({
                    "email": TEST_EMAIL,
                    "prefsUrl": "https://cityscroll.org/prefs",
                    "manageUrl": "https://cityscroll.org/following/#your-following",
                })
            route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
        elif path == "/following/personal":
            if phase == "after":
                body = fixtures["personalIn" if signed_in else "personalOut"]
            elif signed_in:
                body = (
                    '<article data-watch-key="sub:capture" data-watch-lens="meetings" '
                    'data-watch-filter="{&quot;borough&quot;:&quot;Queens&quot;}">'
                    "<h3>Queens public meetings</h3><p class=\"watch-meta\">Active · weekly</p></article>"
                    '<p><a href="https://cityscroll.org/prefs">Change cadence, pause, or unsubscribe</a></p>'
                )
            else:
                body = (
                    "<p>Existing watches appear after CityScroll recognizes a link from one of your emails.</p>"
                    '<p><a href="https://cityscroll.org/prefs">Manage from a CityScroll email</a></p>'
                )
            route.fulfill(status=200, content_type="text/html", body=body)
        elif path == "/pins":
            route.fulfill(status=200, content_type="application/json", body='{"ok":true,"pins":null}')
        else:
            route.fulfill(status=404, content_type="application/json", body="{}")

    def canonical(route: Route) -> None:
        if urlsplit(route.request.url).path == "/prefs":
            if phase == "before":
                body = fixtures["prefsOut"]
            else:
                body = fixtures["prefsIn" if signed_in else "prefsOut"]
            route.fulfill(status=200 if phase == "after" and signed_in else 400, content_type="text/html", body=body)
        else:
            route.continue_()

    page.route("https://api.cityscroll.org/**", api)
    page.route("https://crol-worker.crol-worker.workers.dev/**", api)
    page.route("https://cityscroll.org/**", canonical)
    page.route("https://data.cityofnewyork.us/**", lambda route: route.abort())
    return home_url, following_url


def capture_surface(page: Page, selector: str, destination: Path) -> None:
    target = page.locator(selector)
    target.wait_for(state="visible", timeout=20_000)
    target.screenshot(path=destination, animations="disabled")


def make_contact_sheet(paths: list[tuple[str, Path]], destination: Path, heading: str, note: str) -> None:
    width = 1320
    margin = 24
    gap = 18
    header_height = 98
    panel_width = (width - (margin * 2) - (gap * 2)) // 3
    panel_height = 500
    canvas = Image.new("RGB", (width, header_height + panel_height + margin), "#f4efe4")
    draw = ImageDraw.Draw(canvas)
    title_font = ImageFont.load_default(size=23)
    body_font = ImageFont.load_default(size=15)
    label_font = ImageFont.load_default(size=17)
    draw.rectangle((0, 0, width, header_height), fill="#1a1714")
    draw.text((margin, 16), heading, fill="#fbf7ed", font=title_font)
    draw.text((margin, 53), note, fill="#d9d2c7", font=body_font)

    for index, (label, path) in enumerate(paths):
        x = margin + index * (panel_width + gap)
        y = header_height
        draw.rounded_rectangle((x, y, x + panel_width, y + panel_height), radius=10, fill="#ffffff", outline="#c7bfb2", width=2)
        draw.rectangle((x, y, x + panel_width, y + 48), fill="#7a1f1f")
        draw.text((x + 14, y + 14), label, fill="#ffffff", font=label_font)
        image = Image.open(path).convert("RGB")
        fitted = ImageOps.contain(image, (panel_width - 24, panel_height - 72), method=Image.Resampling.LANCZOS)
        image_x = x + (panel_width - fitted.width) // 2
        image_y = y + 58
        canvas.paste(fitted, (image_x, image_y))

    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, optimize=True)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    before_home = git_source("site/index.html")
    before_following = git_source("site/following/index.html")
    fixtures = worker_fixtures()

    with tempfile.TemporaryDirectory(dir=OUTPUT) as temp_name, StaticServer() as base, sync_playwright() as playwright:
        temp = Path(temp_name)
        browser = playwright.chromium.launch(headless=True)
        for phase in ("before", "after"):
            for signed_in in (False, True):
                auth = "signed-in" if signed_in else "signed-out"
                context = browser.new_context(viewport=VIEWPORT)
                page = context.new_page()
                home_url, following_url = install_routes(
                    page,
                    base=base,
                    phase=phase,
                    signed_in=signed_in,
                    before_home=before_home,
                    before_following=before_following,
                    fixtures=fixtures,
                )

                page.goto(home_url, wait_until="domcontentloaded", timeout=60_000)
                page.wait_for_selector("#homeCta")
                if phase == "before" and signed_in:
                    page.evaluate(
                        """(email) => {
                          const banner = document.getElementById('sessionBanner');
                          banner.hidden = false;
                          banner.dataset.open = 'true';
                          document.getElementById('sessionBannerText').textContent =
                            `Signed in as ${email} — pins follow you on this device.`;
                          const manage = document.getElementById('sessionManage');
                          manage.href = 'https://cityscroll.org/prefs?token=your-token-here';
                        }""",
                        TEST_EMAIL,
                    )
                elif phase == "after" and signed_in:
                    page.locator('#sessionBanner[data-open="true"]').wait_for(state="visible")
                if phase == "before":
                    page.evaluate(
                        """() => {
                          const message = document.getElementById('homeCtaMsg');
                          message.removeAttribute('data-i18n');
                          message.textContent = "We'll email a link to confirm.";
                        }"""
                    )
                capture_surface(page, ".masthead", temp / f"{phase}-{auth}-home.png")

                page.goto(following_url, wait_until="domcontentloaded", timeout=60_000)
                page.locator("[data-personal-watch-list]").wait_for(state="attached")
                page.wait_for_timeout(150)
                capture_surface(page, "#your-following", temp / f"{phase}-{auth}-following.png")

                page.goto("https://cityscroll.org/prefs", wait_until="domcontentloaded", timeout=60_000)
                capture_surface(page, "body > div", temp / f"{phase}-{auth}-prefs.png")
                context.close()

                note = (
                    "Recognized account state" if signed_in else "Anonymous reader state"
                )
                if phase == "before" and signed_in:
                    note += " · recognition and management disagree"
                elif phase == "after" and signed_in:
                    note += " · one session truth across all surfaces"
                elif phase == "before":
                    note += " · confirmation narration still visible"
                else:
                    note += " · creation stays available without the curriculum"
                make_contact_sheet(
                    [
                        ("HOME", temp / f"{phase}-{auth}-home.png"),
                        ("FOLLOWING", temp / f"{phase}-{auth}-following.png"),
                        ("PREFERENCES", temp / f"{phase}-{auth}-prefs.png"),
                    ],
                    OUTPUT / f"{phase}-{auth}.png",
                    f"{phase.upper()} · {auth.replace('-', ' ').upper()}",
                    note,
                )
        browser.close()

    for path in sorted(OUTPUT.glob("*.png")):
        print(f"{path.relative_to(ROOT)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
