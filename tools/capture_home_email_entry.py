#!/usr/bin/env python3
"""Capture homepage email-updates entry before/after at desktop and 390px.

Public alias: c8f4cfa1b7a8d

Before rows read the live production homepage (read-only), including the
phone-viewport map visible-height regression when the email handoff sat on its
own multi-line strip. After rows use the local Near You capture server with the
compact primary-controls handoff and require the live smoke's ≥150px map
visible-height floor at 390×844. Screenshot binaries stay under the task
scratch directory; only the manifest is committed. Use --check to validate an
existing manifest without recapturing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "test" / "browser"))
from browser_support import launched_chromium  # noqa: E402

EVIDENCE_DIR = ROOT / "docs" / "evidence" / "home-email-entry"
MANIFEST_PATH = EVIDENCE_DIR / "capture-manifest.json"
SCREENSHOT_DIR = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "home-email-entry-screenshots"
PUBLIC_ALIAS = "c8f4cfa1b7a8d"
PRODUCTION_BASE = "https://cityscroll.org/"
DESKTOP = (1440, 900)
PHONE = (390, 844)
EMAIL_SELECTOR = "[data-home-email-entry-link]"
EMAIL_LABEL = "Get email updates"
MAP_VISIBLE_FLOOR_PX = 150
MAP_READY_SELECTOR = '[data-near-geography-map-state="ready"]'


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def git_head() -> str:
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
    ).strip()


def fetch_text(url: str, *, timeout: float = 45.0) -> str:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "CityScrollCapture/1.0 (+home-email-entry)"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", "replace")


def render_local_homepage_html() -> str:
    script = r"""
import { readFileSync } from "node:fs";
import { buildNearYouViewModel, renderNearYouDocument } from "./site/near_you_view.mjs";
import { scopeFromNearYouUrl } from "./site/near_you_scope_runtime.mjs";
const boundaries = JSON.parse(readFileSync("site/data/district_boundaries.json", "utf8"));
const view = buildNearYouViewModel(
  scopeFromNearYouUrl("https://cityscroll.org/"),
  null,
  boundaries,
  { dataState: "ready", geometryState: "ready" },
);
process.stdout.write(renderNearYouDocument(view, { assetPrefix: "/" }));
"""
    return subprocess.check_output(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        text=True,
    )


def extract_entry_html(document_html: str) -> str:
    match = re.search(
        r'<p class="near-home-email-entry"[^>]*>[\s\S]*?</p>',
        document_html,
    )
    return match.group(0) if match else ""


class _LocalHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str, homepage_html: str, **kwargs):
        self._homepage_html = homepage_html
        super().__init__(*args, directory=directory, **kwargs)

    def log_message(self, *_args) -> None:  # noqa: D401 - silence capture noise
        return

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in {"/", "/near-you", "/near-you/", "/index.html"}:
            body = self._homepage_html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()


def serve_local(homepage_html: str) -> tuple[ThreadingHTTPServer, str]:
    handler = lambda *args, **kwargs: _LocalHandler(  # noqa: E731
        *args,
        directory=str(ROOT / "site"),
        homepage_html=homepage_html,
        **kwargs,
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}/"


def measure_entry(page) -> dict:
    return page.evaluate(
        """(selector) => {
          const link = document.querySelector(selector);
          const entry = document.querySelector('[data-home-email-entry]');
          const primary = document.querySelector('.near-geo-primary-controls');
          if (!link) {
            return {
              present: false,
              in_viewport: false,
              label: null,
              href: null,
              in_primary_controls: false,
              map_visible_height_px: null,
            };
          }
          const rect = link.getBoundingClientRect();
          const style = window.getComputedStyle(link);
          const inViewport =
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth &&
            style.visibility !== "hidden" &&
            style.display !== "none";
          const canvas = document.querySelector('.maplibregl-canvas');
          let map_visible_height_px = null;
          if (canvas) {
            const box = canvas.getBoundingClientRect();
            map_visible_height_px =
              Math.min(box.y + box.height, window.innerHeight) - Math.max(box.y, 0);
          }
          return {
            present: true,
            in_viewport: inViewport,
            label: (link.textContent || "").trim(),
            href: link.getAttribute("href"),
            min_height_px: Math.round(rect.height),
            top_px: Math.round(rect.top),
            in_primary_controls: !!(primary && entry && primary.contains(entry)),
            map_visible_height_px,
          };
        }""",
        EMAIL_SELECTOR,
    )


def serve_near_you_capture() -> tuple[subprocess.Popen, str]:
    proc = subprocess.Popen(
        ["node", "tools/serve_near_you_capture.mjs"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    assert proc.stdout is not None
    line = proc.stdout.readline().strip()
    if not line.startswith("http://"):
        rest = proc.stdout.read() if proc.stdout else ""
        proc.kill()
        raise RuntimeError(f"near-you capture server failed to start: {line}\n{rest}")
    return proc, line.rstrip("/") + "/"


def capture_row(
    *,
    browser,
    name: str,
    url: str,
    viewport: tuple[int, int],
    phase: str,
    expect_present: bool,
    revision: str,
    entry_content_hash: str | None,
    require_map_floor: bool = False,
) -> dict:
    width, height = viewport
    context = browser.new_context(viewport={"width": width, "height": height})
    page = context.new_page()
    page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    try:
        page.wait_for_selector(MAP_READY_SELECTOR, timeout=120_000)
    except Exception:
        page.wait_for_timeout(250)
    metrics = measure_entry(page)
    if expect_present:
        assert metrics["present"], f"{name}: missing Get email updates control"
        assert metrics["in_viewport"], f"{name}: control not above the fold ({metrics})"
        assert metrics["label"] == EMAIL_LABEL, metrics
        assert metrics["href"] == "/following/?onboarding=1", metrics
        assert metrics["min_height_px"] >= 40, metrics
        if phase == "after":
            assert metrics.get("in_primary_controls") is True, metrics
    else:
        assert not metrics["present"], f"{name}: unexpected email entry on before surface"

    map_visible = metrics.get("map_visible_height_px")
    if require_map_floor:
        assert map_visible is not None, f"{name}: map canvas missing for visible-height check"
        assert map_visible >= MAP_VISIBLE_FLOOR_PX, {
            "visible_height": map_visible,
            "floor": MAP_VISIBLE_FLOOR_PX,
            "viewport": [width, height],
        }

    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    image_path = SCREENSHOT_DIR / f"{name}.png"
    page.screenshot(path=str(image_path), full_page=False)
    digest = sha256_bytes(image_path.read_bytes())
    context.close()

    if phase == "after":
        assertion = (
            "Get email updates stays in primary controls above the fold; "
            f"map visible height meets the {MAP_VISIBLE_FLOOR_PX}px smoke floor"
            if require_map_floor
            else "Get email updates is visible above the fold and opens Following onboarding"
        )
    elif expect_present and width == PHONE[0] and map_visible is not None and map_visible < MAP_VISIBLE_FLOOR_PX:
        assertion = (
            "Production phone viewport still shows Get email updates but leaves the "
            f"Near You map under the {MAP_VISIBLE_FLOOR_PX}px visible-height smoke floor"
        )
    elif expect_present:
        assertion = "Production homepage shows Get email updates above the fold"
    else:
        assertion = "Production homepage lacks the Get email updates entry above the fold"
    return {
        "name": name,
        "phase": phase,
        "route": "/" if "cityscroll.org" in url else "/",
        "url": url,
        "viewport": {"width": width, "height": height},
        "revision": revision,
        "data_vintage": revision,
        "assertion": assertion,
        "sha256": digest,
        "content_hash": entry_content_hash,
        "metrics": metrics,
        "file": None,
        "screenshot_url": None,
        "local_image_ignored": str(image_path.name),
    }


def build_manifest(rows: list[dict], *, revision: str, entry_content_hash: str) -> dict:
    return {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "home-email-entry",
        "public_alias": PUBLIC_ALIAS,
        "capture_mode": "headless-playwright-local-after-production-before",
        "base": PRODUCTION_BASE,
        "condition": (
            "Before rows are read-only production observations of the tall email "
            "handoff. After rows use the local Near You capture server with the "
            "compact primary-controls handoff and record map visible height against "
            "the live smoke floor. Image binaries stay ignored under task scratch."
        ),
        "repository_revision": revision,
        "grounded_at": revision,
        "revision": revision,
        "revision_format": "git rev-parse HEAD for after; production artifact tip noted in before metrics",
        "data_vintage": revision,
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; only this "
            "manifest is committed."
        ),
        "surface": "Homepage Get email updates entry into Following",
        "verifier": "node --test test/home_email_entry.test.mjs",
        "captured_at": utc_now(),
        "local_image_dir_ignored": "home-email-entry-screenshots (local ignored dir under task scratch)",
        "route": "/",
        "entry_content_hash": entry_content_hash,
        "content_hash": entry_content_hash,
        "exact_links": ["/", "/following/?onboarding=1"],
        "captures": rows,
    }


def validate_manifest(path: Path) -> None:
    manifest = json.loads(path.read_text())
    assert manifest["schema"] == "cityscroll.render_capture_manifest.v1"
    assert manifest["feature"] == "home-email-entry"
    assert manifest["public_alias"] == PUBLIC_ALIAS
    assert manifest["image_binaries_committed"] is False
    assert len(manifest["captures"]) >= 4
    widths = {row["viewport"]["width"] for row in manifest["captures"]}
    assert 1440 in widths and 390 in widths
    phases = {row.get("phase") for row in manifest["captures"]}
    assert "before" in phases and "after" in phases
    for row in manifest["captures"]:
        assert re.fullmatch(r"[0-9a-f]{64}", row["sha256"])
        assert row["file"] is None
        assertion = row["assertion"].lower()
        assert (
            "get email updates" in assertion
            or "email updates" in assertion
            or "visible-height" in assertion
            or "smoke floor" in assertion
        ), row["assertion"]
    after_phone = next((row for row in manifest["captures"] if row.get("name") == "after-phone"), None)
    assert after_phone is not None, "after-phone capture required"
    map_visible = after_phone.get("metrics", {}).get("map_visible_height_px")
    assert map_visible is not None and map_visible >= MAP_VISIBLE_FLOOR_PX, after_phone.get("metrics")
    assert re.fullmatch(r"[0-9a-f]{64}", manifest.get("entry_content_hash") or "")
    print(f"capture-home-email-entry: ok {path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate the committed manifest")
    parser.add_argument(
        "--skip-production-before",
        action="store_true",
        help="Skip live before captures when offline; still write after rows",
    )
    args = parser.parse_args(argv)

    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    if args.check:
        validate_manifest(MANIFEST_PATH)
        return 0

    revision = git_head()
    local_html = render_local_homepage_html()
    entry_html = extract_entry_html(local_html)
    assert EMAIL_LABEL in entry_html and "data-home-email-entry-link" in entry_html, (
        "local render is missing the homepage email entry"
    )
    assert "near-geo-primary-controls" in local_html and local_html.find(
        "near-geo-primary-controls"
    ) < local_html.find("data-home-email-entry"), (
        "email entry must render inside primary controls"
    )
    entry_content_hash = sha256_text(entry_html)

    # Static HTML proves markup; the Near You capture server proves map geometry.
    static_server, _static_base = serve_local(local_html)
    capture_proc, local_base = serve_near_you_capture()
    rows: list[dict] = []
    try:
        with launched_chromium() as browser:
            if not args.skip_production_before:
                production_html = fetch_text(PRODUCTION_BASE)
                production_has_entry = "data-home-email-entry" in production_html
                for label, viewport in (("desktop", DESKTOP), ("phone", PHONE)):
                    rows.append(
                        capture_row(
                            browser=browser,
                            name=f"before-{label}",
                            url=PRODUCTION_BASE,
                            viewport=viewport,
                            phase="before",
                            expect_present=production_has_entry,
                            revision=revision,
                            entry_content_hash=None,
                            require_map_floor=False,
                        )
                    )
            for label, viewport in (("desktop", DESKTOP), ("phone", PHONE)):
                rows.append(
                    capture_row(
                        browser=browser,
                        name=f"after-{label}",
                        url=local_base,
                        viewport=viewport,
                        phase="after",
                        expect_present=True,
                        revision=revision,
                        entry_content_hash=entry_content_hash,
                        require_map_floor=True,
                    )
                )
    finally:
        static_server.shutdown()
        static_server.server_close()
        capture_proc.terminate()
        try:
            capture_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            capture_proc.kill()

    manifest = build_manifest(rows, revision=revision, entry_content_hash=entry_content_hash)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    validate_manifest(MANIFEST_PATH)
    print(f"wrote {MANIFEST_PATH}")
    print(f"screenshots under {SCREENSHOT_DIR}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"capture-home-email-entry: {exc}", file=sys.stderr)
        raise SystemExit(1)
