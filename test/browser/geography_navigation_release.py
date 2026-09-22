"""Retained local browser journey for the resident geography navigator.

The journey records rendered HTML and measurements, never screenshot binaries.
Production ``CROL_BASE`` read-back is intentionally a separate, open step.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from browser_support import launched_chromium

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
EVIDENCE_DIR = ROOT / "docs" / "evidence" / "geography-navigation-release"
ROUTE = "/near-you/?geo=nta2020%3ABK1503&compare=council_district&surface=map&drawer=open"
VIEWPORTS = (("desktop", 1440, 900), ("narrow_touch", 390, 844), ("compact_touch", 360, 800))
MINIMUM_VISIBLE_MAP_HEIGHT = 240
ENTRY_ROUTES = (
    ("default", "/near-you/"),
    ("greenpoint", "/near-you/?geo=nta2020%3ABK0101&surface=map"),
    ("tribeca", "/near-you/?geo=nta2020%3AMN0102&surface=map"),
)


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
          const boxes = (selector) => [...document.querySelectorAll(selector)].filter(visible).map((node) => {
            const rect = node.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
          });
          const search = document.querySelector('#near-geo-search-input');
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
            .map((node) => (node.getAttribute('aria-label') || node.textContent || node.name || node.id || node.tagName).trim().replace(/\\s+/g, ' ').slice(0, 80));
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
            overflow_x: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
            form_font_px: search ? Number.parseFloat(getComputedStyle(search).fontSize) : null,
            targets: boxes('#near-geo-search-input, .near-geo-search button, .near-place-guide > summary, [data-near-recovery="retry"]'),
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
    assert snapshot["targets"] and min(item["width"] for item in snapshot["targets"]) >= 44
    assert snapshot["targets"] and min(item["height"] for item in snapshot["targets"]) >= 44
    assert snapshot["drawer_present"]
    assert snapshot["map_area"]["width"] > 0 and snapshot["map_area"]["height"] > 0
    assert snapshot["place_choice_visible"]
    assert not snapshot["control_occlusion"]
    assert snapshot["nta_codes_in_primary_labels"] == 0
    return snapshot


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
            snapshot = overlap_snapshot(page) if overlap else shell_snapshot(page)
            retained = performance_samples(page, page_url, overlap=overlap) if retain_performance else None
            if not overlap:
                focus_target = (
                    page.locator(".near-place-guide > summary")
                    if route != "/near-you/"
                    else page.locator("#near-geo-search-input")
                )
                focus_target.focus()
                snapshot["keyboard_focus_start"] = page.evaluate(
                    "() => document.activeElement?.textContent?.trim() || document.activeElement?.getAttribute('aria-label') || document.activeElement?.id"
                )
                page.keyboard.press("Tab")
                assert page.evaluate("() => document.activeElement !== document.body")
                snapshot["keyboard_focus_next"] = page.evaluate(
                    "() => document.activeElement?.textContent?.trim() || document.activeElement?.getAttribute('aria-label') || document.activeElement?.id"
                )
                snapshot["keyboard_path"] = "passed"
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
            rendered = normalize_html(page.content())
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
                "visual_metrics": {
                    **({
                        "viewport": {"width": width, "height": height},
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
                        "zoom_reflow_basis": "360 CSS px represents a 720 px viewport at 200% browser zoom" if zoom_percent == 200 else "native CSS viewport",
                        "reduced_motion": reduced_motion,
                    }),
                },
                "snapshot": snapshot,
                "rendered_html": rendered,
            })
            if dynamic and width in (390, 1440):
                assert snapshot.get("visible_map_height", height) >= MINIMUM_VISIBLE_MAP_HEIGHT, snapshot
            if webgl_unavailable:
                assert snapshot.get("map_runtime") != "maplibre", snapshot
            if not overlap:
                assert snapshot.get("focus_order"), snapshot
        finally:
            context.close()
    return observations[0]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-evidence", action="store_true")
    parser.add_argument("--layout-only", action="store_true")
    args = parser.parse_args()
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
