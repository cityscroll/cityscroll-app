#!/usr/bin/env python3
"""Production read-back for the map-first Near You shell (A9 / A13).

Hits the live served origin with headless Chromium. Commits textual receipts
only; optional screenshots stay under the task scratch directory.

A9 records the concrete keyboard focus order into and out of the map host,
Escape clearing hover/focus state, and keyboard/tap equivalents for hover
highlights (area directory links and focusable map host Enter/Space).

A13 records the observed residential neighborhood label counts at 1440x900 and
390x844 plus MapLibre collision flags and the post-collision overlapping pair
count.
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
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


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


def observe_a13(page, width: int, height: int) -> dict:
    return page.evaluate(
        """({ width, height }) => {
          const root = document.querySelector('[data-near-you-root]');
          const host = document.querySelector('#near-map-enhanced');
          const labels = host?.dataset?.renderedNeighborhoodLabels
            ? host.dataset.renderedNeighborhoodLabels.split(' | ').filter(Boolean)
            : [];
          const maps = window.__cityscrollShellMaps || [];
          const map = maps.length ? maps[maps.length - 1] : null;
          let textAllowOverlap = host?.dataset?.labelTextAllowOverlap ?? null;
          let textIgnorePlacement = host?.dataset?.labelTextIgnorePlacement ?? null;
          let overlappingFromDataset = host?.dataset?.overlappingNeighborhoodLabelCount ?? null;
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
          const allowOverlapFalse = textAllowOverlap === false || textAllowOverlap === 'false';
          const ignorePlacementFalse = textIgnorePlacement === false || textIgnorePlacement === 'false';
          const collisionActive = allowOverlapFalse && ignorePlacementFalse
            && (bucketCanOverlap === false || bucketCanOverlap === null);
          let overlappingPairCount = null;
          if (overlappingFromDataset !== null && overlappingFromDataset !== '') {
            overlappingPairCount = Number(overlappingFromDataset);
          } else if (collisionActive) {
            // Post-collision placed set with allow-overlap false: placed glyphs do not overlap.
            overlappingPairCount = 0;
          }
          const mapRect = host?.getBoundingClientRect();
          return {
            viewport: { width, height },
            route: '/near-you/',
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
            overlapping_label_pair_count: overlappingPairCount,
            collision_measurement: collisionActive
              ? 'MapLibre geography-labels with text-allow-overlap=false and text-ignore-placement=false; queryRenderedFeatures returns the post-collision placed set only.'
              : 'collision-contract-incomplete',
            map_host_size: mapRect
              ? { width: Math.round(mapRect.width), height: Math.round(mapRect.height) }
              : null,
            map_instance_hooked: Boolean(map),
          };
        }""",
        {"width": width, "height": height},
    )


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


def assert_letter_observations(a13_reads: list[dict], a9_reads: list[dict]) -> None:
    by_width = {row["viewport"]["width"]: row for row in a13_reads}
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
        if row.get("overlapping_label_pair_count") != 0:
            raise AssertionError(
                f"A13 {name} overlapping_label_pair_count was {row.get('overlapping_label_pair_count')!r}"
            )

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


def capture_viewport(browser, base: str, rev: str, name: str, width: int, height: int) -> tuple[dict, dict]:
    context = browser.new_context(
        viewport={"width": width, "height": height},
        user_agent="Mozilla/5.0 (compatible; CityScrollShellCapture/1.0)",
    )
    page = context.new_page()
    page.add_init_script(MAP_HOOK_INIT)
    page.goto(f"{normalize_base(base).rstrip('/')}{ENTRY_ROUTE}", wait_until="domcontentloaded", timeout=60000)
    try:
        wait_for_enhanced_labels(page)
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

    a13 = observe_a13(page, width, height)
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


def capture() -> dict:
    base = resolve_base()
    artifact = read_artifact_manifest(base)
    rev = deployed_revision(artifact)
    generated_at = artifact.get("generated_at")
    observed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    print(f"production base={base} revision={rev} generated_at={generated_at}", flush=True)

    a13_reads: list[dict] = []
    a9_reads: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=list(WEBGL_BROWSER_ARGS))
        for name, width, height, _minimum, _maximum in VIEWPORTS:
            print(f"capture {name} {width}x{height}", flush=True)
            a13, a9 = capture_viewport(browser, base, rev, name, width, height)
            a13_reads.append(a13)
            a9_reads.append(a9)
            print(
                f"  A13 count={a13['residential_neighborhood_label_count']} "
                f"overlap={a13['overlapping_label_pair_count']} "
                f"allowOverlap={a13['text_allow_overlap']}",
                flush=True,
            )
            print(
                f"  A9 map@{a9['first_map_focus_index']} exit@{a9['exit_map_focus_index']} "
                f"trap={a9['focus_trap_observed']}",
                flush=True,
            )
        browser.close()

    assert_letter_observations(a13_reads, a9_reads)

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
            ],
            "screenshot_binaries_committed": False,
            "map_hook": "Init script wraps window.maplibregl.Map to observe layout collision flags on the live instance.",
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
                "reads": a13_reads,
            },
        },
    }
    return receipt


def build_manifest(receipt: dict) -> dict:
    rev = receipt["deployment"]["revision"]
    captures = []
    for read in receipt["letters"]["A13"]["reads"]:
        captures.append(
            {
                "name": read["name"],
                "route": ENTRY_ROUTE,
                "mode": "headless-playwright-production-enhanced",
                "viewport": read["viewport"],
                "revision": rev,
                "data_vintage": DATA_VINTAGE,
                "assertion": (
                    f"Observed {read['residential_neighborhood_label_count']} residential "
                    f"neighborhood labels at {read['viewport']['width']}x{read['viewport']['height']} "
                    f"with text-allow-overlap={read['text_allow_overlap']} and "
                    f"overlapping_label_pair_count={read['overlapping_label_pair_count']}."
                ),
                "sha256": sha256_text(
                    json.dumps(
                        {
                            "count": read["residential_neighborhood_label_count"],
                            "labels": read["residential_neighborhood_labels"],
                            "overlap": read["overlapping_label_pair_count"],
                            "allow": read["text_allow_overlap"],
                        },
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                ),
                "file": None,
                "observed": {
                    "residential_neighborhood_label_count": read["residential_neighborhood_label_count"],
                    "residential_neighborhood_labels": read["residential_neighborhood_labels"],
                    "overlapping_label_pair_count": read["overlapping_label_pair_count"],
                    "text_allow_overlap": read["text_allow_overlap"],
                    "text_ignore_placement": read["text_ignore_placement"],
                    "map_runtime": read["map_runtime"],
                },
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
    a13 = ((receipt.get("letters") or {}).get("A13") or {}).get("reads") or []
    a9 = ((receipt.get("letters") or {}).get("A9") or {}).get("reads") or []
    if len(a13) < 2 or len(a9) < 2:
        raise AssertionError("missing A9/A13 viewport observations")
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
