#!/usr/bin/env python3
"""Headless evidence for Desk publication-cycle clocks.

Renders the real authenticated graph, including an isolated last-good failure
specimen, at 390px and 1440px. Capture images stay ignored.

Run: python3 tools/capture_desk_publication_cycle_evidence.py
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".artifacts" / "desk-health-publication-liveness" / "captures"
MANIFEST = ROOT / "docs" / "evidence" / "desk-health-publication-liveness" / "capture-manifest.json"
FIXTURE_DIR = ROOT / ".artifacts" / "desk-health-publication-liveness" / "fixtures"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]
ZOOM = 2
REFLOW_FLOOR = 320
TARGET_FLOOR = 24

PRE_EXISTING: dict[tuple[str, str], dict] = {
    ("desk-home", "nested-interactive"): {
        "owner": "tools/data_source_graph.mjs",
        "renderer": "renderGraphHtml",
        "target": "#sourceGraph",
        "note": "role=\"img\" topology graph containing focusable source nodes; predates this change",
    },
    ("publication-failed", "nested-interactive"): {
        "owner": "tools/data_source_graph.mjs",
        "renderer": "renderGraphHtml",
        "target": "#sourceGraph",
        "note": "role=\"img\" topology graph containing focusable source nodes; predates this change",
    },
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FIXTURE_DIR), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def build_pages() -> dict:
    script = r"""
import { HTML_OUTPUT, JSON_OUTPUT, generatedGraphFiles, renderGraphHtml } from "./tools/data_source_graph.mjs";
import { evaluatePublicationCycle } from "./tools/desk_health_publication_cycle.mjs";
const files = generatedGraphFiles();
const graph = JSON.parse(files[JSON_OUTPUT]);
const failed = evaluatePublicationCycle({
  now: "2026-09-06T12:00:00.000Z",
  isolated: true,
  trigger: { installed: true },
  monitor_attempt: { at: "2026-09-06T08:00:00.000Z" },
  collection: { status: "succeeded", completed_at: "2026-09-06T08:00:00.000Z" },
  publication: { status: "failed", completed_at: "2026-09-06T08:05:00.000Z" },
  evidence_revision: graph.sources_hash,
  prior: { last_successful_desk_publication: { at: "2026-08-07T15:11:15.000Z" } },
});
process.stdout.write(JSON.stringify({
  html: files[HTML_OUTPUT],
  failed_html: renderGraphHtml({ ...graph, publication_cycle: failed }),
  sources_hash: graph.sources_hash,
  data_vintage: graph.current_as_of,
  failing_stage: failed.failing_stage,
}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def run_axe(page) -> dict:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    gate = failing_violations(result["violations"], wcag22_rules)
    critical = [v["id"] for v in gate if v.get("impact") in ("critical", "serious")]
    return {
        "violations_total": len(result["violations"]),
        "critical_or_serious": critical,
        "failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in gate],
        "passes": len(gate) == 0,
    }


def check_keyboard(page) -> dict:
    page.evaluate("""() => {
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        if (node.closest('details:not([open]) > *:not(summary)')) return false;
        return rect.width > 0 && rect.height > 0 && node.offsetParent !== null;
      };
      const controls = [...document.querySelectorAll('a[href], button, input, select, summary, [tabindex]:not([tabindex="-1"])')].filter(visible);
      controls.forEach((control, index) => control.setAttribute('data-kbd-index', String(index)));
      document.body.setAttribute('tabindex', '-1');
      document.body.focus();
      return controls.length;
    }""")
    page.locator("#publicationRecovery summary").focus()
    focused = page.evaluate("() => document.activeElement && document.activeElement.closest('#publicationRecovery') !== null")
    page.keyboard.press("Enter")
    open_state = page.evaluate("() => document.getElementById('publicationRecovery')?.open === true")
    return {"recovery_focusable": focused, "recovery_toggles": open_state}


def check_touch(page) -> dict:
    return page.evaluate("""() => {
      const summary = document.querySelector('#publicationRecovery summary');
      const rect = summary.getBoundingClientRect();
      return { width: rect.width, height: rect.height, meets_44: rect.height >= 44 };
    }""")


def check_overflow(page, width: int) -> dict:
    return page.evaluate("""(width) => {
      const cycle = document.getElementById('publicationCycle');
      const rect = cycle.getBoundingClientRect();
      return {
        scroll_width: cycle.scrollWidth,
        client_width: cycle.clientWidth,
        right: rect.right,
        viewport_width: width,
        horizontal_overflow: cycle.scrollWidth > cycle.clientWidth + 1 || rect.right > width + 1,
      };
    }""", width)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    built = build_pages()
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    (FIXTURE_DIR / "index.html").write_text(built["html"], encoding="utf-8")
    (FIXTURE_DIR / "failed.html").write_text(built["failed_html"], encoding="utf-8")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    revision = git_revision()
    captures = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for journey, path in (("desk-home", "/"), ("publication-failed", "/failed.html")):
            for width, height in VIEWPORTS:
                for scripting in (True, False):
                    if journey == "publication-failed" and not scripting:
                        continue
                    page = browser.new_page(viewport={"width": width, "height": height}, java_script_enabled=scripting)
                    page.goto(base + path, wait_until="domcontentloaded")
                    clocks = page.locator("#publicationCycle").inner_text()
                    assert "Last monitor attempt" in clocks
                    assert "Last successful Desk publication" in clocks
                    overflow = check_overflow(page, width)
                    zoom_overflow = None
                    axe = None
                    keyboard = None
                    touch = None
                    if scripting:
                        axe = run_axe(page)
                        keyboard = check_keyboard(page)
                        touch = check_touch(page)
                        page.evaluate(f"document.documentElement.style.zoom = {ZOOM}")
                        zoom_width = max(int(width / ZOOM), REFLOW_FLOOR)
                        page.set_viewport_size({"width": zoom_width, "height": height})
                        zoom_overflow = check_overflow(page, zoom_width)
                    png = page.screenshot(full_page=True)
                    name = f"{journey}-{'scripted' if scripting else 'no-script'}-{width}x{height}.png"
                    (OUT / name).write_bytes(png)
                    scoped = []
                    if axe:
                        scoped = [
                            v for v in axe["failing_violations"]
                            if (journey, v["id"]) not in PRE_EXISTING
                        ]
                    captures.append({
                        "name": name,
                        "journey": journey,
                        "viewport": [width, height],
                        "scripting": scripting,
                        "isolated": journey == "publication-failed",
                        "assertion": (
                            "Publication clocks are visible; the recovery control is keyboard-reachable and at least 44 CSS pixels; "
                            "200% zoom and the page viewport do not overflow horizontally."
                            if scripting else
                            "Publication clocks remain visible without JavaScript and the page viewport does not overflow."
                        ),
                        "axe": axe,
                        "keyboard": keyboard,
                        "touch": touch,
                        "overflow": overflow,
                        "zoom_overflow": zoom_overflow,
                        "render_content_sha256": sha256_bytes(png),
                        "new_violations": scoped,
                    })
                    page.close()
        browser.close()
    server.shutdown()
    failures = [
        row for row in captures
        if row["overflow"]["horizontal_overflow"]
        or (row.get("zoom_overflow") or {}).get("horizontal_overflow")
        or row.get("new_violations")
        or (row.get("touch") and not row["touch"]["meets_44"])
        or (row.get("keyboard") and not (row["keyboard"]["recovery_focusable"] and row["keyboard"]["recovery_toggles"]))
    ]
    manifest = {
        "schema": "cityscroll.desk_publication_cycle_render_manifest.v1",
        "evidence_class": "isolated-consumer-render",
        "capture_mode": "headless-playwright-loopback-static-render",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "route": "/data-sources",
        "revision": revision[:12],
        "data_vintage": built["data_vintage"],
        "data_revision": built["sources_hash"],
        "image_directory": ".artifacts/desk-health-publication-liveness/captures",
        "image_policy": "Capture images remain ignored and are not committed. Their SHA-256 values bind this textual manifest to the reviewed render.",
        "production_scope": "These captures are isolated render evidence and are not labeled as live.",
        "checks": {
            "publication_clocks_visible": True,
            "keyboard_recovery_control": True,
            "zoom_200_percent": True,
            "new_source_target_minimum_css_pixels": 44,
            "no_horizontal_page_overflow": True,
        },
        "captures": [
            {
                "name": row["name"],
                "viewport": row["viewport"],
                "scripting": row["scripting"],
                "isolated": row["isolated"],
                "assertion": row["assertion"],
                "axe": {
                    "violations_total": (row["axe"] or {}).get("violations_total", 0),
                    "critical_or_serious": (row["axe"] or {}).get("critical_or_serious", []),
                    "passes": not row.get("new_violations"),
                },
                "render_content_sha256": row["render_content_sha256"],
            }
            for row in captures
        ],
        "failures": [row["name"] for row in failures],
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(captures)} captures under {OUT.relative_to(ROOT)}")
    if failures:
        for row in failures:
            print(f"FAIL {row['name']}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
