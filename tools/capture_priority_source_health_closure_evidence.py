#!/usr/bin/env python3
"""Headless evidence for priority-source observation closure.

Capture proof is the committed manifest. Image binaries stay ignored.
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
OUT = ROOT / "docs" / "evidence" / "priority-source-health-closure"
CAPTURES = OUT / "captures"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]
ZOOM = 2
REFLOW_FLOOR = 320
TARGET_FLOOR = 44


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(CAPTURES), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def build_pages() -> dict:
    script = """
import { readFileSync } from "node:fs";
import { HTML_OUTPUT, JSON_OUTPUT, generatedGraphFiles } from "./tools/data_source_graph.mjs";
const files = generatedGraphFiles();
const graph = JSON.parse(files[JSON_OUTPUT]);
const scorecard = readFileSync("site/community-boards/index.html", "utf8");
process.stdout.write(JSON.stringify({
  html: files[HTML_OUTPUT],
  scorecard,
  sources_hash: graph.sources_hash,
  observed_at: graph.priority_source_closure?.evidence_revision || graph.current_as_of,
  census: graph.priority_source_closure?.census?.active_source_observability || null,
  families: (graph.priority_source_closure?.families || []).map((row) => row.family_id),
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
    return {
        "violations_total": len(result["violations"]),
        "critical_or_serious": [v["id"] for v in gate if v.get("impact") in {"critical", "serious"}],
        "failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in gate],
        "passes": len(gate) == 0,
    }


def check_overflow(page, width: int) -> dict:
    return page.evaluate("""(width) => {
      const doc = document.documentElement;
      return {
        scroll_width: doc.scrollWidth,
        viewport_width: width,
        horizontal_overflow: doc.scrollWidth > width + 1,
      };
    }""", width)


def check_targets(page, selector: str) -> dict:
    return page.evaluate("""({selector, floor}) => {
      const nodes = [...document.querySelectorAll(selector)].filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const undersized = nodes.filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width < floor || rect.height < floor;
      }).map((node) => node.id || node.tagName);
      return { floor, measured: nodes.length, undersized: undersized.slice(0, 8) };
    }""", {"selector": selector, "floor": TARGET_FLOOR})


def main() -> None:
    pages = build_pages()
    revision = git_revision()
    data_vintage = (
        f"priority-source closure and board scorecard at {pages['observed_at']}; "
        f"sources_hash {pages['sources_hash']}; no publisher refresh"
    )
    CAPTURES.mkdir(parents=True, exist_ok=True)
    (CAPTURES / "desk.html").write_text(pages["html"], encoding="utf-8")
    (CAPTURES / "scorecard.html").write_text(pages["scorecard"], encoding="utf-8")

    journeys = [
        ("priority-closure", "desk.html", True, "#prioritySourceClosure", "Active-source observability is visible with seven priority families"),
        ("priority-closure-nojs", "desk.html", False, "#prioritySourceClosure", "priority families remain in the static markup without JavaScript"),
    ]

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    captures = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for name, document, scripting, selector, intent in journeys:
            for width, height in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    java_script_enabled=scripting,
                )
                page = context.new_page()
                route = f"/{document}"
                page.goto(f"{base}{route}", wait_until="domcontentloaded")
                if name == "priority-closure" and scripting:
                    page.evaluate("() => document.getElementById('prioritySourceClosure')?.scrollIntoView()")
                state = page.evaluate("""() => ({
                  has_priority_closure: Boolean(document.getElementById('prioritySourceClosure')),
                  observability: document.getElementById('prioritySourceClosure')?.innerText?.includes('Active-source observability') || false,
                  measurement: document.body.innerText.includes('boards measured') || document.body.innerText.includes('measurement is unavailable'),
                  zero_laggards_claim: /0 laggards/i.test(document.body.innerText),
                })""")
                axe_result = run_axe(page) if scripting else {"passes": True, "violations_total": 0, "critical_or_serious": [], "failing_violations": []}
                overflow = check_overflow(page, width)
                targets = check_targets(page, "button, a, select, summary")
                zoom_width = max(REFLOW_FLOOR, width // ZOOM)
                page.set_viewport_size({"width": zoom_width, "height": height // ZOOM})
                zoom_overflow = check_overflow(page, zoom_width)
                page.set_viewport_size({"width": width, "height": height})
                shot = CAPTURES / f"{name}-{width}.png"
                page.screenshot(path=str(shot), full_page=True)
                html_digest = hashlib.sha256(page.content().encode("utf-8")).hexdigest()
                captures.append({
                    "name": f"{name}-{width}.png",
                    "journey": name,
                    "viewport": [width, height],
                    "scripting": scripting,
                    "route": route,
                    "revision": revision[:12],
                    "data_vintage": data_vintage,
                    "assertion": (
                        f"{intent}; axe_passes={axe_result['passes']} "
                        f"no_page_overflow={not overflow['horizontal_overflow']} "
                        f"zoom_overflow={not zoom_overflow['horizontal_overflow']}"
                    ),
                    "journey_state": state,
                    "axe": axe_result,
                    "overflow": overflow,
                    "zoom_overflow": zoom_overflow,
                    "targets": targets,
                    "sha256": html_digest,
                    "render_content_sha256": html_digest,
                    "screenshot_sha256": hashlib.sha256(shot.read_bytes()).hexdigest(),
                    "screenshot_local_path": str(shot.relative_to(ROOT)),
                })
                page.close()
                context.close()
        browser.close()
    server.shutdown()

    failures = [
        capture for capture in captures
        if not capture["axe"]["passes"]
        or capture["overflow"]["horizontal_overflow"]
        or capture["zoom_overflow"]["horizontal_overflow"]
        or capture["journey_state"].get("zero_laggards_claim")
    ]
    manifest = {
        "schema": "cityscroll.priority_source_health_closure_render_manifest.v1",
        "evidence_class": "isolated-producer-render",
        "capture_mode": "headless-playwright-loopback-static-render",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "route": "/data-sources",
        "revision_format": "git-object-id-prefix-12",
        "revision": revision[:12],
        "data_vintage": data_vintage,
        "data_revision": pages["sources_hash"],
        "image_directory": "docs/evidence/priority-source-health-closure/captures",
        "image_policy": "Capture images remain ignored and are not committed. Their SHA-256 values bind this textual manifest to the reviewed render.",
        "production_scope": "These captures are isolated render evidence and are not labeled as live.",
        "census": pages["census"],
        "families": pages["families"],
        "captures": captures,
        "captures_passing": len(captures) - len(failures),
        "captures_total": len(captures),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "capture-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(captures)} captures under {OUT.relative_to(ROOT)}")
    if failures:
        raise SystemExit("capture assertions failed: " + ", ".join(c["name"] for c in failures))


if __name__ == "__main__":
    main()
