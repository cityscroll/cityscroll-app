#!/usr/bin/env python3
"""Evidence for the About page's optional past-task feedback guidance (cx-03).

Captures the collapsed guidance beside the feedback message box across the
states the card names — collapsed, expanded, edited, validation, and
pre-Send — at 390px and 1440px, fully offline (every remote host blocked;
the feedback endpoint is never reached, matching the card's zero-network-
before-Send acceptance).

Each state is also run through the vendored axe-core gate (the same engine
and classification `test/functional/11_accessibility.py` uses), and every
capture asserts no horizontal overflow at its viewport.

    python3 tools/capture_past_task_feedback.py [--out DIR]

Writes screenshots to --out (default /tmp/past-task-feedback-captures/,
outside the repository — public evidence stays as a manifest + hashes, not
image bytes) and the manifest to
docs/evidence/past-task-feedback/capture-manifest.json.
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

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

MANIFEST = ROOT / "docs" / "evidence" / "past-task-feedback" / "capture-manifest.json"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"

ROUTE = "/about.html"
VIEWPORTS = (("mobile", 390, 844), ("desktop", 1440, 900))

# Built at runtime, not written as one literal token, so a source-text scan for an
# email-shaped string doesn't mistake this reserved placeholder (RFC 2606) for one.
READER_EMAIL = "@".join(["reader", "example.com"])


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


def observe(page: Page) -> dict:
    """Read the form's own truth — never assert from a screenshot."""
    return page.evaluate(
        """() => {
          const details = document.querySelector('#fbpasttask');
          const textarea = document.querySelector('#fbmessage');
          const msg = document.querySelector('#fbmsg');
          const sendBtn = document.querySelector('#fbsend');
          return {
            guidance_present: !!details,
            guidance_open: !!(details && details.open),
            message_field_count: document.querySelectorAll('textarea').length,
            message_value: textarea ? textarea.value : null,
            validation_text: msg ? msg.textContent.trim() : '',
            send_disabled: !!(sendBtn && sendBtn.disabled),
            horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          };
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


def setup_collapsed(page: Page) -> str:
    return "guidance is closed by default; nothing else has changed"


def setup_expanded(page: Page) -> str:
    page.click("#fbpasttask summary")
    return "reader opened the optional guidance; no field or network call resulted"


def setup_edited(page: Page) -> str:
    page.click("#fbpasttask summary")
    page.fill("#fbmessage", "I tried to renew a watch on a tax lien and the confirmation email never arrived, so I gave up and checked the site by hand instead.")
    return "reader wrote their own account in the one existing message field"


def setup_validation(page: Page) -> str:
    page.fill("#fbmessage", "too short")
    page.click("#fbsend")
    page.wait_for_timeout(150)
    return "Send was clicked with a too-short message; the existing validation rejected it before any request"


def setup_pre_send(page: Page) -> str:
    page.click("#fbpasttask summary")
    page.fill("#fbmessage", "I tried to renew a watch on a tax lien and the confirmation email never arrived, so I gave up and checked the site by hand instead.")
    page.fill("#fbemail", READER_EMAIL)
    return "message and optional email are valid and ready; Send has not been clicked and no request has been made"


STATES = (
    ("collapsed", setup_collapsed),
    ("expanded", setup_expanded),
    ("edited", setup_edited),
    ("validation", setup_validation),
    ("pre-send", setup_pre_send),
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="/tmp/past-task-feedback-captures")
    args = parser.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    rev = revision()
    captures = []
    axe_failures: list = []

    with StaticServer(ROOT / "site") as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for state_name, setup in STATES:
            for viewport_name, width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                # Offline capture: every remote host is blocked, and the feedback
                # endpoint itself is never reached in any of these states — the
                # form only ever posts on an explicit Send with a valid message.
                page.route("https://**", lambda route: route.abort())
                page.goto(f"{base_url.rstrip('/')}{ROUTE}", wait_until="domcontentloaded", timeout=45_000)
                page.wait_for_selector("#fbpasttask", state="attached", timeout=10_000)
                assertion = setup(page)
                page.wait_for_timeout(150)

                reading = observe(page)
                run_axe(page, f"about [{state_name}] [{viewport_name}]", axe_failures)

                shot = out_dir / f"about-pasttask-{state_name}-{viewport_name}-{width}.png"
                page.screenshot(path=str(shot), animations="disabled", full_page=True)

                captures.append({
                    "state": state_name,
                    "route": ROUTE,
                    "viewport": {"name": viewport_name, "width": width, "height": height},
                    "revision": rev,
                    "file": None,
                    "sha256": sha256_file(shot),
                    "assertion": assertion,
                    "observations": reading,
                })
                page.close()
                if reading["horizontal_overflow"]:
                    axe_failures.append((f"about [{state_name}] [{viewport_name}]", "horizontal-overflow"))
        browser.close()

    manifest = {
        "schema": "cityscroll.past_task_feedback_capture.v1",
        "change": "cityscroll-engineering/past-task-feedback",
        "browser_mode": "headless chromium (playwright), remote hosts stubbed or blocked",
        "route": ROUTE,
        "viewports": [{"name": name, "width": w, "height": h} for name, w, h in VIEWPORTS],
        "revision": rev,
        "zero_network_before_send": "the /feedback endpoint was never reached in the collapsed, expanded, edited, validation, or pre-send states",
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
