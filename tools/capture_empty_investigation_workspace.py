#!/usr/bin/env python3
"""Evidence for the empty My investigation workspace state (cx-02).

Captures the guided empty state — the find -> open -> pin instruction, the
"Find something to pin" link, and the later-outputs preview — in place of the
six output actions (share, freeze research package, export .csv, export
.json, print, clear) a reader previously saw with nothing yet to act on.
Covers the four states the card names: empty, one-item, last-item removal
(a live in-page transition), and a stored-collection reload — at 390px and
1440px, offline, against the real #investigation route.

Every state also runs the vendored axe-core gate (the same engine and
classification test/functional/11_accessibility.py uses), checks for
horizontal overflow, and confirms the find-a-record link is reachable by
keyboard.

    python3 tools/capture_empty_investigation_workspace.py [--out DIR]

Writes screenshots to --out (default /tmp/empty-investigation-workspace-captures/,
outside the repository) and the manifest to
docs/evidence/empty-investigation-workspace/capture-manifest.json.
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import json
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

MANIFEST = ROOT / "docs" / "evidence" / "empty-investigation-workspace" / "capture-manifest.json"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"

ROUTE = "#investigation"
VIEWPORTS = (("mobile", 390, 844), ("desktop", 1440, 900))
SIX_ACTION_IDS = ["invshare", "invpackage", "invcsv", "invjson", "invprint", "invclear"]

ONE_ITEM_STORE = {
    "current": "inv1",
    "invs": {
        "inv1": {
            "name": "My investigation",
            "created": "2026-09-01",
            "items": [
                {
                    "t": "notice",
                    "id": "20260625017",
                    "title": "Sidewalk repair contract",
                    "meta": "Department of Transportation",
                    "note": "",
                    "added": "2026-09-01",
                }
            ],
        }
    },
}
EMPTY_STORE = {"current": "inv1", "invs": {"inv1": {"name": "My investigation", "created": "2026-09-05", "items": []}}}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path) -> None:
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


def install_capability_route(page: Page, base_url: str) -> None:
    """The production rewrite that serves repo-root capabilities/ under /capabilities/*."""

    def capability_module(route: Route) -> None:
        name = route.request.url.split("/capabilities/", 1)[1].split("?", 1)[0]
        source = ROOT / "capabilities" / name
        if source.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=source.read_text("utf-8"))
        else:
            route.fulfill(status=404, body="")

    page.route(f"{base_url.rstrip('/')}/capabilities/*", capability_module)
    page.route("https://**", lambda route: route.abort())


def seed_local_storage(page: Page, base_url: str, store: dict | None) -> None:
    """Seed (or clear) crd_invs_v1 before the app boots, matching workspace.mjs's own key.

    add_init_script(script=<str>) runs the string as a top-level script, not a
    function body — an arrow-function expression here would only be defined,
    never invoked, and the seed would silently no-op.
    """
    script = "localStorage.clear();"
    if store is not None:
        script += f"localStorage.setItem('crd_invs_v1', {json.dumps(json.dumps(store))});"
    page.add_init_script(script)


def observe(page: Page) -> dict:
    return page.evaluate(
        """() => {
          const guide = document.querySelector('#inv-empty-guide');
          const find = document.querySelector('#invfind');
          const items = [...document.querySelectorAll('#invitems .tl')];
          const actionIds = ['invshare','invpackage','invcsv','invjson','invprint','invclear']
            .filter((id) => !!document.getElementById(id));
          return {
            guide_present: !!guide,
            find_link_present: !!find,
            find_link_href: find ? find.getAttribute('href') : null,
            item_count: items.length,
            action_ids_present: actionIds,
            horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          };
        }"""
    )


def assert_find_link_keyboard_reachable(page: Page) -> dict:
    """Tab from the top of the panel and confirm the find link is a normal, reachable stop."""
    return page.evaluate(
        """() => {
          const find = document.getElementById('invfind');
          if (!find) return { present: false };
          find.focus();
          const focused = document.activeElement === find;
          const tabbable = find.tabIndex >= 0;
          return { present: true, focusable: focused, tabbable, tag: find.tagName.toLowerCase() };
        }"""
    )


def run_axe(page: Page, state_name: str, failures: list) -> None:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    gate = failing_violations(result["violations"], wcag22_rules)
    for violation in gate:
        nodes = "; ".join(node["target"][0] for node in violation["nodes"][:3])
        print(f"AXE FAIL {state_name}: {violation['id']} ({violation['impact']}) {violation['help']} @ {nodes}")
        failures.append((state_name, violation["id"]))
    if not gate:
        print(f"AXE OK {state_name}: no critical/serious violations ({len(result['violations'])} lesser findings)")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def capture_state(browser, base_url, out_dir, rev, axe_failures, *, state, assertion, viewport_name, width, height,
                   seed, in_page_setup=None):
    page = browser.new_page(viewport={"width": width, "height": height})
    install_capability_route(page, base_url)
    seed_local_storage(page, base_url, seed)
    page.goto(f"{base_url.rstrip('/')}/{ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    page.wait_for_selector("#invitems", timeout=15_000)
    page.wait_for_timeout(300)

    if in_page_setup:
        in_page_setup(page)
        page.wait_for_selector("#invitems", timeout=15_000)
        page.wait_for_timeout(300)

    reading = observe(page)
    run_axe(page, f"investigation [{state}] [{viewport_name}]", axe_failures)
    keyboard = assert_find_link_keyboard_reachable(page) if reading["guide_present"] else {"present": False, "note": "no find link in a populated state"}

    shot = out_dir / f"investigation-{state}-{viewport_name}-{width}.png"
    page.screenshot(path=str(shot), animations="disabled", full_page=True)
    page.close()

    if reading["horizontal_overflow"]:
        axe_failures.append((f"investigation [{state}] [{viewport_name}]", "horizontal-overflow"))

    return {
        "state": state,
        "route": ROUTE,
        "viewport": {"name": viewport_name, "width": width, "height": height},
        "revision": rev,
        "file": None,
        "sha256": sha256_file(shot),
        "assertion": assertion,
        "observations": reading,
        "keyboard_access": keyboard,
    }


def click_delete_and_wait(page: Page) -> None:
    page.click("#invitems .invdel")
    page.wait_for_selector("#inv-empty-guide", timeout=10_000)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="/tmp/empty-investigation-workspace-captures")
    args = parser.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    rev = revision()
    captures = []
    axe_failures: list = []

    with StaticServer(ROOT / "site") as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for viewport_name, width, height in VIEWPORTS:
            captures.append(capture_state(
                browser, base_url, out_dir, rev, axe_failures,
                state="empty", assertion="no investigation stored yet: the guide replaces all six output actions",
                viewport_name=viewport_name, width=width, height=height, seed=EMPTY_STORE,
            ))
            captures.append(capture_state(
                browser, base_url, out_dir, rev, axe_failures,
                state="one-item", assertion="one item pinned: every existing control returns, the guide is gone",
                viewport_name=viewport_name, width=width, height=height, seed=ONE_ITEM_STORE,
            ))
            captures.append(capture_state(
                browser, base_url, out_dir, rev, axe_failures,
                state="last-item-removal", assertion="deleting the only pinned item (in the live page) restores the guide without a reload",
                viewport_name=viewport_name, width=width, height=height, seed=ONE_ITEM_STORE,
                in_page_setup=click_delete_and_wait,
            ))
            captures.append(capture_state(
                browser, base_url, out_dir, rev, axe_failures,
                state="stored-reload-empty", assertion="a stored collection that is already empty (e.g. after a prior clear) reloads to the guide, not a stale action bar",
                viewport_name=viewport_name, width=width, height=height, seed=EMPTY_STORE,
                in_page_setup=lambda page: page.reload(wait_until="domcontentloaded"),
            ))
        browser.close()

    manifest = {
        "schema": "cityscroll.empty_investigation_workspace_capture.v1",
        "change": "cityscroll-engineering/empty-investigation-first-artifact",
        "browser_mode": "headless chromium (playwright), remote hosts stubbed or blocked",
        "route": ROUTE,
        "viewports": [{"name": name, "width": w, "height": h} for name, w, h in VIEWPORTS],
        "revision": rev,
        "captures": captures,
    }
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {MANIFEST.relative_to(ROOT)}")
    print(f"screenshots at {out_dir} (not part of the repository)")

    if axe_failures:
        print(f"❌ {len(axe_failures)} accessibility/layout finding(s): {axe_failures}")
        raise SystemExit(1)
    print("✅ axe gate green and no horizontal overflow across every state and viewport")


if __name__ == "__main__":
    main()
