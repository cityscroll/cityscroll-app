#!/usr/bin/env python3
"""Product screenshots for LDP-31 (procedure-aware timeline).

Captures the real ELURP regression corpus (E1-E4) plus the ordinary ULURP
control at mobile (390x844) and desktop (1440x900) against a local site
build, mocking GET /zap-outcomes with the same fixture records the unit
tests assert against (test/fixtures/land_phase_spine/*.json).

    python3 tools/capture_ldp31_procedure_aware_timeline.py
"""

from __future__ import annotations

import functools
import hashlib
import json
import subprocess
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "test" / "fixtures" / "land_phase_spine"
OUT = ROOT / "artifacts" / "land-procedure-aware-timeline"

# (fixture stem, project_name fallback, brief label for the receipt)
CANARIES = [
    ("2024Q0356", "E1 — active, ordinary §197-e-shaped project"),
    ("2024Q0419", "E2 — completed ordinary §197-e route, C-prefixed identifier"),
    ("2025R0257", "E3 — completed ordinary §197-e route, different action family"),
    ("2026X0362", "E4 — completed special Council-route ELURP (HPD)"),
    ("ulurp_control_2023X0100", "Ordinary ULURP control"),
]

VIEWPORTS = [(390, 844), (1440, 900)]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(ROOT / "_site"))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def load_record(stem: str) -> dict:
    raw = json.loads((FIXTURE_DIR / f"{stem}.json").read_text(encoding="utf-8"))
    return {
        "join": {"matched": True, "method": "exact_project_id", "reason": None},
        "project_id": raw["project_id"],
        "project_name": raw.get("project_name") or raw["project_id"],
        "public_status": raw.get("public_status"),
        "portal_url": raw.get("portal_url"),
        "open_data": raw.get("open_data") or {},
        "actions": raw.get("actions") or [],
        "spine": raw.get("spine") or {"events": []},
        "statutory_clock": None,
        "filled": True,
        "useful": True,
        "city_record_notices": [],
        "predictions": [],
        "zoning_statistics": None,
        "milestones": [],
        "dispositions": [],
        "documents": [],
        "approved_actions": [],
        "n_documents": 0,
        "n_dispositions": 0,
        "dob": {"matched": False},
        "certified_referred": (raw.get("open_data") or {}).get("certified_referred"),
    }


def json_response(route: Route, body: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def install_routes(page: Page, record: dict, project_id: str) -> None:
    page.route("https://**", lambda route: route.abort())
    page.route("https://data.cityofnewyork.us/**", lambda route: json_response(route, []))
    page.route(
        "https://geosearch.planninglabs.nyc/**",
        lambda route: json_response(route, {"features": []}),
    )

    list_row = {
        "project_id": project_id,
        "project_name": record["project_name"],
        "public_status": record.get("public_status"),
        "project_status": "Active",
        "borough": "",
        "community_district": "",
        "actions": record.get("open_data", {}).get("actions"),
        "current_milestone": record.get("open_data", {}).get("current_milestone"),
        "current_milestone_date": record.get("open_data", {}).get("current_milestone_date"),
        "ulurp_numbers": record.get("open_data", {}).get("ulurp_numbers"),
    }

    def zap(route: Route) -> None:
        json_response(route, [list_row])

    def worker(route: Route) -> None:
        path = urlparse(route.request.url).path
        if "/zap-outcomes" in path:
            json_response(route, {"ok": True, "cached": True, "record": record})
        elif "/zap-projects-lookup" in path:
            json_response(route, {"rows": [list_row]})
        else:
            json_response(route, {})

    page.route("https://data.cityofnewyork.us/resource/hgx4-8ukb.json*", zap)
    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://cityscroll-worker.crol-worker.workers.dev/**", worker)


def capture_one(browser, base_url: str, stem: str, label: str) -> list[dict]:
    record = load_record(stem)
    project_id = record["project_id"]
    files = []
    for width, height in VIEWPORTS:
        page = browser.new_page(viewport={"width": width, "height": height})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page, record, project_id)
        page.goto(f"{base_url}#land/{project_id}", wait_until="domcontentloaded")
        page.locator(".land-spine-lead, .land-phase-stepper").first.wait_for(
            state="visible", timeout=45000
        )
        page.wait_for_timeout(300)
        out = OUT / f"{stem}-{width}.png"
        target = page.locator("#land-outcomes, #ldetail").first
        target.screenshot(path=str(out), animations="disabled")
        data = out.read_bytes()
        files.append(
            {
                "name": out.name,
                "stem": stem,
                "label": label,
                "project_id": project_id,
                "route": f"#land/{project_id}",
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "viewport": [width, height],
            }
        )
        if errors:
            print(f"page errors ({stem}, {width}):", errors[:5])
        print("wrote", out)
        page.close()
    return files


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    all_files: list[dict] = []
    with StaticServer() as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for stem, label in CANARIES:
            all_files.extend(capture_one(browser, base_url, stem, label))
        browser.close()

    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()
    receipt = {
        "schema": "cityscroll.land-procedure-aware-timeline.capture.v1",
        "card": "cityscroll-land-decision-path/ldp-31-procedure-aware-timeline",
        "assertion": (
            "Phase selection, grouping, labels, and terminal stages are driven by the "
            "resolved procedure profile plus observed-event topology (A1-A5, A9), never a "
            "fixed ordinary-ULURP rail, for the real ELURP regression corpus (E1-E4) and "
            "one ordinary-ULURP control that proves the compatibility fallback is untouched. "
            "390x844 mobile viewport is captured first per canary (A10)."
        ),
        "revision": revision,
        "vintage": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "canaries": [{"stem": s, "label": l} for s, l in CANARIES],
        "files": all_files,
    }
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print("done", OUT, "files", len(all_files))


if __name__ == "__main__":
    main()
