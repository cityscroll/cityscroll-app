#!/usr/bin/env python3
"""Before/after captures for the map exploration surface (cs-geo-04).

    python3 tools/capture_map_exploration.py
    python3 tools/capture_map_exploration.py --before HEAD^

Writes docs/screenshots/map-exploration/{before,after}-*.png
"""

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
OUTPUT = ROOT / "docs" / "screenshots" / "map-exploration"
VIEWPORTS = ((390, 844), (1440, 900))
HASHES = (
    ("borough", "#map"),
    ("queens-cd", "#map?level=community_district&parent=Queens&lens=land"),
    ("district-select", "#map?level=community_district&parent=Queens&id=Q04&lens=land"),
)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A003
        return


def serve(directory: Path):
    handler = functools.partial(QuietHandler, directory=str(directory))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    port = httpd.server_address[1]
    return httpd, f"http://127.0.0.1:{port}"


def capture_tree(tree: Path, label: str) -> None:
    httpd, base = serve(tree / "site" if (tree / "site").is_dir() else tree)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for width, height in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                )
                page = context.new_page()
                for name, hash_route in HASHES:
                    page.goto(f"{base}/index.html{hash_route}", wait_until="networkidle")
                    page.wait_for_selector("#tab-map.map.active, #tab-map[class*='active']", timeout=15000)
                    page.wait_for_selector("#mapAreaList button, #mapAreaList .empty", timeout=15000)
                    # Prefer a painted polygon when present.
                    page.wait_for_timeout(400)
                    out = OUTPUT / f"{label}-{name}-{width}.png"
                    page.screenshot(path=str(out), full_page=False)
                    print("wrote", out.relative_to(ROOT))
                context.close()
            browser.close()
    finally:
        httpd.shutdown()


def export_before(rev: str) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="map-explore-before-"))
    # Export only the files the map surface needs to render.
    files = [
        "site/index.html",
        "site/i18n.js",
        "site/map_exploration.mjs",
        "site/council_district_lookup.mjs",
        "site/data/district_boundaries.json",
        "site/data/district_activity.json",
        "site/data/council_district_boundaries.json",
    ]
    proc = subprocess.run(
        ["git", "archive", "--format=tar", rev, *files],
        cwd=ROOT,
        capture_output=True,
    )
    if proc.returncode != 0:
        # Fall back to empty placeholder directory so after still captures.
        print("before export skipped:", proc.stderr.decode()[:200])
        return tmp
    with tarfile.open(fileobj=io.BytesIO(proc.stdout), mode="r:") as tar:
        tar.extractall(tmp)
    return tmp


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", default=None, help="git rev for before shots")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if args.before:
        before_tree = export_before(args.before)
        # Only capture before when the map surface already existed.
        if (before_tree / "site/map_exploration.mjs").exists() or (
            before_tree / "site/index.html"
        ).exists():
            try:
                capture_tree(before_tree, "before")
            except Exception as exc:  # noqa: BLE001
                print("before capture failed (ok if map was absent):", exc)
    capture_tree(ROOT, "after")
    manifest = {
        "feature": "map-exploration",
        "hashes": [h for _, h in HASHES],
        "viewports": list(VIEWPORTS),
    }
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("done", OUTPUT)


if __name__ == "__main__":
    main()
