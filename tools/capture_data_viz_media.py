#!/usr/bin/env python3
"""Capture deterministic before/after evidence for data.html chart encodings.

The fixture values are a production snapshot observed on 2026-07-27 from the live
NYC Open Data-backed page at https://crol-list.org/data.html. Both revisions receive
the same responses, so the screenshots isolate rendering and encoding changes.

Run before committing:

    python3 tools/capture_data_viz_media.py --before-revision HEAD

Run after committing:

    python3 tools/capture_data_viz_media.py --before-revision HEAD^

Requires Python Playwright with Chromium:

    pip install playwright && playwright install chromium
"""

from __future__ import annotations

import argparse
import functools
import json
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "media" / "review" / "data-viz-intuitive"
SOURCE = "https://crol-list.org/data.html"
OBSERVED_AT = "2026-07-27"

FIXTURES = {
    "sections": [
        {"section_name": "Changes in Personnel", "n": "959659"},
        {"section_name": "Procurement", "n": "105044"},
        {"section_name": "Contract Award Hearings", "n": "10505"},
        {"section_name": "Public Hearings and Meetings", "n": "8932"},
        {"section_name": "Special Materials", "n": "8131"},
        {"section_name": "Agency Rules", "n": "3061"},
        {"section_name": "Public Comment on Contract Awards", "n": "929"},
        {"section_name": "Property Disposition", "n": "243"},
        {"section_name": "Court Notices", "n": "155"},
    ],
    "volume": [
        {"m": "2025-07-01T00:00:00.000", "n": "134"},
        {"m": "2025-08-01T00:00:00.000", "n": "8271"},
        {"m": "2025-09-01T00:00:00.000", "n": "7117"},
        {"m": "2025-10-01T00:00:00.000", "n": "5931"},
        {"m": "2025-11-01T00:00:00.000", "n": "4589"},
        {"m": "2025-12-01T00:00:00.000", "n": "4339"},
        {"m": "2026-01-01T00:00:00.000", "n": "7525"},
        {"m": "2026-02-01T00:00:00.000", "n": "4522"},
        {"m": "2026-03-01T00:00:00.000", "n": "8261"},
        {"m": "2026-04-01T00:00:00.000", "n": "3644"},
        {"m": "2026-05-01T00:00:00.000", "n": "2496"},
        {"m": "2026-06-01T00:00:00.000", "n": "1114"},
        {"m": "2026-07-01T00:00:00.000", "n": "620"},
    ],
    "procmix": [
        {"t": "Award", "n": "3237"},
        {"t": "Solicitation", "n": "929"},
        {"t": "Intent to Award", "n": "488"},
        {"t": "Vendor List", "n": "13"},
    ],
    "agencies": [
        {"agency_name": "Homeless Services", "total": "4610000000"},
        {"agency_name": "Administration for Children's Services", "total": "4260000000"},
        {"agency_name": "Citywide Administrative Services", "total": "3350000000"},
        {"agency_name": "Small Business Services", "total": "2620000000"},
        {"agency_name": "Transportation", "total": "1750000000"},
        {"agency_name": "Health and Mental Hygiene", "total": "1530000000"},
        {"agency_name": "Environmental Protection", "total": "1240000000"},
        {"agency_name": "Information Technology and Telecommunications", "total": "1190000000"},
        {"agency_name": "Design and Construction", "total": "1130000000"},
        {"agency_name": "Youth and Community Development", "total": "985300000"},
    ],
    "vendors": [
        {"vendor_name": "New York City Economic Development Corporation", "total": "2130000000"},
        {"vendor_name": "Common Ground Management Corp", "total": "1050000000"},
        {"vendor_name": "American Traffic Solutions, Inc.", "total": "998500000"},
        {"vendor_name": "Group Health Incorporated", "total": "950000000"},
        {"vendor_name": "Universal Protection Service LLC", "total": "948300000"},
        {"vendor_name": "Dell Marketing L.P.", "total": "573800000"},
        {"vendor_name": "SCO Family of Services", "total": "436100000"},
        {"vendor_name": "Aron Security Inc", "total": "428800000"},
        {"vendor_name": "Inter-Con Security Systems Incorporated", "total": "399700000"},
        {"vendor_name": "Governors Island Corporation", "total": "394100000"},
    ],
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path):
        handler = functools.partial(QuietHandler, directory=str(directory))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def run(*args: str, capture: bool = False) -> str:
    result = subprocess.run(
        args,
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else ""


def export_revision(destination: Path, revision: str) -> None:
    destination.mkdir()
    archive = subprocess.Popen(
        ["git", "archive", revision],
        cwd=ROOT,
        stdout=subprocess.PIPE,
    )
    assert archive.stdout is not None
    try:
        subprocess.run(
            ["tar", "-x", "-C", str(destination)],
            stdin=archive.stdout,
            check=True,
        )
    finally:
        archive.stdout.close()
    if archive.wait() != 0:
        raise subprocess.CalledProcessError(archive.returncode, ["git", "archive", revision])


def json_response(route: Route, body: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def install_routes(page: Page) -> None:
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())

    def soda(route: Route) -> None:
        query = {key: values[0] for key, values in parse_qs(urlparse(route.request.url).query).items()}
        select = query.get("$select", "")
        if "section_name,count(request_id)" in select:
            payload = FIXTURES["sections"]
        elif "date_trunc_ym(start_date)" in select:
            payload = FIXTURES["volume"]
        elif "type_of_notice_description" in select and "count(request_id)" in select:
            payload = FIXTURES["procmix"]
        elif "agency_name,sum(contract_amount)" in select:
            payload = FIXTURES["agencies"]
        elif "vendor_name,sum(contract_amount)" in select:
            payload = FIXTURES["vendors"]
        else:
            raise AssertionError(f"Unexpected data.html query: {select}")
        json_response(route, payload)

    page.route("https://data.cityofnewyork.us/resource/dg92-zbpx.json*", soda)


def measure(page: Page) -> dict:
    return page.evaluate(
        """() => Object.fromEntries([...document.querySelectorAll('.bars')].map(group => [
          group.id,
          {
            encoding: group.dataset.encoding || 'legacy-ranking',
            rows: [...group.querySelectorAll('.bar')].map(row => {
              const fill = row.querySelector('.fil');
              const track = row.querySelector('.trk');
              return {
                label: row.querySelector('.lbl').textContent.trim(),
                value: row.querySelector('.val').textContent.trim(),
                cssWidth: fill.style.width,
                fillPx: Number(fill.getBoundingClientRect().width.toFixed(2)),
                trackPx: Number(track.getBoundingClientRect().width.toFixed(2)),
                renderedPct: Number((fill.getBoundingClientRect().width / track.getBoundingClientRect().width * 100).toFixed(2)),
              };
            }),
          },
        ]))"""
    )


def annotate(page: Page, state: str, measurements: dict) -> None:
    notes = {}
    for chart_id, chart in measurements.items():
        fill_widths = [row["fillPx"] for row in chart["rows"]]
        if state == "before":
            notes[chart_id] = (
                f"BEFORE · RENDERING FAILURE · {len(fill_widths)} fills measure "
                f"{min(fill_widths):g}–{max(fill_widths):g} px"
            )
        elif chart["encoding"] == "composition":
            total = sum(float(row["cssWidth"].rstrip("%")) for row in chart["rows"])
            notes[chart_id] = f"AFTER · COMPOSITION · widths total {total:.2f}%; value + share labeled"
        else:
            notes[chart_id] = "AFTER · RANKING · largest value is the 100% baseline; every value labeled"

    page.evaluate(
        """({state, notes}) => {
          const style = document.createElement('style');
          style.textContent = `
            .evidence-note {
              margin: 8px 0 10px;
              padding: 6px 9px;
              border-inline-start: 4px solid var(--oxblood);
              background: var(--card);
              color: var(--ink-soft);
              box-shadow: var(--shadow);
              font: 700 11px/1.35 var(--ui);
              letter-spacing: .03em;
            }
            .evidence-before .trk { outline: 2px solid var(--oxblood); outline-offset: 1px; }
          `;
          document.head.appendChild(style);
          if (state === 'before') document.body.classList.add('evidence-before');
          Object.entries(notes).forEach(([id, text]) => {
            const group = document.getElementById(id);
            const note = document.createElement('div');
            note.className = 'evidence-note';
            note.textContent = text;
            group.parentNode.insertBefore(note, group);
          });
        }""",
        {"state": state, "notes": notes},
    )


def capture_state(browser, tree: Path, state: str, measurements: dict) -> None:
    with StaticServer(tree) as base_url:
        for width, height in ((390, 844), (1440, 900)):
            context = browser.new_context(
                viewport={"width": width, "height": height},
                device_scale_factor=1,
                locale="en-US",
            )
            page = context.new_page()
            install_routes(page)
            page.goto(f"{base_url}data.html", wait_until="networkidle")
            page.locator("#vendors .bar").nth(9).wait_for(state="visible")
            page.evaluate("document.fonts && document.fonts.ready")
            if page.evaluate("document.documentElement.scrollWidth > innerWidth"):
                raise AssertionError(f"{state} data.html overflows horizontally at {width}px")
            measured = measure(page)
            measurements[f"{state}-{width}"] = measured
            page.screenshot(path=OUTPUT / f"{state}-{width}.png", full_page=True, animations="disabled")
            annotate(page, state, measured)
            page.screenshot(
                path=OUTPUT / f"{state}-{width}-annotated.png",
                full_page=True,
                animations="disabled",
            )
            context.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--before-revision", default="HEAD")
    args = parser.parse_args()

    revision = run("git", "rev-parse", f"{args.before_revision}^{{commit}}", capture=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    measurements = {
        "source": SOURCE,
        "observedAt": OBSERVED_AT,
        "beforeRevision": revision,
        "fixture": FIXTURES,
        "captures": {},
    }

    with tempfile.TemporaryDirectory(prefix="crol-data-viz-") as temp:
        before_tree = Path(temp) / "before"
        export_revision(before_tree, revision)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            capture_state(browser, before_tree, "before", measurements["captures"])
            capture_state(browser, ROOT, "after", measurements["captures"])
            browser.close()

    (OUTPUT / "measurements.json").write_text(
        json.dumps(measurements, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Captured data visualization evidence from {revision[:12]} before and the current tree after:")
    for asset in sorted(OUTPUT.iterdir()):
        print(f"  {asset.relative_to(ROOT)}  {asset.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
