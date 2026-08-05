#!/usr/bin/env python3
"""Capture responsive before/after evidence for static map geography labels."""

from __future__ import annotations

import argparse
import functools
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "map-geography-labels"
VIEWPORTS = ((390, 844), (1440, 900))
ROUTES = (
    ("borough", "/near-you/"),
    ("district", "/near-you/borough/queens/land/"),
)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return


def serve(site: Path):
    handler = functools.partial(QuietHandler, directory=str(site))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


def export_before(revision: str) -> Path:
    target = Path(tempfile.mkdtemp(prefix="map-labels-before-"))
    archive = subprocess.run(
        ["git", "archive", "--format=tar", revision, "site"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    with tarfile.open(fileobj=io.BytesIO(archive.stdout), mode="r:") as bundle:
        bundle.extractall(target)
    return target / "site"


def label_contract(page, expected: bool) -> dict:
    result = page.evaluate(
        """() => {
          const paths = [...document.querySelectorAll('[data-map-id]')];
          const labels = [...document.querySelectorAll('[data-map-label]')];
          const areas = [...document.querySelectorAll('[data-map-area]')];
          const overlaps = [];
          for (let i = 0; i < labels.length; i += 1) {
            const a = labels[i].getBoundingClientRect();
            for (let j = i + 1; j < labels.length; j += 1) {
              const b = labels[j].getBoundingClientRect();
              const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
              const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
              if (x * y > 2) overlaps.push([labels[i].dataset.mapLabel, labels[j].dataset.mapLabel]);
            }
          }
          return {
            paths: paths.map(node => node.dataset.mapId).sort(),
            labels: labels.map(node => node.dataset.mapLabel).sort(),
            areas: areas.map(node => node.dataset.mapArea).sort(),
            namesMatch: labels.every(label => areas.some(area =>
              area.dataset.mapArea === label.dataset.mapLabel
              && area.querySelector('span')?.textContent === label.dataset.areaName)),
            allVisible: labels.every(label => {
              const style = getComputedStyle(label);
              const rect = label.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden'
                && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
            }),
            overlaps,
          };
        }"""
    )
    if expected:
        assert result["paths"] == result["labels"] == result["areas"], result
        assert result["namesMatch"], result
        assert result["allVisible"], result
        assert not result["overlaps"], result
    else:
        assert not result["labels"], result
    return result


def capture(site: Path, label: str, expect_labels: bool) -> list[dict]:
    server, base = serve(site)
    receipts = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                for zoom, route in ROUTES:
                    page.goto(f"{base}{route}", wait_until="networkidle")
                    page.locator(".near-map-section").wait_for()
                    contract = label_contract(page, expect_labels)
                    output = OUTPUT / f"{label}-{zoom}-{width}.png"
                    page.locator(".near-map-section").screenshot(path=str(output))
                    receipts.append({"file": output.name, "zoom": zoom, "width": width, **contract})
                    print("wrote", output.relative_to(ROOT))
                context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    return receipts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", default="HEAD", help="revision for unlabeled comparison")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    receipts = capture(export_before(args.before), "before", False)
    receipts += capture(ROOT / "site", "after", True)
    manifest = {
        "feature": "map-geography-labels",
        "viewports": list(VIEWPORTS),
        "routes": [route for _, route in ROUTES],
        "checks": "polygon-label-list identity and visible-label overlap",
        "captures": receipts,
    }
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("wrote", (OUTPUT / "manifest.json").relative_to(ROOT))


if __name__ == "__main__":
    main()
