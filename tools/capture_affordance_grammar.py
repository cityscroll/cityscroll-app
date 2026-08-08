#!/usr/bin/env python3
"""Capture notice and agency affordance grammar at phone and desktop widths."""

from __future__ import annotations

import argparse
import subprocess
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "affordance-grammar"
VIEWPORTS = ((390, 844), (1440, 1000))
PRODUCTION = "https://cityscroll.org"


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


def notice_markup() -> str:
    script = """
      import { renderEdgeNotice } from './site/pages_edge.mjs';
      process.stdout.write(renderEdgeNotice({
        request_id: '20240515016',
        short_title: 'Natural Resources Group Forest Management Services',
        agency_name: 'DEPT OF PARKS & RECREATION',
        type_of_notice_description: 'Solicitation',
        section_name: 'Procurement',
        start_date: '2026-08-08',
        due_date: '2026-09-04',
        pin: '84626P0001',
        category_description: 'Services',
        additional_description_1: 'The agency seeks qualified vendors for forest management services.'
      }, '20240515016'));
    """
    return subprocess.check_output(
        ["node", "--input-type=module", "--eval", script], cwd=ROOT, text=True
    )


def agency_markup() -> str:
    script = """
      import { readFileSync } from 'node:fs';
      import { buildAgencyConstellationView, renderAgencyConstellationDocument } from './site/agency_constellation.mjs';
      const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
      const view = buildAgencyConstellationView('parks-and-recreation', {
        intelligence: read('./site/data/entity_intelligence_lookup.json'),
        certification: read('./site/data/exam_certification_constellation.json'),
        obligations: read('./site/data/agency_obligations_lookup.json'),
      });
      process.stdout.write(renderAgencyConstellationDocument(view));
    """
    return subprocess.check_output(
        ["node", "--input-type=module", "--eval", script], cwd=ROOT, text=True
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("before", "after"))
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="crol-affordance-") as temp:
        ready = Path(temp) / "ready.txt"
        process = subprocess.Popen(
            [
                "python3", str(ROOT / "tools" / "local_site_server.py"),
                "--directory", str(ROOT / "site"), "--port", "0",
                "--ready-file", str(ready),
            ],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        try:
            base = wait_for_ready(ready, process)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                for width, height in VIEWPORTS:
                    page = browser.new_page(viewport={"width": width, "height": height})
                    if args.phase == "before":
                        page.goto(f"{PRODUCTION}/notices/20240515016", wait_until="networkidle")
                    else:
                        page.goto(f"{base}/index.html", wait_until="networkidle")
                        page.locator("body").evaluate(
                            "(body, markup) => { body.innerHTML = `<main style=\"padding:24px\">${markup}</main>`; }",
                            notice_markup(),
                        )
                    page.locator('[data-edge-rendered="notice"]').screenshot(
                        path=str(OUT / f"{args.phase}-notice-{width}.png")
                    )
                    if args.phase == "after":
                        page.set_content(
                            agency_markup().replace("<head>", f'<head><base href="{base}/">', 1),
                            wait_until="networkidle",
                        )
                    else:
                        page.goto(f"{PRODUCTION}/agencies/parks-and-recreation/", wait_until="networkidle")
                    page.locator("main").screenshot(
                        path=str(OUT / f"{args.phase}-agency-{width}.png")
                    )
                    page.close()
                browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
    print(f"captured {args.phase} evidence under {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
