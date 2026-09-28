#!/usr/bin/env python3
"""Production read-back for the map-first Near You shell (A9 / A13).

Hits the live served origin with headless Chromium. Commits textual receipts
only; optional screenshots stay under the task scratch directory.

A9 records the concrete keyboard focus order into and out of the map host,
Escape clearing hover/focus state, and keyboard/tap equivalents for hover
highlights (area directory links and focusable map host Enter/Space).

A13 records the observed residential neighborhood label counts at 1440x900 and
390x844, plus real label-box geometry (overlap / map-frame clipping / primary
control obscuring) from MapLibre CollisionIndex boxes read back through
getBoundingClientRect, and the selected-neighborhood name on a selected route.

Never treat dataset.overlappingNeighborhoodLabelCount as a geometry measurement:
that field is a derived style flag. Overlap counts come from box intersection.
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
import uuid
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

from deployed_capture_ancestor import (
    load_recorded_delivery,
    resolve_landed_ancestor,
    revision_contains_ancestor,
)

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "near-you-shell-production-read"
OUT_DIR = ROOT / "docs/evidence/near-you-shell-readback"
READBACK = OUT_DIR / "read-back.json"
MANIFEST = OUT_DIR / "capture-manifest.json"
DELIVERY = OUT_DIR / "delivery.json"

PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
ARTIFACT_MANIFEST_PATH = "/artifact-manifest.json"
ARTIFACT_UA = "cityscroll-near-you-shell-capture/1"
DEFAULT_BASE = "https://cityscroll.org/"
PUBLIC_ALIAS = "ced62a84f8213"
SCHEMA = "cityscroll.near_you_shell_production_read.v1"
DATA_VINTAGE = "nta2020 26B"
ENTRY_ROUTE = "/near-you/"
REQUIRED_ANCESTOR = load_recorded_delivery(DELIVERY)
RECEIPT_HEADER_KEYS = ("date", "cf-ray", "cf-cache-status", "age", "last-modified", "etag")

VIEWPORTS = (
    ("desktop", 1440, 900, 12, 40),
    ("mobile", 390, 844, 6, 20),
)

# Dense-area specimens for the A13 selected-name priority clause. Each is read
# at both binding viewports under the same collision measurement as all-city.
SELECTED_SPECIMENS = (
    {
        "name": "greenpoint",
        "route": "/near-you/?geo=nta2020%3ABK0101&surface=map",
        "expected_label": "Greenpoint",
        "geo": "nta2020:BK0101",
    },
    {
        "name": "east-village",
        "route": "/near-you/?geo=nta2020%3AMN0303&surface=map",
        "expected_label": "East Village",
        "geo": "nta2020:MN0303",
    },
)

# Headless Chromium on macOS needs an explicit GL path for MapLibre.
WEBGL_BROWSER_ARGS = (
    "--use-gl=angle",
    "--use-angle=metal",
    "--enable-unsafe-swiftshader",
)

MAP_HOOK_INIT = """
(() => {
  const stash = [];
  const hook = () => {
    const gl = window.maplibregl;
    if (!gl || !gl.Map || gl.Map.__cityscrollShellHooked) return Boolean(gl && gl.Map);
    const Original = gl.Map;
    function Wrapped(...args) {
      const map = new Original(...args);
      stash.push(map);
      window.__cityscrollShellMaps = stash;
      return map;
    }
    Wrapped.prototype = Original.prototype;
    Object.keys(Original).forEach((key) => {
      try { Wrapped[key] = Original[key]; } catch (_error) { /* ignore */ }
    });
    Wrapped.__cityscrollShellHooked = true;
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


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_artifact_manifest(base: str) -> tuple[dict, dict]:
    url = f"{normalize_base(base).rstrip('/')}{ARTIFACT_MANIFEST_PATH}"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": ARTIFACT_UA, "Accept": "application/json"},
    )
    requested_at = now_iso()
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read()
            payload = json.loads(raw.decode("utf-8"))
            headers = {
                key: response.headers.get(key)
                for key in RECEIPT_HEADER_KEYS
            }
            receipt = {
                "url": response.geturl(),
                "http_status": response.status,
                "requested_at": requested_at,
                "responded_at": now_iso(),
                "headers": headers,
                "payload_sha256": hashlib.sha256(raw).hexdigest(),
            }
    except (
        urllib.error.URLError,
        TimeoutError,
        json.JSONDecodeError,
        UnicodeDecodeError,
        OSError,
    ) as error:
        raise RuntimeError(f"deployed build revision unavailable at {url}: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"artifact-manifest at {url} is not an object")
    receipt["served_revision"] = deployed_revision(payload)
    return payload, receipt


def deployed_revision(manifest: dict) -> str:
    sha = manifest.get("source_commit_sha")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("artifact-manifest lacks a 40-hex source_commit_sha")
    return sha


def page_load_receipt(response) -> dict:
    headers: dict[str, str | None] = {}
    status = None
    url = None
    if response is not None:
        try:
            raw = response.headers
        except Exception:  # noqa: BLE001
            raw = {}
        headers = {key: raw.get(key) or None for key in RECEIPT_HEADER_KEYS}
        try:
            status = response.status
        except Exception:  # noqa: BLE001
            status = None
        try:
            url = response.url
        except Exception:  # noqa: BLE001
            url = None
    return {"url": url, "http_status": status, "headers": headers}


def request_receipt(
    *,
    base: str,
    response,
    expected_revision: str,
    capture_run_id: str,
    request_id: str,
) -> dict:
    """Bind one production navigation to a fresh served-manifest read."""
    _artifact, manifest_read = read_artifact_manifest(base)
    observed_revision = manifest_read["served_revision"]
    if observed_revision != expected_revision:
        raise AssertionError(
            f"served revision changed during capture request {request_id}: "
            f"{observed_revision} != {expected_revision}"
        )
    return {
        "capture_run_id": capture_run_id,
        "request_id": request_id,
        "observed_at": now_iso(),
        "page_load": page_load_receipt(response),
        "served_manifest_read": manifest_read,
    }


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def focus_info_js() -> str:
    return """() => {
      const el = document.activeElement;
      if (!el || el === document.body) {
        return { tag: 'BODY', id: null, text: '', in_map_region: false };
      }
      const inMap = Boolean(el.closest('#near-map-enhanced, .maplibregl-map'));
      return {
        tag: el.tagName,
        id: el.id || null,
        className: (el.className || '').toString().slice(0, 100),
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        tabIndex: el.tabIndex,
        href: el.getAttribute('href'),
        dataMapArea: el.getAttribute('data-map-area'),
        dataNearSurface: el.getAttribute('data-near-surface'),
        text: (el.getAttribute('aria-label') || el.textContent || '')
          .trim().replace(/\\s+/g, ' ').slice(0, 80),
        in_map_region: inMap,
      };
    }"""


def wait_for_enhanced_labels(page, timeout: int = 25000) -> None:
    page.locator("[data-near-you-root]").wait_for(timeout=timeout)
    page.wait_for_function(
        """() => {
          const root = document.querySelector('[data-near-you-root]');
          const host = document.querySelector('#near-map-enhanced');
          return root?.dataset?.nearMapRuntime === 'maplibre'
            && Number(host?.dataset?.renderedNeighborhoodLabelCount || 0) > 0;
        }""",
        timeout=timeout,
    )
    page.wait_for_timeout(400)


def observe_a13(page, width: int, height: int, *, route: str = ENTRY_ROUTE) -> dict:
    """Observe A13 counts plus real label-box geometry on the current page."""
    return page.evaluate(
        """({ width, height, route }) => {
          const root = document.querySelector('[data-near-you-root]');
          const host = document.querySelector('#near-map-enhanced');
          const labels = host?.dataset?.renderedNeighborhoodLabels
            ? host.dataset.renderedNeighborhoodLabels.split(' | ').filter(Boolean)
            : [];
          const maps = window.__cityscrollShellMaps || [];
          const map = maps.length ? maps[maps.length - 1] : null;
          let textAllowOverlap = host?.dataset?.labelTextAllowOverlap ?? null;
          let textIgnorePlacement = host?.dataset?.labelTextIgnorePlacement ?? null;
          let bucketCanOverlap = null;
          let queriedUnique = null;
          let collisionSourceFeatures = [];
          let collisionSourceLabels = [];
          let placedLabels = [];
          if (map && typeof map.getLayoutProperty === 'function') {
            try {
              textAllowOverlap = map.getLayoutProperty('geography-labels', 'text-allow-overlap');
              textIgnorePlacement = map.getLayoutProperty('geography-labels', 'text-ignore-placement');
            } catch (_error) { /* keep dataset values */ }
            try {
              const features = map.queryRenderedFeatures(undefined, { layers: ['geography-labels'] }) || [];
              placedLabels = [...new Set(features
                .map((feature) => String(feature?.properties?.label || '').trim())
                .filter(Boolean))].sort((left, right) => left.localeCompare(right));
              queriedUnique = placedLabels.length;
            } catch (_error) {
              queriedUnique = null;
            }
            try {
              const source = map.getSource('geography-label-candidates');
              const sourceData = source?._data || source?._options?.data;
              collisionSourceFeatures = Array.isArray(sourceData?.features)
                ? sourceData.features
                : [];
              collisionSourceLabels = collisionSourceFeatures
                .map((feature) => String(feature?.properties?.label || '').trim())
                .filter(Boolean)
                .sort((left, right) => left.localeCompare(right));
            } catch (_error) {
              collisionSourceFeatures = [];
              collisionSourceLabels = [];
            }
            try {
              const style = map.style;
              const sourceCache = style?.sourceCaches?.['geography-active']
                || style?._sourceCaches?.['geography-active'];
              const tiles = sourceCache?._tiles || {};
              for (const tile of Object.values(tiles)) {
                const bucket = tile?.buckets?.['geography-labels'];
                if (bucket && typeof bucket.canOverlap === 'boolean') {
                  bucketCanOverlap = bucket.canOverlap;
                  break;
                }
              }
            } catch (_error) {
              bucketCanOverlap = null;
            }
          }

          // Real geometry from MapLibre CollisionIndex placed boxes, materialized as
          // DOM nodes and read with getBoundingClientRect. Never trust
          // dataset.overlappingNeighborhoodLabelCount — that is a derived style flag.
          const geometry = {
            measurement: 'maplibre-collisionIndex-grid-bboxes+getBoundingClientRect',
            measured_label_box_count: 0,
            overlapping_label_pair_count: null,
            collision_source_label_count: collisionSourceLabels.length,
            placed_label_count: placedLabels.length,
            collision_dropped_label_count: null,
            collision_dropped_labels_sample: [],
            frame_crossing_label_count: null,
            frame_crossing_labels_sample: [],
            obscured_by_primary_control_count: null,
            control_occlusion_label_box_count: 0,
            clip_surface: 'map_host_canvas_and_overflow_hidden_ancestors',
            primary_control_box_count: 0,
            overlapping_pairs_sample: [],
            obscured_sample: [],
            label_boxes: [],
            dataset_overlap_flag_ignored: host?.dataset?.overlappingNeighborhoodLabelCount ?? null,
          };

          if (map && host) {
            const canvas = map.getCanvas();
            const canvasRect = canvas.getBoundingClientRect();
            const hostRect = host.getBoundingClientRect();
            const placement = map.painter?.placement || map.style?.placement;
            const collisionGrid = placement?.collisionIndex?.grid;
            const raw = collisionGrid?.bboxes;
            const boxKeys = collisionGrid?.boxKeys || [];
            if (raw && raw.length >= 4) {
              const gridOffsetX = Math.max(0, ((collisionGrid?.width || canvas.clientWidth) - canvas.clientWidth) / 2);
              const gridOffsetY = Math.max(0, ((collisionGrid?.height || canvas.clientHeight) - canvas.clientHeight) / 2);
              const unmatchedBoxes = [];
              for (let i = 0; i + 3 < raw.length; i += 4) {
                const key = boxKeys[i / 4] || null;
                // The selected label uses overlapMode=always and a separate
                // source. Ordinary A13 geometry owns only the collision-gated
                // candidate population (overlapMode=never).
                const includeAlways = host.dataset.a13IncludeAlwaysCollisionBoxes === '1';
                if (!includeAlways && key?.overlapMode && key.overlapMode !== 'never') continue;
                unmatchedBoxes.push({
                  x1: raw[i] - gridOffsetX,
                  y1: raw[i + 1] - gridOffsetY,
                  x2: raw[i + 2] - gridOffsetX,
                  y2: raw[i + 3] - gridOffsetY,
                });
              }
              const placedSet = new Set(placedLabels);
              const mapBoxes = [];
              for (const feature of collisionSourceFeatures) {
                const label = String(feature?.properties?.label || '').trim();
                if (!label || !placedSet.has(label) || unmatchedBoxes.length === 0) continue;
                const coordinates = feature?.geometry?.type === 'Point'
                  ? feature.geometry.coordinates
                  : [feature?.properties?.label_lon, feature?.properties?.label_lat];
                const point = map.project(coordinates);
                let bestIndex = 0;
                let bestDistance = Number.POSITIVE_INFINITY;
                for (let index = 0; index < unmatchedBoxes.length; index += 1) {
                  const box = unmatchedBoxes[index];
                  const centerX = (box.x1 + box.x2) / 2;
                  const centerY = (box.y1 + box.y2) / 2;
                  const distance = Math.hypot(centerX - point.x, centerY - point.y);
                  if (distance < bestDistance) {
                    bestIndex = index;
                    bestDistance = distance;
                  }
                }
                const [box] = unmatchedBoxes.splice(bestIndex, 1);
                mapBoxes.push({ ...box, label });
              }
              const measureRoot = document.createElement('div');
              measureRoot.setAttribute('data-a13-label-geometry-measure', '1');
              measureRoot.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
              document.body.appendChild(measureRoot);
              const labelBoxes = [];
              for (const mb of mapBoxes) {
                const left = canvasRect.left + mb.x1;
                const top = canvasRect.top + mb.y1;
                const el = document.createElement('div');
                el.style.cssText = [
                  'position:absolute',
                  `left:${left}px`,
                  `top:${top}px`,
                  `width:${mb.x2 - mb.x1}px`,
                  `height:${mb.y2 - mb.y1}px`,
                  'box-sizing:border-box',
                  'opacity:0',
                  'pointer-events:none',
                ].join(';');
                measureRoot.appendChild(el);
                const r = el.getBoundingClientRect();
                labelBoxes.push({
                  label: mb.label,
                  box: {
                    left: r.left, top: r.top, right: r.right, bottom: r.bottom,
                    width: r.width, height: r.height,
                  },
                });
              }

              const intersects = (a, b) => (
                a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
              );
              let overlapping = 0;
              const overlappingSample = [];
              for (let i = 0; i < labelBoxes.length; i += 1) {
                for (let j = i + 1; j < labelBoxes.length; j += 1) {
                  if (intersects(labelBoxes[i].box, labelBoxes[j].box)) {
                    overlapping += 1;
                    if (overlappingSample.length < 12) {
                      overlappingSample.push([labelBoxes[i].label, labelBoxes[j].label]);
                    }
                  }
                }
              }

              // Clip surface = map host/canvas frame plus overflow:hidden|clip ancestors.
              // Browser page-fold is recorded separately so scrollable below-fold map
              // content is not conflated with glyph clipping at the map frame.
              let clip = {
                left: Math.min(hostRect.left, canvasRect.left),
                top: Math.min(hostRect.top, canvasRect.top),
                right: Math.max(hostRect.right, canvasRect.right),
                bottom: Math.max(hostRect.bottom, canvasRect.bottom),
              };
              let ancestor = host.parentElement;
              while (ancestor && ancestor !== document.documentElement) {
                const cs = getComputedStyle(ancestor);
                if (/(hidden|clip)/.test(`${cs.overflow}|${cs.overflowX}|${cs.overflowY}`)) {
                  const ar = ancestor.getBoundingClientRect();
                  clip = {
                    left: Math.max(clip.left, ar.left),
                    top: Math.max(clip.top, ar.top),
                    right: Math.min(clip.right, ar.right),
                    bottom: Math.min(clip.bottom, ar.bottom),
                  };
                }
                ancestor = ancestor.parentElement;
              }
              const isClipped = (box) => (
                box.left < clip.left - 0.5
                || box.top < clip.top - 0.5
                || box.right > clip.right + 0.5
                || box.bottom > clip.bottom + 0.5
              );
              const clippedRows = labelBoxes.filter((row) => isClipped(row.box));
              const browserFoldRows = labelBoxes.filter((row) => (
                row.box.left < -0.5
                || row.box.top < -0.5
                || row.box.right > window.innerWidth + 0.5
                || row.box.bottom > window.innerHeight + 0.5
              ));

              const controlBoxes = [];
              for (const el of host.querySelectorAll(
                '.maplibregl-ctrl-attrib, .maplibregl-ctrl-group, .maplibregl-ctrl-zoom-in, .maplibregl-ctrl-zoom-out, .maplibregl-ctrl-compass',
              )) {
                const r = el.getBoundingClientRect();
                if (r.width <= 1 || r.height <= 1) continue;
                controlBoxes.push({
                  className: (el.className || '').toString().slice(0, 96),
                  box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
                });
              }
              let obscured = 0;
              const obscuredSample = [];
              for (const lb of labelBoxes) {
                for (const cb of controlBoxes) {
                  if (intersects(lb.box, cb.box)) {
                    obscured += 1;
                    if (obscuredSample.length < 12) {
                      obscuredSample.push({ label: lb.label, control: cb.className });
                    }
                    break;
                  }
                }
              }

              geometry.measured_label_box_count = labelBoxes.length;
              geometry.overlapping_label_pair_count = overlapping;
              const droppedLabels = collisionSourceLabels.filter((label) => !placedSet.has(label));
              geometry.collision_dropped_label_count = droppedLabels.length;
              geometry.collision_dropped_labels_sample = droppedLabels.slice(0, 12);
              geometry.frame_crossing_label_count = clippedRows.length;
              geometry.frame_crossing_labels_sample = clippedRows.slice(0, 12).map((row) => row.label);
              geometry.obscured_by_primary_control_count = obscured;
              geometry.control_occlusion_label_box_count = labelBoxes.length;
              geometry.primary_control_box_count = controlBoxes.length;
              geometry.overlapping_pairs_sample = overlappingSample;
              geometry.obscured_sample = obscuredSample;
              geometry.label_boxes = labelBoxes;
              geometry.clip_bounds = clip;
              geometry.browser_fold_label_count = browserFoldRows.length;
              measureRoot.remove();
            }
          }

          const mapRect = host?.getBoundingClientRect();
          return {
            viewport: { width, height },
            route,
            map_runtime: root?.dataset?.nearMapRuntime || null,
            map_runtime_reason: root?.dataset?.nearMapRuntimeReason || null,
            heading: (document.querySelector('#near-geo-heading, .near-geo-entry h1, .near-hero h1')?.textContent || '').trim(),
            residential_neighborhood_label_count: labels.length,
            residential_neighborhood_labels: labels,
            queried_unique_label_count: queriedUnique,
            text_allow_overlap: textAllowOverlap === 'false' ? false
              : textAllowOverlap === 'true' ? true
              : textAllowOverlap,
            text_ignore_placement: textIgnorePlacement === 'false' ? false
              : textIgnorePlacement === 'true' ? true
              : textIgnorePlacement,
            bucket_can_overlap: bucketCanOverlap,
            overlapping_label_pair_count: geometry.overlapping_label_pair_count,
            collision_measurement: geometry.measurement,
            geometry,
            map_host_size: mapRect
              ? { width: Math.round(mapRect.width), height: Math.round(mapRect.height) }
              : null,
            map_instance_hooked: Boolean(map),
          };
        }""",
        {"width": width, "height": height, "route": route},
    )


def exercise_a13_positive_controls(page, width: int, height: int, *, route: str) -> dict:
    """Prove the drop and control-occlusion detectors flip on real map state."""
    baseline = observe_a13(page, width, height, route=route)
    geometry = baseline.get("geometry") or {}
    boxes = [row for row in geometry.get("label_boxes") or [] if row.get("label")]
    if not boxes:
        raise AssertionError("A13 positive controls need a named placed label box")

    original_padding = page.evaluate(
        """() => {
          const map = (window.__cityscrollShellMaps || []).at(-1);
          const value = map?.getLayoutProperty?.('geography-labels', 'text-padding');
          map?.setLayoutProperty?.('geography-labels', 'text-padding', 160);
          return value ?? null;
        }"""
    )
    page.wait_for_timeout(800)
    collision = observe_a13(page, width, height, route=route)
    page.evaluate(
        """(padding) => {
          const map = (window.__cityscrollShellMaps || []).at(-1);
          map?.setLayoutProperty?.('geography-labels', 'text-padding', padding ?? 2);
        }""",
        original_padding,
    )
    page.wait_for_timeout(800)
    collision_geometry = collision.get("geometry") or {}
    if collision_geometry.get("collision_dropped_label_count", 0) < 1:
        raise AssertionError("A13 collision positive control did not report a dropped label")
    collision_sample = collision_geometry.get("collision_dropped_labels_sample") or []
    if not collision_sample or not all(collision_sample):
        raise AssertionError("A13 collision positive control did not name the dropped label")

    overlap_state = page.evaluate(
        """() => {
          const map = (window.__cityscrollShellMaps || []).at(-1);
          const host = document.querySelector('#near-map-enhanced');
          const source = map?.getSource?.('geography-label-candidates');
          const originalData = structuredClone(source?._data || { type: 'FeatureCollection', features: [] });
          const features = structuredClone(originalData.features || []).slice(0, 2);
          if (features.length < 2) return null;
          features[1].geometry.coordinates = [...features[0].geometry.coordinates];
          const allowOverlap = map.getLayoutProperty('geography-labels', 'text-allow-overlap');
          const ignorePlacement = map.getLayoutProperty('geography-labels', 'text-ignore-placement');
          host.dataset.a13IncludeAlwaysCollisionBoxes = '1';
          source.setData({ type: 'FeatureCollection', features });
          map.setLayoutProperty('geography-labels', 'text-allow-overlap', true);
          return { originalData, allowOverlap, ignorePlacement };
        }"""
    )
    if overlap_state is None:
        raise AssertionError("A13 overlap positive control needs two admitted labels")
    page.wait_for_timeout(800)
    overlap = observe_a13(page, width, height, route=route)
    page.evaluate(
        """({ data, allowOverlap, ignorePlacement }) => {
          const map = (window.__cityscrollShellMaps || []).at(-1);
          const host = document.querySelector('#near-map-enhanced');
          map?.getSource?.('geography-label-candidates')?.setData?.(data);
          map?.setLayoutProperty?.('geography-labels', 'text-allow-overlap', allowOverlap);
          map?.setLayoutProperty?.('geography-labels', 'text-ignore-placement', ignorePlacement);
          delete host?.dataset?.a13IncludeAlwaysCollisionBoxes;
        }""",
        {
            "data": overlap_state["originalData"],
            "allowOverlap": overlap_state["allowOverlap"],
            "ignorePlacement": overlap_state["ignorePlacement"],
        },
    )
    page.wait_for_timeout(800)
    overlap_geometry = overlap.get("geometry") or {}
    if overlap_geometry.get("overlapping_label_pair_count", 0) < 1:
        raise AssertionError("A13 overlap positive control did not report an overlapping pair")
    overlap_sample = overlap_geometry.get("overlapping_pairs_sample") or []
    if not overlap_sample or not all(all(pair) for pair in overlap_sample):
        raise AssertionError("A13 overlap positive control did not name both labels")

    frame_state = page.evaluate(
        """() => {
          const map = (window.__cityscrollShellMaps || []).at(-1);
          const source = map?.getSource?.('geography-label-candidates');
          const originalData = structuredClone(source?._data || { type: 'FeatureCollection', features: [] });
          const mutated = structuredClone(originalData);
          if (!mutated.features?.length) return null;
          const canvas = map.getCanvas();
          const edge = map.unproject([1, canvas.clientHeight / 2]);
          mutated.features[0].geometry.coordinates = [edge.lng, edge.lat];
          source.setData(mutated);
          return { originalData, label: mutated.features[0].properties.label };
        }"""
    )
    if frame_state is None:
        raise AssertionError("A13 frame positive control needs an admitted label")
    page.wait_for_timeout(800)
    frame = observe_a13(page, width, height, route=route)
    page.evaluate(
        """(data) => {
          const map = (window.__cityscrollShellMaps || []).at(-1);
          map?.getSource?.('geography-label-candidates')?.setData?.(data);
        }""",
        frame_state["originalData"],
    )
    page.wait_for_timeout(800)
    frame_geometry = frame.get("geometry") or {}
    if frame_geometry.get("frame_crossing_label_count", 0) < 1:
        raise AssertionError("A13 frame-crossing positive control did not flip")
    frame_sample = frame_geometry.get("frame_crossing_labels_sample") or []
    if frame_state["label"] not in frame_sample:
        raise AssertionError("A13 frame-crossing positive control did not name its moved label")

    target = boxes[0]
    control_state = page.evaluate(
        """({ box }) => {
          const host = document.querySelector('#near-map-enhanced');
          const control = host?.querySelector('.maplibregl-ctrl-attrib, .maplibregl-ctrl-group');
          if (!control) return null;
          const previous = control.getAttribute('style');
          control.style.setProperty('position', 'fixed', 'important');
          control.style.setProperty('left', `${box.left}px`, 'important');
          control.style.setProperty('top', `${box.top}px`, 'important');
          control.style.setProperty('right', 'auto', 'important');
          control.style.setProperty('bottom', 'auto', 'important');
          control.style.setProperty('width', `${Math.max(44, box.width)}px`, 'important');
          control.style.setProperty('height', `${Math.max(44, box.height)}px`, 'important');
          return { previous, className: String(control.className || '') };
        }""",
        {"box": target["box"]},
    )
    if control_state is None:
        raise AssertionError("A13 control-occlusion positive control found no primary control")
    page.wait_for_timeout(100)
    control = observe_a13(page, width, height, route=route)
    page.evaluate(
        """(previous) => {
          const host = document.querySelector('#near-map-enhanced');
          const control = host?.querySelector('.maplibregl-ctrl-attrib, .maplibregl-ctrl-group');
          if (!control) return;
          if (previous == null) control.removeAttribute('style');
          else control.setAttribute('style', previous);
        }""",
        control_state["previous"],
    )
    control_geometry = control.get("geometry") or {}
    if control_geometry.get("obscured_by_primary_control_count", 0) < 1:
        raise AssertionError("A13 control positive control did not report occlusion")
    obscured_sample = control_geometry.get("obscured_sample") or []
    if not obscured_sample or not obscured_sample[0].get("label"):
        raise AssertionError("A13 control positive control did not name the obscured label")

    return {
        "overlap": {
            "overlapping_label_pair_count": overlap_geometry.get(
                "overlapping_label_pair_count"
            ),
            "overlapping_pairs_sample": overlap_sample,
        },
        "collision_drop": {
            "forced_text_padding_px": 160,
            "collision_source_label_count": collision_geometry.get("collision_source_label_count"),
            "placed_label_count": collision_geometry.get("placed_label_count"),
            "collision_dropped_label_count": collision_geometry.get("collision_dropped_label_count"),
            "collision_dropped_labels_sample": collision_sample,
        },
        "control_occlusion": {
            "moved_control_class": control_state["className"],
            "label_box_count": control_geometry.get("control_occlusion_label_box_count"),
            "obscured_by_primary_control_count": control_geometry.get(
                "obscured_by_primary_control_count"
            ),
            "obscured_sample": obscured_sample,
        },
        "frame_crossing": {
            "moved_label": frame_state["label"],
            "frame_crossing_label_count": frame_geometry.get("frame_crossing_label_count"),
            "frame_crossing_labels_sample": frame_sample,
        },
    }


def observe_a13_selected(page, width: int, height: int, *, route: str, expected_label: str) -> dict:
    """Observe the selected-neighborhood name on a selected Near You route."""
    base = observe_a13(page, width, height, route=route)
    selected = page.evaluate(
        """({ expectedLabel }) => {
          const maps = window.__cityscrollShellMaps || [];
          const map = maps.length ? maps[maps.length - 1] : null;
          const host = document.querySelector('#near-map-enhanced');
          const uiLabel = (
            document.querySelector('[data-geography-selected-label]')?.textContent || ''
          ).trim() || null;
          const heading = (
            document.querySelector('#near-geo-heading, .near-geo-entry h1, .near-hero h1')?.textContent || ''
          ).trim() || null;
          let layerLabels = [];
          if (map) {
            try {
              const feats = map.queryRenderedFeatures(undefined, {
                layers: ['geography-selected-label'],
              }) || [];
              layerLabels = [...new Set(
                feats.map((f) => String(f.properties?.label || '').trim()).filter(Boolean),
              )];
            } catch (_error) {
              layerLabels = [];
            }
          }
          let selected_name_box = null;
          if (map && layerLabels.includes(expectedLabel)) {
            const canvasRect = map.getCanvas().getBoundingClientRect();
            const measureRoot = document.createElement('div');
            measureRoot.setAttribute('data-a13-selected-label-measure', '1');
            measureRoot.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
            document.body.appendChild(measureRoot);
            let hit = null;
            const step = 20;
            const cw = map.getCanvas().clientWidth;
            const ch = map.getCanvas().clientHeight;
            outer: for (let y = 0; y < ch; y += step) {
              for (let x = 0; x < cw; x += step) {
                const hits = map.queryRenderedFeatures([x, y], {
                  layers: ['geography-selected-label'],
                }) || [];
                if (hits.some((h) => String(h.properties?.label || '').trim() === expectedLabel)) {
                  hit = { x, y };
                  break outer;
                }
              }
            }
            if (hit) {
              const textSize = map.getLayoutProperty('geography-selected-label', 'text-size') || 13;
              const textMaxWidth = map.getLayoutProperty('geography-selected-label', 'text-max-width') || 12;
              const el = document.createElement('div');
              el.textContent = expectedLabel;
              el.style.cssText = [
                'position:absolute',
                `left:${canvasRect.left + hit.x}px`,
                `top:${canvasRect.top + hit.y}px`,
                `font:bold ${textSize}px "Noto Sans", system-ui, sans-serif`,
                `max-width:${textMaxWidth * textSize}px`,
                'transform:translate(-50%, -50%)',
                'text-align:center',
                'line-height:1.2',
                'opacity:0',
                'pointer-events:none',
              ].join(';');
              measureRoot.appendChild(el);
              const r = el.getBoundingClientRect();
              selected_name_box = {
                label: expectedLabel,
                hit,
                box: {
                  left: r.left, top: r.top, right: r.right, bottom: r.bottom,
                  width: r.width, height: r.height,
                },
              };
            }
            measureRoot.remove();
          }
          const intersects = (a, b) => (
            a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
          );
          const controlBoxes = [...(host?.querySelectorAll(
            '.maplibregl-ctrl-attrib, .maplibregl-ctrl-group, .maplibregl-ctrl-zoom-in, .maplibregl-ctrl-zoom-out, .maplibregl-ctrl-compass',
          ) || [])]
            .map((control) => ({
              className: String(control.className || '').slice(0, 96),
              box: control.getBoundingClientRect(),
            }))
            .filter((row) => row.box.width > 1 && row.box.height > 1);
          const selectedOcclusions = selected_name_box
            ? controlBoxes.filter((control) => intersects(selected_name_box.box, control.box))
            : [];
          return {
            selected_neighborhood_label: expectedLabel,
            selected_ui_label: uiLabel,
            selected_heading: heading,
            selected_layer_rendered_label_count: layerLabels.length,
            selected_layer_rendered_labels: layerLabels,
            selected_name_box,
            selected_name_control_occlusion: {
              label_box_count: selected_name_box ? 1 : 0,
              primary_control_box_count: controlBoxes.length,
              obscured_by_primary_control_count: selectedOcclusions.length,
              obscured_sample: selectedOcclusions.map((control) => ({
                label: expectedLabel,
                control: control.className,
              })).slice(0, 12),
            },
            map_runtime: document.querySelector('[data-near-you-root]')?.dataset?.nearMapRuntime || null,
            map_instance_hooked: Boolean(map),
            host_present: Boolean(host),
          };
        }""",
        {"expectedLabel": expected_label},
    )
    base.update(selected)
    return base


def exercise_selected_control_occlusion_positive_control(
    page,
    width: int,
    height: int,
    *,
    route: str,
) -> dict:
    """Move a real primary control over a placed ordinary label on a selected read."""
    baseline = observe_a13(page, width, height, route=route)
    geometry = baseline.get("geometry") or {}
    boxes = [row for row in geometry.get("label_boxes") or [] if row.get("label")]
    if not boxes:
        raise AssertionError("A13 selected control positive control needs a placed label")
    target = boxes[0]
    state = page.evaluate(
        """({ box }) => {
          const host = document.querySelector('#near-map-enhanced');
          const control = host?.querySelector('.maplibregl-ctrl-attrib, .maplibregl-ctrl-group');
          if (!control) return null;
          const previous = control.getAttribute('style');
          control.style.setProperty('position', 'fixed', 'important');
          control.style.setProperty('left', `${box.left}px`, 'important');
          control.style.setProperty('top', `${box.top}px`, 'important');
          control.style.setProperty('right', 'auto', 'important');
          control.style.setProperty('bottom', 'auto', 'important');
          control.style.setProperty('width', `${Math.max(44, box.width)}px`, 'important');
          control.style.setProperty('height', `${Math.max(44, box.height)}px`, 'important');
          return { previous, className: String(control.className || '') };
        }""",
        {"box": target["box"]},
    )
    if state is None:
        raise AssertionError("A13 selected control positive control found no primary control")
    page.wait_for_timeout(100)
    pressured = observe_a13(page, width, height, route=route)
    page.evaluate(
        """(previous) => {
          const host = document.querySelector('#near-map-enhanced');
          const control = host?.querySelector('.maplibregl-ctrl-attrib, .maplibregl-ctrl-group');
          if (!control) return;
          if (previous == null) control.removeAttribute('style');
          else control.setAttribute('style', previous);
        }""",
        state["previous"],
    )
    page.wait_for_timeout(100)
    pressured_geometry = pressured.get("geometry") or {}
    obscured = pressured_geometry.get("obscured_by_primary_control_count", 0)
    sample = pressured_geometry.get("obscured_sample") or []
    if obscured < 1:
        raise AssertionError("A13 selected control positive control did not report occlusion")
    if not sample or not sample[0].get("label"):
        raise AssertionError("A13 selected control positive control did not name its label")
    return {
        "moved_control_class": state["className"],
        "label_box_count": pressured_geometry.get("control_occlusion_label_box_count"),
        "primary_control_box_count": pressured_geometry.get("primary_control_box_count"),
        "obscured_by_primary_control_count": obscured,
        "obscured_sample": sample,
    }


def exercise_selected_priority_positive_control(
    page,
    width: int,
    height: int,
    *,
    route: str,
    expected_label: str,
) -> dict:
    control_state = page.evaluate(
        """() => {
          const map = (window.__cityscrollShellMaps || []).at(-1);
          const labelSource = map?.getSource?.('geography-label-candidates');
          const activeSource = map?.getSource?.('geography-active');
          const selectedSource = map?.getSource?.('geography-selected');
          const originalData = structuredClone(labelSource?._data || { type: 'FeatureCollection', features: [] });
          const selectedFeature = selectedSource?._data?.features?.[0];
          const coordinates = [
            Number(selectedFeature?.properties?.label_lon),
            Number(selectedFeature?.properties?.label_lat),
          ];
          const neighbors = (activeSource?._data?.features || [])
            .filter((feature) => feature?.properties?.key !== selectedFeature?.properties?.key)
            .slice(0, 2)
            .map((feature) => ({
              type: 'Feature',
              id: feature.id,
              geometry: { type: 'Point', coordinates },
              properties: { ...feature.properties },
            }));
          if (neighbors.length < 2 || coordinates.some((value) => !Number.isFinite(value))) {
            return null;
          }
          const originalPadding = map?.getLayoutProperty?.('geography-labels', 'text-padding');
          labelSource.setData({ type: 'FeatureCollection', features: neighbors });
          map?.setLayoutProperty?.('geography-labels', 'text-padding', 160);
          return { originalData, originalPadding: originalPadding ?? null };
        }"""
    )
    if control_state is None:
        raise AssertionError("A13 selected priority control could not stage neighboring labels")
    page.wait_for_timeout(800)
    pressured = observe_a13_selected(
        page,
        width,
        height,
        route=route,
        expected_label=expected_label,
    )
    page.evaluate(
        """({ padding, data }) => {
          const map = (window.__cityscrollShellMaps || []).at(-1);
          map?.getSource?.('geography-label-candidates')?.setData?.(data);
          map?.setLayoutProperty?.('geography-labels', 'text-padding', padding ?? 2);
        }""",
        {
            "padding": control_state["originalPadding"],
            "data": control_state["originalData"],
        },
    )
    page.wait_for_timeout(800)
    geometry = pressured.get("geometry") or {}
    if expected_label not in (pressured.get("selected_layer_rendered_labels") or []):
        raise AssertionError(
            f"A13 selected priority positive control dropped {expected_label!r}"
        )
    if geometry.get("collision_dropped_label_count", 0) < 1:
        raise AssertionError(
            "A13 selected priority positive control did not drop an ordinary neighboring label"
        )
    dropped = geometry.get("collision_dropped_labels_sample") or []
    if not dropped or not all(dropped):
        raise AssertionError("A13 selected priority control did not name an ordinary dropped label")
    return {
        "forced_text_padding_px": 160,
        "selected_label": expected_label,
        "selected_layer_rendered_labels": pressured.get("selected_layer_rendered_labels"),
        "surrounding_collision_source_label_count": geometry.get("collision_source_label_count"),
        "surrounding_placed_label_count": geometry.get("placed_label_count"),
        "ordinary_collision_dropped_label_count": geometry.get("collision_dropped_label_count"),
        "ordinary_collision_dropped_labels_sample": dropped,
    }


def observe_a9(page, width: int, height: int) -> dict:
    focus_js = focus_info_js()
    # Reset focus to body, then Tab through the page.
    page.evaluate("() => { document.activeElement?.blur?.(); document.body.focus?.(); }")
    order: list[dict] = []
    for _ in range(48):
        page.keyboard.press("Tab")
        info = page.evaluate(focus_js)
        order.append(info)

    first_map_at = next((index for index, row in enumerate(order) if row.get("in_map_region")), None)
    exit_map_at = None
    if first_map_at is not None:
        exit_map_at = next(
            (
                index
                for index in range(first_map_at + 1, len(order))
                if not order[index].get("in_map_region")
            ),
            None,
        )

    map_region_steps = []
    if first_map_at is not None:
        end = exit_map_at if exit_map_at is not None else len(order)
        map_region_steps = order[first_map_at:end]

    # Escape path: focus the map host, press Escape, then Tab out.
    page.locator("#near-map-enhanced").focus()
    on_map_before_escape = page.evaluate(focus_js)
    page.keyboard.press("Escape")
    after_escape = page.evaluate(focus_js)
    page.keyboard.press("Tab")
    after_escape_tab = page.evaluate(focus_js)

    # Continue Tab until we leave the map region (bounded).
    escape_exit = after_escape_tab
    escape_tabs_to_exit = 1 if not after_escape_tab.get("in_map_region") else None
    if after_escape_tab.get("in_map_region"):
        for step in range(2, 8):
            page.keyboard.press("Tab")
            escape_exit = page.evaluate(focus_js)
            if not escape_exit.get("in_map_region"):
                escape_tabs_to_exit = step
                break

    equivalents = page.evaluate(
        """() => {
          const host = document.querySelector('#near-map-enhanced');
          const labels = (host?.dataset?.renderedNeighborhoodLabels || '')
            .split(' | ').filter(Boolean);
          const areaLinks = [...document.querySelectorAll(
            '#near-area-list a[data-map-area], [data-geography-directory-list] a[data-map-area], a[data-map-area]'
          )];
          const linkTexts = areaLinks.map((node) => (node.textContent || '').trim());
          const withHref = areaLinks.filter((node) => Boolean(node.getAttribute('href')));
          const matched = labels.filter((label) =>
            linkTexts.some((text) => text === label || text.includes(label) || label.includes(text))
          );
          const titleOnly = [...document.querySelectorAll(
            '#near-you-root [title], [data-near-you-root] [title]'
          )].filter((node) => {
            const title = (node.getAttribute('title') || '').trim();
            if (!title) return false;
            const accessible = (node.getAttribute('aria-label') || node.textContent || '').trim();
            return !accessible;
          }).map((node) => ({
            tag: node.tagName,
            title: node.getAttribute('title'),
          }));
          return {
            rendered_label_count: labels.length,
            area_link_count: areaLinks.length,
            area_links_with_href: withHref.length,
            rendered_labels_with_directory_link: matched.length,
            title_only_instruction_count: titleOnly.length,
            title_only_instructions: titleOnly.slice(0, 8),
            map_host_tab_index: host?.tabIndex ?? null,
            map_canvas_tab_index: document.querySelector('.maplibregl-canvas')?.tabIndex ?? null,
            map_canvas_aria_label: document.querySelector('.maplibregl-canvas')?.getAttribute('aria-label'),
          };
        }"""
    )

    digest = {
        "viewport": {"width": width, "height": height},
        "first_map_focus_index": first_map_at,
        "exit_map_focus_index": exit_map_at,
        "escape_tabs_to_exit": escape_tabs_to_exit,
        "equivalents": equivalents,
    }
    return {
        "viewport": {"width": width, "height": height},
        "route": ENTRY_ROUTE,
        "focus_order": [
            {
                "index": index,
                "tag": row.get("tag"),
                "id": row.get("id"),
                "ariaLabel": row.get("ariaLabel"),
                "text": row.get("text"),
                "in_map_region": row.get("in_map_region"),
            }
            for index, row in enumerate(order[:32])
        ],
        "map_region_focus_steps": [
            {
                "tag": row.get("tag"),
                "id": row.get("id"),
                "ariaLabel": row.get("ariaLabel"),
                "text": row.get("text"),
            }
            for row in map_region_steps
        ],
        "first_map_focus_index": first_map_at,
        "first_map_focus": order[first_map_at] if first_map_at is not None else None,
        "exit_map_focus_index": exit_map_at,
        "exit_map_focus": order[exit_map_at] if exit_map_at is not None else None,
        "focus_trap_observed": first_map_at is not None and exit_map_at is None,
        "escape_path": {
            "before": on_map_before_escape,
            "after_escape": after_escape,
            "after_escape_tab": after_escape_tab,
            "exit_after_escape": escape_exit,
            "tabs_from_map_host_to_leave_region": escape_tabs_to_exit,
            "key_path": "Focus #near-map-enhanced → Escape (clears hover/focus ring) → Tab until focus leaves the map region",
        },
        "hover_equivalents": equivalents,
        "dom_sha256": sha256_text(json.dumps(digest, sort_keys=True, separators=(",", ":"))),
    }


def assert_letter_observations(
    a13_reads: list[dict],
    a9_reads: list[dict],
    *,
    require_selected_control_clearance: bool = True,
) -> None:
    all_city = [
        row for row in a13_reads
        if row.get("route") in (None, ENTRY_ROUTE) and not row.get("selected_neighborhood_label")
    ]
    by_width = {row["viewport"]["width"]: row for row in all_city}
    for name, width, _height, minimum, maximum in VIEWPORTS:
        row = by_width.get(width)
        if not row:
            raise AssertionError(f"A13 missing {name} observation")
        count = row.get("residential_neighborhood_label_count")
        if not isinstance(count, int) or not (minimum <= count <= maximum):
            raise AssertionError(
                f"A13 {name} label count {count} outside {minimum}–{maximum}"
            )
        if row.get("map_runtime") != "maplibre":
            raise AssertionError(f"A13 {name} runtime was {row.get('map_runtime')!r}")
        if row.get("text_allow_overlap") is not False:
            raise AssertionError(f"A13 {name} text-allow-overlap was {row.get('text_allow_overlap')!r}")
        if row.get("text_ignore_placement") is not False:
            raise AssertionError(
                f"A13 {name} text-ignore-placement was {row.get('text_ignore_placement')!r}"
            )
        geometry = row.get("geometry") or {}
        if geometry.get("measurement") != "maplibre-collisionIndex-grid-bboxes+getBoundingClientRect":
            raise AssertionError(f"A13 {name} missing real label-box geometry measurement")
        if not isinstance(geometry.get("measured_label_box_count"), int) or geometry["measured_label_box_count"] < 1:
            raise AssertionError(f"A13 {name} measured_label_box_count was {geometry.get('measured_label_box_count')!r}")
        # Overlap must come from box intersection, never the derived dataset flag.
        if geometry.get("overlapping_label_pair_count") != row.get("overlapping_label_pair_count"):
            raise AssertionError(
                f"A13 {name} overlapping_label_pair_count drifted from geometry measurement"
            )
        if row.get("overlapping_label_pair_count") != 0:
            raise AssertionError(
                f"A13 {name} overlapping_label_pair_count was {row.get('overlapping_label_pair_count')!r}"
            )
        source_count = geometry.get("collision_source_label_count")
        placed_count = geometry.get("placed_label_count")
        if not isinstance(source_count, int) or source_count < 1:
            raise AssertionError(f"A13 {name} collision source population was {source_count!r}")
        if not isinstance(placed_count, int) or placed_count < 1:
            raise AssertionError(f"A13 {name} placed label denominator was {placed_count!r}")
        if source_count != placed_count:
            raise AssertionError(
                f"A13 {name} source/placed populations differ: {source_count}/{placed_count}"
            )
        if geometry.get("collision_dropped_label_count") != 0:
            raise AssertionError(
                f"A13 {name} collision_dropped_label_count was "
                f"{geometry.get('collision_dropped_label_count')!r}"
            )
        if not isinstance(geometry.get("frame_crossing_label_count"), int):
            raise AssertionError(f"A13 {name} frame_crossing_label_count missing")
        frame_sample = geometry.get("frame_crossing_labels_sample") or []
        if geometry.get("frame_crossing_label_count", 0) > 0 and (
            not frame_sample or not all(frame_sample)
        ):
            raise AssertionError(f"A13 {name} frame-crossing sample did not name its labels")
        if not isinstance(geometry.get("obscured_by_primary_control_count"), int):
            raise AssertionError(f"A13 {name} obscured_by_primary_control_count missing")
        if geometry.get("control_occlusion_label_box_count") != geometry.get(
            "measured_label_box_count"
        ):
            raise AssertionError(f"A13 {name} control occlusion population drifted")
        if not isinstance(geometry.get("primary_control_box_count"), int) or geometry.get(
            "primary_control_box_count", 0
        ) < 1:
            raise AssertionError(f"A13 {name} primary control-box population was empty")
        if geometry.get("obscured_by_primary_control_count") != 0:
            raise AssertionError(
                f"A13 {name} obscured_by_primary_control_count was "
                f"{geometry.get('obscured_by_primary_control_count')!r}"
            )
        positive = row.get("positive_controls") or {}
        overlap_positive = positive.get("overlap") or {}
        if overlap_positive.get("overlapping_label_pair_count", 0) < 1:
            raise AssertionError(f"A13 {name} overlap positive control did not flip")
        overlap_sample = overlap_positive.get("overlapping_pairs_sample") or []
        if not overlap_sample or not all(all(pair) for pair in overlap_sample):
            raise AssertionError(f"A13 {name} overlap positive control labels missing")
        collision_positive = positive.get("collision_drop") or {}
        if collision_positive.get("collision_dropped_label_count", 0) < 1:
            raise AssertionError(f"A13 {name} collision positive control did not flip")
        if not all(collision_positive.get("collision_dropped_labels_sample") or []):
            raise AssertionError(f"A13 {name} collision positive control sample missing")
        control_positive = positive.get("control_occlusion") or {}
        if control_positive.get("label_box_count", 0) < 1:
            raise AssertionError(f"A13 {name} control positive population missing")
        if control_positive.get("obscured_by_primary_control_count", 0) < 1:
            raise AssertionError(f"A13 {name} control positive control did not flip")
        if not (control_positive.get("obscured_sample") or [{}])[0].get("label"):
            raise AssertionError(f"A13 {name} control positive control label missing")
        frame_positive = positive.get("frame_crossing") or {}
        if frame_positive.get("frame_crossing_label_count", 0) < 1:
            raise AssertionError(f"A13 {name} frame positive control did not flip")
        if frame_positive.get("moved_label") not in (
            frame_positive.get("frame_crossing_labels_sample") or []
        ):
            raise AssertionError(f"A13 {name} frame positive control label missing")
        # Receipts record observed values only — never a result/pass verdict field.
        for banned in ("result", "pass", "passed", "verdict"):
            if banned in row or banned in geometry:
                raise AssertionError(f"A13 {name} must not carry a {banned!r} field")

    selected_reads = [row for row in a13_reads if row.get("selected_neighborhood_label")]
    expected_pairs = {
        (specimen["expected_label"], width)
        for specimen in SELECTED_SPECIMENS
        for _name, width, _height, _minimum, _maximum in VIEWPORTS
    }
    observed_pairs = {
        (row.get("selected_neighborhood_label"), row.get("viewport", {}).get("width"))
        for row in selected_reads
    }
    if observed_pairs != expected_pairs:
        raise AssertionError(
            f"A13 selected-neighborhood coverage was {sorted(observed_pairs)!r}, "
            f"expected {sorted(expected_pairs)!r}"
        )
    for selected in selected_reads:
        expected = selected.get("selected_neighborhood_label")
        if expected not in (selected.get("selected_layer_rendered_labels") or []):
            raise AssertionError(
                f"A13 selected layer did not render {expected!r}: "
                f"{selected.get('selected_layer_rendered_labels')!r}"
            )
        if selected.get("selected_layer_rendered_label_count", 0) < 1:
            raise AssertionError("A13 selected layer rendered label count was zero")
        if selected.get("selected_ui_label") != expected and selected.get("selected_heading") != expected:
            raise AssertionError(
                f"A13 selected UI/heading missing {expected!r}: "
                f"ui={selected.get('selected_ui_label')!r} heading={selected.get('selected_heading')!r}"
            )
        geometry = selected.get("geometry") or {}
        if geometry.get("placed_label_count", 0) < 1:
            raise AssertionError(f"A13 selected {expected!r} has no surrounding label population")
        if require_selected_control_clearance:
            if geometry.get("control_occlusion_label_box_count", 0) < 1:
                raise AssertionError(f"A13 selected {expected!r} control population has no labels")
            if geometry.get("primary_control_box_count", 0) < 1:
                raise AssertionError(f"A13 selected {expected!r} primary control population was empty")
            if geometry.get("obscured_by_primary_control_count") != 0:
                raise AssertionError(
                    f"A13 selected {expected!r} obscured ordinary labels: "
                    f"{geometry.get('obscured_sample')!r}"
                )
            selected_control = selected.get("selected_name_control_occlusion") or {}
            if selected_control.get("label_box_count") != 1:
                raise AssertionError(f"A13 selected {expected!r} name box population was empty")
            if selected_control.get("primary_control_box_count", 0) < 1:
                raise AssertionError(f"A13 selected {expected!r} name control population was empty")
            if selected_control.get("obscured_by_primary_control_count") != 0:
                raise AssertionError(
                    f"A13 selected name {expected!r} was obscured: "
                    f"{selected_control.get('obscured_sample')!r}"
                )
            control_positive = selected.get("selected_control_occlusion_positive_control") or {}
            if control_positive.get("label_box_count", 0) < 1:
                raise AssertionError(f"A13 selected {expected!r} control positive population missing")
            if control_positive.get("primary_control_box_count", 0) < 1:
                raise AssertionError(f"A13 selected {expected!r} positive control population was empty")
            if control_positive.get("obscured_by_primary_control_count", 0) < 1:
                raise AssertionError(f"A13 selected {expected!r} control positive did not flip")
            if not (control_positive.get("obscured_sample") or [{}])[0].get("label"):
                raise AssertionError(f"A13 selected {expected!r} control positive label missing")
        priority = selected.get("selected_priority_positive_control") or {}
        if expected not in (priority.get("selected_layer_rendered_labels") or []):
            raise AssertionError(f"A13 selected priority control lost {expected!r}")
        if priority.get("ordinary_collision_dropped_label_count", 0) < 1:
            raise AssertionError(f"A13 selected priority control did not drop an ordinary label")
        if not all(priority.get("ordinary_collision_dropped_labels_sample") or []):
            raise AssertionError(f"A13 selected priority control sample missing")
        for banned in ("result", "pass", "passed", "verdict"):
            if banned in selected:
                raise AssertionError(f"A13 selected read must not carry a {banned!r} field")

    for read in a9_reads:
        width = read["viewport"]["width"]
        if read.get("focus_trap_observed"):
            raise AssertionError(f"A9 {width}px focus trap: never left the map region")
        if read.get("first_map_focus_index") is None:
            raise AssertionError(f"A9 {width}px never reached the map host")
        if read.get("exit_map_focus_index") is None:
            raise AssertionError(f"A9 {width}px never left the map region via Tab")
        escape = read.get("escape_path") or {}
        if escape.get("tabs_from_map_host_to_leave_region") is None:
            raise AssertionError(f"A9 {width}px Escape+Tab did not leave the map region")
        equiv = read.get("hover_equivalents") or {}
        if equiv.get("area_links_with_href", 0) < 1:
            raise AssertionError(f"A9 {width}px missing directory links as tap/keyboard equivalents")
        if equiv.get("title_only_instruction_count", 0) > 0:
            raise AssertionError(
                f"A9 {width}px hover-only title instructions without accessible name: "
                f"{equiv.get('title_only_instructions')}"
            )


def _open_near_you(
    browser,
    base: str,
    *,
    width: int,
    height: int,
    route: str,
    name: str,
    revision: str,
    capture_run_id: str,
):
    context = browser.new_context(
        viewport={"width": width, "height": height},
        user_agent="Mozilla/5.0 (compatible; CityScrollShellCapture/1.0)",
    )
    page = context.new_page()
    page.add_init_script(MAP_HOOK_INIT)
    response = page.goto(
        f"{normalize_base(base).rstrip('/')}{route}",
        wait_until="domcontentloaded",
        timeout=60000,
    )
    try:
        wait_for_enhanced_labels(page)
        # Placement finishes after the first idle; give CollisionIndex a beat to settle.
        page.wait_for_timeout(800)
    except Exception as error:  # noqa: BLE001
        diagnostics = page.evaluate(
            """() => ({
              runtime: document.querySelector('[data-near-you-root]')?.dataset?.nearMapRuntime || null,
              reason: document.querySelector('[data-near-you-root]')?.dataset?.nearMapRuntimeReason || null,
              host: {...(document.querySelector('#near-map-enhanced')?.dataset || {})},
              canvas: Boolean(document.querySelector('.maplibregl-canvas')),
            })"""
        )
        context.close()
        raise AssertionError(f"{name}: enhanced labels missing: {diagnostics}") from error
    receipt = request_receipt(
        base=base,
        response=response,
        expected_revision=revision,
        capture_run_id=capture_run_id,
        request_id=f"near-you-{name}",
    )
    return context, page, receipt


def capture_viewport(
    browser,
    base: str,
    rev: str,
    capture_run_id: str,
    name: str,
    width: int,
    height: int,
) -> tuple[dict, dict]:
    context, page, receipt = _open_near_you(
        browser,
        base,
        width=width,
        height=height,
        route=ENTRY_ROUTE,
        name=name,
        revision=rev,
        capture_run_id=capture_run_id,
    )

    a13 = observe_a13(page, width, height, route=ENTRY_ROUTE)
    a13["name"] = f"a13-{name}"
    a13["revision"] = rev
    a13["data_vintage"] = DATA_VINTAGE
    a13["request_receipt"] = receipt
    a13["positive_controls"] = exercise_a13_positive_controls(
        page, width, height, route=ENTRY_ROUTE
    )

    a9 = observe_a9(page, width, height)
    a9["name"] = f"a9-{name}"
    a9["revision"] = rev
    a9["data_vintage"] = DATA_VINTAGE
    a9["request_receipt"] = receipt

    SCRATCH.mkdir(parents=True, exist_ok=True)
    page.screenshot(
        path=str(SCRATCH / f"shell-{name}-{width}x{height}.png"),
        full_page=False,
        animations="disabled",
    )
    context.close()
    return a13, a9


def capture_selected(
    browser,
    base: str,
    rev: str,
    capture_run_id: str | None,
    specimen: dict,
    *,
    width: int,
    height: int,
    served_receipts: bool = True,
) -> dict:
    capture_name = f"selected-{specimen['name']}-{width}"
    if served_receipts:
        if not capture_run_id:
            raise ValueError("capture_run_id is required for a served-origin selected read")
        context, page, receipt = _open_near_you(
            browser,
            base,
            width=width,
            height=height,
            route=specimen["route"],
            name=capture_name,
            revision=rev,
            capture_run_id=capture_run_id,
        )
    else:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.add_init_script(MAP_HOOK_INIT)
        page.goto(
            f"{normalize_base(base).rstrip('/')}{specimen['route']}",
            wait_until="domcontentloaded",
            timeout=60000,
        )
        wait_for_enhanced_labels(page)
        page.wait_for_timeout(800)
        receipt = None
    # Selected routes can show zero ordinary labels while the camera flies;
    # wait until the selected layer or UI label is present.
    page.wait_for_function(
        """(expected) => {
          const ui = (document.querySelector('[data-geography-selected-label]')?.textContent || '').trim();
          const heading = (document.querySelector('#near-geo-heading, .near-geo-entry h1, .near-hero h1')?.textContent || '').trim();
          const maps = window.__cityscrollShellMaps || [];
          const map = maps.length ? maps[maps.length - 1] : null;
          let layer = [];
          try {
            layer = map?.queryRenderedFeatures?.(undefined, { layers: ['geography-selected-label'] }) || [];
          } catch (_error) { layer = []; }
          const names = layer.map((f) => String(f?.properties?.label || '').trim());
          return ui === expected || heading === expected || names.includes(expected);
        }""",
        arg=specimen["expected_label"],
        timeout=25000,
    )
    page.wait_for_timeout(600)
    a13 = observe_a13_selected(
        page,
        width,
        height,
        route=specimen["route"],
        expected_label=specimen["expected_label"],
    )
    a13["name"] = f"a13-{capture_name}"
    a13["revision"] = rev
    a13["data_vintage"] = DATA_VINTAGE
    if receipt is not None:
        a13["request_receipt"] = receipt
    a13["selected_priority_positive_control"] = exercise_selected_priority_positive_control(
        page,
        width,
        height,
        route=specimen["route"],
        expected_label=specimen["expected_label"],
    )
    a13["selected_control_occlusion_positive_control"] = (
        exercise_selected_control_occlusion_positive_control(
            page,
            width,
            height,
            route=specimen["route"],
        )
    )
    SCRATCH.mkdir(parents=True, exist_ok=True)
    page.screenshot(
        path=str(SCRATCH / f"shell-{capture_name}-{width}x{height}.png"),
        full_page=False,
        animations="disabled",
    )
    context.close()
    return a13


def capture() -> dict:
    base = resolve_base()
    capture_run_id = str(uuid.uuid4())
    run_started_at = now_iso()
    artifact, initial_manifest_receipt = read_artifact_manifest(base)
    rev = deployed_revision(artifact)
    resolve_landed_ancestor(REQUIRED_ANCESTOR, cwd=ROOT)
    if not revision_contains_ancestor(REQUIRED_ANCESTOR, rev, cwd=ROOT):
        raise RuntimeError(
            f"served page revision {rev} does not contain required ancestor "
            f"{REQUIRED_ANCESTOR}; wait for the instrumented Pages deployment"
        )
    generated_at = artifact.get("generated_at")
    observed_at = run_started_at
    print(
        f"production base={base} revision={rev} generated_at={generated_at} "
        f"capture_run_id={capture_run_id}",
        flush=True,
    )

    a13_reads: list[dict] = []
    a9_reads: list[dict] = []
    a13_selected: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=list(WEBGL_BROWSER_ARGS))
        for name, width, height, _minimum, _maximum in VIEWPORTS:
            print(f"capture {name} {width}x{height}", flush=True)
            a13, a9 = capture_viewport(
                browser, base, rev, capture_run_id, name, width, height
            )
            a13_reads.append(a13)
            a9_reads.append(a9)
            geometry = a13.get("geometry") or {}
            print(
                f"  A13 count={a13['residential_neighborhood_label_count']} "
                f"overlap={a13['overlapping_label_pair_count']} "
                f"dropped={geometry.get('collision_dropped_label_count')} "
                f"frame-crossing={geometry.get('frame_crossing_label_count')} "
                f"obscured={geometry.get('obscured_by_primary_control_count')} "
                f"allowOverlap={a13['text_allow_overlap']}",
                flush=True,
            )
            print(
                f"  A9 map@{a9['first_map_focus_index']} exit@{a9['exit_map_focus_index']} "
                f"trap={a9['focus_trap_observed']}",
                flush=True,
            )
        for specimen in SELECTED_SPECIMENS:
            for viewport_name, width, height, _minimum, _maximum in VIEWPORTS:
                print(
                    f"capture selected {specimen['name']} {viewport_name} "
                    f"{width}x{height} {specimen['route']}",
                    flush=True,
                )
                selected_read = capture_selected(
                    browser,
                    base,
                    rev,
                    capture_run_id,
                    specimen,
                    width=width,
                    height=height,
                )
                a13_selected.append(selected_read)
                a13_reads.append(selected_read)
                print(
                    f"  A13 selected={selected_read.get('selected_layer_rendered_labels')} "
                    f"surrounding={selected_read.get('geometry', {}).get('placed_label_count')} "
                    f"ui={selected_read.get('selected_ui_label')!r}",
                    flush=True,
                )
        browser.close()

    assert_letter_observations(a13_reads, a9_reads)
    _final_artifact, final_manifest_receipt = read_artifact_manifest(base)
    if final_manifest_receipt["served_revision"] != rev:
        raise AssertionError(
            "served revision changed before capture completion: "
            f"{final_manifest_receipt['served_revision']} != {rev}"
        )
    request_ids = {
        row["request_receipt"]["request_id"]
        for row in a13_reads
    }
    run_receipt = {
        "capture_run_id": capture_run_id,
        "run_started_at": run_started_at,
        "run_finished_at": now_iso(),
        "served_revision": rev,
        "request_count": len(request_ids),
        "initial_served_manifest": initial_manifest_receipt,
        "final_served_manifest": final_manifest_receipt,
    }

    receipt = {
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
        },
        "capture_run_id": capture_run_id,
        "run_receipt": run_receipt,
        "capture": {
            "tool": "tools/capture_near_you_shell_production_read.py",
            "browser": "chromium",
            "viewports": [
                {"name": name, "width": width, "height": height}
                for name, width, height, _minimum, _maximum in VIEWPORTS
            ] + [
                {
                    "name": f"selected-{specimen['name']}-{name}",
                    "width": width,
                    "height": height,
                    "route": specimen["route"],
                }
                for specimen in SELECTED_SPECIMENS
                for name, width, height, _minimum, _maximum in VIEWPORTS
            ],
            "screenshot_binaries_committed": False,
            "selected_control_clearance_contract": 1,
            "map_hook": (
                "Init script wraps window.maplibregl.Map; A13 geometry reads "
                "CollisionIndex grid bboxes via getBoundingClientRect."
            ),
        },
        "producer": {
            "path": "docs/evidence/near-you-shell-readback/read-back.json",
            "schema": SCHEMA,
            "letters": ["A9", "A13"],
        },
        "letters": {
            "A9": {
                "route": ENTRY_ROUTE,
                "reads": a9_reads,
            },
            "A13": {
                "route": ENTRY_ROUTE,
                "budgets": {
                    "desktop_1440x900": {"min": 12, "max": 40},
                    "mobile_390x844": {"min": 6, "max": 20},
                },
                "selected_specimens": [
                    {
                        "route": specimen["route"],
                        "label": specimen["expected_label"],
                        "geo": specimen["geo"],
                    }
                    for specimen in SELECTED_SPECIMENS
                ],
                "reads": a13_reads,
            },
        },
    }
    return receipt


def build_manifest(receipt: dict) -> dict:
    rev = receipt["deployment"]["revision"]
    captures = []
    for read in receipt["letters"]["A13"]["reads"]:
        geometry = read.get("geometry") or {}
        is_selected = bool(read.get("selected_neighborhood_label"))
        if is_selected:
            assertion = (
                f"Selected neighborhood {read.get('selected_neighborhood_label')!r} rendered "
                f"on {read.get('route')} at {read['viewport']['width']}x{read['viewport']['height']} "
                f"(layer labels={read.get('selected_layer_rendered_labels')}, "
                f"surrounding placed labels={geometry.get('placed_label_count')}, "
                f"ui={read.get('selected_ui_label')!r}); the forced-collision control retained "
                "the selected label while dropping an ordinary label."
            )
            observed = {
                "selected_neighborhood_label": read.get("selected_neighborhood_label"),
                "selected_ui_label": read.get("selected_ui_label"),
                "selected_heading": read.get("selected_heading"),
                "selected_layer_rendered_label_count": read.get("selected_layer_rendered_label_count"),
                "selected_layer_rendered_labels": read.get("selected_layer_rendered_labels"),
                "selected_name_box": read.get("selected_name_box"),
                "surrounding_placed_label_count": geometry.get("placed_label_count"),
                "selected_priority_positive_control": read.get(
                    "selected_priority_positive_control"
                ),
                "map_runtime": read.get("map_runtime"),
            }
            digest = {
                "selected": read.get("selected_neighborhood_label"),
                "layer": read.get("selected_layer_rendered_labels"),
                "ui": read.get("selected_ui_label"),
                "surrounding": geometry.get("placed_label_count"),
                "priority_control": read.get("selected_priority_positive_control"),
            }
            if "selected_name_control_occlusion" in read:
                assertion += (
                    " No ordinary or selected label was obscured by a primary control "
                    f"across {geometry.get('control_occlusion_label_box_count')} ordinary "
                    "label boxes and one selected-name box; the selected-view control "
                    "positive control reported a named obscured label."
                )
                observed.update({
                    "geometry": {
                        "control_occlusion_label_box_count": geometry.get(
                            "control_occlusion_label_box_count"
                        ),
                        "primary_control_box_count": geometry.get("primary_control_box_count"),
                        "obscured_by_primary_control_count": geometry.get(
                            "obscured_by_primary_control_count"
                        ),
                        "obscured_sample": geometry.get("obscured_sample"),
                    },
                    "selected_name_control_occlusion": read.get(
                        "selected_name_control_occlusion"
                    ),
                    "selected_control_occlusion_positive_control": read.get(
                        "selected_control_occlusion_positive_control"
                    ),
                })
                digest.update({
                    "control_clearance": observed["geometry"],
                    "selected_name_control_occlusion": read.get(
                        "selected_name_control_occlusion"
                    ),
                    "control_positive": read.get(
                        "selected_control_occlusion_positive_control"
                    ),
                })
            mode = "headless-playwright-production-selected"
            route = read.get("route") or ENTRY_ROUTE
        else:
            assertion = (
                f"Observed {read['residential_neighborhood_label_count']} residential "
                f"neighborhood labels at {read['viewport']['width']}x{read['viewport']['height']} "
                f"with text-allow-overlap={read['text_allow_overlap']}; geometry "
                f"overlapping_label_pair_count={geometry.get('overlapping_label_pair_count')}, "
                f"collision_dropped_label_count={geometry.get('collision_dropped_label_count')} "
                f"across {geometry.get('placed_label_count')} placed labels, "
                f"frame_crossing_label_count={geometry.get('frame_crossing_label_count')} (permitted), "
                f"obscured_by_primary_control_count={geometry.get('obscured_by_primary_control_count')} "
                f"across {geometry.get('control_occlusion_label_box_count')} label boxes "
                f"via {geometry.get('measurement')}."
            )
            observed = {
                "residential_neighborhood_label_count": read["residential_neighborhood_label_count"],
                "residential_neighborhood_labels": read["residential_neighborhood_labels"],
                "overlapping_label_pair_count": read["overlapping_label_pair_count"],
                "text_allow_overlap": read["text_allow_overlap"],
                "text_ignore_placement": read["text_ignore_placement"],
                "map_runtime": read["map_runtime"],
                "geometry": {
                    "measurement": geometry.get("measurement"),
                    "measured_label_box_count": geometry.get("measured_label_box_count"),
                    "overlapping_label_pair_count": geometry.get("overlapping_label_pair_count"),
                    "collision_source_label_count": geometry.get("collision_source_label_count"),
                    "placed_label_count": geometry.get("placed_label_count"),
                    "collision_dropped_label_count": geometry.get(
                        "collision_dropped_label_count"
                    ),
                    "collision_dropped_labels_sample": geometry.get(
                        "collision_dropped_labels_sample"
                    ),
                    "frame_crossing_label_count": geometry.get("frame_crossing_label_count"),
                    "frame_crossing_labels_sample": geometry.get(
                        "frame_crossing_labels_sample"
                    ),
                    "obscured_by_primary_control_count": geometry.get(
                        "obscured_by_primary_control_count"
                    ),
                    "control_occlusion_label_box_count": geometry.get(
                        "control_occlusion_label_box_count"
                    ),
                    "primary_control_box_count": geometry.get("primary_control_box_count"),
                    "clip_surface": geometry.get("clip_surface"),
                },
                "positive_controls": read.get("positive_controls"),
            }
            digest = {
                "count": read["residential_neighborhood_label_count"],
                "labels": read["residential_neighborhood_labels"],
                "overlap": geometry.get("overlapping_label_pair_count"),
                "source": geometry.get("collision_source_label_count"),
                "placed": geometry.get("placed_label_count"),
                "dropped": geometry.get("collision_dropped_label_count"),
                "frame_crossing": geometry.get("frame_crossing_label_count"),
                "obscured": geometry.get("obscured_by_primary_control_count"),
                "positive_controls": read.get("positive_controls"),
                "allow": read["text_allow_overlap"],
            }
            mode = "headless-playwright-production-enhanced"
            route = ENTRY_ROUTE
        captures.append(
            {
                "name": read["name"],
                "route": route,
                "mode": mode,
                "viewport": read["viewport"],
                "revision": rev,
                "data_vintage": DATA_VINTAGE,
                "assertion": assertion,
                "sha256": sha256_text(
                    json.dumps(digest, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
                ),
                "file": None,
                "observed": observed,
                "request_receipt": read.get("request_receipt"),
            }
        )
    for read in receipt["letters"]["A9"]["reads"]:
        captures.append(
            {
                "name": read["name"],
                "route": ENTRY_ROUTE,
                "mode": "headless-playwright-production-keyboard",
                "viewport": read["viewport"],
                "revision": rev,
                "data_vintage": DATA_VINTAGE,
                "assertion": (
                    f"Focus reached the map at index {read['first_map_focus_index']} and left at "
                    f"index {read['exit_map_focus_index']}; Escape+Tab left the map region in "
                    f"{read['escape_path']['tabs_from_map_host_to_leave_region']} Tab step(s); "
                    "directory links provide keyboard/tap equivalents for neighborhood names."
                ),
                "sha256": read["dom_sha256"],
                "file": None,
                "request_receipt": read.get("request_receipt"),
                "observed": {
                    "first_map_focus_index": read["first_map_focus_index"],
                    "exit_map_focus_index": read["exit_map_focus_index"],
                    "focus_trap_observed": read["focus_trap_observed"],
                    "map_region_focus_steps": read["map_region_focus_steps"],
                    "escape_path_key": read["escape_path"]["key_path"],
                    "tabs_from_map_host_to_leave_region": read["escape_path"][
                        "tabs_from_map_host_to_leave_region"
                    ],
                    "area_links_with_href": read["hover_equivalents"]["area_links_with_href"],
                    "title_only_instruction_count": read["hover_equivalents"][
                        "title_only_instruction_count"
                    ],
                },
            }
        )
    return {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "near-you-shell-readback",
        "public_alias": PUBLIC_ALIAS,
        "surface": "Near You map-first shell",
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
        "data_vintage": DATA_VINTAGE,
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots may exist under the local task scratch directory; "
            "only this manifest is committed."
        ),
        "producer": receipt["producer"],
        "capture_run_id": receipt["capture_run_id"],
        "run_receipt": receipt["run_receipt"],
        "captures": captures,
    }


def parse_timestamp(value: object, *, label: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise AssertionError(f"{label} missing")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise AssertionError(f"{label} is not an ISO timestamp: {value!r}") from error


def validate_manifest_read(
    read: object,
    *,
    revision: str,
    label: str,
    run_started_at: datetime | None = None,
    run_finished_at: datetime | None = None,
) -> None:
    if not isinstance(read, dict):
        raise AssertionError(f"{label} missing")
    if read.get("http_status") != 200:
        raise AssertionError(f"{label} status was {read.get('http_status')!r}")
    if read.get("served_revision") != revision:
        raise AssertionError(
            f"{label} served revision mismatch: {read.get('served_revision')!r} != {revision}"
        )
    if not str(read.get("url") or "").endswith(ARTIFACT_MANIFEST_PATH):
        raise AssertionError(f"{label} URL was {read.get('url')!r}")
    if not re.fullmatch(r"[0-9a-f]{64}", str(read.get("payload_sha256") or "")):
        raise AssertionError(f"{label} payload_sha256 missing")
    requested_at = parse_timestamp(read.get("requested_at"), label=f"{label} requested_at")
    responded_at = parse_timestamp(read.get("responded_at"), label=f"{label} responded_at")
    if responded_at < requested_at:
        raise AssertionError(f"{label} response precedes request")
    if run_started_at is not None and run_finished_at is not None and (
        requested_at < run_started_at or responded_at > run_finished_at
    ):
        raise AssertionError(f"{label} falls outside the capture run window")
    headers = read.get("headers") or {}
    if not headers.get("date"):
        raise AssertionError(f"{label} Date header missing")
    if not re.fullmatch(r"[0-9a-f]{16}-[A-Z0-9]{2,4}", str(headers.get("cf-ray") or "")):
        raise AssertionError(f"{label} CF-Ray header missing")


def validate_request_receipt(
    value: object,
    *,
    capture_run_id: str,
    revision: str,
    run_started_at: datetime,
    run_finished_at: datetime,
    label: str,
) -> str:
    if not isinstance(value, dict):
        raise AssertionError(f"{label} request_receipt missing")
    if value.get("capture_run_id") != capture_run_id:
        raise AssertionError(f"{label} request_receipt capture_run_id mismatch")
    request_id = value.get("request_id")
    if not isinstance(request_id, str) or not request_id.startswith("near-you-"):
        raise AssertionError(f"{label} request_receipt request_id missing")
    observed_at = parse_timestamp(
        value.get("observed_at"), label=f"{label} request_receipt observed_at"
    )
    if observed_at < run_started_at or observed_at > run_finished_at:
        raise AssertionError(f"{label} request_receipt observed_at outside run window")
    page_load = value.get("page_load") or {}
    if page_load.get("http_status") != 200:
        raise AssertionError(f"{label} page load status was {page_load.get('http_status')!r}")
    if not str(page_load.get("url") or "").startswith("https://cityscroll.org/near-you/"):
        raise AssertionError(f"{label} page load URL was {page_load.get('url')!r}")
    page_headers = page_load.get("headers") or {}
    if not page_headers.get("date"):
        raise AssertionError(f"{label} page load Date header missing")
    if not re.fullmatch(
        r"[0-9a-f]{16}-[A-Z0-9]{2,4}", str(page_headers.get("cf-ray") or "")
    ):
        raise AssertionError(f"{label} page load CF-Ray header missing")
    validate_manifest_read(
        value.get("served_manifest_read"),
        revision=revision,
        label=f"{label} served_manifest_read",
        run_started_at=run_started_at,
        run_finished_at=run_finished_at,
    )
    return request_id


def validate(receipt: dict) -> None:
    if receipt.get("schema") != SCHEMA:
        raise AssertionError(f"unexpected schema {receipt.get('schema')}")
    if receipt.get("public_alias") != PUBLIC_ALIAS:
        raise AssertionError("public_alias mismatch")
    deployment = receipt.get("deployment") or {}
    revision = deployment.get("revision") or ""
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise AssertionError("deployment.revision must be a 40-hex served SHA")
    if deployment.get("required_ancestor") != REQUIRED_ANCESTOR:
        raise AssertionError("deployment.required_ancestor mismatch")
    if deployment.get("required_ancestor_contained") is not True:
        raise AssertionError("deployment.required_ancestor_contained must be true")
    capture_run_id = receipt.get("capture_run_id")
    if not isinstance(capture_run_id, str) or not capture_run_id:
        raise AssertionError("capture_run_id missing")
    run_receipt = receipt.get("run_receipt") or {}
    if run_receipt.get("capture_run_id") != capture_run_id:
        raise AssertionError("run_receipt capture_run_id mismatch")
    if run_receipt.get("served_revision") != revision:
        raise AssertionError("run_receipt served_revision mismatch")
    run_started_at = parse_timestamp(
        run_receipt.get("run_started_at"), label="run_receipt.run_started_at"
    )
    run_finished_at = parse_timestamp(
        run_receipt.get("run_finished_at"), label="run_receipt.run_finished_at"
    )
    if run_finished_at < run_started_at:
        raise AssertionError("run_receipt run window is reversed")
    validate_manifest_read(
        run_receipt.get("initial_served_manifest"),
        revision=revision,
        label="initial served manifest read",
        run_started_at=run_started_at,
        run_finished_at=run_finished_at,
    )
    validate_manifest_read(
        run_receipt.get("final_served_manifest"),
        revision=revision,
        label="final served manifest read",
        run_started_at=run_started_at,
        run_finished_at=run_finished_at,
    )
    for banned in ("result", "pass", "passed", "verdict"):
        if banned in receipt:
            raise AssertionError(f"receipt must not carry a {banned!r} field")
    a13 = ((receipt.get("letters") or {}).get("A13") or {}).get("reads") or []
    a9 = ((receipt.get("letters") or {}).get("A9") or {}).get("reads") or []
    selected = [row for row in a13 if row.get("selected_neighborhood_label")]
    all_city = [row for row in a13 if not row.get("selected_neighborhood_label")]
    if len(all_city) < 2 or len(a9) < 2:
        raise AssertionError("missing A9/A13 viewport observations")
    current_contract = all(
        "collision_dropped_label_count" in (row.get("geometry") or {})
        for row in all_city
    )
    if current_contract:
        if len(selected) != len(SELECTED_SPECIMENS) * len(VIEWPORTS):
            raise AssertionError("missing A13 selected-neighborhood viewport observations")
        selected_control_contract = (
            (receipt.get("capture") or {}).get("selected_control_clearance_contract") == 1
        )
        assert_letter_observations(
            a13,
            a9,
            require_selected_control_clearance=selected_control_contract,
        )
        a13_request_ids = {
            validate_request_receipt(
                row.get("request_receipt"),
                capture_run_id=capture_run_id,
                revision=revision,
                run_started_at=run_started_at,
                run_finished_at=run_finished_at,
                label=row.get("name") or "A13 row",
            )
            for row in a13
        }
        if len(a13_request_ids) != len(all_city) + len(selected):
            raise AssertionError("A13 rows do not carry one distinct receipt per page request")
        if run_receipt.get("request_count") != len(a13_request_ids):
            raise AssertionError("run_receipt request_count drift")
        a9_request_ids = {
            validate_request_receipt(
                row.get("request_receipt"),
                capture_run_id=capture_run_id,
                revision=revision,
                run_started_at=run_started_at,
                run_finished_at=run_finished_at,
                label=row.get("name") or "A9 row",
            )
            for row in a9
        }
        if not a9_request_ids.issubset(a13_request_ids):
            raise AssertionError("A9 rows do not reference their shared page request receipts")
    else:
        # Historical deployed packets remain checkable until a release carrying
        # the candidate-label source can replace them. Current branch evidence
        # is retained by capture_geography_navigation.py --case shell.
        if len(selected) < 1:
            raise AssertionError("historical packet lacks its selected-neighborhood observation")
        for row in all_city:
            geometry = row.get("geometry") or {}
            if row.get("map_runtime") != "maplibre":
                raise AssertionError("historical A13 packet lacks MapLibre runtime evidence")
            if geometry.get("measurement") != "maplibre-collisionIndex-grid-bboxes+getBoundingClientRect":
                raise AssertionError("historical A13 packet lacks collision geometry")
    producer = receipt.get("producer") or {}
    if producer.get("path") != "docs/evidence/near-you-shell-readback/read-back.json":
        raise AssertionError("producer path mismatch")
    if producer.get("letters") != ["A9", "A13"]:
        raise AssertionError("producer letters mismatch")


def check() -> None:
    receipt = json.loads(READBACK.read_text(encoding="utf-8"))
    validate(receipt)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("public_alias") != PUBLIC_ALIAS:
        raise AssertionError("capture-manifest public_alias mismatch")
    if manifest.get("revision") != receipt["deployment"]["revision"]:
        raise AssertionError("capture-manifest revision drift")
    if manifest.get("producer", {}).get("letters") != ["A9", "A13"]:
        raise AssertionError("capture-manifest producer letters mismatch")
    if manifest != build_manifest(receipt):
        raise AssertionError("capture-manifest does not match the retained read-back")
    print(f"near-you-shell production read-back check passed: {READBACK.relative_to(ROOT)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return 0
    receipt = capture()
    validate(receipt)
    write_json(READBACK, receipt)
    write_json(MANIFEST, build_manifest(receipt))
    print(f"wrote {READBACK.relative_to(ROOT)}", flush=True)
    print(f"wrote {MANIFEST.relative_to(ROOT)}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(exc, file=sys.stderr)
        raise
