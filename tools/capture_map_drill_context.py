#!/usr/bin/env python3
"""Before/after captures for map drill-through scope carry.

    python3 tools/capture_map_drill_context.py
    python3 tools/capture_map_drill_context.py --before HEAD^

Writes docs/screenshots/map-drill-context/{before,after}-*.png
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
OUTPUT = ROOT / "docs" / "screenshots" / "map-drill-context"
VIEWPORTS = ((390, 844), (1440, 900))

# Owner exemplar + borough rules drill + list landing after virtual bag.
SHOTS = (
    ("map-virtual-bucket", "#map?id=Virtual", "map"),
    ("meetings-virtual-scope", "#meetings?scope=virtual&when=all", "meetings"),
    ("map-brooklyn", "#map?id=Brooklyn", "map"),
    ("rules-brooklyn", "#rules?boro=Brooklyn", "rules"),
    ("rules-citywide", "#rules?scope=citywide", "rules"),
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


def wait_for_shot(page, kind: str) -> None:
    if kind == "map":
        page.wait_for_selector("#tab-map.map.active, #tab-map[class*='active']", timeout=20000)
        page.wait_for_selector("#mapDetail:not([hidden]), #mapAreaList button", timeout=20000)
        page.wait_for_timeout(500)
        return
    if kind == "meetings":
        page.wait_for_selector("#tab-meetings.map.active, #tab-meetings[class*='active'], #tab-meetings.active", timeout=20000)
        page.wait_for_selector("#meetingsfeed .fcard, #meetingsfeed .empty, #nltrans-meetings", timeout=25000)
        page.wait_for_timeout(400)
        return
    if kind == "rules":
        page.wait_for_selector("#tab-rules.active, #tab-rules[class*='active']", timeout=20000)
        page.wait_for_selector("#rulesfeed .fcard, #rulesfeed .empty, #nltrans-rules", timeout=25000)
        page.wait_for_timeout(400)


def capture_tree(tree: Path, label: str) -> None:
    site = tree / "site" if (tree / "site").is_dir() else tree
    httpd, base = serve(site)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for width, height in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                )
                page = context.new_page()
                for name, hash_route, kind in SHOTS:
                    page.goto(f"{base}/index.html{hash_route}", wait_until="networkidle")
                    try:
                        wait_for_shot(page, kind)
                    except Exception as exc:  # noqa: BLE001
                        print(f"wait soft-fail {label}/{name}: {exc}")
                    out = OUTPUT / f"{label}-{name}-{width}.png"
                    page.screenshot(path=str(out), full_page=False)
                    print("wrote", out.relative_to(ROOT))
                context.close()
            browser.close()
    finally:
        httpd.shutdown()


def export_before(rev: str) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="map-drill-before-"))
    files = [
        "site/index.html",
        "site/i18n.js",
        "site/map_exploration.mjs",
        "site/hearing_location.js",
        "site/app/map.mjs",
        "site/app/routing.mjs",
        "site/app/feed-actions.mjs",
        "site/app/search-share.mjs",
        "site/app/boot.mjs",
        "site/app/rules.mjs",
        "site/rules_explorer.mjs",
        "site/data/district_boundaries.json",
        "site/data/district_activity.json",
    ]
    # Include module graph pieces the site loads.
    extra = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", rev, "site/app", "site/i18n"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if extra.returncode == 0:
        for line in extra.stdout.splitlines():
            if line and line not in files:
                files.append(line)
    proc = subprocess.run(
        ["git", "archive", "--format=tar", rev, *files],
        cwd=ROOT,
        capture_output=True,
    )
    if proc.returncode != 0:
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
        try:
            capture_tree(before_tree, "before")
        except Exception as exc:  # noqa: BLE001
            print("before capture failed:", exc)
    capture_tree(ROOT, "after")
    manifest = {
        "feature": "map-drill-context",
        "shots": [{"name": n, "hash": h, "kind": k} for n, h, k in SHOTS],
        "viewports": list(VIEWPORTS),
    }
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("done", OUTPUT)


if __name__ == "__main__":
    main()
