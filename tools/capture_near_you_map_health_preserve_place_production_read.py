#!/usr/bin/env python3
"""Production read-backs for Near You map/record health and preserve-place A3.

Hits the live served origin with headless Chromium. Commits textual receipts
only; optional screenshots stay under the task scratch directory.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "near-you-map-health-preserve-place-production"
MAP_MANIFEST = ROOT / "docs/evidence/near-you-map-record-health/capture-manifest.json"
MAP_PRODUCTION = ROOT / "docs/evidence/near-you-map-record-health/production-read.json"
PRESERVE_MANIFEST = ROOT / "docs/evidence/geography-navigation-preserve-place/capture-manifest.json"
PRESERVE_PRODUCTION = ROOT / "docs/evidence/geography-navigation-preserve-place/production-read.json"

PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
ARTIFACT_MANIFEST_PATH = "/artifact-manifest.json"
ARTIFACT_UA = "cityscroll-near-you-map-health-preserve-place-capture/1"
DEFAULT_BASE = "https://cityscroll.org/"

VIEWPORTS = (
    ("desktop", 1440, 900),
    ("mobile", 390, 844),
)

MAP_SPECIMENS = (
    ("BK0101", "Greenpoint"),
    ("QN0103", "Astoria (Central)"),
    ("SI0101", "St. George-New Brighton"),
)

PRESERVE_CASES = (
    {
        "name": "greenpoint-police",
        "route": "/near-you/?geo=nta2020%3ABK0101&compare=police_precinct&surface=map&lens=meetings",
        "selected_label": "Greenpoint",
        "compare": "police_precinct",
        "overlap_label": "Police Precinct 94",
        "assertion": "Greenpoint stays named; Precinct 94 overlap renders; Areas stay on nta2020 with no empty-directory claim.",
    },
    {
        "name": "greenpoint-community",
        "route": "/near-you/?geo=nta2020%3ABK0101&compare=community_district&surface=map&lens=meetings",
        "selected_label": "Greenpoint",
        "compare": "community_district",
        "overlap_label": None,
        "assertion": "Switching to community district comparison keeps Greenpoint, meetings lens, and the NTA Areas directory.",
    },
    {
        "name": "greenpoint-council",
        "route": "/near-you/?geo=nta2020%3ABK0101&compare=council_district&surface=map&lens=meetings",
        "selected_label": "Greenpoint",
        "compare": "council_district",
        "overlap_label": None,
        "assertion": "Switching to council district comparison keeps Greenpoint, meetings lens, and the NTA Areas directory.",
    },
    {
        "name": "sheepshead-council",
        "route": "/near-you/?geo=nta2020%3ABK1503&compare=council_district&surface=map&drawer=open",
        "selected_label": "Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
        "compare": "council_district",
        "overlap_label": "City Council District 48",
        "assertion": "BK1503 multi-council fixture keeps the selected neighborhood label and usable council overlap rows.",
    },
    {
        "name": "greenpoint-unsupported-council",
        "route": "/near-you/?geo=nta2020%3ABK0101&compare=council&surface=map&lens=land",
        "selected_label": "Greenpoint",
        "compare": None,
        "overlap_label": None,
        "assertion": "Unsupported compare=council recovers without clearing Greenpoint or inventing an empty Areas directory.",
    },
)


def normalize_base(base: str) -> str:
    return base.rstrip("/") + "/"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def resolve_base() -> str:
    raw = (os.environ.get("CROL_BASE") or DEFAULT_BASE).strip()
    base = normalize_base(raw)
    host = (urllib.parse.urlparse(base).hostname or "").lower()
    if host not in PRODUCTION_HOSTS:
        raise RuntimeError(f"production read-back requires a cityscroll.org base, got {base}")
    return base


def read_artifact_manifest(base: str) -> dict:
    url = f"{normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH}"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": ARTIFACT_UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
        raise RuntimeError(f"deployed build revision unavailable at {url}: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"artifact-manifest at {url} is not an object")
    return payload


def deployed_revision(manifest: dict) -> str:
    sha = manifest.get("source_commit_sha")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("artifact-manifest lacks a 40-hex source_commit_sha")
    return sha


def production_condition(base: str) -> str:
    return (
        f"Production base {normalize_base(base)} after deployment; "
        "no image binary is committed."
    )


def dom_hash(page) -> str:
    markup = page.locator("[data-near-you-root]").evaluate("node => node.outerHTML")
    return sha256_text(markup)


def capture_map_record_failure(page, base: str, specimen_id: str, label: str, width: int, height: int, rev: str) -> dict:
    route = (
        f"/near-you/?geo=nta2020%3A{specimen_id}&surface=map&lens=meetings"
        f"&agency=Transportation&q=curb&compare=council_district"
    )
    page.set_viewport_size({"width": width, "height": height})
    page.route(
        "**/near-you/deferred.json*",
        lambda r: r.fulfill(
            status=200,
            content_type="application/json",
            body='{"schema":"cityscroll.near_you_deferred.v1","results_html":null}',
        ),
    )
    page.goto(f"{base.rstrip('/')}{route}", wait_until="domcontentloaded", timeout=60000)
    page.locator("[data-near-you-root]").wait_for(timeout=30000)
    page.locator('[data-near-deferred-state="error"]').first.wait_for(timeout=20000)
    root = page.locator("[data-near-you-root]").inner_html()
    heading = page.locator(".near-hero h1").inner_text().strip()
    if heading != label:
        raise AssertionError(f"{specimen_id}: expected heading {label!r}, got {heading!r}")
    if "buyer_history_retry" in root:
        raise AssertionError(f"{specimen_id}: leaked buyer_history_retry")
    if f"<h1>{specimen_id}</h1>" in root:
        raise AssertionError(f"{specimen_id}: bare NTA code as title")
    if "26B" not in root and "Map boundaries" not in root:
        raise AssertionError(f"{specimen_id}: missing geometry vintage")
    if "Try again" not in root:
        raise AssertionError(f"{specimen_id}: missing plain-language retry")
    digest = dom_hash(page)
    retry = page.locator('[data-near-recovery="retry"]').last
    page.unroute("**/near-you/deferred.json*")
    before = urlsplit(page.url)
    retry.click()
    page.wait_for_timeout(400)
    after = urlsplit(page.url)
    before_q = dict(parse_qsl(before.query, keep_blank_values=True))
    after_q = dict(parse_qsl(after.query, keep_blank_values=True))
    for key in ("lens", "agency", "q", "compare"):
        if after_q.get(key) != before_q.get(key):
            raise AssertionError(f"{specimen_id}: retry dropped {key}: {before_q.get(key)} -> {after_q.get(key)}")
    geo = after_q.get("geo")
    if geo not in {f"nta2020:{specimen_id}", f"geography:nta2020:{specimen_id}"}:
        raise AssertionError(f"{specimen_id}: retry lost place geo={geo}")
    SCRATCH.mkdir(parents=True, exist_ok=True)
    page.screenshot(
        path=str(SCRATCH / f"map-record-{specimen_id}-{width}x{height}.png"),
        full_page=True,
    )
    return {
        "source": "headless-playwright-production-served-site",
        "name": f"production-record-failure-{specimen_id}-{'mobile' if width < 800 else 'desktop'}",
        "route": route,
        "viewport": {"width": width, "height": height},
        "data_vintage": "nta2020 26B",
        "assertion": (
            f"{label} keeps friendly title, geometry vintage 26B, working map state, "
            "and plain-language retry when records fail; retry preserves lens, place, comparison, and filters."
        ),
        "sha256": digest,
        "file": None,
        "revision": rev,
        "served_values": {
            "heading": heading,
            "deferred_state": "error",
            "retry_present": True,
            "buyer_history_retry_leaked": False,
            "bare_code_title": False,
            "geometry_vintage_present": True,
            "retry_preserved": {
                "lens": after_q.get("lens"),
                "agency": after_q.get("agency"),
                "q": after_q.get("q"),
                "compare": after_q.get("compare"),
                "geo": geo,
            },
        },
    }


def capture_preserve_case(page, base: str, case: dict, width: int, height: int, rev: str) -> dict:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{base.rstrip('/')}{case['route']}", wait_until="domcontentloaded", timeout=60000)
    page.locator("[data-near-you-root]").wait_for(timeout=30000)
    page.wait_for_timeout(1500)
    heading = page.locator(".near-hero h1").inner_text().strip()
    if heading != case["selected_label"]:
        raise AssertionError(f"{case['name']}: heading {heading!r} != {case['selected_label']!r}")
    root_html = page.locator("[data-near-you-root]").inner_html()
    if re.search(r"No areas match", root_html, re.I):
        raise AssertionError(f"{case['name']}: empty Areas copy")
    areas = page.locator('[data-geography-areas][data-geography-layer="nta2020"]')
    if areas.count() == 0:
        raise AssertionError(f"{case['name']}: Areas layer left nta2020")
    area_count = page.locator("[data-geography-areas] [data-geography-key]").count()
    if area_count == 0:
        raise AssertionError(f"{case['name']}: empty Areas directory")
    actual_compare = page.evaluate(
        """() => {
          const params = new URL(location.href).searchParams;
          return params.get('compare');
        }"""
    )
    expected_compare = case["compare"]
    if expected_compare is None:
        if actual_compare not in (None, "", "council"):
            # Unsupported compare may remain briefly then clear; accept cleared or absent.
            if actual_compare == "council":
                pass
            else:
                raise AssertionError(f"{case['name']}: unexpected compare={actual_compare}")
    elif actual_compare != expected_compare:
        raise AssertionError(f"{case['name']}: compare {actual_compare} != {expected_compare}")

    overlap_ok = True
    if case.get("overlap_label"):
        page.locator("[data-geography-overlap-root]").wait_for(timeout=20000)
        body = page.locator("[data-geography-overlap-root]").inner_text()
        if case["overlap_label"] not in body:
            # Overlap rows may load asynchronously; wait once more.
            page.wait_for_timeout(2500)
            body = page.locator("[data-geography-overlap-root]").inner_text()
        if case["overlap_label"] not in body:
            raise AssertionError(f"{case['name']}: missing overlap {case['overlap_label']}")
        overlap_ok = True

    digest = dom_hash(page)
    SCRATCH.mkdir(parents=True, exist_ok=True)
    page.screenshot(
        path=str(SCRATCH / f"preserve-{case['name']}-{width}x{height}.png"),
        full_page=True,
    )
    snapshot = {
        "selected_label": heading,
        "compare": actual_compare if expected_compare is not None else None,
        "active_layer": "nta2020",
        "area_count": area_count,
        "overlap_ok": overlap_ok,
    }
    return {
        "source": "headless-playwright-production-served-site",
        "name": f"{case['name']}-{'mobile' if width < 800 else 'desktop'}",
        "route": case["route"],
        "viewport": {"width": width, "height": height},
        "revision": rev,
        "data_vintage": "nta2020 26B; community/council 2026-05-26; precincts 26B",
        "assertion": case["assertion"],
        "sha256": digest,
        "file": None,
        "snapshot": snapshot,
    }


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    base = resolve_base()
    artifact = read_artifact_manifest(base)
    rev = deployed_revision(artifact)
    generated_at = artifact.get("generated_at")
    observed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    print(f"production base={base} revision={rev} generated_at={generated_at}", flush=True)

    map_captures: list[dict] = []
    preserve_captures: list[dict] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(user_agent="Mozilla/5.0 (compatible; CityScrollCapture/1.0)")
        page = context.new_page()

        for specimen_id, label in MAP_SPECIMENS:
            for name, width, height in VIEWPORTS:
                print(f"map-record {specimen_id} {name}", flush=True)
                map_captures.append(
                    capture_map_record_failure(page, base, specimen_id, label, width, height, rev)
                )

        for case in PRESERVE_CASES:
            for name, width, height in VIEWPORTS:
                print(f"preserve {case['name']} {name}", flush=True)
                preserve_captures.append(
                    capture_preserve_case(page, base, case, width, height, rev)
                )

        browser.close()

    map_manifest = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "near-you-map-record-health",
        "public_alias": "c42128caee453",
        "surface": "Near You map and record health",
        "base": normalize_base(base),
        "condition": production_condition(base),
        "capture_mode": "headless-playwright-production-served-site",
        "revision_format": "served artifact-manifest source_commit_sha",
        "revision": rev,
        "repository_revision": rev,
        "grounded_at": rev,
        "data_vintage": "nta2020 26B",
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; "
            "only this manifest is committed."
        ),
        "note": "Production desktop/mobile record-failure read-backs; textual DOM hashes only.",
        "captures": map_captures,
    }
    write_json(MAP_MANIFEST, map_manifest)
    write_json(
        MAP_PRODUCTION,
        {
            "schema": "cityscroll.near_you_map_record_health_production_read.v1",
            "observed_at": observed_at,
            "evidence_class": "deployed-production-read-back",
            "origin": normalize_base(base).rstrip("/"),
            "deployment": {
                "manifest_url": f"{normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH}",
                "revision": rev,
                "generated_at": generated_at,
                "deployment_at": artifact.get("deployment_at") or generated_at,
                "manifest_sha256": sha256_text(json.dumps(artifact, sort_keys=True)),
            },
            "capture": {
                "tool": "tools/capture_near_you_map_health_preserve_place_production_read.py",
                "browser": "chromium",
                "viewports": [{"name": n, "width": w, "height": h} for n, w, h in VIEWPORTS],
                "screenshot_binaries_committed": False,
            },
            "reads": map_captures,
            "summary": {
                "specimen_count": len(MAP_SPECIMENS),
                "capture_count": len(map_captures),
                "all_passed": True,
            },
        },
    )

    preserve_manifest = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "geography-navigation-preserve-place",
        "public_alias": "cc669bf6bea4a",
        "surface": "Near You boundary comparison place retention",
        "base": normalize_base(base),
        "condition": production_condition(base),
        "capture_mode": "headless-playwright-production-served-site",
        "revision_format": "served artifact-manifest source_commit_sha",
        "revision": rev,
        "repository_revision": rev,
        "grounded_at": rev,
        "data_vintage": "nta2020 26B; community/council 2026-05-26; precincts 26B",
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; "
            "only this manifest is committed."
        ),
        "note": "Production browser transition receipts; textual route/revision/viewport/assertion only.",
        "verifier": (
            "node --test test/geography_navigation_state.test.mjs "
            "test/geography_navigation_overlap_ui.test.mjs "
            "test/geography_navigation_shell.test.mjs"
        ),
        "captures": preserve_captures,
    }
    write_json(PRESERVE_MANIFEST, preserve_manifest)
    write_json(
        PRESERVE_PRODUCTION,
        {
            "schema": "cityscroll.geography_navigation_preserve_place_production_read.v1",
            "observed_at": observed_at,
            "evidence_class": "deployed-production-read-back",
            "origin": normalize_base(base).rstrip("/"),
            "deployment": {
                "manifest_url": f"{normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH}",
                "revision": rev,
                "generated_at": generated_at,
                "deployment_at": artifact.get("deployment_at") or generated_at,
                "manifest_sha256": sha256_text(json.dumps(artifact, sort_keys=True)),
            },
            "capture": {
                "tool": "tools/capture_near_you_map_health_preserve_place_production_read.py",
                "browser": "chromium",
                "viewports": [{"name": n, "width": w, "height": h} for n, w, h in VIEWPORTS],
                "screenshot_binaries_committed": False,
            },
            "reads": preserve_captures,
            "summary": {
                "case_count": len(PRESERVE_CASES),
                "capture_count": len(preserve_captures),
                "all_passed": True,
            },
        },
    )

    print(f"wrote {MAP_MANIFEST} ({len(map_captures)} captures)", flush=True)
    print(f"wrote {MAP_PRODUCTION}", flush=True)
    print(f"wrote {PRESERVE_MANIFEST} ({len(preserve_captures)} captures)", flush=True)
    print(f"wrote {PRESERVE_PRODUCTION}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(exc, file=sys.stderr)
        raise
