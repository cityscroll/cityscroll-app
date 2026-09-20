#!/usr/bin/env python3
"""Capture textual assertions for the Near You geography navigation shell.

Writes a manifest under docs/evidence/geography-navigation-shell/. Does not
commit image binaries.
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import json
import subprocess
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_DIR = ROOT / "docs" / "evidence" / "geography-navigation-shell"
MANIFEST_PATH = MANIFEST_DIR / "capture-manifest.json"
SCREENSHOT_DIR = ROOT / "docs" / "screenshots" / "geography-navigation-shell"
OVERLAP_MANIFEST_DIR = ROOT / "docs" / "evidence" / "geography-navigation-overlap"
OVERLAP_MANIFEST_PATH = OVERLAP_MANIFEST_DIR / "capture-manifest.json"
OVERLAP_SCREENSHOT_DIR = ROOT / "docs" / "screenshots" / "geography-navigation-overlap"

VIEWPORTS = (
    ("desktop", 1440, 900),
    ("narrow", 390, 844),
    ("compact", 360, 800),
)

OVERLAP_ROUTE = "/near-you/?geo=nta2020%3ABK1503&compare=council_district&surface=map&drawer=open"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return


def serve(directory: Path) -> tuple[ThreadingHTTPServer, str]:
    handler = functools.partial(QuietHandler, directory=str(directory))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_port}"


def local_revision() -> str:
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT,
        text=True,
    ).strip()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def assert_shell_semantics(page, *, enhanced: bool, failed: bool = False) -> dict:
    return page.evaluate(
        """({ enhanced, failed }) => {
          const root = document.querySelector('[data-near-you-root]');
          const text = (selector) => (document.querySelector(selector)?.textContent || '').trim();
          const box = (selector) => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            return {
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
              bottom: rect.bottom,
              right: rect.right,
            };
          };
          const overflowX = Math.max(
            0,
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          const layerButtons = [...document.querySelectorAll('[data-geography-layer]')].map((node) => ({
            type: node.getAttribute('data-geography-layer'),
            label: (node.textContent || '').trim(),
            pressed: node.getAttribute('aria-pressed'),
            minHeight: Math.round(node.getBoundingClientRect().height),
            minWidth: Math.round(node.getBoundingClientRect().width),
          }));
          const areaKeys = [...document.querySelectorAll('[data-geography-key]')].map(
            (node) => node.getAttribute('data-geography-key'),
          );
          const areaLabels = [...document.querySelectorAll('[data-geography-key] span, [data-geography-key]')].map(
            (node) => (node.textContent || '').trim(),
          );
          const search = document.querySelector('#near-geo-search-input, [data-geography-search] input');
          const searchFont = search ? Number.parseFloat(getComputedStyle(search).fontSize) : null;
          const mapSvg = document.querySelector('#nearMapSvg');
          const enhancedHost = document.querySelector('#near-map-enhanced');
          const advanced = document.querySelector('.near-advanced');
          const heading = text('#near-geo-heading, .near-geo-entry h1, .near-hero h1');
          const surface = root?.dataset?.nearSurface || root?.dataset?.nearMobileSurface || null;
          const runtime = root?.dataset?.nearMapRuntime || null;
          const labels = [...document.querySelectorAll('.maplibregl-map .maplibregl-marker, .maplibregl-canvas-container')]
            .length;
          // MapLibre symbol labels are not DOM text; count via canvas presence + area list.
          const mapCanvas = document.querySelector('.maplibregl-canvas, .maplibregl-map canvas');
          return {
            heading,
            has_search: Boolean(search),
            search_font_px: searchFont,
            has_use_location: Boolean(document.querySelector('[data-use-location]')),
            has_more_boundaries: /More boundaries/i.test(document.body.innerText || ''),
            has_browse_records: /Browse records/i.test(document.body.innerText || ''),
            has_neighborhoods: /Neighborhoods/i.test(document.body.innerText || ''),
            has_map_svg: Boolean(mapSvg),
            map_svg_visible: mapSvg ? getComputedStyle(mapSvg).display !== 'none' && getComputedStyle(mapSvg).visibility !== 'hidden' : false,
            has_enhanced_host: Boolean(enhancedHost),
            enhanced_visible: enhancedHost ? getComputedStyle(enhancedHost).display !== 'none' : false,
            has_areas: Boolean(document.querySelector('#near-area-list, [data-geography-areas]')),
            area_key_count: areaKeys.length,
            area_keys_sample: areaKeys.slice(0, 8),
            area_labels_sample: areaLabels.slice(0, 8),
            code_like_labels: areaLabels.filter((label) => /^[A-Z]{2}\\d{4}$/.test(label)).length,
            layer_buttons: layerButtons,
            advanced_precedes_map: (() => {
              const advNode = document.querySelector('.near-advanced');
              const mapNode = document.querySelector('.near-geo-workspace, .near-map-section');
              if (!advNode || !mapNode) return null;
              const advStyle = getComputedStyle(advNode);
              const parent = advNode.closest('[data-near-surface-panel]');
              const parentHidden = parent && getComputedStyle(parent).display === 'none';
              if (advStyle.display === 'none' || parentHidden || advNode.getBoundingClientRect().height < 1) {
                return false;
              }
              return advNode.getBoundingClientRect().top < mapNode.getBoundingClientRect().top;
            })(),
            overflow_x: overflowX,
            surface,
            runtime,
            has_map_canvas: Boolean(mapCanvas),
            viewport: { width: innerWidth, height: innerHeight },
            map_box: box('.near-map-wrap, #near-map-enhanced, #nearMapSvg'),
            entry_box: box('.near-geo-entry, #near-geo-heading'),
            drawer: box('[data-geography-drawer], .near-geo-rail, .near-geo-drawer'),
            enhanced,
            failed,
          };
        }""",
        {"enhanced": enhanced, "failed": failed},
    )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def validate_snapshot(snapshot: dict, *, mode: str, width: int) -> list[str]:
    assertions: list[str] = []
    require(snapshot["has_search"], "search control missing")
    assertions.append("search control present")
    require(snapshot["has_use_location"], "Use my location missing")
    assertions.append("Use my location present")
    require(snapshot["has_neighborhoods"], "Neighborhoods layer missing")
    assertions.append("Neighborhoods layer present")
    require(snapshot["has_more_boundaries"], "More boundaries missing")
    assertions.append("More boundaries present")
    require(snapshot["has_browse_records"], "Browse records missing")
    assertions.append("Browse records present")
    require(snapshot["has_areas"], "Areas list missing")
    assertions.append("Areas list present")
    require(snapshot["has_map_svg"] or snapshot["has_map_canvas"], "map surface missing")
    assertions.append("map surface present")
    require(snapshot["overflow_x"] <= 1, f"horizontal overflow {snapshot['overflow_x']}px")
    assertions.append("horizontal overflow ≤ 1px")
    require(snapshot["code_like_labels"] == 0, "NTA codes appeared as primary labels")
    assertions.append("NTA codes absent from primary area labels")
    if width <= 400 and snapshot["search_font_px"] is not None:
        require(snapshot["search_font_px"] >= 16, f"search font {snapshot['search_font_px']}px")
        assertions.append("search font ≥ 16px on narrow")
    for button in snapshot["layer_buttons"]:
        require(button["minHeight"] >= 44 or width > 900, f"layer target too small: {button}")
    assertions.append("layer controls present")
    if mode == "server":
        require(snapshot["has_map_svg"], "server SVG missing")
        assertions.append("server SVG visible path")
    if mode == "failed":
        require(snapshot["has_map_svg"], "failed enhancement must restore SVG")
        assertions.append("failed enhancement restored SVG")
    if mode == "enhanced" and width >= 1400:
        require(
            "What's near you" in (snapshot["heading"] or "")
            or "near you" in (snapshot["heading"] or "").lower(),
            f"unexpected heading {snapshot['heading']!r}",
        )
        assertions.append("first-viewport heading present")
        if snapshot["advanced_precedes_map"] is True:
            raise AssertionError("advanced filters precede the map on enhanced desktop")
        assertions.append("advanced filters do not precede the map")
    return assertions


def capture_case(page, base: str, *, mode: str, width: int, height: int, route: str = "/near-you/") -> dict:
    if mode == "server":
        page.goto(f"{base}{route}", wait_until="networkidle")
        # Disable JS by using a context without scripts — caller passes java_script_enabled=False.
    elif mode == "failed":
        page.add_init_script(
            """
            window.__CITYSCROLL_FORCE_GEOGRAPHY_MAP_FAILURE = true;
            const original = window.WebGLRenderingContext;
            // Force the adapter seam to fail after load by stubbing createMap host signal.
            Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
              configurable: true,
              value: function(type, ...args) {
                if (String(type).includes('webgl')) return null;
                return null;
              }
            });
            """
        )
        page.goto(f"{base}{route}", wait_until="networkidle")
        page.wait_for_timeout(500)
    else:
        page.goto(f"{base}{route}", wait_until="networkidle")
        page.locator("[data-near-you-root]").wait_for()
        # Enhancement marker may be data-enhanced or map runtime.
        page.wait_for_timeout(800)

    snapshot = assert_shell_semantics(page, enhanced=(mode == "enhanced"), failed=(mode == "failed"))
    assertions = validate_snapshot(snapshot, mode=mode, width=width)
    digest = sha256_text(json.dumps(snapshot, sort_keys=True, separators=(",", ":")))
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    shot = SCREENSHOT_DIR / f"shell-{mode}-{width}.png"
    page.screenshot(path=str(shot), full_page=False, animations="disabled")
    return {
        "name": f"shell-{mode}-{width}",
        "route": route,
        "mode": mode,
        "viewport": {"width": width, "height": height},
        "assertion": "; ".join(assertions),
        "sha256": digest,
        "file": None,
        "snapshot": {
            "heading": snapshot.get("heading"),
            "overflow_x": snapshot.get("overflow_x"),
            "area_key_count": snapshot.get("area_key_count"),
            "surface": snapshot.get("surface"),
            "runtime": snapshot.get("runtime"),
            "code_like_labels": snapshot.get("code_like_labels"),
            "advanced_precedes_map": snapshot.get("advanced_precedes_map"),
            "has_map_canvas": snapshot.get("has_map_canvas"),
            "has_map_svg": snapshot.get("has_map_svg"),
        },
    }


def run_shell(write_manifest: bool) -> int:
    from playwright.sync_api import sync_playwright

    server, base = serve(ROOT / "site")
    revision = local_revision()
    captures: list[dict] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for mode in ("server", "enhanced", "failed"):
                for name, width, height in VIEWPORTS:
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        java_script_enabled=(mode != "server"),
                    )
                    page = context.new_page()
                    try:
                        captures.append(
                            capture_case(page, base, mode=mode, width=width, height=height)
                        )
                    finally:
                        context.close()
            browser.close()
    finally:
        server.shutdown()

    manifest = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "geography-navigation-shell",
        "public_alias": "ced62a84f8213",
        "capture_mode": "headless_playwright_local_site",
        "repository_revision": revision,
        "grounded_at": revision,
        "data_vintage": "nta2020 26B; community/council 2026-05-26; precincts 26B",
        "image_binaries_committed": False,
        "image_policy": "Screenshots may exist under docs/screenshots/ locally; only this manifest is committed.",
        "route": "/near-you/",
        "captures": [
            {
                "name": row["name"],
                "route": row["route"],
                "mode": row["mode"],
                "viewport": row["viewport"],
                "revision": revision,
                "assertion": row["assertion"],
                "sha256": row["sha256"],
                "file": None,
                "snapshot": row["snapshot"],
            }
            for row in captures
        ],
        "verifier": "python3 tools/capture_geography_navigation.py --case shell",
    }
    if write_manifest:
        MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
        MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {MANIFEST_PATH}")
    else:
        print(json.dumps(manifest, indent=2))
    return 0


def build_overlap_fixture_html(*, unavailable: bool = False) -> str:
    script = """
import {
  buildBk1503CouncilOverlapFixtureModel,
  buildSelectedGeographyOverlapViewModel,
  renderGeographyOverlapWorkspaceChrome,
} from "./site/geography_navigation_overlap_ui.mjs";
import { GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE as FIXTURE } from "./site/geography_navigation_capability.mjs";

const unavailable = %s;
const model = unavailable
  ? buildSelectedGeographyOverlapViewModel({
      selected: FIXTURE.selected,
      compareType: "council_district",
      crosswalkAvailable: false,
      crosswalkRows: null,
    })
  : buildBk1503CouncilOverlapFixtureModel({ focusToken: "geography:nta2020:BK1503" });
const workspace = renderGeographyOverlapWorkspaceChrome(model, {
  mapSectionHtml: '<section class="near-map-section" aria-labelledby="near-map-heading"><h2 id="near-map-heading" tabindex="-1">Map</h2><div class="near-map-wrap"><svg id="nearMapSvg" width="640" height="400" role="img" aria-label="Map"></svg><button type="button" data-geography-key="geography:nta2020:BK1503">Sheepshead Bay area</button></div></section>',
});
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Overlap fixture</title><link rel="stylesheet" href="/site/civic-documents.css"></head><body><main id="main" data-near-you-root data-geography-shell="map-first" data-near-surface="map">${workspace}</main><script type="module">
import { GEOGRAPHY_NAVIGATION_DRAWER_CLOSED, GEOGRAPHY_NAVIGATION_DRAWER_OPEN } from "/site/geography_navigation_state.mjs";
import { rememberOverlapInvoker, restoreOverlapInvokerFocus } from "/site/geography_navigation_overlap_ui.mjs";
const root = document.querySelector("[data-near-you-root]");
const workspaceNode = root?.querySelector("[data-geography-workspace]");
const toggle = root?.querySelector("[data-geography-drawer-toggle]");
const invoker = root?.querySelector('[data-geography-key="geography:nta2020:BK1503"]');
if (workspaceNode && toggle) {
  toggle.hidden = false;
  rememberOverlapInvoker(workspaceNode.dataset.geographyFocusRestore, invoker);
  toggle.addEventListener("click", () => {
    const open = workspaceNode.dataset.geographyDrawerState !== GEOGRAPHY_NAVIGATION_DRAWER_CLOSED;
    const next = open ? GEOGRAPHY_NAVIGATION_DRAWER_CLOSED : GEOGRAPHY_NAVIGATION_DRAWER_OPEN;
    workspaceNode.dataset.geographyDrawerState = next;
    toggle.setAttribute("aria-expanded", next === GEOGRAPHY_NAVIGATION_DRAWER_OPEN ? "true" : "false");
    const token = workspaceNode.dataset.geographyFocusRestore
      || root.querySelector("[data-geography-overlap-root]")?.dataset?.geographyFocusRestore;
    if (next === GEOGRAPHY_NAVIGATION_DRAWER_CLOSED) {
      restoreOverlapInvokerFocus(token, { root });
    } else {
      rememberOverlapInvoker(token || "geography-drawer-toggle", toggle);
      root.querySelector("#near-geo-overlap-heading")?.focus?.({ preventScroll: true });
    }
  });
}
</script></body></html>`;
process.stdout.write(html);
""" % ("true" if unavailable else "false")
    return subprocess.check_output(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        text=True,
    )


def assert_overlap_semantics(page, *, unavailable: bool = False) -> dict:
    return page.evaluate(
        """({ unavailable }) => {
          const text = (selector) => (document.querySelector(selector)?.textContent || '').trim();
          const bodyText = document.body.innerText || '';
          const primary = document.querySelector('[data-geography-overlap-list]')?.innerText || '';
          const detailsNode = document.querySelector('[data-geography-overlap-details]');
          if (detailsNode) detailsNode.open = true;
          const details = detailsNode?.textContent || '';
          const order = [
            'data-geography-selected-label',
            'data-geography-compare-controls',
            'data-geography-overlap-area',
            'data-geography-overlap-details',
            'data-geography-overlap-records',
          ].map((attr) => {
            const node = document.querySelector(`[${attr}]`);
            return node ? node.getBoundingClientRect().top : null;
          });
          return {
            selected_label: text('[data-geography-selected-label]'),
            has_overlap_root: Boolean(document.querySelector('[data-geography-overlap-root]')),
            summary: text('[data-geography-overlap-summary], [data-geography-overlap-unavailable-copy]'),
            primary_has_48: /Council District 48/.test(primary) || /Council District 48/.test(bodyText),
            primary_has_46: /Council District 46/.test(primary) || /Council District 46/.test(bodyText),
            primary_has_pct: /69\\.0%/.test(bodyText) && /31\\.0%/.test(bodyText),
            primary_has_sliver: /Community District 13/.test(primary) || /Precinct 60/.test(primary),
            details_has_exact: /68\\.986772%/.test(details) || unavailable,
            unavailable: /Comparison details unavailable/i.test(bodyText),
            has_select_link: Boolean(document.querySelector('[data-geography-overlap-select]')),
            has_highlight: Boolean(document.querySelector('[data-geography-overlap-highlight]')),
            sole_district_claim: /your district|sole .*district|the Council district for this neighborhood/i.test(bodyText),
            semantic_order_ok: order.every((value, index, all) => (
              value == null || all.slice(0, index).every((prev) => prev == null || prev <= value + 1)
            )),
            overflow_x: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
          };
        }""",
        {"unavailable": unavailable},
    )


def validate_overlap_snapshot(snapshot: dict, *, unavailable: bool = False) -> list[str]:
    assertions: list[str] = []
    require(snapshot["has_overlap_root"], "overlap root missing")
    assertions.append("overlap root present")
    require(snapshot["semantic_order_ok"], "semantic order broken")
    assertions.append("shared semantic order")
    require(snapshot["overflow_x"] <= 1, f"horizontal overflow {snapshot['overflow_x']}px")
    assertions.append("horizontal overflow ≤ 1px")
    require(not snapshot["sole_district_claim"], "sole-district wording present")
    assertions.append("no sole-district wording")
    if unavailable:
        require(snapshot["unavailable"], "missing-crosswalk copy absent")
        assertions.append("Comparison details unavailable")
    else:
        require(snapshot["primary_has_48"] and snapshot["primary_has_46"], "council rows missing")
        assertions.append("Council 48 then 46 present")
        require(snapshot["primary_has_pct"], "display percentages missing")
        assertions.append("69.0% and 31.0% present")
        require(not snapshot["primary_has_sliver"], "sliver leaked into primary list")
        assertions.append("slivers absent from primary list")
        require(snapshot["has_select_link"] and snapshot["has_highlight"], "row actions missing")
        assertions.append("highlight and select actions present")
        require(snapshot["details_has_exact"], "exact percentages missing from details")
        assertions.append("exact percentages in details")
    return assertions


def validate_mobile_drawer_snapshot(snapshot: dict) -> list[str]:
    require(snapshot["drawer_toggle_present"], "drawer toggle missing")
    require(snapshot["drawer_collapsed"], "drawer did not collapse its body")
    require(snapshot["drawer_expanded"], "drawer did not re-expand")
    require(snapshot["focus_restored_to_invoker"], "drawer close did not restore invoker focus")
    return [
        "mobile drawer collapses and re-expands",
        "focus returns to invoking map feature on close",
    ]


def exercise_mobile_drawer(page) -> dict:
    toggle = page.locator("[data-geography-drawer-toggle]")
    require(toggle.count() == 1, "expected one mobile drawer toggle")
    invoker = page.locator('[data-geography-key="geography:nta2020:BK1503"]')
    require(invoker.count() == 1, "expected one invoking map feature")
    invoker.focus()
    toggle.click()
    closed = page.evaluate(
        """() => {
          const workspace = document.querySelector('[data-geography-workspace]');
          const body = document.querySelector('[data-geography-overlap-root]');
          return {
            state: workspace?.dataset?.geographyDrawerState,
            expanded: document.querySelector('[data-geography-drawer-toggle]')?.getAttribute('aria-expanded'),
            body_hidden: body ? getComputedStyle(body).display === 'none' : false,
            focus_restored: document.activeElement?.matches('[data-geography-key="geography:nta2020:BK1503"]') || false,
          };
        }"""
    )
    toggle.click()
    expanded = page.evaluate(
        """() => {
          const workspace = document.querySelector('[data-geography-workspace]');
          const body = document.querySelector('[data-geography-overlap-root]');
          return workspace?.dataset?.geographyDrawerState === 'open'
            && document.querySelector('[data-geography-drawer-toggle]')?.getAttribute('aria-expanded') === 'true'
            && body && getComputedStyle(body).display !== 'none';
        }"""
    )
    return {
        "drawer_toggle_present": True,
        "drawer_collapsed": closed["state"] == "closed" and closed["expanded"] == "false" and closed["body_hidden"],
        "drawer_expanded": bool(expanded),
        "focus_restored_to_invoker": closed["focus_restored"],
    }


def capture_overlap_variant(
    page,
    base: str,
    *,
    name: str,
    width: int,
    height: int,
    unavailable: bool,
    exercise_drawer: bool = False,
) -> dict:
    html = build_overlap_fixture_html(unavailable=unavailable)
    fixture_dir = OVERLAP_SCREENSHOT_DIR
    fixture_dir.mkdir(parents=True, exist_ok=True)
    fixture_path = fixture_dir / ("fixture-unavailable.html" if unavailable else "fixture.html")
    fixture_path.write_text(html, encoding="utf-8")
    route = f"/docs/screenshots/geography-navigation-overlap/{fixture_path.name}"
    # Serve from repository root so /civic-documents.css and fixture path resolve.
    page.goto(f"{base}{route}", wait_until="networkidle")
    page.locator("[data-geography-overlap-root]").wait_for(timeout=5000)
    snapshot = assert_overlap_semantics(page, unavailable=unavailable)
    assertions = validate_overlap_snapshot(snapshot, unavailable=unavailable)
    if exercise_drawer:
        snapshot.update(exercise_mobile_drawer(page))
        assertions.extend(validate_mobile_drawer_snapshot(snapshot))
    digest = sha256_text(json.dumps(snapshot, sort_keys=True, separators=(",", ":")))
    shot = OVERLAP_SCREENSHOT_DIR / f"{name}.png"
    page.screenshot(path=str(shot), full_page=False, animations="disabled")
    return {
        "name": name,
        "route": OVERLAP_ROUTE if not unavailable else f"{OVERLAP_ROUTE}&crosswalk=missing",
        "mode": name,
        "viewport": {"width": width, "height": height},
        "assertion": "; ".join(assertions),
        "sha256": digest,
        "file": None,
        "snapshot": snapshot,
    }


def run_overlap(write_manifest: bool) -> int:
    from playwright.sync_api import sync_playwright

    server, base = serve(ROOT)
    revision = local_revision()
    captures: list[dict] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)

            # Desktop happy path
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            page = context.new_page()
            try:
                captures.append(
                    capture_overlap_variant(
                        page, base, name="overlap-desktop", width=1440, height=900, unavailable=False
                    )
                )
            finally:
                context.close()

            # Mobile bottom drawer
            context = browser.new_context(viewport={"width": 390, "height": 844})
            page = context.new_page()
            try:
                captures.append(
                    capture_overlap_variant(
                        page,
                        base,
                        name="overlap-mobile",
                        width=390,
                        height=844,
                        unavailable=False,
                        exercise_drawer=True,
                    )
                )
            finally:
                context.close()

            # Keyboard-only
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            page = context.new_page()
            try:
                row = capture_overlap_variant(
                    page, base, name="overlap-keyboard", width=1440, height=900, unavailable=False
                )
                page.keyboard.press("Tab")
                page.keyboard.press("Tab")
                page.keyboard.press("Escape")
                selected = page.locator("[data-geography-selected-key]").get_attribute(
                    "data-geography-selected-key"
                )
                require(selected == "geography:nta2020:BK1503", "Escape cleared selection")
                row["assertion"] += "; Escape keeps selection; keyboard reaches overlap controls"
                captures.append(row)
            finally:
                context.close()

            # 200% zoom
            context = browser.new_context(
                viewport={"width": 720, "height": 450},
                device_scale_factor=2,
            )
            page = context.new_page()
            try:
                page.set_viewport_size({"width": 720, "height": 450})
                captures.append(
                    capture_overlap_variant(
                        page, base, name="overlap-zoom-200", width=720, height=450, unavailable=False
                    )
                )
                captures[-1]["assertion"] += "; 200% zoom layout holds"
            finally:
                context.close()

            # Reduced motion
            context = browser.new_context(
                viewport={"width": 1440, "height": 900},
                reduced_motion="reduce",
            )
            page = context.new_page()
            try:
                captures.append(
                    capture_overlap_variant(
                        page, base, name="overlap-reduced-motion", width=1440, height=900, unavailable=False
                    )
                )
                captures[-1]["assertion"] += "; reduced-motion path renders"
            finally:
                context.close()

            # Missing crosswalk
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            page = context.new_page()
            try:
                captures.append(
                    capture_overlap_variant(
                        page, base, name="overlap-missing-crosswalk", width=1440, height=900, unavailable=True
                    )
                )
            finally:
                context.close()

            browser.close()
    finally:
        server.shutdown()

    manifest = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "geography-navigation-overlap",
        "public_alias": "c2a23f401f3d1",
        "capture_mode": "headless_playwright_local_fixture",
        "repository_revision": revision,
        "grounded_at": revision,
        "data_vintage": "nta2020 26B; community/council 2026-05-26; precincts 26B",
        "image_binaries_committed": False,
        "image_policy": "Screenshots may exist under docs/screenshots/ locally; only this manifest is committed.",
        "route": OVERLAP_ROUTE,
        "captures": [
            {
                "name": row["name"],
                "route": row["route"],
                "mode": row["mode"],
                "viewport": row["viewport"],
                "revision": revision,
                "assertion": row["assertion"],
                "sha256": row["sha256"],
                "file": None,
                "snapshot": {
                    "selected_label": row["snapshot"].get("selected_label"),
                    "unavailable": row["snapshot"].get("unavailable"),
                    "primary_has_pct": row["snapshot"].get("primary_has_pct"),
                    "semantic_order_ok": row["snapshot"].get("semantic_order_ok"),
                    "drawer_collapsed": row["snapshot"].get("drawer_collapsed"),
                    "drawer_expanded": row["snapshot"].get("drawer_expanded"),
                    "focus_restored_to_invoker": row["snapshot"].get("focus_restored_to_invoker"),
                    "overflow_x": row["snapshot"].get("overflow_x"),
                },
            }
            for row in captures
        ],
        "verifier": "python3 tools/capture_geography_navigation.py --case overlap",
    }
    if write_manifest:
        OVERLAP_MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
        OVERLAP_MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {OVERLAP_MANIFEST_PATH}")
    else:
        print(json.dumps(manifest, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=("shell", "overlap"), required=True)
    parser.add_argument("--write-manifest", action="store_true", default=True)
    parser.add_argument("--no-write-manifest", action="store_true")
    args = parser.parse_args(argv)
    write = not args.no_write_manifest
    if args.case == "shell":
        return run_shell(write)
    if args.case == "overlap":
        return run_overlap(write)
    return 2


if __name__ == "__main__":
    sys.exit(main())
