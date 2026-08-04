#!/usr/bin/env python3
"""Capture the optional post-handoff outcome prompt at review viewports.

The field case is a source-published NYCHA solicitation already committed in the
task-first examples. City Record and lifecycle requests are pinned locally; no
product row or outcome is invented.
"""

from __future__ import annotations

import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "action-outcome-prompt"
NOTICE_ID = "20260617050"


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
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def field_case() -> dict:
    examples = json.loads((ROOT / "site" / "data" / "task_first_examples.json").read_text())
    stack: list[object] = [examples]
    while stack:
        value = stack.pop()
        if isinstance(value, dict):
            if str(value.get("id")) == NOTICE_ID and isinstance(value.get("official"), dict):
                return value["official"]
            stack.extend(value.values())
        elif isinstance(value, list):
            stack.extend(value)
    raise RuntimeError(f"field case {NOTICE_ID} missing from task_first_examples.json")


def fulfill_json(route: Route, payload: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))


def main() -> None:
    notice = field_case()
    lifecycle = {
        "ok": True,
        "pin": "517992",
        "pin_strategy": "exact",
        "timeline": [{
            "stage": "solicitation",
            "status": "matched",
            "source": "city-record",
            "date": "2026-06-30",
            "detail": {"request_id": NOTICE_ID},
        }],
        "rfx_detail": {
            "status": "unmatched",
            "reason": "no_epin_pin_join",
            "portal": "https://a0333-passportpublic.nyc.gov/rfx.html",
        },
    }
    OUT.mkdir(parents=True, exist_ok=True)
    captures: list[str] = []
    with StaticServer() as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width, height, label in ((1440, 1000, "desktop"), (390, 844, "mobile")):
            page = browser.new_page(viewport={"width": width, "height": height})
            page.route("**/resource/dg92-zbpx.json**", lambda route: fulfill_json(route, [notice]))
            page.route("**/contract-lifecycle**", lambda route: fulfill_json(route, lifecycle))
            page.route("https://api.cityscroll.org/**", lambda route: route.abort())
            page.route("https://crol-worker.crol-worker.workers.dev/**", lambda route: route.abort())
            page.goto(f"{base}#notice/{NOTICE_ID}", wait_until="domcontentloaded")
            page.wait_for_selector("#nactions a[data-action-outcome-index]")
            page.wait_for_timeout(150)
            page.locator("#nactions a[data-action-outcome-index]").first.evaluate(
                """link => {
                  link.addEventListener('click', event => event.preventDefault(), {once: true});
                  link.click();
                }"""
            )
            page.wait_for_selector("#nactions [data-action-outcome-prompt='official_handoff']")
            prompt = page.locator("#nactions .outcome-prompt")
            assert prompt.locator("textarea,input,select").count() == 0
            assert prompt.locator("[data-outcome-choice]").count() == 3
            target = OUT / f"after-{label}.png"
            page.locator("#nactions .next-action-rail").screenshot(path=str(target))
            captures.append(str(target.relative_to(ROOT)))
            page.close()
        browser.close()
    receipt = {
        "notice_id": NOTICE_ID,
        "source": "NYC Open Data City Record Online (dg92-zbpx)",
        "scenario": "official solicitation handoff return",
        "outcome_choices": 3,
        "free_text_controls": 0,
        "viewports": [1440, 390],
        "captures": captures,
    }
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"Captured {len(captures)} outcome prompt screenshots")


if __name__ == "__main__":
    main()
