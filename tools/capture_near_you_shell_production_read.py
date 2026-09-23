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
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "near-you-shell-production-read"
OUT_DIR = ROOT / "docs/evidence/near-you-shell-readback"
READBACK = OUT_DIR / "read-back.json"
MANIFEST = OUT_DIR / "capture-manifest.json"

PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
ARTIFACT_MANIFEST_PATH = "/artifact-manifest.json"
ARTIFACT_UA = "cityscroll-near-you-shell-capture/1"
DEFAULT_BASE = "https://cityscroll.org/"
PUBLIC_ALIAS = "ced62a84f8213"
SCHEMA = "cityscroll.near_you_shell_production_read.v1"
DATA_VINTAGE = "nta2020 26B"
ENTRY_ROUTE = "/near-you/"

VIEWPORTS = (
    ("desktop", 1440, 900, 12, 40),
    ("mobile", 390, 844, 6, 20),
)

# Selected-neighborhood specimen for the A13 name-renders clause.
SELECTED_SPECIMEN = {
    "name": "selected-desktop",
    "width": 1440,
    "height": 900,
    "route": "/near-you/?geo=nta2020%3ABK0101&surface=map",
    "expected_label": "Greenpoint",
    "geo": "nta2020:BK0101",
}

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
          if (map && typeof map.getLayoutProperty === 'function') {
            try {
              textAllowOverlap = map.getLayoutProperty('geography-labels', 'text-allow-overlap');
              textIgnorePlacement = map.getLayoutProperty('geography-labels', 'text-ignore-placement');
            } catch (_error) { /* keep dataset values */ }
            try {
              const features = map.queryRenderedFeatures(undefined, { layers: ['geography-labels'] }) || [];
              queriedUnique = [...new Set(features
                .map((feature) => String(feature?.properties?.label || '').trim())
                .filter(Boolean))].length;
            } catch (_error) {
              queriedUnique = null;
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
            clipped_label_count: null,
            obscured_by_primary_control_count: null,
            clip_surface: 'map_host_canvas_and_overflow_hidden_ancestors',
            primary_control_box_count: 0,
            overlapping_pairs_sample: [],
            clipped_labels_sample: [],
            obscured_sample: [],
            dataset_overlap_flag_ignored: host?.dataset?.overlappingNeighborhoodLabelCount ?? null,
          };

          if (map && host) {
            const canvas = map.getCanvas();
            const canvasRect = canvas.getBoundingClientRect();
            const hostRect = host.getBoundingClientRect();
            const placement = map.painter?.placement || map.style?.placement;
            const raw = placement?.collisionIndex?.grid?.bboxes;
            if (raw && raw.length >= 4) {
              const mapBoxes = [];
              for (let i = 0; i + 3 < raw.length; i += 4) {
                mapBoxes.push({
                  x1: raw[i], y1: raw[i + 1], x2: raw[i + 2], y2: raw[i + 3],
                });
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
                const cx = (mb.x1 + mb.x2) / 2;
                const cy = (mb.y1 + mb.y2) / 2;
                let label = null;
                try {
                  const feats = map.queryRenderedFeatures([cx, cy], { layers: ['geography-labels'] }) || [];
                  label = feats.map((f) => String(f.properties?.label || '').trim()).find(Boolean) || null;
                } catch (_error) { /* leave null */ }
                labelBoxes.push({
                  label,
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
              geometry.clipped_label_count = clippedRows.length;
              geometry.obscured_by_primary_control_count = obscured;
              geometry.primary_control_box_count = controlBoxes.length;
              geometry.overlapping_pairs_sample = overlappingSample;
              geometry.clipped_labels_sample = clippedRows.slice(0, 12).map((row) => row.label);
              geometry.obscured_sample = obscuredSample;
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
          return {
            selected_neighborhood_label: expectedLabel,
            selected_ui_label: uiLabel,
            selected_heading: heading,
            selected_layer_rendered_label_count: layerLabels.length,
            selected_layer_rendered_labels: layerLabels,
            selected_name_box,
            map_runtime: document.querySelector('[data-near-you-root]')?.dataset?.nearMapRuntime || null,
            map_instance_hooked: Boolean(map),
            host_present: Boolean(host),
          };
        }""",
        {"expectedLabel": expected_label},
    )
    base.update(selected)
    base["name"] = f"a13-{SELECTED_SPECIMEN['name']}"
    return base


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
    a13_selected: dict | None = None,
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
        if not isinstance(geometry.get("clipped_label_count"), int):
            raise AssertionError(f"A13 {name} clipped_label_count missing")
        if not isinstance(geometry.get("obscured_by_primary_control_count"), int):
            raise AssertionError(f"A13 {name} obscured_by_primary_control_count missing")
        if geometry.get("obscured_by_primary_control_count") != 0:
            raise AssertionError(
                f"A13 {name} obscured_by_primary_control_count was "
                f"{geometry.get('obscured_by_primary_control_count')!r}"
            )
        # Receipts record observed values only — never a result/pass verdict field.
        for banned in ("result", "pass", "passed", "verdict"):
            if banned in row or banned in geometry:
                raise AssertionError(f"A13 {name} must not carry a {banned!r} field")

    selected = a13_selected
    if selected is None:
        selected = next((row for row in a13_reads if row.get("selected_neighborhood_label")), None)
    if not selected:
        raise AssertionError("A13 missing selected-neighborhood observation")
    expected = SELECTED_SPECIMEN["expected_label"]
    if selected.get("selected_neighborhood_label") != expected:
        raise AssertionError(
            f"A13 selected label specimen was {selected.get('selected_neighborhood_label')!r}"
        )
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


def _open_near_you(browser, base: str, *, width: int, height: int, route: str, name: str):
    context = browser.new_context(
        viewport={"width": width, "height": height},
        user_agent="Mozilla/5.0 (compatible; CityScrollShellCapture/1.0)",
    )
    page = context.new_page()
    page.add_init_script(MAP_HOOK_INIT)
    page.goto(
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
    return context, page


def capture_viewport(browser, base: str, rev: str, name: str, width: int, height: int) -> tuple[dict, dict]:
    context, page = _open_near_you(
        browser, base, width=width, height=height, route=ENTRY_ROUTE, name=name
    )

    a13 = observe_a13(page, width, height, route=ENTRY_ROUTE)
    a13["name"] = f"a13-{name}"
    a13["revision"] = rev
    a13["data_vintage"] = DATA_VINTAGE

    a9 = observe_a9(page, width, height)
    a9["name"] = f"a9-{name}"
    a9["revision"] = rev
    a9["data_vintage"] = DATA_VINTAGE

    SCRATCH.mkdir(parents=True, exist_ok=True)
    page.screenshot(
        path=str(SCRATCH / f"shell-{name}-{width}x{height}.png"),
        full_page=False,
        animations="disabled",
    )
    context.close()
    return a13, a9


def capture_selected(browser, base: str, rev: str) -> dict:
    specimen = SELECTED_SPECIMEN
    context, page = _open_near_you(
        browser,
        base,
        width=specimen["width"],
        height=specimen["height"],
        route=specimen["route"],
        name=specimen["name"],
    )
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
        specimen["width"],
        specimen["height"],
        route=specimen["route"],
        expected_label=specimen["expected_label"],
    )
    a13["revision"] = rev
    a13["data_vintage"] = DATA_VINTAGE
    SCRATCH.mkdir(parents=True, exist_ok=True)
    page.screenshot(
        path=str(SCRATCH / f"shell-{specimen['name']}-{specimen['width']}x{specimen['height']}.png"),
        full_page=False,
        animations="disabled",
    )
    context.close()
    return a13


def capture() -> dict:
    base = resolve_base()
    artifact = read_artifact_manifest(base)
    rev = deployed_revision(artifact)
    generated_at = artifact.get("generated_at")
    observed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    print(f"production base={base} revision={rev} generated_at={generated_at}", flush=True)

    a13_reads: list[dict] = []
    a9_reads: list[dict] = []
    a13_selected: dict | None = None
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=list(WEBGL_BROWSER_ARGS))
        for name, width, height, _minimum, _maximum in VIEWPORTS:
            print(f"capture {name} {width}x{height}", flush=True)
            a13, a9 = capture_viewport(browser, base, rev, name, width, height)
            a13_reads.append(a13)
            a9_reads.append(a9)
            geometry = a13.get("geometry") or {}
            print(
                f"  A13 count={a13['residential_neighborhood_label_count']} "
                f"overlap={a13['overlapping_label_pair_count']} "
                f"clipped={geometry.get('clipped_label_count')} "
                f"obscured={geometry.get('obscured_by_primary_control_count')} "
                f"allowOverlap={a13['text_allow_overlap']}",
                flush=True,
            )
            print(
                f"  A9 map@{a9['first_map_focus_index']} exit@{a9['exit_map_focus_index']} "
                f"trap={a9['focus_trap_observed']}",
                flush=True,
            )
        print(
            f"capture selected {SELECTED_SPECIMEN['width']}x{SELECTED_SPECIMEN['height']} "
            f"{SELECTED_SPECIMEN['route']}",
            flush=True,
        )
        a13_selected = capture_selected(browser, base, rev)
        a13_reads.append(a13_selected)
        print(
            f"  A13 selected={a13_selected.get('selected_layer_rendered_labels')} "
            f"ui={a13_selected.get('selected_ui_label')!r}",
            flush=True,
        )
        browser.close()

    assert_letter_observations(a13_reads, a9_reads, a13_selected=a13_selected)

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
        },
        "capture": {
            "tool": "tools/capture_near_you_shell_production_read.py",
            "browser": "chromium",
            "viewports": [
                {"name": name, "width": width, "height": height}
                for name, width, height, _minimum, _maximum in VIEWPORTS
            ] + [
                {
                    "name": SELECTED_SPECIMEN["name"],
                    "width": SELECTED_SPECIMEN["width"],
                    "height": SELECTED_SPECIMEN["height"],
                    "route": SELECTED_SPECIMEN["route"],
                }
            ],
            "screenshot_binaries_committed": False,
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
                "selected_specimen": {
                    "route": SELECTED_SPECIMEN["route"],
                    "label": SELECTED_SPECIMEN["expected_label"],
                    "geo": SELECTED_SPECIMEN["geo"],
                },
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
                f"ui={read.get('selected_ui_label')!r})."
            )
            observed = {
                "selected_neighborhood_label": read.get("selected_neighborhood_label"),
                "selected_ui_label": read.get("selected_ui_label"),
                "selected_heading": read.get("selected_heading"),
                "selected_layer_rendered_label_count": read.get("selected_layer_rendered_label_count"),
                "selected_layer_rendered_labels": read.get("selected_layer_rendered_labels"),
                "selected_name_box": read.get("selected_name_box"),
                "map_runtime": read.get("map_runtime"),
            }
            digest = {
                "selected": read.get("selected_neighborhood_label"),
                "layer": read.get("selected_layer_rendered_labels"),
                "ui": read.get("selected_ui_label"),
            }
            mode = "headless-playwright-production-selected"
            route = read.get("route") or SELECTED_SPECIMEN["route"]
        else:
            assertion = (
                f"Observed {read['residential_neighborhood_label_count']} residential "
                f"neighborhood labels at {read['viewport']['width']}x{read['viewport']['height']} "
                f"with text-allow-overlap={read['text_allow_overlap']}; geometry "
                f"overlapping_label_pair_count={geometry.get('overlapping_label_pair_count')}, "
                f"clipped_label_count={geometry.get('clipped_label_count')}, "
                f"obscured_by_primary_control_count={geometry.get('obscured_by_primary_control_count')} "
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
                    "clipped_label_count": geometry.get("clipped_label_count"),
                    "obscured_by_primary_control_count": geometry.get(
                        "obscured_by_primary_control_count"
                    ),
                    "clip_surface": geometry.get("clip_surface"),
                },
            }
            digest = {
                "count": read["residential_neighborhood_label_count"],
                "labels": read["residential_neighborhood_labels"],
                "overlap": geometry.get("overlapping_label_pair_count"),
                "clipped": geometry.get("clipped_label_count"),
                "obscured": geometry.get("obscured_by_primary_control_count"),
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
    for banned in ("result", "pass", "passed", "verdict"):
        if banned in receipt:
            raise AssertionError(f"receipt must not carry a {banned!r} field")
    a13 = ((receipt.get("letters") or {}).get("A13") or {}).get("reads") or []
    a9 = ((receipt.get("letters") or {}).get("A9") or {}).get("reads") or []
    selected = [row for row in a13 if row.get("selected_neighborhood_label")]
    all_city = [row for row in a13 if not row.get("selected_neighborhood_label")]
    if len(all_city) < 2 or len(a9) < 2:
        raise AssertionError("missing A9/A13 viewport observations")
    if len(selected) < 1:
        raise AssertionError("missing A13 selected-neighborhood observation")
    assert_letter_observations(a13, a9)
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
    print(f"near-you-shell production read-back check passed: {READBACK.relative_to(ROOT)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return 0
    receipt = capture()
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
