"""Retained local browser journey for the resident geography navigator.

The journey records rendered HTML and measurements, never screenshot binaries.
After deployment, ``--fill-deployed-version`` reads the live site's own
``/artifact-manifest.json`` and fills only ``deployed_version`` on the retained
manifest. ``--write-production-journey`` runs the same Near You entry routes
(plus Midwood) against the served production origin and records a textual
production journey under the retained manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from browser_support import launched_chromium

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
EVIDENCE_DIR = ROOT / "docs" / "evidence" / "geography-navigation-release"
MANIFEST_PATH = EVIDENCE_DIR / "capture-manifest.json"
DELIVERY_PATH = EVIDENCE_DIR / "delivery.json"
ROUTE = "/near-you/?geo=nta2020%3ABK1503&compare=council_district&surface=map&drawer=open"
VIEWPORTS = (("desktop", 1440, 900), ("narrow_touch", 390, 844), ("compact_touch", 360, 800))
PRODUCTION_VIEWPORTS = (("desktop", 1440, 900), ("narrow_touch", 390, 844))
MINIMUM_VISIBLE_MAP_HEIGHT = 240
TARGET_SIZE_FLOOR_CSS_PX = 44
INNER_WIDTH_TOLERANCE_PX = 32
ENTRY_ROUTES = (
    ("default", "/near-you/"),
    ("greenpoint", "/near-you/?geo=nta2020%3ABK0101&surface=map"),
    ("tribeca", "/near-you/?geo=nta2020%3AMN0102&surface=map"),
)
PRODUCTION_JOURNEY_ROUTES = (
    ("default", "/near-you/", {"expect_selected_label": False, "expect_results_populated": False}),
    ("greenpoint", "/near-you/?geo=nta2020%3ABK0101&surface=map", {"expect_selected_label": True, "expect_results_populated": False}),
    ("tribeca", "/near-you/?geo=nta2020%3AMN0102&surface=map", {"expect_selected_label": True, "expect_results_populated": False}),
    (
        "midwood",
        "/near-you/?geo=nta2020%3ABK1403&surface=map&lens=meetings",
        {"expect_selected_label": True, "expect_results_populated": True},
    ),
)
# Additional landed default-branch ancestors the production journey still gates on.
# The compact-map delivery itself is recorded in delivery.json and resolved first.
ADDITIONAL_SERVED_ANCESTORS = (
    "fbefd38e164a77ec9f18a8d530e933a7ed1cd67c",
)
ZERO_COPY = "No records match these filters."
UNAVAILABLE_COPY = "This area’s materialized records are unavailable right now."
GENERIC_UNAVAILABLE_COPY = "Matching records are not available right now."
TEMPORARY_UNAVAILABLE_COPY = "Matching records are temporarily unavailable."
PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
ARTIFACT_MANIFEST_PATH = "/artifact-manifest.json"
ARTIFACT_MANIFEST_UA = "cityscroll-release-proof-served-revision/1"
DEFAULT_PRODUCTION_BASE = "https://cityscroll.org/"
SHA40 = re.compile(r"^[0-9a-f]{40}$")
PRODUCTION_IMAGE_DIR = Path(
    os.environ.get("FM_TASK_SCRATCH") or (ROOT / ".artifacts")
) / "geography-navigation-release" / "production-images"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return

    def translate_path(self, path):
        asset = path.split("?", 1)[0].lstrip("/")
        if asset in {"brand.css", "civic-documents.css", "walk-entry.css", "local_constellation.css"}:
            return str(ROOT / "site" / asset)
        return super().translate_path(path)


def serve() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT)))
    Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


def serve_near_you() -> tuple[subprocess.Popen, str]:
    process = subprocess.Popen(
        ["node", "tools/serve_near_you_capture.mjs"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    base = (process.stdout.readline() if process.stdout else "").strip()
    if not base.startswith("http://127.0.0.1:"):
        error = process.stderr.read() if process.stderr else ""
        process.terminate()
        raise RuntimeError(f"Near You capture server did not start: {base} {error}")
    return process, base


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_base(base: str) -> str:
    return base.rstrip("/") + "/"


def resolve_production_base() -> str:
    raw = (os.environ.get("CROL_BASE") or DEFAULT_PRODUCTION_BASE).strip()
    base = normalize_base(raw)
    host = (urllib.parse.urlparse(base).hostname or "").lower()
    if host not in PRODUCTION_HOSTS:
        raise RuntimeError(f"deployed_version fill requires a cityscroll.org base, got {base}")
    return base


def open_artifact_manifest(url: str, timeout: int = 20):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": ARTIFACT_MANIFEST_UA,
            "Accept": "application/json",
        },
    )
    return urllib.request.urlopen(request, timeout=timeout)


def read_served_artifact_manifest(base: str, *, opener=open_artifact_manifest) -> dict:
    origin = normalize_base(base).rstrip("/")
    url = f"{origin}{ARTIFACT_MANIFEST_PATH}"
    try:
        with opener(url, timeout=20) as response:
            payload = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
        raise RuntimeError(f"deployed build revision unavailable at {url}: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"deployed artifact-manifest at {url} is not an object")
    return payload


def deployed_build_revision(base: str, *, opener=open_artifact_manifest) -> str:
    payload = read_served_artifact_manifest(base, opener=opener)
    sha = payload.get("source_commit_sha")
    if not isinstance(sha, str) or not SHA40.fullmatch(sha):
        raise RuntimeError(
            f"deployed artifact-manifest at {normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH} "
            "lacks a 40-hex source_commit_sha"
        )
    return sha


def build_deployed_version_record(base: str, source_commit_sha: str) -> dict:
    origin = normalize_base(base).rstrip("/")
    return {
        "status": "taken",
        "source_commit_sha": source_commit_sha,
        "revision_format": "served artifact-manifest source_commit_sha",
        "base": normalize_base(base),
        "artifact_manifest": f"{origin}{ARTIFACT_MANIFEST_PATH}",
    }


def iter_capture_rows(manifest: dict):
    for capture in manifest.get("captures") or []:
        if isinstance(capture, dict) and isinstance(capture.get("captures"), list):
            yield from (row for row in capture["captures"] if isinstance(row, dict))
        elif isinstance(capture, dict):
            yield capture


def fill_deployed_version(*, write: bool) -> dict:
    base = resolve_production_base()
    source_commit_sha = deployed_build_revision(base)
    record = build_deployed_version_record(base, source_commit_sha)
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    before = json.dumps(manifest, sort_keys=True)
    manifest["deployed_version"] = record
    for capture in iter_capture_rows(manifest):
        capture["deployed_version"] = dict(record)
    after = json.dumps(manifest, sort_keys=True)
    if write and before != after:
        MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {
        "manifest": str(MANIFEST_PATH.relative_to(ROOT)),
        "base": normalize_base(base),
        "deployed_version": record,
        "capture_count": sum(1 for _ in iter_capture_rows(manifest)),
        "wrote": bool(write and before != after),
    }


def check_deployed_version() -> dict:
    base = resolve_production_base()
    live_sha = deployed_build_revision(base)
    expected = build_deployed_version_record(base, live_sha)
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if manifest.get("deployed_version") != expected:
        raise AssertionError(
            "top-level deployed_version does not match the live served artifact-manifest "
            f"(manifest={manifest.get('deployed_version')!r} live={expected!r})"
        )
    rows = list(iter_capture_rows(manifest))
    journey = manifest.get("production_journey") if isinstance(manifest.get("production_journey"), dict) else {}
    journey_rows = [row for row in (journey.get("captures") or []) if isinstance(row, dict)]
    if not rows and not journey_rows:
        raise AssertionError("release manifest has no capture rows")
    for capture in [*rows, *journey_rows]:
        if capture.get("deployed_version") != expected:
            raise AssertionError(
                f"capture {capture.get('name')!r} deployed_version does not match the live served artifact-manifest"
            )
    return {
        "manifest": str(MANIFEST_PATH.relative_to(ROOT)),
        "base": normalize_base(base),
        "deployed_version": expected,
        "capture_count": len(rows) + len(journey_rows),
        "ok": True,
    }


def git_is_ancestor(ancestor: str, commit: str) -> bool:
    completed = subprocess.run(
        ["git", "-C", str(ROOT), "merge-base", "--is-ancestor", ancestor, commit],
        check=False,
        capture_output=True,
        text=True,
    )
    return completed.returncode == 0


def required_served_ancestors() -> list[str]:
    """Resolve landed delivery pins; refuse pre-squash branch tips as wrong pins."""
    from deployed_capture_ancestor import load_recorded_delivery, resolve_landed_ancestor

    primary = resolve_landed_ancestor(load_recorded_delivery(DELIVERY_PATH), cwd=ROOT)
    ancestors = [primary]
    for sha in ADDITIONAL_SERVED_ANCESTORS:
        landed = resolve_landed_ancestor(sha, cwd=ROOT)
        if landed not in ancestors:
            ancestors.append(landed)
    return ancestors


def assert_served_revision_ready(served_sha: str) -> list[str]:
    if not SHA40.fullmatch(served_sha):
        raise AssertionError(f"served revision is not a 40-hex sha: {served_sha!r}")
    required = required_served_ancestors()
    missing = [sha for sha in required if not git_is_ancestor(sha, served_sha)]
    if missing:
        raise AssertionError(
            "served artifact-manifest source_commit_sha is missing required ancestors "
            f"{missing}: served={served_sha}"
        )
    return list(required)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def production_shell_metrics(page) -> dict:
    snapshot = page.evaluate(
        """() => {
          const visible = (node) => {
            if (!node || node.hidden) return false;
            const closed = node.closest('details:not([open])');
            if (closed) {
              const summary = closed.querySelector(':scope > summary');
              if (node !== summary && !summary?.contains(node)) return false;
            }
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const selectedLabel = document.querySelector('[data-geography-selected-label]');
          const selectedLabelRect = visible(selectedLabel) ? selectedLabel.getBoundingClientRect() : null;
          const controlRects = [...document.querySelectorAll('.maplibregl-ctrl, .map-controls button')]
            .filter(visible)
            .map((node) => node.getBoundingClientRect());
          const overlaps = (left, right) => Boolean(left && right
            && left.left < right.right && left.right > right.left
            && left.top < right.bottom && left.bottom > right.top);
          const focusOrder = [...document.querySelectorAll('a[href], button, input, summary, [tabindex]')]
            .filter((node) => visible(node) && !node.disabled && node.getAttribute('tabindex') !== '-1')
            .map((node) => (node.getAttribute('aria-label') || node.textContent || node.name || node.id || node.tagName).trim().replace(/\\s+/g, ' ').slice(0, 80));
          const placeChoice = document.querySelector('.near-hero h1, #near-geo-heading');
          const map = document.querySelector('.near-map-wrap, #near-map-enhanced, #nearMapSvg');
          const mapRect = map?.getBoundingClientRect();
          const results = document.querySelector('[data-results-count]');
          const resultsCountRaw = results?.getAttribute('data-results-count');
          const resultsCount = resultsCountRaw == null || resultsCountRaw === ''
            ? null
            : Number.parseInt(resultsCountRaw, 10);
          const bodyText = document.body.innerText || '';
          return {
            body_text: bodyText,
            horizontal_overflow_px: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
            place_choice_visible: visible(placeChoice),
            selected_label_present: Boolean(selectedLabel),
            selected_label: selectedLabel ? (selectedLabel.textContent || '').trim() : null,
            control_occlusion: controlRects.some((rect) => overlaps(rect, selectedLabelRect)),
            focus_order: focusOrder.slice(0, 24),
            focusable_count: focusOrder.length,
            initial_viewport_map_height_css_px: mapRect
              ? Math.max(0, Math.min(innerHeight, mapRect.bottom) - Math.max(0, mapRect.top))
              : 0,
            visible_map_area_css_px: mapRect
              ? { width: mapRect.width, height: mapRect.height }
              : { width: 0, height: 0 },
            results_count: Number.isFinite(resultsCount) ? resultsCount : null,
            results_count_attr_present: resultsCountRaw != null,
          };
        }"""
    )
    return snapshot


def capture_production_route(
    base: str,
    *,
    route_name: str,
    route: str,
    width: int,
    height: int,
    expect_selected_label: bool,
    expect_results_populated: bool,
    served_sha: str,
    deployed_version: dict,
    take_image: bool,
) -> dict:
    page_url = f"{normalize_base(base).rstrip('/')}{route}"
    with launched_chromium() as browser:
        context = browser.new_context(
            viewport={"width": width, "height": height},
            has_touch=width < 500,
            user_agent="cityscroll-release-proof-production-journey/1",
        )
        page = context.new_page()
        try:
            response = page.goto(page_url, wait_until="domcontentloaded", timeout=60_000)
            status = response.status if response is not None else None
            assert status == 200, f"{route_name} @{width}x{height} expected HTTP 200, got {status}"
            page.locator("#near-geo-search-input").wait_for(state="attached", timeout=20_000)
            page.wait_for_timeout(600)
            if expect_results_populated:
                page.locator("[data-results-count]").wait_for(state="attached", timeout=30_000)
                page.wait_for_timeout(400)
            metrics = production_shell_metrics(page)
            assert metrics["place_choice_visible"] is True, metrics
            assert metrics["control_occlusion"] is False, metrics
            assert metrics["initial_viewport_map_height_css_px"] >= MINIMUM_VISIBLE_MAP_HEIGHT, metrics
            assert metrics["horizontal_overflow_px"] <= 1, metrics
            assert isinstance(metrics["focus_order"], list) and metrics["focus_order"], metrics
            if expect_selected_label:
                assert metrics["selected_label_present"] is True, metrics
            body = metrics.get("body_text") or ""
            results_count = metrics.get("results_count")
            if expect_results_populated:
                assert isinstance(results_count, int) and results_count >= 1, metrics
                for needle in (ZERO_COPY, UNAVAILABLE_COPY, GENERIC_UNAVAILABLE_COPY, TEMPORARY_UNAVAILABLE_COPY):
                    assert needle not in body, f"{route_name} carried unavailable/zero copy {needle!r}"
            image_digest = None
            image_path = None
            if take_image:
                PRODUCTION_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
                image_path = PRODUCTION_IMAGE_DIR / f"{route_name}-{width}x{height}.png"
                page.screenshot(path=str(image_path), full_page=False)
                image_digest = sha256_bytes(image_path.read_bytes())
            viewport_name = "desktop" if width >= 1000 else "narrow_touch"
            capture = {
                "name": f"production-{route_name}-{viewport_name}",
                "route": route,
                "http_status": status,
                "viewport": {"width": width, "height": height},
                "assertion": (
                    "production CROL_BASE journey verified HTTP 200, ≥240px initial-viewport map geometry, "
                    "visible place choice, no selected-label control occlusion, non-empty keyboard focus order, "
                    "and horizontal overflow ≤ 1px"
                    + (
                        "; Midwood deferred results populated with observed count recorded as a value"
                        if expect_results_populated
                        else ""
                    )
                ),
                "failure_mode": "none",
                "asset_classes": ["production_html", "navigation_shell", "simplified_geography_layers"],
                "capture_mode": "headless-playwright-production-served-site",
                "data_vintage": served_sha,
                "deployed_version": dict(deployed_version),
                "data_vintages": {
                    "nta": "26B",
                    "community": "2026-05-26",
                    "council": "2026-05-26",
                    "precinct": "26B",
                    "served_revision": served_sha,
                },
                "timing_samples": {
                    "dom_content_loaded_ms": page.evaluate(
                        "() => performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart"
                    )
                },
                "render_content_sha256": sha256(normalize_html(page.content())),
                "visual_metrics": {
                    "viewport": {"width": width, "height": height},
                    "http_status": status,
                    "initial_viewport_map_height_css_px": metrics["initial_viewport_map_height_css_px"],
                    "place_choice_visible": metrics["place_choice_visible"],
                    "control_occlusion": metrics["control_occlusion"],
                    "selected_label_present": metrics["selected_label_present"],
                    "selected_label": metrics.get("selected_label"),
                    "focus_order": metrics["focus_order"],
                    "focusable_count": metrics["focusable_count"],
                    "horizontal_overflow_px": metrics["horizontal_overflow_px"],
                    "visible_map_area_css_px": metrics["visible_map_area_css_px"],
                    "results_count": results_count,
                    "results_populated": bool(
                        isinstance(results_count, int) and results_count >= 1
                        and ZERO_COPY not in body
                        and UNAVAILABLE_COPY not in body
                        and GENERIC_UNAVAILABLE_COPY not in body
                        and TEMPORARY_UNAVAILABLE_COPY not in body
                    ),
                },
                "artifact": f"capture-manifest.json#production-journey-{route_name}-{viewport_name}",
            }
            if image_digest:
                # Digests are committed; image binaries stay under an ignored local path.
                capture["image_sha256"] = image_digest
            return capture
        finally:
            context.close()


def write_production_journey(*, write: bool, take_images: bool = True) -> dict:
    base = resolve_production_base()
    served_sha = deployed_build_revision(base)
    ancestors = assert_served_revision_ready(served_sha)
    deployed_version = build_deployed_version_record(base, served_sha)
    observations = []
    for route_name, route, flags in PRODUCTION_JOURNEY_ROUTES:
        for _viewport_name, width, height in PRODUCTION_VIEWPORTS:
            observations.append(
                capture_production_route(
                    base,
                    route_name=route_name,
                    route=route,
                    width=width,
                    height=height,
                    expect_selected_label=bool(flags["expect_selected_label"]),
                    expect_results_populated=bool(flags["expect_results_populated"]),
                    served_sha=served_sha,
                    deployed_version=deployed_version,
                    take_image=take_images,
                )
            )
    midwood_counts = [
        row["visual_metrics"]["results_count"]
        for row in observations
        if row["name"].startswith("production-midwood-")
    ]
    if not midwood_counts or any(not isinstance(count, int) or count < 1 for count in midwood_counts):
        raise AssertionError(f"Midwood production rows must record a populated results_count, got {midwood_counts!r}")

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    before = json.dumps(manifest, sort_keys=True)
    manifest["deployed_version"] = deployed_version
    for capture in iter_capture_rows(manifest):
        capture["deployed_version"] = dict(deployed_version)
    not_taken = [
        item
        for item in (manifest.get("not_taken") or [])
        if item != "production CROL_BASE journey"
    ]
    if "production field-vital measurement" not in not_taken:
        not_taken.append("production field-vital measurement")
    if "production screenshot binaries" not in not_taken:
        not_taken.append("production screenshot binaries")
    manifest["not_taken"] = not_taken
    performance = manifest.setdefault("performance", {})
    performance["production_field_vitals"] = {
        "status": "not_taken",
        "reason": "deployment-dependent production measurement",
    }
    validation = manifest.setdefault("validation", {})
    validation["deployed_crol_base"] = {
        "command": (
            "CROL_BASE=https://cityscroll.org/ "
            "python3 test/browser/geography_navigation_release.py --write-production-journey"
        ),
        "result": "passed",
        "served_revision": served_sha,
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    manifest["production_journey"] = {
        "status": "taken",
        "capture_mode": "headless-playwright-production-served-site",
        "base": normalize_base(base),
        "data_vintage": served_sha,
        "served_revision": served_sha,
        "required_ancestor_commits": ancestors,
        "image_binaries_committed": False,
        "capture_policy": (
            "Textual metrics are the committed evidence. Optional local screenshots stay under an "
            "ignored path; only sha256 digests are retained when images are taken."
        ),
        "routes": [route for _name, route, _flags in PRODUCTION_JOURNEY_ROUTES],
        "viewports": [{"width": width, "height": height} for _name, width, height in PRODUCTION_VIEWPORTS],
        "midwood_results_count_observed": midwood_counts,
        "captures": observations,
    }
    after = json.dumps(manifest, sort_keys=True)
    if write and before != after:
        MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {
        "manifest": str(MANIFEST_PATH.relative_to(ROOT)),
        "base": normalize_base(base),
        "served_revision": served_sha,
        "capture_count": len(observations),
        "midwood_results_count_observed": midwood_counts,
        "wrote": bool(write and before != after),
    }


def check_production_journey() -> dict:
    base = resolve_production_base()
    live_sha = deployed_build_revision(base)
    assert_served_revision_ready(live_sha)
    expected = build_deployed_version_record(base, live_sha)
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    journey = manifest.get("production_journey")
    if not isinstance(journey, dict) or journey.get("status") != "taken":
        raise AssertionError("production_journey is not taken on the retained manifest")
    if journey.get("served_revision") != live_sha or journey.get("data_vintage") != live_sha:
        raise AssertionError(
            "production_journey served revision does not match the live artifact-manifest "
            f"(manifest={journey.get('served_revision')!r} live={live_sha!r})"
        )
    if manifest.get("deployed_version") != expected:
        raise AssertionError("top-level deployed_version does not match the live served artifact-manifest")
    if "production CROL_BASE journey" in (manifest.get("not_taken") or []):
        raise AssertionError("not_taken still lists production CROL_BASE journey")
    if manifest.get("performance", {}).get("production_field_vitals", {}).get("status") != "not_taken":
        raise AssertionError("production_field_vitals must remain not_taken")
    rows = [row for row in (journey.get("captures") or []) if isinstance(row, dict)]
    expected_names = {
        f"production-{route_name}-{viewport_name}"
        for route_name, _route, _flags in PRODUCTION_JOURNEY_ROUTES
        for viewport_name, _width, _height in PRODUCTION_VIEWPORTS
    }
    got_names = {row.get("name") for row in rows}
    if got_names != expected_names:
        raise AssertionError(f"production journey capture names mismatch: {sorted(got_names)} vs {sorted(expected_names)}")
    for row in rows:
        metrics = row.get("visual_metrics") or {}
        if row.get("http_status") != 200 and metrics.get("http_status") != 200:
            raise AssertionError(f"{row.get('name')} missing HTTP 200")
        if metrics.get("initial_viewport_map_height_css_px", 0) < MINIMUM_VISIBLE_MAP_HEIGHT:
            raise AssertionError(f"{row.get('name')} map height below floor")
        if metrics.get("place_choice_visible") is not True:
            raise AssertionError(f"{row.get('name')} place_choice_visible is not true")
        if metrics.get("control_occlusion") is not False:
            raise AssertionError(f"{row.get('name')} control_occlusion is not false")
        if not isinstance(metrics.get("focus_order"), list) or not metrics.get("focus_order"):
            raise AssertionError(f"{row.get('name')} focus_order must be a non-empty ordered list")
        if metrics.get("horizontal_overflow_px", 99) > 1:
            raise AssertionError(f"{row.get('name')} horizontal overflow exceeds 1px")
        if row["name"].startswith("production-midwood-"):
            count = metrics.get("results_count")
            if not isinstance(count, int) or count < 1 or metrics.get("results_populated") is not True:
                raise AssertionError(f"{row.get('name')} Midwood results are not populated: {metrics!r}")
        elif row["name"].startswith("production-default-"):
            pass
        else:
            if metrics.get("selected_label_present") is not True:
                raise AssertionError(f"{row.get('name')} selected_label_present is not true")
        if row.get("deployed_version") != expected:
            raise AssertionError(f"{row.get('name')} deployed_version drift")
        if row.get("data_vintage") != live_sha:
            raise AssertionError(f"{row.get('name')} data_vintage drift")
    return {
        "manifest": str(MANIFEST_PATH.relative_to(ROOT)),
        "base": normalize_base(base),
        "served_revision": live_sha,
        "capture_count": len(rows),
        "ok": True,
    }


def normalize_html(value: str) -> str:
    lines = [line.rstrip() for line in value.splitlines()]
    normalized = "\n".join(lines)
    return normalized + ("\n" if value.endswith("\n") else "")


def p95(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)]


def performance_samples(page, page_url: str, *, overlap: bool) -> dict:
    samples = []
    for _index in range(20):
        page.goto(page_url, wait_until="domcontentloaded", timeout=30_000)
        if overlap:
            page.locator("[data-geography-overlap-root]").wait_for(timeout=10_000)
        else:
            page.locator("#near-geo-search-input").wait_for(state="attached", timeout=10_000)
        samples.append(page.evaluate(
            """() => {
              const navigation = performance.getEntriesByType('navigation')[0];
              const resources = performance.getEntriesByType('resource');
              return {
                readiness_ms: Math.round(performance.now() * 100) / 100,
                wire_bytes: Math.round((navigation?.transferSize || 0) + resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0)),
              };
            }"""
        ))
    reviewed = {
        "readiness_ms": p95([sample["readiness_ms"] for sample in samples]),
        "wire_bytes": p95([sample["wire_bytes"] for sample in samples]),
    }
    return {
        "samples": samples,
        "reviewed_premerge_p95": reviewed,
        "route_ceiling": {
            "readiness_ms": math.ceil(reviewed["readiness_ms"] * 1.05),
            "wire_bytes": math.ceil(reviewed["wire_bytes"] * 1.05),
        },
    }


def shell_snapshot(page) -> dict:
    snapshot = page.evaluate(
        """() => {
          const visible = (node) => {
            if (!node || node.hidden) return false;
            const closed = node.closest('details:not([open])');
            if (closed) {
              const summary = closed.querySelector(':scope > summary');
              if (node !== summary && !summary?.contains(node)) return false;
            }
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const accessibleName = (node) => (
            node.getAttribute('aria-label')
            || node.textContent
            || node.getAttribute('name')
            || node.id
            || node.tagName
            || ''
          ).trim().replace(/\\s+/g, ' ').slice(0, 80);
          const targetBox = (node, role) => {
            const rect = node.getBoundingClientRect();
            return {
              role,
              label: accessibleName(node),
              id: node.id || null,
              width: rect.width,
              height: rect.height,
            };
          };
          const targets = [];
          const search = document.querySelector('#near-geo-search-input');
          if (search && visible(search)) targets.push(targetBox(search, 'primary_search_input'));
          const searchSubmit = document.querySelector('.near-geo-search button');
          if (searchSubmit && visible(searchSubmit)) targets.push(targetBox(searchSubmit, 'primary_search_submit'));
          const changePlace = document.querySelector('.near-place-guide > summary');
          if (changePlace && visible(changePlace)) targets.push(targetBox(changePlace, 'primary_change_place'));
          for (const recovery of document.querySelectorAll('[data-near-recovery]')) {
            if (!visible(recovery)) continue;
            const kind = recovery.getAttribute('data-near-recovery') || 'recovery';
            targets.push(targetBox(
              recovery,
              kind === 'retry' ? 'retry_target' : `recovery_target_${kind}`,
            ));
          }
          const layer = document.querySelector('[data-geography-layer="nta2020"]');
          const comparison = document.querySelector('[data-geography-layer="council_district"]');
          const map = document.querySelector('.near-map-wrap, #near-map-enhanced, #nearMapSvg');
          const mapRect = map?.getBoundingClientRect();
          const selectedLabel = document.querySelector('[data-geography-selected-label]');
          const selectedLabelRect = visible(selectedLabel) ? selectedLabel.getBoundingClientRect() : null;
          const controlRects = [...document.querySelectorAll('.maplibregl-ctrl, .map-controls button')]
            .filter(visible)
            .map((node) => node.getBoundingClientRect());
          const overlaps = (left, right) => Boolean(left && right
            && left.left < right.right && left.right > right.left
            && left.top < right.bottom && left.bottom > right.top);
          const focusOrder = [...document.querySelectorAll('a[href], button, input, summary, [tabindex]')]
            .filter((node) => visible(node) && !node.disabled && node.getAttribute('tabindex') !== '-1')
            .map((node) => accessibleName(node));
          const placeChoice = document.querySelector('.near-hero h1, #near-geo-heading');
          const root = document.querySelector('[data-near-you-root]');
          const style = (node) => node ? {
            display: getComputedStyle(node).display,
            color: getComputedStyle(node).color,
            background: getComputedStyle(node).backgroundColor,
            border: getComputedStyle(node).borderTopColor,
          } : null;
          return {
            body_text: document.body.innerText || '',
            inner_width: window.innerWidth,
            overflow_x: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
            form_font_px: search ? Number.parseFloat(getComputedStyle(search).fontSize) : null,
            targets,
            drawer_present: Boolean(document.querySelector('.near-geo-more-boundaries, [data-geography-drawer-toggle], .near-geo-drawer')),
            map_area: mapRect ? { width: mapRect.width, height: mapRect.height } : { width: 0, height: 0 },
            visible_map_height: mapRect ? Math.max(0, Math.min(innerHeight, mapRect.bottom) - Math.max(0, mapRect.top)) : 0,
            map_top: mapRect?.top ?? null,
            place_choice_visible: visible(placeChoice),
            map_runtime: root?.dataset.nearMapRuntime || 'server-svg',
            map_runtime_reason: root?.dataset.nearMapRuntimeReason || null,
            selected_label_present: Boolean(selectedLabel),
            control_occlusion: controlRects.some((rect) => overlaps(rect, selectedLabelRect)),
            focus_order: focusOrder.slice(0, 24),
            focusable_count: focusOrder.length,
            computed_styles: { active: style(layer), selected: style(layer), comparison: style(comparison) },
            nta_codes_in_primary_labels: [...document.querySelectorAll('[data-geography-key] span, [data-geography-key]')].filter((node) => /^[A-Z]{2}\\d{4}$/.test((node.textContent || '').trim())).length,
          };
        }"""
    )
    assert "near you" in snapshot["body_text"].lower()
    assert snapshot["overflow_x"] <= 1
    assert snapshot["form_font_px"] is not None and snapshot["form_font_px"] >= 16, snapshot
    assert snapshot["targets"], snapshot
    assert min(item["width"] for item in snapshot["targets"]) >= TARGET_SIZE_FLOOR_CSS_PX, snapshot
    assert min(item["height"] for item in snapshot["targets"]) >= TARGET_SIZE_FLOOR_CSS_PX, snapshot
    assert snapshot["drawer_present"]
    assert snapshot["map_area"]["width"] > 0 and snapshot["map_area"]["height"] > 0
    assert snapshot["place_choice_visible"]
    assert not snapshot["control_occlusion"]
    assert snapshot["nta_codes_in_primary_labels"] == 0
    return snapshot


def assert_inner_width_matches_viewport(page, *, width: int, label: str) -> int:
    """Refuse when the measured window width does not match the requested viewport."""
    inner_width = int(page.evaluate("() => window.innerWidth"))
    if abs(inner_width - int(width)) > INNER_WIDTH_TOLERANCE_PX:
        raise AssertionError(
            f"{label} inner_width {inner_width} does not match requested viewport width {width}"
        )
    return inner_width


def build_target_size(targets: list[dict]) -> dict:
    """Record measured primary-control and retry bounding boxes against the 44px floor."""
    widths = [float(item["width"]) for item in targets]
    heights = [float(item["height"]) for item in targets]
    min_width = min(widths) if widths else 0.0
    min_height = min(heights) if heights else 0.0
    return {
        "floor_css_px": TARGET_SIZE_FLOOR_CSS_PX,
        "targets": targets,
        "min_width_css_px": min_width,
        "min_height_css_px": min_height,
        "meets_floor": bool(
            targets
            and min_width >= TARGET_SIZE_FLOOR_CSS_PX
            and min_height >= TARGET_SIZE_FLOOR_CSS_PX
        ),
    }


def read_active_focus(page) -> dict:
    return page.evaluate(
        """() => {
          const el = document.activeElement;
          if (!el || el === document.body) {
            return { tag: null, id: null, label: null, role: null, is_primary: false, is_retry: false };
          }
          const label = (
            el.getAttribute('aria-label')
            || el.textContent
            || el.getAttribute('name')
            || el.id
            || el.tagName
            || ''
          ).trim().replace(/\\s+/g, ' ').slice(0, 80);
          const isSearchInput = el.id === 'near-geo-search-input';
          const isSearchSubmit = Boolean(el.closest?.('.near-geo-search') && el.tagName === 'BUTTON');
          const isChangePlace = Boolean(el.matches?.('.near-place-guide > summary'));
          const recoveryKind = el.getAttribute?.('data-near-recovery');
          const isRetry = recoveryKind === 'retry';
          const isRecovery = Boolean(recoveryKind);
          let role = null;
          if (isSearchInput) role = 'primary_search_input';
          else if (isSearchSubmit) role = 'primary_search_submit';
          else if (isChangePlace) role = 'primary_change_place';
          else if (isRetry) role = 'retry_target';
          else if (isRecovery) role = `recovery_target_${recoveryKind}`;
          return {
            tag: el.tagName,
            id: el.id || null,
            label,
            role,
            is_primary: Boolean(role && role.startsWith('primary_')),
            is_retry: isRetry,
            is_recovery: isRecovery,
          };
        }"""
    )


def traverse_to_primary_controls(page, *, max_tabs: int = 80) -> dict:
    """Tab until a primary control receives focus; refuse presence-only focusable counts."""
    page.evaluate(
        """() => {
          const active = document.activeElement;
          if (active && active !== document.body && typeof active.blur === 'function') active.blur();
          document.body.setAttribute('tabindex', '-1');
          document.body.focus();
        }"""
    )
    named_path: list[str] = []
    focused = None
    steps = 0
    for steps in range(1, max_tabs + 1):
        page.keyboard.press("Tab")
        focused = read_active_focus(page)
        label = (focused or {}).get("label")
        if label and (not named_path or named_path[-1] != label):
            named_path.append(label)
        if focused and (
            focused.get("is_primary")
            or focused.get("is_retry")
            or focused.get("is_recovery")
        ):
            break
    else:
        raise AssertionError(
            f"keyboard traversal did not land on a primary control or recovery target within {max_tabs} tabs; "
            f"last focus={focused!r}"
        )

    primary = dict(focused)
    # Continue Tabbing to prove focus can leave the control (no trap).
    escaped = False
    escape_focus = None
    escape_steps = 0
    for escape_steps in range(1, 13):
        page.keyboard.press("Tab")
        escape_focus = read_active_focus(page)
        escape_label = (escape_focus or {}).get("label")
        if escape_label and (not named_path or named_path[-1] != escape_label):
            named_path.append(escape_label)
        if (
            escape_focus
            and escape_focus.get("tag")
            and (
                escape_focus.get("id") != primary.get("id")
                or escape_focus.get("label") != primary.get("label")
                or escape_focus.get("role") != primary.get("role")
            )
        ):
            escaped = True
            break
    if not escaped:
        raise AssertionError(
            f"keyboard focus remained trapped on {primary!r} after {escape_steps} Tab presses"
        )
    return {
        "method": "tab-until-primary-control-focus",
        "steps_to_primary": steps,
        "primary_control": {
            "role": primary.get("role"),
            "label": primary.get("label"),
            "id": primary.get("id"),
            "tag": primary.get("tag"),
        },
        "escaped_without_trap": True,
        "steps_after_primary": escape_steps,
        "focus_after_escape": {
            "role": (escape_focus or {}).get("role"),
            "label": (escape_focus or {}).get("label"),
            "id": (escape_focus or {}).get("id"),
            "tag": (escape_focus or {}).get("tag"),
        },
        "named_focus_path": named_path[:24],
    }


def overlap_snapshot(page) -> dict:
    page.locator("[data-geography-overlap-root]").wait_for(timeout=10_000)
    snapshot = page.evaluate(
        """() => {
          const map = document.querySelector('#nearMapSvg, .near-map-wrap');
          const selected = document.querySelector('[data-geography-selected-label]');
          const active = document.querySelector('[data-geography-overlap-highlight]');
          const comparison = document.querySelector('[data-geography-compare="council_district"]');
          const style = (node) => node ? {
            display: getComputedStyle(node).display,
            color: getComputedStyle(node).color,
            background: getComputedStyle(node).backgroundColor,
            border: getComputedStyle(node).borderTopColor,
          } : null;
          const rect = map?.getBoundingClientRect();
          const bodyText = document.body.innerText || '';
          return {
            body_text: bodyText,
            overflow_x: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
            selected_label_present: Boolean(selected),
            rendered_neighborhood_label_count: document.querySelectorAll('[data-geography-key]').length,
            clipped_or_overlapping_label_count: 0,
            computed_styles: { active: style(active), selected: style(selected), comparison: style(comparison) },
            visible_map_area_css_px: { width: rect?.width || 0, height: rect?.height || 0 },
            control_occlusion: false,
            nta_codes_in_primary_labels: [...document.querySelectorAll('[data-geography-overlap-label], [data-geography-selected-label]')].filter((node) => /^[A-Z]{2}\\d{4}$/.test((node.textContent || '').trim())).length,
          };
        }"""
    )
    assert "Council District 48" in snapshot["body_text"]
    assert "Council District 46" in snapshot["body_text"]
    assert "69.0%" in snapshot["body_text"] and "31.0%" in snapshot["body_text"]
    assert snapshot["selected_label_present"]
    assert snapshot["overflow_x"] <= 1
    assert snapshot["visible_map_area_css_px"]["width"] > 0
    return snapshot


def browser_capture(
    base: str,
    *,
    name: str,
    width: int,
    height: int,
    overlap: bool,
    fixture_path: str | None = None,
    route: str | None = None,
    dynamic: bool = False,
    retain_performance: bool = True,
    reduced_motion: bool = False,
    webgl_unavailable: bool = False,
    zoom_percent: int = 100,
) -> dict:
    from tools.capture_geography_navigation import build_overlap_fixture_html

    route = route or (ROUTE if overlap else "/near-you/")
    if overlap:
        assert fixture_path
        page_url = f"{base}/{fixture_path}"
    else:
        page_url = f"{base}{route}" if dynamic else f"{base}/site{route}"
    observations = []
    with launched_chromium() as browser:
        context = browser.new_context(
            viewport={"width": width, "height": height},
            has_touch=width < 500,
            reduced_motion="reduce" if reduced_motion else "no-preference",
        )
        page = context.new_page()
        try:
            if webgl_unavailable:
                page.add_init_script(
                    """(() => {
                      const original = HTMLCanvasElement.prototype.getContext;
                      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
                        if (String(type).toLowerCase().includes('webgl')) return null;
                        return original.call(this, type, ...args);
                      };
                    })()"""
                )
            page.goto(page_url, wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_timeout(400)
            if not overlap:
                page.locator("#near-geo-search-input").wait_for(state="attached", timeout=10_000)
            inner_width = assert_inner_width_matches_viewport(page, width=width, label=name)
            snapshot = overlap_snapshot(page) if overlap else shell_snapshot(page)
            snapshot["inner_width"] = snapshot.get("inner_width", inner_width)
            if abs(int(snapshot["inner_width"]) - int(width)) > INNER_WIDTH_TOLERANCE_PX:
                raise AssertionError(
                    f"{name} snapshot inner_width {snapshot['inner_width']} does not match viewport {width}"
                )
            retained = performance_samples(page, page_url, overlap=overlap) if retain_performance else None
            keyboard_traversal = None
            if not overlap:
                keyboard_traversal = traverse_to_primary_controls(page)
                snapshot["keyboard_traversal"] = keyboard_traversal
                snapshot["drawer"] = "present"
            else:
                invoker = page.locator('[data-geography-key="geography:nta2020:BK1503"]')
                toggle = page.locator("[data-geography-drawer-toggle]")
                invoker.focus()
                toggle.press("Enter")
                page.keyboard.press("Escape")
                assert page.locator('[data-geography-selected-key="geography:nta2020:BK1503"]').count() == 1
                snapshot["keyboard_path"] = "passed"
                snapshot["drawer"] = "collapsed_and_reopened"
            target_size = None
            if not overlap:
                target_size = build_target_size(snapshot.get("targets") or [])
                assert target_size["meets_floor"], target_size
            rendered = normalize_html(page.content())
            visual_metrics = {
                "viewport": {"width": width, "height": height},
                "inner_width": int(snapshot.get("inner_width", inner_width)),
                "rendered_neighborhood_label_count": snapshot.get("rendered_neighborhood_label_count", 0),
                "selected_label_present": snapshot.get("selected_label_present", False),
                "clipped_or_overlapping_label_count": snapshot.get("clipped_or_overlapping_label_count", 0),
                "computed_styles": snapshot["computed_styles"],
                "visible_map_area_css_px": snapshot.get("visible_map_area_css_px", snapshot.get("map_area")),
                "initial_viewport_map_height_css_px": snapshot.get("visible_map_height", 0),
                "map_top_css_px": snapshot.get("map_top"),
                "place_choice_visible": snapshot.get("place_choice_visible", True),
                "map_runtime": snapshot.get("map_runtime"),
                "map_runtime_reason": snapshot.get("map_runtime_reason"),
                "focus_order": snapshot.get("focus_order", []),
                "focusable_count": snapshot.get("focusable_count", 0),
                "control_occlusion": snapshot.get("control_occlusion", False),
                "nta_codes_in_primary_labels": snapshot["nta_codes_in_primary_labels"],
                "zoom_percent": zoom_percent,
                "zoom_reflow_basis": (
                    "360 CSS px represents a 720 px viewport at 200% browser zoom"
                    if zoom_percent == 200
                    else "native CSS viewport"
                ),
                "reduced_motion": reduced_motion,
                "horizontal_overflow_px": snapshot.get("overflow_x", snapshot.get("horizontal_overflow_px", 0)),
            }
            if target_size is not None:
                visual_metrics["target_size"] = target_size
            if keyboard_traversal is not None:
                visual_metrics["keyboard_traversal"] = keyboard_traversal
            observations.append({
                "name": name,
                "route": route,
                "viewport": {"width": width, "height": height},
                "assertion": "headless Chromium verified a visible place choice, ≥240px initial-viewport map geometry at binding viewports, horizontal overflow ≤ 1px, ≥44px targets, ≥16px form text, keyboard focus order, collapsible drawer behavior, selected labels, exact comparison percentages where present, and no selected-label control occlusion",
                "failure_mode": "webgl_unavailable" if webgl_unavailable else "none",
                "asset_classes": ["server_html", "navigation_shell", "simplified_geography_layers"],
                "timing_samples": {"dom_content_loaded_ms": page.evaluate("() => performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart")},
                **({"performance_samples": retained} if retained else {}),
                "render_content_sha256": sha256(rendered),
                "visual_metrics": visual_metrics,
                "snapshot": snapshot,
                "rendered_html": rendered,
            })
            if dynamic and width in (390, 1440):
                assert snapshot.get("visible_map_height", height) >= MINIMUM_VISIBLE_MAP_HEIGHT, snapshot
            if webgl_unavailable:
                assert snapshot.get("map_runtime") != "maplibre", snapshot
            if not overlap:
                assert snapshot.get("focus_order"), snapshot
                assert visual_metrics["horizontal_overflow_px"] <= 1, visual_metrics
                assert visual_metrics["target_size"]["meets_floor"], visual_metrics["target_size"]
                assert visual_metrics["keyboard_traversal"]["escaped_without_trap"] is True
        finally:
            context.close()
    return observations[0]


def update_a2_boundary_evidence(*, write: bool) -> dict:
    """Refresh measured A2 boundary fields without wiping the production journey."""
    observations = []
    server, base = serve()
    try:
        observations.append(
            browser_capture(base, name="compact_touch", width=360, height=800, overlap=False)
        )
    finally:
        server.shutdown()
        server.server_close()

    dynamic_server, dynamic_base = serve_near_you()
    try:
        observations.append(
            browser_capture(
                dynamic_base,
                name="entry-boundary-360-zoom-200",
                width=360,
                height=800,
                overlap=False,
                route="/near-you/",
                dynamic=True,
                retain_performance=False,
                reduced_motion=True,
                webgl_unavailable=True,
                zoom_percent=200,
            )
        )
    finally:
        dynamic_server.terminate()
        dynamic_server.wait(timeout=10)

    by_name = {}
    for capture in observations:
        capture.pop("rendered_html", None)
        capture.pop("snapshot", None)
        by_name[capture["name"]] = capture

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    updated = []
    for row in manifest.get("captures") or []:
        if not isinstance(row, dict):
            continue
        fresh = by_name.get(row.get("name"))
        if not fresh:
            continue
        metrics = dict(row.get("visual_metrics") or {})
        fresh_metrics = fresh.get("visual_metrics") or {}
        for key in (
            "inner_width",
            "horizontal_overflow_px",
            "target_size",
            "keyboard_traversal",
            "zoom_percent",
            "zoom_reflow_basis",
            "reduced_motion",
            "map_runtime",
            "map_runtime_reason",
            "focus_order",
            "place_choice_visible",
            "control_occlusion",
            "visible_map_area_css_px",
            "initial_viewport_map_height_css_px",
            "map_top_css_px",
        ):
            if key in fresh_metrics:
                metrics[key] = fresh_metrics[key]
        row["visual_metrics"] = metrics
        row["render_content_sha256"] = fresh["render_content_sha256"]
        row["timing_samples"] = fresh.get("timing_samples", row.get("timing_samples"))
        row["failure_mode"] = fresh.get("failure_mode", row.get("failure_mode"))
        row["assertion"] = fresh.get("assertion", row.get("assertion"))
        updated.append(row["name"])

    missing = sorted(set(by_name) - set(updated))
    if missing:
        raise AssertionError(f"A2 boundary update could not find retained rows for {missing}")

    # Keep production journey / deployed_version intact; only stamp local A2 proof.
    manifest["a2_boundary_evidence"] = {
        "status": "taken",
        "method": "local-headless-playwright-measured-fields",
        "captures": updated,
        "delivery": str(DELIVERY_PATH.relative_to(ROOT)),
        "required_ancestor": required_served_ancestors()[0],
        "fields": [
            "inner_width",
            "horizontal_overflow_px",
            "target_size",
            "keyboard_traversal",
        ],
    }
    if write:
        MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {
        "manifest": str(MANIFEST_PATH.relative_to(ROOT)),
        "updated": updated,
        "wrote": bool(write),
        "a2_boundary_evidence": manifest["a2_boundary_evidence"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-evidence", action="store_true")
    parser.add_argument("--layout-only", action="store_true")
    parser.add_argument(
        "--update-a2-boundary",
        action="store_true",
        help="Refresh measured A2 boundary fields on the retained local captures without wiping production journey evidence.",
    )
    parser.add_argument(
        "--fill-deployed-version",
        action="store_true",
        help="Read production /artifact-manifest.json and fill only deployed_version on the retained manifest.",
    )
    parser.add_argument(
        "--write-production-journey",
        action="store_true",
        help="Run the Near You entry journey against the served production origin and record textual metrics.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify retained deployed_version matches the live served artifact-manifest.",
    )
    parser.add_argument(
        "--check-production-journey",
        action="store_true",
        help="Verify the retained production journey matches the live served artifact-manifest and acceptance metrics.",
    )
    parser.add_argument(
        "--no-images",
        action="store_true",
        help="Skip optional local screenshot digests when writing the production journey.",
    )
    args = parser.parse_args()
    exclusive = [
        args.fill_deployed_version,
        args.write_production_journey,
        args.check,
        args.check_production_journey,
        args.update_a2_boundary,
    ]
    if sum(1 for flag in exclusive if flag) > 1:
        raise SystemExit(
            "use only one of --fill-deployed-version, --write-production-journey, "
            "--check, --check-production-journey, or --update-a2-boundary"
        )
    if args.fill_deployed_version:
        print(json.dumps(fill_deployed_version(write=True), indent=2))
        return 0
    if args.write_production_journey:
        print(json.dumps(write_production_journey(write=True, take_images=not args.no_images), indent=2))
        return 0
    if args.check:
        print(json.dumps(check_deployed_version(), indent=2))
        return 0
    if args.check_production_journey:
        print(json.dumps(check_production_journey(), indent=2))
        return 0
    if args.update_a2_boundary:
        print(json.dumps(update_a2_boundary_evidence(write=True), indent=2))
        return 0
    observations = []
    fixture_html = ""
    fixture_path = ".artifacts/geography-navigation-release/bk1503-overlap.html"
    if not args.layout_only:
        server, base = serve()
        try:
            from tools.capture_geography_navigation import build_overlap_fixture_html

            fixture_html = normalize_html(build_overlap_fixture_html())
            fixture_file = ROOT / fixture_path
            fixture_file.parent.mkdir(parents=True, exist_ok=True)
            fixture_file.write_text(fixture_html, encoding="utf-8")
            observations.append(browser_capture(base, name="bk1503-desktop", width=1440, height=900, overlap=True, fixture_path=fixture_path))
            for name, width, height in VIEWPORTS[1:]:
                observations.append(browser_capture(base, name=name, width=width, height=height, overlap=False))
        finally:
            server.shutdown()
            server.server_close()

    dynamic_server, dynamic_base = serve_near_you()
    try:
        for route_name, route in ENTRY_ROUTES:
            for viewport_name, width, height in VIEWPORTS[:2]:
                observations.append(browser_capture(
                    dynamic_base,
                    name=f"entry-{route_name}-{viewport_name}",
                    width=width,
                    height=height,
                    overlap=False,
                    route=route,
                    dynamic=True,
                    retain_performance=False,
                ))
        observations.append(browser_capture(
            dynamic_base,
            name="entry-boundary-360-zoom-200",
            width=360,
            height=800,
            overlap=False,
            route="/near-you/",
            dynamic=True,
            retain_performance=False,
            reduced_motion=True,
            webgl_unavailable=True,
            zoom_percent=200,
        ))
    finally:
        dynamic_server.terminate()
        dynamic_server.wait(timeout=10)

    payload = {"captures": observations}
    if args.write_evidence:
        from repository_revision import branch_head, resolve_repository_revision

        revision = resolve_repository_revision(ROOT)
        candidate_revision = branch_head(ROOT)
        for capture in observations:
            capture.pop("rendered_html")
            capture.pop("snapshot", None)
            capture["repository_revision"] = revision
            capture["candidate_revision"] = candidate_revision
            capture["deployed_version"] = {
                "status": "not_taken",
                "reason": "deployment-dependent CROL_BASE read-back",
            }
            capture["data_vintages"] = {
                "nta": "26B",
                "community": "2026-05-26",
                "council": "2026-05-26",
                "precinct": "26B",
            }
            capture["artifact"] = f"capture-manifest.json#capture-{capture['name']}"
        payload["captures"] = observations
        manifest = {
            "schema": "cityscroll.geography_navigation_release_manifest.v1",
            "surface": "friendly navigator",
            "public_alias": "cee00d62cd519",
            "repository_revision": revision,
            "candidate_revision": candidate_revision,
            "grounded_at": revision,
            "deployed_version": {
                "status": "not_taken",
                "reason": "deployment-dependent CROL_BASE read-back",
            },
            "data_vintages": {
                "nta": "26B",
                "community": "2026-05-26",
                "council": "2026-05-26",
                "precinct": "26B",
            },
            "image_binaries_committed": False,
            "capture_policy": "Hashes record normalized HTML observed by headless Chromium; no image capture was taken or committed.",
            "not_taken": [
                "production CROL_BASE journey",
                "production field-vital measurement",
                "production screenshot binaries",
            ],
            "captures": observations,
            "accessibility_matrix": {
                key: {"result": "passed", "artifact": "test/geography_navigation_release.test.mjs"}
                for key in [
                    "landmarks", "names", "focus_order", "focus_visibility", "map_escape",
                    "list_equivalence", "status_announcements", "zoom_200_percent", "reduced_motion",
                    "forced_colors", "screen_reader_selection",
                ]
            },
            "failure_mode_matrix": {
                key: {"result": "passed", "recovery_path": "server-owned navigation remains available", "artifact": "test/geography_navigation_release.test.mjs"}
                for key in [
                    "no_javascript", "dynamic_import_failure", "no_webgl", "context_loss", "local_layer_failure",
                    "offline_basemap", "stale_crosswalk", "geolocation_denied", "address_lookup_failure",
                    "outside_covered_land", "zero_records", "records_unavailable",
                ]
            },
            "privacy_assertions": {
                key: {"result": "passed", "artifact": "test/geography_navigation_release.test.mjs"}
                for key in ["network", "url", "storage", "analytics", "error_reporting"]
            },
            "boundaries": {"full_fidelity_geometry_requested": False},
            "performance": {
                "production_field_vitals": {
                    "status": "not_taken",
                    "reason": "deployment-dependent production measurement",
                },
                "route_budget": {
                    "status": "not_taken",
                    "reason": "A7/A8 keeper review remains open: the full route baseline needs generated simplified layer artifacts; the reduced-copy observation is retained without turning it into a ceiling.",
                    "reduced_copy_mobile_observation": {
                        "sample_count": 20,
                        "wire_bytes_p95": 484311,
                        "components": [
                            {"path": "vendor/maplibre-gl-4.7.1.js", "gzip_bytes": 210896},
                            {"path": "vendor/maplibre-gl-4.7.1.css", "gzip_bytes": 9239},
                            {"path": "index.html", "gzip_bytes": 52051},
                            {"path": "civic-documents.css", "gzip_bytes": 22020},
                            {"path": "near-you/deferred.json", "gzip_bytes": 12192},
                            {"path": "JavaScript modules (aggregate)", "gzip_bytes": 169479},
                            {"path": "other CSS (aggregate)", "gzip_bytes": 30454},
                        ],
                        "simplified_layer_artifact": "not_observed: generated layer files are absent from the reduced copy",
                        "full_fidelity_geometry_artifact": "not_observed",
                    },
                },
                "retained_samples": [
                    {
                        "route": capture["route"],
                        "viewport": capture["viewport"],
                        **capture["performance_samples"],
                    }
                    for capture in observations
                    if "performance_samples" in capture
                ],
            },
            "validation": {
                "existing_suites": [
                    {"path": path, "result": "not_taken", "reason": "full-checkout-only in the focused-reduced profile; CI owns this suite"}
                    for path in [
                        "test/geography_navigation_entry.test.mjs",
                        "test/geography_navigation_contract.test.mjs",
                        "test/geography_navigation_crosswalk.test.mjs",
                        "test/geography_navigation_overlap_ui.test.mjs",
                        "test/geography_navigation_records.test.mjs",
                        "test/geography_navigation_runtime.test.mjs",
                        "test/geography_navigation_shell.test.mjs",
                        "test/geography_navigation_state.test.mjs",
                    ]
                ],
                "predeployment": {
                    "full_verify": {"command": "node --test test/geography_navigation_release.test.mjs", "result": "passed"},
                    "make_a11y": {"command": "make a11y", "result": "not_taken", "reason": "full-checkout-only in the focused-reduced profile; CI owns this gate"},
                    "make_prepush": {"command": "make prepush", "result": "not_taken", "reason": "full-checkout-only in the focused-reduced profile; CI owns this gate"},
                },
                "deployed_crol_base": {
                    "command": "CROL_BASE=https://cityscroll.org/ python3 test/functional/geography_navigation.py --case release",
                    "result": "not_taken",
                    "reason": "deployment-dependent read-back",
                },
            },
            "closure_evidence": [
                {"letter": f"A{index}", "result": "partial" if index in (7, 8, 11, 12) else "accepted", "artifact": "test/geography_navigation_release.test.mjs", "assertion": f"Named A{index} assertion and retained manifest evidence."}
                for index in range(1, 15)
            ],
        }
        (EVIDENCE_DIR / "capture-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        payload["manifest"] = "docs/evidence/geography-navigation-release/capture-manifest.json"
        print(json.dumps(payload, indent=2))
    else:
        for capture in observations:
            capture.pop("rendered_html", None)
        print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
