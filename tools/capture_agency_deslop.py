#!/usr/bin/env python3
"""Capture agency provenance and mandate-conformance copy at review widths."""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "agency-deslop"
VIEWPORTS = ((390, 844), (1440, 1000))
# Source: City Record notice 20260522005 in the committed Fire Department constellation.
CLAIM = "rules:notice:20260522005"
PATH = f"agencies/fire-department/?claim={CLAIM}#mandates-conformance"
FORBIDDEN = (
    "awaiting detector",
    "this pass matches",
    "corpus checked",
    "this pass covers",
    "not yet attached",
    "later enrichment",
    "later iterations",
    "how it was derived",
    "publisher civil-service certification record",
    "joined by an exact publisher key",
)


def wait_for_ready(path: Path, process: subprocess.Popen[str]) -> str:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if path.exists():
            return path.read_text(encoding="utf-8").strip()
        if process.poll() is not None:
            output = process.stdout.read() if process.stdout else ""
            raise RuntimeError(f"local server exited early: {output}")
        time.sleep(0.05)
    raise TimeoutError("local site server did not become ready")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("before", "after"))
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="crol-agency-deslop-") as temp:
        ready = Path(temp) / "ready.txt"
        process = subprocess.Popen(
            [
                "python3",
                str(ROOT / "tools" / "local_site_server.py"),
                "--directory",
                str(ROOT / "site"),
                "--port",
                "0",
                "--ready-file",
                str(ready),
            ],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            base = wait_for_ready(ready, process)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                for width, height in VIEWPORTS:
                    page = browser.new_page(viewport={"width": width, "height": height})
                    page.goto(f"{base}{PATH}", wait_until="networkidle", timeout=60_000)
                    page.wait_for_selector("#mandates-conformance", timeout=30_000)
                    page.wait_for_selector("#edge-provenance .edge-prov-inspector", timeout=30_000)

                    body = page.locator("body").inner_text().lower()
                    if args.phase == "before":
                        assert any(text in body for text in FORBIDDEN), (
                            "baseline page did not reproduce the unwanted copy"
                        )
                    else:
                        for text in FORBIDDEN:
                            assert text not in body, f"unwanted agency copy remains: {text}"

                    for name, selector in (
                        ("conformance", "#mandates-conformance"),
                        ("provenance", "#edge-provenance"),
                    ):
                        locator = page.locator(selector)
                        locator.scroll_into_view_if_needed()
                        page.wait_for_timeout(150)
                        locator.screenshot(
                            path=str(OUT / f"{args.phase}-{name}-{width}.png")
                        )
                    page.close()
                browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)

    receipt = {
        "agency": "fire-department",
        "claim": CLAIM,
        "phase": args.phase,
        "viewports": [width for width, _ in VIEWPORTS],
        "selectors": ["#mandates-conformance", "#edge-provenance"],
        "forbidden_copy": list(FORBIDDEN),
    }
    (OUT / f"{args.phase}-receipt.json").write_text(
        json.dumps(receipt, indent=2) + "\n", encoding="utf-8"
    )
    print(f"captured {args.phase} agency evidence under {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
