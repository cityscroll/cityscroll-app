#!/usr/bin/env python3
"""Capture the public-stats reduction.

The before frames use the deployed routes. The after frames use the changed
public document plus deterministic API data. Authenticated operations surfaces
are verified separately and are never captured into the public repository.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "stats-public-private-split"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
PUBLIC_BEFORE = "https://cityscroll.org/stats.html"

PUBLIC_STATS = {
    "schema": "public-stats.v2",
    "generated_at": "2026-08-05T15:00:00.000Z",
    "scope": "Public corpus and coverage only. Product-use telemetry is private.",
    "city_record": {
        "available": True,
        "notice_count": 1_099_194,
        "first_notice_date": "2003-01-02",
        "latest_notice_date": "2026-08-05",
    },
    "sources": {"primary_system_count": 6},
    "language_coverage": {"site_languages": 11},
}

def start_site_server(temp_dir: Path) -> tuple[subprocess.Popen[str], str]:
    ready_file = temp_dir / "site-url.txt"
    process = subprocess.Popen(
        [
            "python3",
            "tools/local_site_server.py",
            "--directory",
            "site",
            "--port",
            "0",
            "--ready-file",
            str(ready_file),
        ],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    for _ in range(100):
        if ready_file.exists():
            return process, ready_file.read_text(encoding="utf-8").strip()
        if process.poll() is not None:
            output = process.stdout.read() if process.stdout else ""
            raise RuntimeError(f"local site server exited early: {output}")
        import time

        time.sleep(0.05)
    process.terminate()
    raise TimeoutError("local site server did not become ready")


def assert_mobile_fit(page: Page, frame: str) -> None:
    dimensions = page.evaluate(
        """() => ({ width: document.documentElement.clientWidth,
                       scroll: document.documentElement.scrollWidth })"""
    )
    if dimensions["scroll"] > dimensions["width"]:
        raise AssertionError(f"{frame}: horizontal overflow: {dimensions}")


def assert_accessible(page: Page, frame: str) -> None:
    """Apply the project's serious/critical and WCAG 2.2 axe ratchets."""
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22 = set(page.evaluate("() => axe.getRules(['wcag22aa']).map((rule) => rule.ruleId)"))
    ratchets = {"landmark-one-main", "region", "heading-order"}  # Mirrors test/functional/11_accessibility.py.
    failures = [
        violation
        for violation in result["violations"]
        if violation.get("impact") in {"critical", "serious"}
        or violation["id"] in ratchets
        or violation["id"] in wcag22
    ]
    if failures:
        summary = [f"{item['id']} ({item.get('impact')})" for item in failures]
        raise AssertionError(f"{frame}: axe violations: {summary}")


def capture(page: Page, name: str, *, full_page: bool = True) -> None:
    page.evaluate("document.fonts && document.fonts.ready")
    page.screenshot(path=str(OUT / name), full_page=full_page, animations="disabled")


def capture_public_before(page: Page) -> None:
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(PUBLIC_BEFORE, wait_until="domcontentloaded", timeout=45_000)
    page.wait_for_function(
        """() => {
          const active = document.querySelector('#s-subs');
          const daily = document.querySelector('h3');
          return active && active.textContent.trim() !== '–'
            && [...document.querySelectorAll('h3')].some((el) => el.textContent.includes('Daily use'));
        }""",
        timeout=45_000,
    )
    capture(page, "public-before-desktop.png")


def capture_public_after(page: Page, base_url: str) -> None:
    payload = json.dumps(PUBLIC_STATS)
    page.route(
        "**/stats",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=payload,
            headers={"Access-Control-Allow-Origin": "*"},
        ),
    )
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(f"{base_url}stats.html", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_function("() => document.querySelector('#s-notices')?.textContent.includes('1,099,194')")
    assert_accessible(page, "public-after-desktop.png")
    capture(page, "public-after-desktop.png")

    page.set_viewport_size({"width": 390, "height": 844})
    page.reload(wait_until="domcontentloaded")
    page.wait_for_function("() => document.querySelector('#s-notices')?.textContent.includes('1,099,194')")
    assert_mobile_fit(page, "public-after-mobile.png")
    assert_accessible(page, "public-after-mobile.png")
    capture(page, "public-after-mobile.png")
    page.unroute("**/stats")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="crol-stats-capture-") as temp:
        server, base_url = start_site_server(Path(temp))
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                page = browser.new_page()
                capture_public_before(page)
                capture_public_after(page, base_url)
                browser.close()
        finally:
            server.terminate()
            server.wait(timeout=10)

    receipt = {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "before": {
            "public_url": PUBLIC_BEFORE,
        },
        "after": {
            "public_schema": PUBLIC_STATS["schema"],
            "public_fixture_as_of": PUBLIC_STATS["generated_at"],
            "mobile_width": 390,
            "axe_gate": "serious/critical + project ratchets + WCAG 2.2 AA",
        },
    }
    (OUT / "capture-receipt.json").write_text(
        json.dumps(receipt, indent=2) + "\n", encoding="utf-8"
    )
    print(f"captured {len(list(OUT.glob('*.png')))} frames in {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
