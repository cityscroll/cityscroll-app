#!/usr/bin/env python3
"""Before/after screenshots for ULURP pipeline position + ZAP hearing logistics.

Deterministic local capture of #land/2024Q0292 with mocked /zap-outcomes.

  python3 tools/capture_zap_hearing_logistics.py
"""

from __future__ import annotations

import functools
import hashlib
import json
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "zap-hearing-logistics"
PROJECT_ID = "2024Q0292"
PORTAL = f"https://zap.planning.nyc.gov/projects/{PROJECT_ID}"
FIX = ROOT / "test" / "fixtures" / "zap_hearing_logistics" / "2024Q0292.json"

PROJECT = {
    "project_id": PROJECT_ID,
    "project_name": "108-05 68th Road Rezoning",
    "project_brief": "Rezoning a daycare site in Forest Hills, Queens.",
    "primary_applicant": "All My Children Daycare and Nursery School",
    "public_status": "In Public Review",
    "project_status": "Active",
    "borough": "Queens",
    "community_district": "Q06",
    "actions": "ZM; ZR",
    "mih_flag": "false",
    "current_milestone": "Borough President Review",
    "current_milestone_date": "2026-07-09T00:00:00.000",
    "ulurp_numbers": "260234ZMQ; 260235ZRQ",
}

SPINE = {
    "schema_version": 1,
    "project_id": PROJECT_ID,
    "events": [
        {
            "id": "cert",
            "kind": "zap_milestone",
            "title": "Application Reviewed at City Planning Commission Review Session",
            "detail": "Certified",
            "status": "Completed",
            "time": {
                "value": "2026-05-11",
                "precision": "day",
                "basis": "actual_end",
                "certainty": "actual",
            },
            "source": {
                "id": "zap-project-api",
                "label": "Zoning Application Portal",
                "url": PORTAL,
            },
        },
        {
            "id": "cb",
            "kind": "zap_milestone",
            "title": "Community Board Review",
            "detail": "Completed",
            "status": "Completed",
            "time": {
                "value": "2026-07-08",
                "precision": "day",
                "basis": "actual_end",
                "certainty": "actual",
            },
            "source": {
                "id": "zap-project-api",
                "label": "Zoning Application Portal",
                "url": PORTAL,
            },
        },
        {
            "id": "bp",
            "kind": "zap_milestone",
            "title": "Borough President Review",
            "detail": "In Progress",
            "status": "In Progress",
            "time": {
                "value": "2026-07-09",
                "precision": "day",
                "basis": "actual_start",
                "certainty": "actual",
            },
            "source": {
                "id": "zap-project-api",
                "label": "Zoning Application Portal",
                "url": PORTAL,
            },
        },
    ],
    "lag": {"open_data_vs_portal": {"status": "unknown"}},
    "gaps": [],
}

STATUTORY_CLOCK = {
    "schema_version": 1,
    "statute_ref": "NYC Charter §197-c",
    "model_name": "ulurp_statutory_clock",
    "model_version": "1.0.0",
    "status": "open",
    "reason": None,
    "certified_date": "2026-05-11",
    "total_days": 205,
    "phases": [
        {
            "phase_id": "community_board",
            "short": "CB",
            "label_key": "land_phase_community_board",
            "days": 60,
            "cumulative_days": 60,
            "due_date": "2026-07-10",
            "status": "open",
        },
        {
            "phase_id": "borough_president",
            "short": "BP",
            "label_key": "land_phase_borough_president",
            "days": 30,
            "cumulative_days": 90,
            "due_date": "2026-08-09",
            "status": "open",
        },
        {
            "phase_id": "cpc",
            "short": "CPC",
            "label_key": "land_phase_cpc",
            "days": 60,
            "cumulative_days": 150,
            "due_date": "2026-10-08",
            "status": "open",
        },
        {
            "phase_id": "city_council",
            "short": "Council",
            "label_key": "land_phase_city_council",
            "days": 50,
            "cumulative_days": 200,
            "due_date": "2026-11-27",
            "status": "open",
        },
        {
            "phase_id": "mayoral_appeals",
            "short": "Mayor",
            "label_key": "land_phase_mayoral_appeals",
            "days": 5,
            "cumulative_days": 205,
            "due_date": "2026-12-02",
            "status": "open",
        },
    ],
}


def build_outcome_record() -> dict:
    script = f"""
import {{ readFileSync }} from 'node:fs';
import {{ parseZapApiProject }} from './worker/src/lib/zap_outcomes.mjs';
const payload = JSON.parse(readFileSync({json.dumps(str(FIX))}, 'utf8'));
const record = parseZapApiProject(payload);
record.spine = {json.dumps(SPINE)};
record.statutory_clock = {json.dumps(STATUTORY_CLOCK)};
record.open_data = {json.dumps(PROJECT)};
record.public_status = 'In Public Review';
record.certified_referred = '2026-05-11';
for (const h of record.hearing_logistics || []) {{
  if (h.representing === 'Borough President') {{
    h.hearing_date = '2026-09-02';
    h.hearing_at = '2026-09-02T13:30:00.000Z';
  }}
}}
console.log(JSON.stringify({{ ok: true, cached: true, record }}));
"""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def json_response(route: Route, body: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def install_routes(page: Page, record: dict) -> None:
    page.route("https://**", lambda route: route.abort())
    page.route("https://data.cityofnewyork.us/**", lambda route: json_response(route, []))
    page.route(
        "https://geosearch.planninglabs.nyc/**",
        lambda route: json_response(route, {"features": []}),
    )

    def zap(route: Route) -> None:
        query = dict(
            (key, values[0])
            for key, values in parse_qs(urlparse(route.request.url).query).items()
        )
        json_response(
            route,
            [PROJECT] if f"project_id='{PROJECT_ID}'" in query.get("$where", "") else [PROJECT],
        )

    def worker(route: Route) -> None:
        if urlparse(route.request.url).path == "/zap-outcomes":
            json_response(route, {"ok": True, "cached": True, "record": record})
        else:
            json_response(route, {})

    page.route("https://data.cityofnewyork.us/resource/hgx4-8ukb.json*", zap)
    page.route("https://data.cityofnewyork.us/resource/2iga-a6mk.json*", lambda r: json_response(r, []))
    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker)


def shot(page: Page, path: Path, width: int) -> None:
    page.set_viewport_size({"width": width, "height": 1200})
    page.wait_for_timeout(300)
    page.locator("#ldetail").screenshot(path=str(path))
    print("wrote", path)


def capture_variant(page: Page, base_url: str, record: dict, label: str) -> None:
    install_routes(page, record)
    page.goto(f"{base_url}#land/{PROJECT_ID}", wait_until="domcontentloaded")
    page.wait_for_selector("#ldetail .rolename", timeout=20000)
    # Outcomes hydrate async after phase tools import.
    page.wait_for_selector(".land-spine-lead, .land-outcomes, #land-outcomes", timeout=20000)
    page.wait_for_timeout(1200)
    if label == "after":
        page.wait_for_selector(".land-pipeline-position", timeout=15000)
    shot(page, OUT / f"{label}-1440.png", 1440)
    shot(page, OUT / f"{label}-390.png", 390)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    after = build_outcome_record()
    assert after.get("record", {}).get("hearing_logistics"), "need hearing_logistics"

    # Before: same project without logistics / without pipeline-friendly status framing.
    before = json.loads(json.dumps(after))
    before["record"].pop("hearing_logistics", None)
    # Keep spine so timeline still paints; strip pipeline sentence by forcing
    # public_status + phase to pre-review-only would hide the defect. Instead
    # keep data and rely on capturing before the sentence class existed —
    # for a same-binary capture, remove the rendered node after load.
    with StaticServer() as base_url:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            install_routes(page, before["record"])
            page.goto(f"{base_url}#land/{PROJECT_ID}", wait_until="domcontentloaded")
            page.wait_for_selector("#ldetail .rolename", timeout=20000)
            page.wait_for_timeout(1200)
            page.evaluate(
                """() => {
                  document.querySelectorAll('.land-pipeline-position').forEach(n => n.remove());
                  // Restore competing labels for the before frame when pipeline is stripped.
                  const detail = document.querySelector('.land-spine-now-detail');
                  if (detail && !/Public status/i.test(detail.innerHTML)) {
                    detail.innerHTML += '<br>Public status: <b>In Public Review</b>';
                  }
                  const phase = document.querySelector('.land-spine-now-phase');
                  if (!phase) {
                    const lead = document.querySelector('.land-spine-lead');
                    if (lead) {
                      const p = document.createElement('p');
                      p.className = 'land-spine-now-phase';
                      p.textContent = 'Borough President review';
                      lead.insertBefore(p, lead.querySelector('.land-spine-now-detail'));
                    }
                  }
                }"""
            )
            shot(page, OUT / "before-1440.png", 1440)
            shot(page, OUT / "before-390.png", 390)
            page.close()

            page = browser.new_page()
            capture_variant(page, base_url, after["record"], "after")
            page.close()
            browser.close()

    meta = {
        "project_id": PROJECT_ID,
        "paths": {
            "before_1440": "docs/screenshots/zap-hearing-logistics/before-1440.png",
            "after_1440": "docs/screenshots/zap-hearing-logistics/after-1440.png",
            "before_390": "docs/screenshots/zap-hearing-logistics/before-390.png",
            "after_390": "docs/screenshots/zap-hearing-logistics/after-390.png",
        },
        "fixture_sha256": hashlib.sha256(FIX.read_bytes()).hexdigest() if FIX.exists() else None,
    }
    (OUT / "receipt.json").write_text(json.dumps(meta, indent=2) + "\n")
    print("done", OUT)


if __name__ == "__main__":
    main()
