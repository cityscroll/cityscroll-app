#!/usr/bin/env python3
"""Before/after screenshots for ULURP statutory-clock deadlines on the land timeline."""

from __future__ import annotations

import functools
import hashlib
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "ulurp-statutory-clock"
PROJECT_ID = "FIXTURED0001"
PROJECT = {
    "project_id": PROJECT_ID,
    "project_name": "Statutory clock certify fixture",
    "project_brief": "Fixture project certified into ULURP public review for statutory deadline rendering.",
    "primary_applicant": "NYC Housing Preservation and Development",
    "public_status": "In Public Review",
    "project_status": "Active",
    "borough": "Manhattan",
    "community_district": "M11",
    "actions": "ZM",
    "mih_flag": "false",
    "current_milestone": "Community Board Review",
    "current_milestone_date": "2024-01-20T00:00:00.000",
    "ulurp_numbers": "240100ZMM",
}
PORTAL = f"https://zap.planning.nyc.gov/projects/{PROJECT_ID}"
SPINE = {
    "schema_version": 1,
    "project_id": PROJECT_ID,
    "events": [
        {
            "id": "m1",
            "kind": "zap_milestone",
            "title": "Land Use Application Filed",
            "detail": "Completed",
            "time": {
                "value": "2023-11-01",
                "precision": "day",
                "basis": "actual_end",
                "certainty": "actual",
            },
            "source": {"id": "zap-project-api", "label": "Zoning Application Portal", "url": PORTAL},
        },
        {
            "id": "cert-1",
            "kind": "zap_milestone",
            "title": "Application Reviewed at City Planning Commission Review Session",
            "detail": "Certified",
            "status": "Certified",
            "time": {
                "value": "2024-01-15",
                "precision": "day",
                "basis": "actual_end",
                "certainty": "actual",
            },
            "source": {"id": "zap-project-api", "label": "Zoning Application Portal", "url": PORTAL},
        },
        {
            "id": "cb-planned",
            "kind": "zap_milestone",
            "title": "Community Board Review",
            "detail": "Not Started",
            "status": "Not Started",
            "time": {
                "value": "2024-03-15",
                "precision": "day",
                "basis": "planned_completion",
                "certainty": "planned",
            },
            "source": {"id": "zap-project-api", "label": "Zoning Application Portal", "url": PORTAL},
        },
    ],
    "gaps": [],
    "lag": {
        "open_data_vs_portal": {
            "status": "aligned",
            "days": 0,
            "open_data_date": "2024-01-15",
            "portal_date": "2024-01-15",
        }
    },
}

STATUTORY_CLOCK = {
    "schema_version": 1,
    "statute_ref": "NYC Charter §197-c",
    "model_name": "ulurp_statutory_clock",
    "model_version": "1.0.0",
    "status": "open",
    "reason": None,
    "certified_date": "2024-01-15",
    "total_days": 205,
    "phases": [
        {
            "phase_id": "community_board",
            "short": "CB",
            "label_key": "land_phase_community_board",
            "days": 60,
            "cumulative_days": 60,
            "model_stage": "community_board",
            "due_date": "2024-03-15",
            "statute_ref": "NYC Charter §197-c",
            "status": "open",
        },
        {
            "phase_id": "borough_president",
            "short": "BP",
            "label_key": "land_phase_borough_president",
            "days": 30,
            "cumulative_days": 90,
            "model_stage": "borough_president",
            "due_date": "2024-04-14",
            "statute_ref": "NYC Charter §197-c",
            "status": "open",
        },
        {
            "phase_id": "cpc",
            "short": "CPC",
            "label_key": "land_phase_cpc",
            "days": 60,
            "cumulative_days": 150,
            "model_stage": "cpc",
            "due_date": "2024-06-13",
            "statute_ref": "NYC Charter §197-c",
            "status": "open",
        },
        {
            "phase_id": "city_council",
            "short": "Council",
            "label_key": "land_phase_city_council",
            "days": 50,
            "cumulative_days": 200,
            "model_stage": "city_council",
            "due_date": "2024-08-02",
            "statute_ref": "NYC Charter §197-c",
            "status": "open",
        },
        {
            "phase_id": "mayoral_appeals",
            "short": "Mayor",
            "label_key": "land_phase_mayoral_appeals",
            "days": 5,
            "cumulative_days": 205,
            "model_stage": "mayoral_appeals",
            "due_date": "2024-08-07",
            "statute_ref": "NYC Charter §197-c",
            "status": "open",
        },
    ],
    "disposition": {
        "phase_id": "disposition",
        "predicted_event_kind": "land.zap_disposition",
        "due_date": "2024-08-07",
        "cumulative_days": 205,
        "statute_ref": "NYC Charter §197-c",
        "status": "open",
    },
    "evidence_event_ids": ["cert-1"],
    "generated_at": "2024-01-16T12:00:00Z",
}


def base_record(*, with_clock: bool) -> dict:
    record = {
        "project_id": PROJECT_ID,
        "project_name": PROJECT["project_name"],
        "public_status": "In Public Review",
        "certified_referred": "2024-01-15",
        "portal_url": PORTAL,
        "join": {"matched": True, "method": "exact_project_id"},
        "filled": True,
        "n_documents": 0,
        "approved_actions": [],
        "dispositions": [],
        "documents": [],
        "dob": {"matched": False, "reason": "Screenshot fixture — no DOB side-car."},
        "open_data": PROJECT,
        "spine": SPINE,
        "generated_at": "2024-01-16T12:00:00Z",
    }
    if with_clock:
        record["statutory_clock"] = STATUTORY_CLOCK
        record["predictions"] = []  # before-frame: no prediction assertions
    return record


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
    page.route("https://geosearch.planninglabs.nyc/**", lambda route: json_response(route, {"features": []}))

    def zap(route: Route) -> None:
        query = dict(
            (key, values[0])
            for key, values in parse_qs(urlparse(route.request.url).query).items()
        )
        json_response(
            route,
            [PROJECT] if f"project_id='{PROJECT_ID}'" in query.get("$where", "") else [],
        )

    def worker(route: Route) -> None:
        if urlparse(route.request.url).path == "/zap-outcomes":
            json_response(route, {"ok": True, "cached": True, "record": record})
        else:
            json_response(route, {})

    page.route("https://data.cityofnewyork.us/resource/hgx4-8ukb.json*", zap)
    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker)


def capture_variant(page: Page, base_url: str, record: dict, out: Path, *, expect_statutory: bool) -> dict:
    install_routes(page, record)
    page.goto(f"{base_url}#land/{PROJECT_ID}", wait_until="domcontentloaded")
    page.locator("#land-outcomes .land-phase-stepper").first.wait_for(state="visible", timeout=15000)
    # Expand Community Board phase so the statutory note is visible in the frame.
    cb = page.locator('[data-land-phase-panel="community_board"]')
    if cb.count():
        cb.first.evaluate("el => { el.open = true; }")
    page.evaluate("document.fonts && document.fonts.ready")
    notes = page.locator("#land-outcomes .land-statutory-deadline")
    if expect_statutory:
        notes.first.wait_for(state="visible", timeout=5000)
        text = notes.first.inner_text()
        assert "Statutory deadline" in text or "197-c" in text
        assert "2024" in text
    else:
        assert notes.count() == 0
    page.locator("#land-outcomes").screenshot(path=str(out), animations="disabled")
    data = out.read_bytes()
    return {
        "name": out.name,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    files = []  # screenshot file receipts for manifest.json
    with StaticServer() as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors: list[str] = []  # Playwright pageerror collector
        page.on("pageerror", lambda error: errors.append(str(error)))

        before = OUT / "land-timeline-before.png"
        files.append(
            capture_variant(
                page,
                base_url,
                base_record(with_clock=False),
                before,
                expect_statutory=False,
            )
        )

        # Fresh page so route handlers for the after variant replace cleanly.
        page.close()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda error: errors.append(str(error)))
        after = OUT / "land-timeline-after.png"
        files.append(
            capture_variant(
                page,
                base_url,
                base_record(with_clock=True),
                after,
                expect_statutory=True,
            )
        )

        # Mobile after frame for the PR body pair.
        page.close()
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.on("pageerror", lambda error: errors.append(str(error)))
        mobile = OUT / "land-timeline-after-390.png"
        files.append(
            capture_variant(
                page,
                base_url,
                base_record(with_clock=True),
                mobile,
                expect_statutory=True,
            )
        )

        if errors:
            raise AssertionError(errors)
        page.close()
        browser.close()

    (OUT / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "feature": "ulurp-statutory-clock",
                "project_id": PROJECT_ID,
                "certified_date": "2024-01-15",
                "files": files,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"captured {len(files)} statutory-clock screenshots → {OUT}")


if __name__ == "__main__":
    main()
