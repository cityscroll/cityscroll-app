#!/usr/bin/env python3
"""Capture homepage email-updates entry before/after at desktop and 390px.

Public alias: c8f4cfa1b7a8d

Before rows read the live production homepage (read-only). After rows render
the local Near You shell with the Get email updates handoff. Screenshot
binaries stay under the task scratch directory; only the manifest is
committed. Use --check to validate an existing manifest without recapturing.
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
          if (!link) {
            return { present: false, in_viewport: false, label: null, href: null };
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
          return {
            present: true,
            in_viewport: inViewport,
            label: (link.textContent || "").trim(),
            href: link.getAttribute("href"),
            min_height_px: Math.round(rect.height),
            top_px: Math.round(rect.top),
          };
        }""",
        EMAIL_SELECTOR,
    )


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
) -> dict:
    width, height = viewport
    context = browser.new_context(viewport={"width": width, "height": height})
    page = context.new_page()
    page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_timeout(250)
    metrics = measure_entry(page)
    if expect_present:
        assert metrics["present"], f"{name}: missing Get email updates control"
        assert metrics["in_viewport"], f"{name}: control not above the fold ({metrics})"
        assert metrics["label"] == EMAIL_LABEL, metrics
        assert metrics["href"] == "/following/?onboarding=1", metrics
        assert metrics["min_height_px"] >= 40, metrics
    else:
        assert not metrics["present"], f"{name}: unexpected email entry on before surface"

    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    image_path = SCREENSHOT_DIR / f"{name}.png"
    page.screenshot(path=str(image_path), full_page=False)
    digest = sha256_bytes(image_path.read_bytes())
    context.close()

    assertion = (
        "Get email updates is visible above the fold and opens Following onboarding"
        if expect_present
        else "Production homepage lacks the Get email updates entry above the fold"
    )
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
            "Before rows are read-only production observations. After rows render the "
            "local Near You homepage with the email-updates handoff. Image binaries "
            "stay ignored under task scratch."
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
        assert "Get email updates" in row["assertion"] or "email updates" in row["assertion"].lower()
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
    entry_content_hash = sha256_text(entry_html)

    server, local_base = serve_local(local_html)
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
                    )
                )
    finally:
        server.shutdown()
        server.server_close()

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
