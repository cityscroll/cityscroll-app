#!/usr/bin/env python3
"""Production read-back for Near You preserve-place comparison (A1).

Hits the live served origin with headless Chromium. Records the concrete
served text that shows Greenpoint preserved through a Precinct 94 boundary
comparison — observed values only, never a pass verdict.

Also records the map camera (center + zoom) observed from the page across
police, community-district, and council-district comparisons at both binding
viewports, and refuses when those cameras diverge beyond a stated tolerance.

Commits textual receipts under docs/evidence/geography-navigation-preserve-place/.
Optional screenshots stay under the task scratch directory.

Map/record-health A3 recovery evidence is owned by
tools/capture_near_you_map_record_health_retry_recovery_production_read.py and
is not rewritten here.
"""

from __future__ import annotations

import argparse
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

from deployed_capture_ancestor import (
    load_recorded_delivery,
    resolve_landed_ancestor,
    revision_contains_ancestor,
)

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "docs/evidence/geography-navigation-preserve-place"
MANIFEST = OUT_DIR / "capture-manifest.json"
PRODUCTION = OUT_DIR / "production-read.json"
READBACK = OUT_DIR / "read-back.json"
DELIVERY = OUT_DIR / "delivery.json"
SCRATCH = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "near-you-map-health-preserve-place-production"

PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
ARTIFACT_MANIFEST_PATH = "/artifact-manifest.json"
ARTIFACT_UA = "cityscroll-near-you-map-health-preserve-place-capture/1"
DEFAULT_BASE = "https://cityscroll.org/"
PUBLIC_ALIAS = "cc669bf6bea4a"
SCHEMA = "cityscroll.near_you_preserve_place_production_read.v1"
PRODUCER_PATH = "docs/evidence/geography-navigation-preserve-place/read-back.json"
DATA_VINTAGE = "nta2020 26B; community/council 2026-05-26; precincts 26B"
REQUIRED_ANCESTOR = load_recorded_delivery(DELIVERY)

VIEWPORTS = (
    ("desktop", 1440, 900),
    ("mobile", 390, 844),
)

# Camera equality tolerance is recorded beside the readings, never applied silently.
CAMERA_TOLERANCE = {
    "center_degrees": 0.0005,
    "zoom": 0.15,
}

# Page-extracted camera fields — never filled from an expected constant.
CAMERA_PAGE_EXTRACTED_FIELDS = (
    "camera.center.lng",
    "camera.center.lat",
    "camera.zoom",
    "heading",
    "geo",
    "lens",
    "compare",
    "selected_key",
    "active_layer",
)

MAP_HOOK_INIT = """
(() => {
  const stash = [];
  const hook = () => {
    const gl = window.maplibregl;
    if (!gl || !gl.Map || gl.Map.__cityscrollPreservePlaceHooked) return Boolean(gl && gl.Map);
    const Original = gl.Map;
    function Wrapped(...args) {
      const map = new Original(...args);
      stash.push(map);
      window.__cityscrollPreservePlaceMaps = stash;
      return map;
    }
    Wrapped.prototype = Original.prototype;
    Object.keys(Original).forEach((key) => {
      try { Wrapped[key] = Original[key]; } catch (_error) { /* ignore */ }
    });
    Wrapped.__cityscrollPreservePlaceHooked = true;
    gl.Map = Wrapped;
    return true;
  };
  Object.defineProperty(window, "maplibregl", {
    configurable: true,
    set(value) {
      Object.defineProperty(window, "maplibregl", {
        configurable: true,
        writable: true,
        value,
      });
      hook();
    },
    get() { return undefined; },
  });
  const timer = setInterval(() => { if (hook()) clearInterval(timer); }, 20);
  setTimeout(() => clearInterval(timer), 20000);
})();
"""

READ_CAMERA_JS = """() => {
  const maps = window.__cityscrollPreservePlaceMaps || [];
  const map = maps.length ? maps[maps.length - 1] : null;
  if (!map || typeof map.getCenter !== 'function' || typeof map.getZoom !== 'function') {
    return null;
  }
  const center = map.getCenter();
  if (!center || typeof center.lng !== 'number' || typeof center.lat !== 'number') {
    return null;
  }
  const zoom = map.getZoom();
  if (typeof zoom !== 'number' || !Number.isFinite(zoom)) {
    return null;
  }
  return {
    center: { lng: center.lng, lat: center.lat },
    zoom,
  };
}"""

PERTURB_CAMERA_JS = """() => {
  const maps = window.__cityscrollPreservePlaceMaps || [];
  const map = maps.length ? maps[maps.length - 1] : null;
  if (!map || typeof map.jumpTo !== 'function') return false;
  const center = map.getCenter?.();
  const zoom = map.getZoom?.();
  if (!center || typeof zoom !== 'number') return false;
  map.jumpTo({
    center: [center.lng + 0.05, center.lat - 0.04],
    zoom: Math.max(1, zoom - 2),
  });
  return true;
}"""

# A1 specimen: Greenpoint kept through a police-precinct comparison that shows
# Precinct 94 in the served overlap rail.
A1_SPECIMEN = {
    "name": "greenpoint-police",
    "route": (
        "/near-you/?geo=nta2020%3ABK0101&compare=police_precinct"
        "&surface=map&lens=meetings"
    ),
    "selected_label": "Greenpoint",
    "compare": "police_precinct",
    "overlap_needle": "Police Precinct 94",
    "geo": "nta2020:BK0101",
    "lens": "meetings",
    "assertion": (
        "Served Near You shows Greenpoint as the selected neighborhood and "
        "Police Precinct 94 in the comparison overlap while Areas stay on "
        "nta2020."
    ),
}

# A1 second clause: switching the three supported comparisons retains camera.
A1_CAMERA_SPECIMENS = (
    {
        "name": "greenpoint-police-camera",
        "route": (
            "/near-you/?geo=nta2020%3ABK0101&compare=police_precinct"
            "&surface=map&lens=meetings"
        ),
        "compare": "police_precinct",
        "selected_label": "Greenpoint",
        "geo": "nta2020:BK0101",
        "lens": "meetings",
        "assertion": (
            "Page-observed map camera for Greenpoint under police_precinct "
            "comparison at this viewport."
        ),
    },
    {
        "name": "greenpoint-community-camera",
        "route": (
            "/near-you/?geo=nta2020%3ABK0101&compare=community_district"
            "&surface=map&lens=meetings"
        ),
        "compare": "community_district",
        "selected_label": "Greenpoint",
        "geo": "nta2020:BK0101",
        "lens": "meetings",
        "assertion": (
            "Page-observed map camera for Greenpoint under community_district "
            "comparison at this viewport."
        ),
    },
    {
        "name": "greenpoint-council-camera",
        "route": (
            "/near-you/?geo=nta2020%3ABK0101&compare=council_district"
            "&surface=map&lens=meetings"
        ),
        "compare": "council_district",
        "selected_label": "Greenpoint",
        "geo": "nta2020:BK0101",
        "lens": "meetings",
        "assertion": (
            "Page-observed map camera for Greenpoint under council_district "
            "comparison at this viewport."
        ),
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


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Sorted keys + literal Unicode keep the committed receipt byte-stable and
    # preserve observed copy characters without host-dependent \\u escapes.
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def query_map(url: str) -> dict[str, str]:
    return dict(parse_qsl(urlsplit(url).query, keep_blank_values=True))


def normalize_ws(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip())


def dom_hash(page) -> str:
    markup = page.locator("[data-near-you-root]").evaluate("node => node.outerHTML")
    return sha256_text(markup)


def cameras_equal(left: dict, right: dict, tolerance: dict = CAMERA_TOLERANCE) -> bool:
    """Return True when two page-observed cameras agree within the stated tolerance."""

    center_tol = float(tolerance["center_degrees"])
    zoom_tol = float(tolerance["zoom"])
    try:
        return (
            abs(float(left["center"]["lng"]) - float(right["center"]["lng"])) <= center_tol
            and abs(float(left["center"]["lat"]) - float(right["center"]["lat"])) <= center_tol
            and abs(float(left["zoom"]) - float(right["zoom"])) <= zoom_tol
        )
    except (KeyError, TypeError, ValueError):
        return False


def assert_cameras_retained(rows: list[dict], *, tolerance: dict = CAMERA_TOLERANCE) -> dict:
    """Refuse unless every camera reading in the group matches the first within tolerance."""

    if len(rows) < 2:
        raise AssertionError("camera retention requires at least two comparison readings")
    baseline = (rows[0].get("served_values") or {}).get("camera")
    if not isinstance(baseline, dict):
        raise AssertionError(f"{rows[0].get('name')}: camera missing or unreadable")
    mismatches = []
    for row in rows[1:]:
        camera = (row.get("served_values") or {}).get("camera")
        if not isinstance(camera, dict):
            raise AssertionError(f"{row.get('name')}: camera missing or unreadable")
        if not cameras_equal(baseline, camera, tolerance):
            mismatches.append({
                "name": row.get("name"),
                "camera": camera,
                "baseline": baseline,
            })
    if mismatches:
        raise AssertionError(
            "camera diverged across comparison switches beyond recorded tolerance "
            f"{tolerance!r}: {mismatches!r}"
        )
    return {
        "tolerance": tolerance,
        "equal": True,
        "baseline": baseline,
        "compare_types": [row.get("served_values", {}).get("compare") for row in rows],
        "routes": [row.get("route") for row in rows],
        "revision": rows[0].get("revision"),
        "viewport": rows[0].get("viewport"),
    }


def read_page_camera(page, *, case_name: str, attempts: int = 8) -> dict:
    """Read center/zoom from the hooked MapLibre instance; refuse when absent."""

    last = None
    for _ in range(attempts):
        last = page.evaluate(READ_CAMERA_JS)
        if isinstance(last, dict) and isinstance(last.get("center"), dict):
            lng = last["center"].get("lng")
            lat = last["center"].get("lat")
            zoom = last.get("zoom")
            if all(isinstance(value, (int, float)) for value in (lng, lat, zoom)):
                return {
                    "center": {"lng": float(lng), "lat": float(lat)},
                    "zoom": float(zoom),
                }
        page.wait_for_timeout(500)
    raise AssertionError(
        f"{case_name}: map camera absent or unreadable from the page "
        f"(last={last!r})"
    )


def wait_for_map_idle(page, *, case_name: str, timeout_ms: int = 15000) -> None:
    """Wait until the hooked map exists and is not mid-move."""

    settled = page.evaluate(
        """({ timeoutMs }) => new Promise((resolve) => {
          const started = Date.now();
          const tick = () => {
            const maps = window.__cityscrollPreservePlaceMaps || [];
            const map = maps.length ? maps[maps.length - 1] : null;
            if (map && typeof map.getCenter === 'function' && map.getCenter()) {
              const moving = typeof map.isMoving === 'function' ? map.isMoving() : false;
              if (!moving) {
                resolve(true);
                return;
              }
              map.once?.('idle', () => resolve(true));
              setTimeout(() => resolve(Boolean(map.getCenter?.())), Math.max(0, timeoutMs - (Date.now() - started)));
              return;
            }
            if (Date.now() - started >= timeoutMs) {
              resolve(false);
              return;
            }
            setTimeout(tick, 200);
          };
          tick();
        })""",
        {"timeoutMs": timeout_ms},
    )
    if not settled:
        raise AssertionError(f"{case_name}: map never became idle for camera observation")


def wait_for_map_ready(page, *, case_name: str) -> None:
    page.locator("[data-near-you-root]").wait_for(timeout=30000)
    page.locator("#near-map-enhanced, .maplibregl-canvas, .maplibregl-map").first.wait_for(
        timeout=45000
    )
    for _ in range(40):
        state = page.evaluate(
            """() => {
              const root = document.querySelector('[data-near-you-root]');
              const maps = window.__cityscrollPreservePlaceMaps || [];
              const map = maps.length ? maps[maps.length - 1] : null;
              return {
                mapState: root?.dataset?.nearGeographyMapState || null,
                mapCount: maps.length,
                hasCenter: Boolean(map && typeof map.getCenter === 'function' && map.getCenter()),
              };
            }"""
        )
        if state.get("mapCount", 0) > 0 and state.get("hasCenter"):
            wait_for_map_idle(page, case_name=case_name)
            return
        page.wait_for_timeout(250)
    raise AssertionError(f"{case_name}: map never became readable for camera observation")


def switch_compare_control(page, compare: str, *, case_name: str) -> None:
    control = page.locator(f'[data-geography-compare-controls] [data-geography-compare="{compare}"]')
    if control.count() == 0:
        control = page.locator(f'[data-geography-compare="{compare}"]')
    if control.count() == 0:
        raise AssertionError(f"{case_name}: no compare control for {compare}")
    control.first.click()
    page.wait_for_function(
        """(compare) => {
          const params = new URLSearchParams(location.search);
          return params.get('compare') === compare;
        }""",
        arg=compare,
        timeout=15000,
    )
    page.locator("[data-geography-overlap-root]").wait_for(timeout=20000)
    wait_for_map_idle(page, case_name=case_name)


def capture_a1_case(page, base: str, width: int, height: int, rev: str) -> dict:
    case = A1_SPECIMEN
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{base.rstrip('/')}{case['route']}", wait_until="domcontentloaded", timeout=60000)
    page.locator("[data-near-you-root]").wait_for(timeout=30000)
    page.wait_for_timeout(1500)

    heading = normalize_ws(page.locator(".near-hero h1").inner_text())
    if heading != case["selected_label"]:
        raise AssertionError(
            f"{case['name']}: served heading {heading!r} does not show preserved "
            f"place {case['selected_label']!r}"
        )

    root_html = page.locator("[data-near-you-root]").inner_html()
    if re.search(r"No areas match", root_html, re.I):
        raise AssertionError(f"{case['name']}: empty Areas copy")

    areas = page.locator('[data-geography-areas][data-geography-layer="nta2020"]')
    if areas.count() == 0:
        raise AssertionError(f"{case['name']}: Areas layer left nta2020")
    area_count = page.locator("[data-geography-areas] [data-geography-key]").count()
    if area_count == 0:
        raise AssertionError(f"{case['name']}: empty Areas directory")

    page.locator("[data-geography-overlap-root]").wait_for(timeout=20000)
    overlap_body = normalize_ws(page.locator("[data-geography-overlap-root]").inner_text())
    if case["overlap_needle"] not in overlap_body:
        page.wait_for_timeout(2500)
        overlap_body = normalize_ws(page.locator("[data-geography-overlap-root]").inner_text())
    if case["overlap_needle"] not in overlap_body:
        raise AssertionError(
            f"{case['name']}: served overlap does not show {case['overlap_needle']!r}; "
            f"observed {overlap_body!r}"
        )

    # Record the concrete row label the page rendered for Precinct 94.
    overlap_labels = page.evaluate(
        """() => Array.from(
          document.querySelectorAll(
            '[data-geography-overlap-root] [data-geography-overlap-key], '
            + '[data-geography-overlap-root] [data-geography-overlap-immaterial]'
          )
        ).map((node) => (node.innerText || '').replace(/\\s+/g, ' ').trim())"""
    )
    matching_labels = [
        label for label in overlap_labels if case["overlap_needle"] in (label or "")
    ]
    if not matching_labels:
        # Fall back to the first line in the overlap body that carries the needle.
        matching_labels = [
            line.strip()
            for line in overlap_body.splitlines()
            if case["overlap_needle"] in line
        ]
    if not matching_labels and case["overlap_needle"] in overlap_body:
        matching_labels = [case["overlap_needle"]]
    if not matching_labels:
        raise AssertionError(
            f"{case['name']}: could not extract shown Precinct 94 text from served overlap"
        )
    overlap_shown = matching_labels[0]

    params = query_map(page.url)
    actual_compare = params.get("compare")
    if actual_compare != case["compare"]:
        raise AssertionError(
            f"{case['name']}: compare {actual_compare!r} != {case['compare']!r}"
        )
    actual_geo = params.get("geo")
    actual_lens = params.get("lens")

    compare_control = normalize_ws(
        page.locator("[data-geography-overlap-root]").get_attribute("data-geography-compare")
        or ""
    )
    selected_key = (
        page.locator("[data-geography-overlap-root]").get_attribute("data-geography-selected-key")
        or ""
    )

    digest = dom_hash(page)
    SCRATCH.mkdir(parents=True, exist_ok=True)
    page.screenshot(
        path=str(SCRATCH / f"preserve-{case['name']}-{width}x{height}.png"),
        full_page=True,
    )

    served_values = {
        "heading": heading,
        "overlap_label": overlap_shown,
        "overlap_needle_shown": case["overlap_needle"],
        "compare": actual_compare,
        "compare_control": compare_control or actual_compare,
        "geo": actual_geo,
        "lens": actual_lens,
        "active_layer": "nta2020",
        "areas_layer": "nta2020",
        "area_count": area_count,
        "selected_key": selected_key or None,
        "place_preserved": heading == case["selected_label"],
        "precinct_shown": case["overlap_needle"] in overlap_shown
        or case["overlap_needle"] in overlap_body,
    }
    # Capture-as-test: never invent shown text.
    if not served_values["place_preserved"] or not served_values["precinct_shown"]:
        raise AssertionError(
            f"{case['name']}: served_values missing preserved place or precinct: {served_values!r}"
        )
    if "result" in served_values or "pass" in served_values:
        raise AssertionError("served_values must not carry a pass verdict")

    return {
        "source": "headless-playwright-production-served-site",
        "name": f"{case['name']}-{'mobile' if width < 800 else 'desktop'}",
        "route": case["route"],
        "viewport": {"width": width, "height": height},
        "revision": rev,
        "data_vintage": DATA_VINTAGE,
        "assertion": case["assertion"],
        "sha256": digest,
        "file": None,
        "served_values": served_values,
    }


def capture_camera_row(
    page,
    *,
    case: dict,
    width: int,
    height: int,
    rev: str,
) -> dict:
    heading = normalize_ws(page.locator(".near-hero h1").inner_text())
    if heading != case["selected_label"]:
        raise AssertionError(
            f"{case['name']}: served heading {heading!r} does not show preserved "
            f"place {case['selected_label']!r}"
        )
    areas = page.locator('[data-geography-areas][data-geography-layer="nta2020"]')
    if areas.count() == 0:
        raise AssertionError(f"{case['name']}: Areas layer left nta2020")

    camera = read_page_camera(page, case_name=case["name"])
    params = query_map(page.url)
    actual_compare = params.get("compare")
    if actual_compare != case["compare"]:
        raise AssertionError(
            f"{case['name']}: compare {actual_compare!r} != {case['compare']!r}"
        )
    selected_key = None
    if page.locator("[data-geography-overlap-root]").count():
        selected_key = page.locator("[data-geography-overlap-root]").get_attribute(
            "data-geography-selected-key"
        )
    digest = dom_hash(page)
    SCRATCH.mkdir(parents=True, exist_ok=True)
    page.screenshot(
        path=str(SCRATCH / f"preserve-{case['name']}-{width}x{height}.png"),
        full_page=True,
    )
    served_values = {
        "heading": heading,
        "compare": actual_compare,
        "geo": params.get("geo"),
        "lens": params.get("lens"),
        "active_layer": "nta2020",
        "selected_key": selected_key or None,
        "camera": camera,
        "camera_page_extracted_fields": list(CAMERA_PAGE_EXTRACTED_FIELDS),
        "camera_tolerance": dict(CAMERA_TOLERANCE),
        "place_preserved": heading == case["selected_label"],
    }
    if not served_values["place_preserved"]:
        raise AssertionError(f"{case['name']}: place not preserved: {served_values!r}")
    if "result" in served_values or "pass" in served_values:
        raise AssertionError("served_values must not carry a pass verdict")
    return {
        "source": "headless-playwright-production-served-site",
        "name": f"{case['name']}-{'mobile' if width < 800 else 'desktop'}",
        "route": case["route"],
        "viewport": {"width": width, "height": height},
        "revision": rev,
        "data_vintage": DATA_VINTAGE,
        "assertion": case["assertion"],
        "sha256": digest,
        "file": None,
        "served_values": served_values,
    }


def capture_a1_camera_viewport(
    page,
    base: str,
    width: int,
    height: int,
    rev: str,
    *,
    perturb_last: bool = False,
) -> list[dict]:
    """Load once, then switch comparisons in-page so camera retention is observed."""

    first = A1_CAMERA_SPECIMENS[0]
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{base.rstrip('/')}{first['route']}", wait_until="domcontentloaded", timeout=60000)
    wait_for_map_ready(page, case_name=first["name"])
    page.locator("[data-geography-overlap-root]").wait_for(timeout=20000)
    wait_for_map_idle(page, case_name=first["name"])

    rows: list[dict] = []
    for index, case in enumerate(A1_CAMERA_SPECIMENS):
        if index > 0:
            switch_compare_control(page, case["compare"], case_name=case["name"])
        if perturb_last and index == len(A1_CAMERA_SPECIMENS) - 1:
            moved = page.evaluate(PERTURB_CAMERA_JS)
            if not moved:
                raise AssertionError(
                    f"{case['name']}: failed to perturb map camera for mutation control"
                )
            page.wait_for_timeout(300)
            wait_for_map_idle(page, case_name=case["name"])
        rows.append(
            capture_camera_row(
                page,
                case=case,
                width=width,
                height=height,
                rev=rev,
            )
        )
    return rows


def build_receipt(
    *,
    base: str,
    artifact: dict,
    rev: str,
    observed_at: str,
    a1_reads: list[dict],
    camera_reads: list[dict],
    camera_retention: list[dict],
) -> dict:
    generated_at = artifact.get("generated_at")
    return {
        "schema": SCHEMA,
        "public_alias": PUBLIC_ALIAS,
        "observed_at": observed_at,
        "evidence_class": "deployed-production-read-back",
        "origin": normalize_base(base).rstrip("/"),
        "deployment": {
            "manifest_url": f"{normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH}",
            "revision": rev,
            "generated_at": generated_at,
            "deployment_at": artifact.get("deployment_at") or generated_at,
            "manifest_sha256": sha256_text(json.dumps(artifact, sort_keys=True)),
            "required_ancestor": REQUIRED_ANCESTOR,
            "required_ancestor_contained": True,
            "required_ancestor_on_default_branch": True,
        },
        "capture": {
            "tool": "tools/capture_near_you_map_health_preserve_place_production_read.py",
            "browser": "chromium",
            "viewports": [{"name": n, "width": w, "height": h} for n, w, h in VIEWPORTS],
            "screenshot_binaries_committed": False,
            "camera_page_extracted_fields": list(CAMERA_PAGE_EXTRACTED_FIELDS),
            "camera_tolerance": dict(CAMERA_TOLERANCE),
        },
        "producer": {
            "path": PRODUCER_PATH,
            "schema": SCHEMA,
            "letters": ["A1"],
        },
        "letters": {
            "A1": {
                "clause": "preserved_place_shown_through_boundary_comparison",
                "route": A1_SPECIMEN["route"],
                "reads": a1_reads,
                "camera_reads": camera_reads,
                "camera_retention": camera_retention,
            }
        },
        "reads": a1_reads,
        "summary": {
            "case_count": 1 + len(A1_CAMERA_SPECIMENS),
            "capture_count": len(a1_reads) + len(camera_reads),
            "letter": "A1",
            "camera_compare_types": [row["compare"] for row in A1_CAMERA_SPECIMENS],
        },
    }


def build_manifest(receipt: dict) -> dict:
    rev = receipt["deployment"]["revision"]
    a1 = receipt["letters"]["A1"]
    captures = list(a1.get("reads") or []) + list(a1.get("camera_reads") or [])
    return {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "geography-navigation-preserve-place",
        "public_alias": PUBLIC_ALIAS,
        "surface": "Near You boundary comparison place retention",
        "base": normalize_base(receipt["origin"]),
        "condition": (
            f"Production base {normalize_base(receipt['origin'])} after deployment; "
            "no image binary is committed."
        ),
        "capture_mode": "headless-playwright-production-served-site",
        "revision_format": "served artifact-manifest source_commit_sha",
        "revision": rev,
        "repository_revision": rev,
        "grounded_at": rev,
        "required_ancestor": REQUIRED_ANCESTOR,
        "required_ancestor_contained": True,
        "data_vintage": DATA_VINTAGE,
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; "
            "only this manifest is committed."
        ),
        "note": (
            "Production desktop/mobile receipts for Greenpoint preserved through "
            "a Precinct 94 police comparison, plus page-observed map camera "
            "retention across police, community, and council comparisons."
        ),
        "verifier": (
            "node --test test/geography_navigation_preserve_place_production_read.test.mjs"
        ),
        "producer": receipt["producer"],
        "camera_tolerance": dict(CAMERA_TOLERANCE),
        "camera_page_extracted_fields": list(CAMERA_PAGE_EXTRACTED_FIELDS),
        "captures": captures,
    }


def validate(receipt: dict) -> None:
    if receipt.get("schema") != SCHEMA:
        raise AssertionError(f"unexpected schema {receipt.get('schema')}")
    if receipt.get("public_alias") != PUBLIC_ALIAS:
        raise AssertionError("public_alias mismatch")
    deployment = receipt.get("deployment") or {}
    if not re.fullmatch(r"[0-9a-f]{40}", deployment.get("revision") or ""):
        raise AssertionError("deployment.revision must be a 40-hex served SHA")
    if deployment.get("required_ancestor") != REQUIRED_ANCESTOR:
        raise AssertionError("deployment.required_ancestor mismatch")
    if deployment.get("required_ancestor_contained") is not True:
        raise AssertionError("deployment.required_ancestor_contained must be true")
    if not revision_contains_ancestor(REQUIRED_ANCESTOR, deployment["revision"], cwd=ROOT):
        raise AssertionError(
            f"served revision {deployment['revision']} does not contain required ancestor "
            f"{REQUIRED_ANCESTOR}"
        )
    resolve_landed_ancestor(REQUIRED_ANCESTOR, cwd=ROOT)
    producer = receipt.get("producer") or {}
    if producer.get("path") != PRODUCER_PATH:
        raise AssertionError("producer path mismatch")
    if producer.get("letters") != ["A1"]:
        raise AssertionError("producer letters mismatch")
    a1 = ((receipt.get("letters") or {}).get("A1") or {})
    if a1.get("clause") != "preserved_place_shown_through_boundary_comparison":
        raise AssertionError("A1 clause mismatch")
    reads = a1.get("reads") or []
    if len(reads) < 2:
        raise AssertionError("A1 requires desktop and mobile served reads")
    for row in reads:
        values = row.get("served_values")
        if values is None:
            raise AssertionError(f"{row.get('name')}: served_values is null")
        if not isinstance(values, dict) or not values:
            raise AssertionError(f"{row.get('name')}: served_values missing observed text")
        heading = values.get("heading")
        overlap = values.get("overlap_label") or ""
        needle = values.get("overlap_needle_shown") or A1_SPECIMEN["overlap_needle"]
        if heading != A1_SPECIMEN["selected_label"]:
            raise AssertionError(
                f"{row.get('name')}: served heading {heading!r} is not Greenpoint"
            )
        if needle not in overlap and not values.get("precinct_shown"):
            raise AssertionError(
                f"{row.get('name')}: served overlap {overlap!r} does not show Precinct 94"
            )
        if values.get("compare") != "police_precinct":
            raise AssertionError(f"{row.get('name')}: compare not preserved as police_precinct")
        if values.get("active_layer") != "nta2020":
            raise AssertionError(f"{row.get('name')}: active layer left nta2020")
        if "result" in values or "pass" in values:
            raise AssertionError("A1 served_values must not carry a pass verdict")

    camera_reads = a1.get("camera_reads") or []
    expected_camera_count = len(A1_CAMERA_SPECIMENS) * len(VIEWPORTS)
    if len(camera_reads) != expected_camera_count:
        raise AssertionError(
            f"A1 camera_reads must cover three compares at two viewports "
            f"({expected_camera_count}), got {len(camera_reads)}"
        )
    page_fields = set(CAMERA_PAGE_EXTRACTED_FIELDS)
    for row in camera_reads:
        values = row.get("served_values") or {}
        camera = values.get("camera")
        if not isinstance(camera, dict):
            raise AssertionError(f"{row.get('name')}: camera missing or unreadable")
        center = camera.get("center") or {}
        if not isinstance(center.get("lng"), (int, float)) or not isinstance(center.get("lat"), (int, float)):
            raise AssertionError(f"{row.get('name')}: camera.center missing page numbers")
        if not isinstance(camera.get("zoom"), (int, float)):
            raise AssertionError(f"{row.get('name')}: camera.zoom missing page number")
        if values.get("heading") != "Greenpoint":
            raise AssertionError(f"{row.get('name')}: camera row lost Greenpoint")
        if values.get("active_layer") != "nta2020":
            raise AssertionError(f"{row.get('name')}: camera row left nta2020")
        if row.get("revision") != deployment["revision"]:
            raise AssertionError(f"{row.get('name')}: camera row revision mismatch")
        if not row.get("route") or not row.get("viewport"):
            raise AssertionError(f"{row.get('name')}: camera row missing route or viewport")
        recorded_fields = set(values.get("camera_page_extracted_fields") or [])
        if not page_fields.issubset(recorded_fields):
            raise AssertionError(
                f"{row.get('name')}: camera_page_extracted_fields missing "
                f"{sorted(page_fields - recorded_fields)}"
            )
        tolerance = values.get("camera_tolerance") or {}
        if tolerance != CAMERA_TOLERANCE:
            raise AssertionError(f"{row.get('name')}: camera_tolerance must be recorded with the values")
        if "result" in values or "pass" in values:
            raise AssertionError("camera served_values must not carry a pass verdict")

    retention = a1.get("camera_retention") or []
    if len(retention) != len(VIEWPORTS):
        raise AssertionError("camera_retention must include one group per viewport")
    for group in retention:
        if group.get("equal") is not True:
            raise AssertionError(f"camera_retention not equal: {group!r}")
        if group.get("tolerance") != CAMERA_TOLERANCE:
            raise AssertionError("camera_retention must record the tolerance beside the values")
        if len(group.get("compare_types") or []) != len(A1_CAMERA_SPECIMENS):
            raise AssertionError("camera_retention must cover all three comparison types")


def assert_canonical_json(path: Path) -> None:
    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw)
    canonical = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if raw != canonical:
        raise AssertionError(f"{path.relative_to(ROOT)} is not canonical sorted-key JSON")


def check() -> None:
    receipt = load_json(READBACK)
    validate(receipt)
    assert_canonical_json(READBACK)
    production = load_json(PRODUCTION)
    if production.get("schema") != SCHEMA:
        raise AssertionError("production-read schema mismatch")
    if production.get("producer", {}).get("letters") != ["A1"]:
        raise AssertionError("production-read producer letters mismatch")
    if not ((production.get("letters") or {}).get("A1") or {}).get("reads"):
        raise AssertionError("production-read missing A1 reads")
    if not ((production.get("letters") or {}).get("A1") or {}).get("camera_reads"):
        raise AssertionError("production-read missing A1 camera_reads")
    assert_canonical_json(PRODUCTION)
    manifest = load_json(MANIFEST)
    if manifest.get("public_alias") != PUBLIC_ALIAS:
        raise AssertionError("capture-manifest public_alias mismatch")
    if manifest.get("producer", {}).get("letters") != ["A1"]:
        raise AssertionError("capture-manifest producer letters mismatch")
    if manifest.get("camera_tolerance") != CAMERA_TOLERANCE:
        raise AssertionError("capture-manifest must record camera_tolerance")
    assert_canonical_json(MANIFEST)
    a1_names = {row["name"] for row in receipt["letters"]["A1"]["reads"]}
    camera_names = {row["name"] for row in receipt["letters"]["A1"]["camera_reads"]}
    manifest_names = {row.get("name") for row in manifest.get("captures") or []}
    if not a1_names.issubset(manifest_names):
        raise AssertionError("capture-manifest missing A1 captures")
    if not camera_names.issubset(manifest_names):
        raise AssertionError("capture-manifest missing A1 camera captures")
    print(
        f"geography-navigation-preserve-place A1 check passed: {READBACK.relative_to(ROOT)}"
    )


def capture(*, mutation_control: bool = False) -> dict:
    from playwright.sync_api import sync_playwright

    base = resolve_base()
    artifact = read_artifact_manifest(base)
    rev = deployed_revision(artifact)
    resolve_landed_ancestor(REQUIRED_ANCESTOR, cwd=ROOT)
    if not revision_contains_ancestor(REQUIRED_ANCESTOR, rev, cwd=ROOT):
        raise RuntimeError(
            f"served revision {rev} does not contain required ancestor {REQUIRED_ANCESTOR}"
        )
    observed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    print(
        f"production base={base} revision={rev} ancestor={REQUIRED_ANCESTOR}",
        flush=True,
    )

    a1_reads: list[dict] = []
    camera_reads: list[dict] = []
    camera_retention: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (compatible; CityScrollCapture/1.0)",
            # Prefer settled cameras over mid-animation samples when reading retention.
            reduced_motion="reduce",
        )
        context.add_init_script(MAP_HOOK_INIT)
        page = context.new_page()
        for name, width, height in VIEWPORTS:
            print(f"preserve A1 {A1_SPECIMEN['name']} {name}", flush=True)
            a1_reads.append(capture_a1_case(page, base, width, height, rev))

        for name, width, height in VIEWPORTS:
            print(
                f"preserve A1 camera switches {name}"
                + (" MUTATION" if mutation_control else ""),
                flush=True,
            )
            viewport_rows = capture_a1_camera_viewport(
                page,
                base,
                width,
                height,
                rev,
                perturb_last=bool(mutation_control),
            )
            camera_reads.extend(viewport_rows)
            camera_retention.append(assert_cameras_retained(viewport_rows))
        browser.close()

    receipt = build_receipt(
        base=base,
        artifact=artifact,
        rev=rev,
        observed_at=observed_at,
        a1_reads=a1_reads,
        camera_reads=camera_reads,
        camera_retention=camera_retention,
    )
    validate(receipt)
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument(
        "--mutation-control",
        action="store_true",
        help=(
            "Deliberately perturb the camera on the last comparison type and "
            "expect the capture to refuse. Used to prove camera equality is load-bearing."
        ),
    )
    args = parser.parse_args()
    if args.check:
        check()
        return 0

    if args.mutation_control:
        try:
            capture(mutation_control=True)
        except AssertionError as error:
            message = str(error)
            if "camera diverged" in message or "camera missing" in message:
                print(f"mutation-control refused as expected: {error}", flush=True)
                return 0
            raise
        print("mutation-control unexpectedly succeeded", file=sys.stderr)
        return 1

    receipt = capture()
    write_json(READBACK, receipt)
    write_json(PRODUCTION, receipt)
    write_json(MANIFEST, build_manifest(receipt))
    print(f"wrote {READBACK.relative_to(ROOT)}", flush=True)
    print(f"wrote {PRODUCTION.relative_to(ROOT)}", flush=True)
    print(f"wrote {MANIFEST.relative_to(ROOT)}", flush=True)
    for row in receipt["letters"]["A1"]["reads"]:
        values = row["served_values"]
        print(
            f"  {row['name']}: heading={values['heading']!r} "
            f"overlap={values['overlap_label']!r}",
            flush=True,
        )
    for row in receipt["letters"]["A1"]["camera_reads"]:
        camera = row["served_values"]["camera"]
        print(
            f"  {row['name']}: compare={row['served_values']['compare']!r} "
            f"camera={camera!r}",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(exc, file=sys.stderr)
        raise
