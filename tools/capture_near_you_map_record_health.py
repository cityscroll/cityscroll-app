#!/usr/bin/env python3
"""Desktop/mobile read-backs for Near You map/record health decoupling.

Commits textual DOM hashes only. Optional screenshots stay under the task
scratch directory and are never committed.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs/evidence/near-you-map-record-health/capture-manifest.json"
SCREENSHOT_DIR = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "near-you-map-record-health-screenshots"
ROUTE = (
    "/near-you/?geo=nta2020%3ABK0101&surface=map&lens=meetings"
    "&agency=Transportation&q=curb&compare=council_district"
)
SPECIMENS = (
    ("BK0101", "Greenpoint"),
    ("QN0103", "Astoria (Central)"),
    ("SI0101", "St. George-New Brighton"),
)
VIEWPORTS = (
    ("desktop", 1440, 900),
    ("mobile", 390, 844),
)


def revision() -> str:
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def local_rendered_captures(rev: str) -> list[dict]:
    script = r"""
import { createHash } from "node:crypto";
import { buildNearYouViewModel, renderNearYouDocument } from "./site/near_you_view.mjs";
import { scopeFromNearYouUrl } from "./site/near_you_scope_runtime.mjs";
import ntaLayer from "./worker/src/data/geography/layers/nta2020/26B.json" with { type: "json" };
import boundaries from "./site/data/district_boundaries.json" with { type: "json" };

const specimens = JSON.parse(process.argv[1]);
const labelIndex = Object.fromEntries(
  (ntaLayer.features || [])
    .filter((feature) => feature?.key && feature?.label)
    .flatMap((feature) => [
      [feature.key, feature.label],
      [`${feature.type}:${feature.id}`, feature.label],
      [String(feature.id), feature.label],
    ]),
);
const out = [];
for (const [id, label] of specimens) {
  const route = `/near-you/?geo=nta2020%3A${id}&surface=map&lens=meetings&agency=Transportation&q=curb&compare=council_district`;
  const scope = scopeFromNearYouUrl(`https://cityscroll.org${route}`);
  const view = buildNearYouViewModel(scope, null, boundaries, {
    dataState: "error",
    geometryState: "ready",
    canonicalBase: "https://cityscroll.org/near-you",
    geographySearch: route.slice(route.indexOf("?")),
    navigationLayerDoc: ntaLayer,
    navigationLayerType: "nta2020",
    geographyLabelIndex: labelIndex,
  });
  const html = renderNearYouDocument(view, { assetPrefix: "/" });
  if (!html.includes(`<h1>${label}</h1>`)) throw new Error(`${id} missing title`);
  if (!html.includes("Map boundaries: 26B")) throw new Error(`${id} missing vintage`);
  if (html.includes("buyer_history_retry")) throw new Error(`${id} leaked key`);
  if (html.includes(`<h1>${id}</h1>`)) throw new Error(`${id} bare code title`);
  if (!html.includes('data-near-recovery="retry">Try again')) throw new Error(`${id} missing retry`);
  out.push({
    id,
    label,
    route,
    digest: createHash("sha256").update(html).digest("hex"),
  });
}
process.stdout.write(JSON.stringify(out));
"""
    rendered = json.loads(
        subprocess.check_output(
            ["node", "--input-type=module", "-e", script, json.dumps(SPECIMENS)],
            cwd=ROOT,
            text=True,
        )
    )
    captures = []
    for row in rendered:
        for name, width, height in VIEWPORTS:
            captures.append(
                {
                    "source": "local-rendered-output",
                    "name": f"record-failure-{row['id']}-{name}",
                    "route": row["route"],
                    "viewport": {"width": width, "height": height},
                    "data_vintage": "nta2020 26B",
                    "assertion": (
                        f"{row['label']} keeps friendly title, geometry vintage 26B, "
                        "working map state, and plain-language retry when records fail."
                    ),
                    "sha256": row["digest"],
                    "file": None,
                    "revision": rev,
                }
            )
    return captures


def dom_hash(page) -> str:
    markup = page.locator("[data-near-you-root]").evaluate("node => node.outerHTML")
    return sha256(markup)


def capture_served(page, base: str, width: int, height: int, keyboard: bool, rev: str) -> dict:
    page.set_viewport_size({"width": width, "height": height})
    page.route(
        "**/near-you/deferred.json*",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body='{"schema":"cityscroll.near_you_deferred.v1","results_html":null}',
        ),
    )
    page.goto(f"{base}{ROUTE}", wait_until="networkidle")
    page.locator('[data-near-deferred-state="error"]').first.wait_for(timeout=15000)
    root = page.locator("[data-near-you-root]").inner_html()
    assert "buyer_history_retry" not in root
    assert "Try again" in root
    digest = dom_hash(page)
    retry = page.locator('[data-near-recovery="retry"]').last
    page.unroute("**/near-you/deferred.json*")
    if keyboard:
        retry.focus()
        assert page.evaluate("document.activeElement?.dataset.nearRecovery === 'retry'")
        retry.press("Enter")
    else:
        retry.click()
    page.wait_for_timeout(250)
    actual = urlsplit(page.url)
    expected = urlsplit(ROUTE)
    assert actual.path.rstrip("/") == expected.path.rstrip("/")
    expected_q = dict(parse_qsl(expected.query, keep_blank_values=True))
    actual_q = dict(parse_qsl(actual.query, keep_blank_values=True))
    for key in ("lens", "agency", "q", "compare"):
        assert actual_q.get(key) == expected_q.get(key), (key, actual_q.get(key), expected_q.get(key))
    geo = actual_q.get("geo")
    assert geo in {"nta2020:BK0101", "geography:nta2020:BK0101"}, geo
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    page.screenshot(
        path=str(SCREENSHOT_DIR / f"bk0101-records-error-{'mobile' if keyboard else 'desktop'}.png"),
        full_page=True,
    )
    return {
        "source": "headless-http-served-route",
        "name": f"served-records-error-{'mobile' if keyboard else 'desktop'}",
        "route": ROUTE,
        "viewport": {"width": width, "height": height},
        "assertion": (
            "Served Greenpoint selection recovers from deferred record failure with keyboard Enter "
            "while preserving lens, place, comparison, and filters."
            if keyboard
            else "Served Greenpoint selection keeps map identity through deferred record failure "
            "and recovers with a scope-preserving retry."
        ),
        "sha256": digest,
        "file": None,
        "revision": rev,
        "data_vintage": "nta2020 26B",
    }


def main() -> None:
    rev = revision()
    captures = local_rendered_captures(rev)
    server = subprocess.Popen(
        ["node", str(ROOT / "tools/serve_near_you_capture.mjs")],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        text=True,
    )
    assert server.stdout is not None
    base = server.stdout.readline().strip()
    if not base:
        server.kill()
        raise RuntimeError("capture server did not announce a base URL")
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            desktop = browser.new_page()
            captures.append(capture_served(desktop, base, 1440, 900, False, rev))
            touch = browser.new_context(
                viewport={"width": 390, "height": 844},
                has_touch=True,
            ).new_page()
            captures.append(capture_served(touch, base, 390, 844, True, rev))
            browser.close()
    finally:
        server.terminate()

    manifest = {
        "schema": "cityscroll.served_browser_capture_manifest.v1",
        "feature": "near-you-map-record-health",
        "public_alias": "c42128caee453",
        "capture_mode": "headless_playwright_served_route",
        "repository_revision": rev,
        "grounded_at": rev,
        "data_vintage": "nta2020 26B",
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; "
            "only this manifest is committed."
        ),
        "note": "Textual DOM hashes are committed; no image binaries are committed.",
        "captures": captures,
    }
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {MANIFEST} ({len(captures)} captures)")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(exc, file=sys.stderr)
        raise
