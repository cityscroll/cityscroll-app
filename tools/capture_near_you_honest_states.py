#!/usr/bin/env python3
"""Record browser proof for the served Near You failure recovery path.

The manifest hashes the served DOM, not an image. The browser run must point at
the route-aware HTTP server (set CROL_BASE); the deferred response is malformed
only to exercise the reader's recovery path.
"""
from __future__ import annotations

from repository_revision import resolve_repository_revision

import hashlib
import json
import os
import subprocess
import sys
from urllib.parse import parse_qsl, urlsplit
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs/evidence/near-you-honest-states/capture-manifest.json"
BASE = os.environ.get("CROL_BASE", "http://localhost:8000").rstrip("/")
ROUTE = "/near-you/?v=0&lens=meetings&boro=Queens&agency=Transportation&q=curb"


def revision() -> str:
    return resolve_repository_revision(ROOT)

def dom_hash(page) -> str:
    markup = page.locator("[data-near-you-root]").evaluate("node => node.outerHTML")
    return hashlib.sha256(markup.encode("utf-8")).hexdigest()


def capture(page, width: int, height: int, keyboard: bool) -> dict[str, object]:
    page.set_viewport_size({"width": width, "height": height})
    page.route(
        "**/near-you/deferred.json*",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body='{"schema":"cityscroll.near_you_deferred.v1","results_html":null}',
        ),
    )
    page.goto(f"{BASE}{ROUTE}", wait_until="networkidle")
    page.locator('[data-near-deferred-state="error"]').first.wait_for()
    retry = page.locator('[data-near-recovery="retry"]').last
    page.unroute("**/near-you/deferred.json*")
    if keyboard:
        retry.focus()
        assert page.evaluate("document.activeElement?.dataset.nearRecovery === 'retry'")
        retry.press("Enter")
    else:
        retry.click()
    expected = urlsplit(ROUTE)
    actual = urlsplit(page.url)
    assert actual.path.rstrip("/") == expected.path.rstrip("/")
    assert sorted(parse_qsl(actual.query, keep_blank_values=True)) == sorted(parse_qsl(expected.query, keep_blank_values=True)), (actual.query, expected.query)
    page.locator('[data-near-you-root][data-near-deferred-state="ready"]').wait_for()
    return {
        "source": "headless-http-served-route",
        "route": ROUTE,
        "viewport": {"width": width, "height": height},
        "assertion": (
            "Served Near You route recovers from a malformed deferred payload with a visible, "
            "scope-preserving retry; keyboard focus and Enter work."
            if keyboard else
            "Served Near You route recovers from a malformed deferred payload with a visible, "
            "scope-preserving retry."
        ),
        "sha256": dom_hash(page),
        "file": None,
    }


def main() -> None:
    revision_value = revision()
    activity = json.loads((ROOT / "site/data/district_activity.json").read_text())
    vintage = activity.get("built_at", "unavailable")
    server = subprocess.Popen(
        ["node", str(ROOT / "tools/serve_near_you_capture.mjs")],
        cwd=ROOT, stdout=subprocess.PIPE, text=True,
    )
    assert server.stdout is not None
    served_base = server.stdout.readline().strip()
    if not served_base:
        server.kill()
        raise RuntimeError("capture server did not announce a base URL")
    global BASE
    BASE = served_base
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            desktop = browser.new_page()
            desktop_capture = capture(desktop, 1440, 900, keyboard=False)
            touch = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True).new_page()
            touch_capture = capture(touch, 390, 844, keyboard=True)
            browser.close()
    finally:
        server.terminate()
    for entry in (desktop_capture, touch_capture):
        entry["revision"] = revision_value
        entry["data_vintage"] = vintage
    prior = json.loads(subprocess.run(
        ["git", "show", "origin/main:docs/evidence/near-you-honest-states/capture-manifest.json"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout)
    prior_captures = []
    for entry in prior.get("captures", []):
        copied = dict(entry)
        copied["source"] = "local-rendered-output"
        if copied.get("name") == "served-route-failure":
            copied["name"] = "local-rendered-failure"
            copied["assertion"] = "Local rendered failure state; not served-route evidence."
        prior_captures.append(copied)
    manifest = {
        "schema": "cityscroll.served_browser_capture_manifest.v1",
        "capture_mode": "headless_playwright_served_route",
        "repository_revision": revision_value,
        "grounded_at": revision_value,
        "data_vintage": vintage,
        "note": "Textual DOM hashes are committed; no image binaries are committed.",
        "captures": prior_captures + [desktop_capture, touch_capture],
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {MANIFEST} ({len(manifest['captures'])} captures)")


if __name__ == "__main__":
    main()
