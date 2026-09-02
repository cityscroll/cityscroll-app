#!/usr/bin/env python3
"""Cold Notice trace: the edge primary body is usable before optional owners settle.

Captures the reader-facing Notice document at 390px and 1440px with the optional
route modules and the client notice read delayed or blocked, and records the
owner-call timing for the pre-boundary ("before") and boundary ("after")
readiness semantics against the same delayed cold trace.

The timings this writes are lab measurements. They are not the production field
distribution and never stand in for the projected reduction.
"""

from __future__ import annotations

import argparse
import functools
import json
import re
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / "docs" / "screenshots" / "notice-primary-readiness"
EVIDENCE = ROOT / "docs" / "evidence" / "notice-primary-readiness"
NOTICE_ID = "20260710020"
UNAVAILABLE_ID = "20991231999"
VIEWPORTS = ((390, 900), (1440, 1000))

# Owners that must not gate content_ready_ms, and the delay each is held for so a
# cold trace can show the boundary reporting while they are still in flight.
DEFERRED_DELAY_MS = 3000
DEFERRED_PATTERNS = (
    "**/money-history.mjs",
    "**/rules.mjs",
    "**/notice-read.mjs",
)

NOTICE_ROW = {
    "request_id": NOTICE_ID,
    "short_title": "Pesticides and Mosquito Control Products",
    "agency_name": "Health and Mental Hygiene",
    "section_name": "Public Comment on Contract Awards",
    "type_of_notice_description": "Notice",
    "additional_description_1": (
        "<p>This is a notice seeking comments about the proposed contract below.</p>"
        "<p><strong>E-PIN:&nbsp;</strong>81626S0021001</p>"
        "<p>Comments must be submitted before July 27, 2026.</p>"
    ),
}


def revision() -> str:
    """Name the exact source state, including an uncommitted working tree."""
    return subprocess.run(
        ["git", "describe", "--always", "--dirty", "--abbrev=9"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout.strip()


def edge_markup(row: dict | None, notice_id: str) -> str:
    """Render the real edge body so the capture measures shipped output."""
    script = (
        'import { renderEdgeNotice } from "./site/pages_edge.mjs";'
        f"const row = {json.dumps(row)};"
        f'process.stdout.write(renderEdgeNotice(row, {json.dumps(notice_id)}));'
    )
    return subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout


def document(markup: str) -> str:
    html = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
    html = html.replace('class="tabpane active"', 'class="tabpane"')
    html = html.replace('id="tab-notice" class="tabpane"', 'id="tab-notice" class="tabpane active"')
    return re.sub(
        r'<div id="noticeview" translate="no">[\s\S]*?</div>\s*<!-- permalink views',
        f'<div id="noticeview" translate="no">{markup}</div><!-- permalink views',
        html,
        count=1,
    )


class QuietHandler(SimpleHTTPRequestHandler):
    pages: dict[str, tuple[int, str]] = {}

    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def do_GET(self) -> None:
        route = self.path.split("?", 1)[0]
        if route in self.pages:
            status, body_text = self.pages[route]
            body = body_text.encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


# Drives the real semantic-milestone seam in the page. "before" reports readiness
# only once the deferred owners settle; "after" reports at the edge boundary.
OWNER_TRACE_JS = """
async ({ origin, deferredDelayMs }) => {
  const seam = await import(`${origin}/rum_static_record_instrumentation.mjs`);
  const milestones = await import(`${origin}/rum_semantic_milestones.mjs`);
  const started = performance.now();
  const edgeNode = document.querySelector("[data-edge-rendered][data-notice-id]");
  const edgeState = seam.noticePrimaryOutcomeFromEdge(edgeNode?.dataset.edgeRendered);

  // Deferred owners: started at the boundary, settling only after the delay.
  const deferredOwners = ["money-history", "rules", "notice-read"];
  const calledAt = performance.now();
  const deferred = deferredOwners.map((owner) => new Promise((resolve) => {
    setTimeout(() => resolve({ owner, settled_at_ms: performance.now() - started }), deferredDelayMs);
  }));

  function reporter() {
    const records = [];
    return {
      records,
      rum: milestones.createRumSemanticMilestones({
        enabled: true,
        navigationStart: started,
        now: () => performance.now(),
        record: (value) => records.push(value),
      }),
    };
  }

  // after: the edge body is the boundary.
  const after = reporter();
  const afterAt = seam.noticePrimaryOwnerNow();
  seam.noticePrimaryReady(after.rum, { resultState: edgeState }, afterAt);
  const afterMs = after.records[0]?.value ?? null;
  const bodyUsableWhileDeferredPending = Boolean(
    edgeNode && edgeNode.getBoundingClientRect().height > 0,
  );

  // before: readiness waits for every deferred owner, as the route once did.
  const settled = await Promise.all(deferred);
  const before = reporter();
  seam.noticePrimaryReady(before.rum, { resultState: edgeState }, seam.noticePrimaryOwnerNow());
  const beforeMs = before.records[0]?.value ?? null;

  return {
    edge_result_state: edgeState,
    body_usable_while_deferred_pending: bodyUsableWhileDeferredPending,
    deferred_called_at_ms: calledAt - started,
    deferred_settled: settled,
    after_content_ready_ms: afterMs,
    before_content_ready_ms: beforeMs,
    after_result_state: after.records[0]?.result_state ?? null,
    after_metric_id: after.records[0]?.metric_id ?? null,
    after_surface_id: after.records[0]?.surface_id ?? null,
    after_component_id: after.records[0]?.component_id ?? null,
  };
};
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(EVIDENCE / "cold-trace.json"))
    args = parser.parse_args()

    QuietHandler.pages = {
        f"/notices/{NOTICE_ID}": (200, document(edge_markup(NOTICE_ROW, NOTICE_ID))),
        f"/notices/{UNAVAILABLE_ID}": (404, document(edge_markup(None, UNAVAILABLE_ID))),
    }
    SHOTS.mkdir(parents=True, exist_ok=True)
    EVIDENCE.mkdir(parents=True, exist_ok=True)

    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    captures: list[dict] = []

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for scenario, notice_id, selector in (
                ("primary-body", NOTICE_ID, '[data-edge-rendered="notice"]'),
                ("unavailable", UNAVAILABLE_ID, '[data-edge-rendered="notice-unavailable"]'),
            ):
                for width, height in VIEWPORTS:
                    # Cold cache: a fresh context holds no HTTP or module cache.
                    context = browser.new_context(viewport={"width": width, "height": height})
                    for pattern in DEFERRED_PATTERNS:
                        context.route(pattern, lambda route: route.abort())
                    page = context.new_page()
                    page.goto(f"{origin}/notices/{notice_id}", wait_until="domcontentloaded")
                    panel = page.locator(selector)
                    panel.wait_for(state="visible")
                    text = panel.inner_text()
                    assert text.strip(), "the primary body must carry readable content"
                    if scenario == "unavailable":
                        assert "Pesticides" not in text, "an edge failure must not render as content"
                    shot = SHOTS / f"{scenario}-{width}.png"
                    page.screenshot(path=str(shot), full_page=True)
                    captures.append({
                        "scenario": scenario,
                        "route": f"/notices/{notice_id}",
                        "viewport_px": width,
                        "cache_state": "cold",
                        "deferred_owners": "blocked",
                        "screenshot": str(shot.relative_to(ROOT)),
                        "edge_result_state": panel.get_attribute("data-edge-rendered"),
                        "demonstrates": (
                            "the edge-rendered primary body is usable with every optional owner blocked"
                            if scenario == "primary-body"
                            else "an edge failure renders an honest unavailable state, never a success"
                        ),
                    })
                    context.close()

            # Owner-call timing on a cold mobile trace with the optional owners delayed.
            context = browser.new_context(viewport={"width": 390, "height": 900})
            page = context.new_page()
            page.goto(f"{origin}/notices/{NOTICE_ID}", wait_until="domcontentloaded")
            timing = page.evaluate(
                OWNER_TRACE_JS,
                {"origin": origin, "deferredDelayMs": DEFERRED_DELAY_MS},
            )
            context.close()
            browser.close()
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()

    assert timing["after_metric_id"] == "content_ready_ms"
    assert timing["after_surface_id"] == "notice"
    assert timing["after_component_id"] == "none"
    assert timing["edge_result_state"] == "content"
    assert timing["body_usable_while_deferred_pending"] is True
    assert timing["after_content_ready_ms"] < timing["before_content_ready_ms"]

    receipt = {
        "schema": "cityscroll.notice_primary_readiness_cold_trace.v1",
        "version": 1,
        "measurement_class": "lab",
        "revision": revision(),
        "route": f"/notices/{NOTICE_ID}",
        "cache_state": "cold",
        "deferred_owner_delay_ms": DEFERRED_DELAY_MS,
        "identity": {
            "metric_id": timing["after_metric_id"],
            "surface_id": timing["after_surface_id"],
            "component_id": timing["after_component_id"],
        },
        "owner_call_timing_ms": {
            "before": round(timing["before_content_ready_ms"], 1),
            "after": round(timing["after_content_ready_ms"], 1),
            "observed_difference": round(
                timing["before_content_ready_ms"] - timing["after_content_ready_ms"], 1,
            ),
            # The gap is bounded by the delay this trace injects, so it measures
            # the ordering property and not any real-world saving.
            "difference_is_bounded_by_injected_delay": True,
            "injected_delay_ms": DEFERRED_DELAY_MS,
        },
        "deferred_owners": timing["deferred_settled"],
        "body_usable_while_deferred_pending": timing["body_usable_while_deferred_pending"],
        "captures": captures,
        "interpretation": (
            "A single cold lab trace. 'before' is the pre-boundary semantics in which readiness "
            "waits for the deferred owners; 'after' is the shipped boundary. What this trace "
            "establishes is the ordering property: the primary body is usable and readiness is "
            "recorded while every deferred owner is still in flight. The size of the gap is an "
            "artifact of the delay the trace injects, not a measured saving, so it corroborates "
            "neither the projected 3,000-7,000 ms range nor any production "
            "p50/p75/p95 result. Only a grouped production before/after window can do that, and "
            "no such window has been collected; see read-back.json."
        ),
    }
    Path(args.out).write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {Path(args.out).relative_to(ROOT)} and {len(captures)} captures")


if __name__ == "__main__":
    main()
