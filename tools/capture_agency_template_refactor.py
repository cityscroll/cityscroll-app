#!/usr/bin/env python3
"""Capture the shared agency-template hierarchy at review widths.

The pair deliberately covers a dense agency (DCAS) and a sparse agency
(Staten Island DA) so a template change cannot be mistaken for a one-off page.
Generated agency documents must already exist; refresh them with
`node tools/build_agency_constellation_documents.mjs` before capturing.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "site" / "media" / "review" / "agency-template-refactor"
VIEWPORTS = ((390, 844), (1440, 1000))
AGENCIES = (
    ("dcas", "citywide-administrative-services", 5),
    ("parks", "parks-and-recreation", 6),
    ("rent-guidelines", "rent-guidelines-board", 2),
    ("staten-island-da", "district-attorney-richmond-county", 1),
)
CAPTURE_AGENCIES = {"citywide-administrative-services", "district-attorney-richmond-county"}


def start_server() -> tuple[subprocess.Popen[str], str]:
    process = subprocess.Popen(
        [
            sys.executable,
            str(ROOT / "tools" / "local_site_server.py"),
            "--directory",
            str(ROOT / "site"),
        ],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    assert process.stdout is not None
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        line = process.stdout.readline().strip()
        if line.startswith("http://") or line.startswith("https://"):
            return process, line.rstrip("/")
        if process.poll() is not None:
            break
    output = process.stdout.read()
    process.kill()
    raise RuntimeError(f"local site server did not start: {output}")


def verify_phase(page, phase: str) -> dict[str, int | str]:
    page.locator("h1").wait_for()
    if phase == "before":
        page.locator(".civic-object-pivot").wait_for()
        page.get_by_role("heading", name="Nearby agency records").wait_for()
    else:
        page.get_by_role("navigation", name="Primary agency actions").wait_for()
        page.get_by_role("heading", name="Connected records").wait_for()
        assert page.locator(".civic-object-pivot").count() == 0
        assert page.get_by_text("Nearby agency records", exact=True).count() == 0
        for card in page.locator(".agency-connection-card").all():
            assert card.is_visible()
            assert card.locator(".agency-connection-title").count() == 1
            assert card.locator(".agency-connection-title").is_visible()
            assert card.locator(".agency-connection-relation").count() == 1
            assert card.locator(".agency-connection-action").count() == 1
    return {
        "primary_actions": page.locator(".agency-primary-actions .civic-object-action").count(),
        "connection_cards": page.locator(".agency-connection-card").count(),
        "h1_height": round(page.locator("h1").bounding_box()["height"]),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("before", "after"))
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    process, base = start_server()
    receipt: dict[str, object] = {
        "phase": args.phase,
        "agencies": [agency for _, agency, _ in AGENCIES],
        "viewports": [width for width, _ in VIEWPORTS],
        "frames": [],
        "observations": [],
    }
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            agencies = AGENCIES if args.phase == "after" else tuple(
                row for row in AGENCIES if row[1] in CAPTURE_AGENCIES
            )
            for short_name, agency, expected_cards in agencies:
                for width, height in VIEWPORTS:
                    page = browser.new_page(viewport={"width": width, "height": height})
                    path = f"/agencies/{agency}/"
                    page.goto(base + path, wait_until="networkidle", timeout=60_000)
                    observations = verify_phase(page, args.phase)
                    if args.phase == "after":
                        assert observations["connection_cards"] == expected_cards, (
                            agency,
                            observations,
                        )
                    if agency in CAPTURE_AGENCIES:
                        destination = OUT / f"{args.phase}-{short_name}-{width}.png"
                        page.screenshot(path=str(destination), full_page=False)
                        receipt["frames"].append(str(destination.relative_to(ROOT)))
                    receipt["observations"].append({
                        "agency": agency,
                        "viewport": width,
                        **observations,
                    })
                    page.close()
            browser.close()
    finally:
        process.terminate()
        process.wait(timeout=10)

    receipt_path = OUT / f"{args.phase}-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"captured {args.phase} evidence under {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
