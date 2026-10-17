"""Full-card Land authority recovery journey with retained fixtures."""

from __future__ import annotations

import functools
import json
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from browser_support import launched_chromium

ROOT = Path(__file__).resolve().parents[2]
PROJECT_ID = "2026K0233"
NOW = "2026-10-17T12:00:00.000Z"

ROW = {
    "project_id": PROJECT_ID,
    "project_name": "240 Nassau Street",
    "public_status": "In Public Review",
    "project_status": "Active",
    "borough": "Brooklyn",
    "community_district": "K02",
    "actions": "ZM",
    "ulurp_numbers": "C260395ZMK",
    "ulurp_non": "ULURP",
    "primary_applicant": "New York City Education Construction Fund",
    "current_milestone": "ZM - Prepare Filed Land Use Fee Payment",
}

INITIAL_AUTHORITY = {
    "schema": "cityscroll.land_authority_summary.v1",
    "status": "resolved",
    "reason": None,
    "project_id": PROJECT_ID,
    "procedure_id": "ulurp_197c",
    "procedure_resolution": "uniform",
    "current_stage": {
        "stage_id": "ulurp_197c.application_certification",
        "spine_phase_id": "pre_application",
        "status": "known",
    },
    "current_actor_refs": ["agency:id:city-planning"],
    "current_role": "administrative_certifier",
    "effect": "Receives and circulates the application, then certifies it as complete for review.",
    "source_basis": {
        "profile": {"procedure_id": "ulurp_197c"},
        "phase": {"current_milestone": ROW["current_milestone"], "phase_id": "pre_application"},
        "geography": {"status": "resolved", "profile_version": "fixture.v1"},
        "publisher": {"source": "fixture-hearings", "source_id": "fixture-opportunity", "checked": True},
    },
    "expected_next_stage": {
        "stage_id": "ulurp_197c.community_board_review",
        "spine_phase_id": "community_board",
        "status": "known",
    },
    "published_next_opportunity": {
        "status": "published",
        "checked": True,
        "checked_vintage": "2026-10-17",
        "source_id": "fixture-opportunity",
        "source": "fixture-hearings",
        "label": "City Planning Commission review session",
        "date": "2026-11-16",
        "representing": "City Planning Commission",
        "phase_id": "cpc",
        "body_ref": "agency:id:city-planning-commission",
    },
    "next_procedural_body": {
        "body_ref": "agency:id:city-planning-commission",
        "source_id": "fixture-opportunity",
        "source": "fixture-hearings",
    },
    "affected_actor_refs": [
        {"body_ref": "community-board:brooklyn-cb-02", "role": "affected_community_board"},
        {"body_ref": "borough-president:brooklyn", "role": "affected_borough_president"},
    ],
    "observed": {"status": "no_observation", "recommendations": []},
    "freshness": {
        "generated_at": NOW,
        "as_of": NOW,
        "source_vintages": {"outcomes_generated_at": NOW, "hearings_generated_at": NOW},
    },
}


def event(title: str, status: str, date: str) -> dict:
    return {
        "id": f"fixture:{title.lower().replace(' ', '-')}",
        "kind": "zap_milestone",
        "title": title,
        "detail": status,
        "status": status,
        "time": {"value": date, "precision": "day", "basis": "actual", "certainty": "actual"},
        "source": {"id": "fixture-zap", "label": "Retained ZAP fixture"},
    }


def record(phase: str) -> dict:
    events = [event("Community Board Review", "In Progress", "2026-10-05")]
    if phase == "borough_president":
        events = [
            event("Community Board Review", "Completed", "2026-10-05"),
            event("Borough President Review", "In Progress", "2026-10-06"),
        ]
    return {
        "project_id": PROJECT_ID,
        "project_name": ROW["project_name"],
        "public_status": ROW["public_status"],
        "snapshot_state": "present",
        "filled": True,
        "useful": True,
        "generated_at": NOW,
        "stage_observation": {"observed_at": NOW},
        "open_data": ROW,
        "actions": [],
        "dispositions": [],
        "documents": [],
        "city_record_notices": [],
        "spine": {"schema_version": 1, "project_id": PROJECT_ID, "events": events, "gaps": []},
    }


class QuietHandler(SimpleHTTPRequestHandler):
    api_record: dict | None = None
    api_delay = 0.0

    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def translate_path(self, path: str) -> str:
        parsed = urlparse(path).path
        site_path = ROOT / "site" / parsed.lstrip("/")
        return str(site_path if site_path.exists() else ROOT / parsed.lstrip("/"))

    def do_POST(self) -> None:
        if urlparse(self.path).path == "/events":
            self.send_response(204)
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/zap-outcomes":
            if self.api_delay:
                time.sleep(self.api_delay)
            payload = (
                {"ok": True, "cached": False, "record": self.api_record}
                if self.api_record is not None
                else {"ok": False, "reason": "fixture failure"}
            )
            body = json.dumps(payload).encode("utf-8")
            self.send_response(200 if self.api_record is not None else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


class StaticServer:
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def json_response(route, payload: object, status: int = 200) -> None:
    route.fulfill(status=status, content_type="application/json", body=json.dumps(payload))


def install_routes(page, *, warm_phase: str) -> None:
    page.route("https://**", lambda route: route.abort())
    page.route(
        "**/data/land_project_catalog.json*",
        lambda route: json_response(route, {"projects": [ROW], "source_dates": {"warehouse_materialized_at": NOW}}),
    )
    page.route(
        "**/data/land_default_ulurp.json*",
        lambda route: json_response(
            route,
            {"generated_at": NOW, "projects": [ROW], "outcomes": {"by_project": {PROJECT_ID: record(warm_phase)}}},
        ),
    )
    page.route(
        "**/data/land_authority_summary.json*",
        lambda route: json_response(route, {"summaries": {PROJECT_ID: INITIAL_AUTHORITY}}),
    )

def current_phase(page) -> str | None:
    step = page.locator('#land-outcomes [data-land-phase-state="current"]').first
    return step.get_attribute("data-land-phase") if step.count() else None


def assert_card(page, *, phase: str, stage: str, actor: str, status: str) -> None:
    page.wait_for_function(
        "expected => document.querySelector('#land-outcomes [data-land-phase-state=\"current\"]')?.dataset.landPhase === expected",
        arg=phase,
    )
    authority = page.locator("#land-authority-summary")
    authority.wait_for(state="visible", timeout=10_000)
    assert authority.get_attribute("data-status") == status
    observed_stage = page.locator("[data-land-authority-stage]").get_attribute("data-land-authority-stage")
    assert observed_stage == stage, {"expected_stage": stage, "observed_stage": observed_stage}
    observed_actor = page.locator("[data-land-authority-actor]").inner_text()
    assert actor in observed_actor, {"expected_actor": actor, "observed_actor": observed_actor}
    assert current_phase(page) == phase
    assert page.locator('[data-land-authority-published-checked="true"]').count() == 1


def open_case(browser, base: str, *, warm_phase: str, refreshed: dict | None, delay: float = 0):
    QuietHandler.api_record = refreshed
    QuietHandler.api_delay = delay
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    page.on("pageerror", lambda error: print(f"browser page error: {error}"))
    page.add_init_script(
        script=(
            f"window.CROL_DISABLE_ROOT_HASH_BOOT=true; window.CROL_API_ORIGIN={json.dumps(base)}; "
            f"window.CROL_API_FALLBACK_ORIGIN={json.dumps(base)}; Date.now=()=>Date.parse({json.dumps(NOW)});"
        )
    )
    install_routes(page, warm_phase=warm_phase)
    page.goto(f"{base}/#land/{PROJECT_ID}", wait_until="domcontentloaded")
    return context, page


def main() -> int:
    with StaticServer() as base, launched_chromium() as browser:
        context, page = open_case(
            browser,
            base,
            warm_phase="community_board",
            refreshed=record("borough_president"),
            delay=1.0,
        )
        assert_card(
            page,
            phase="community_board",
            stage="ulurp_197c.community_board_review",
            actor="Brooklyn Community Board 2",
            status="resolved",
        )
        assert_card(
            page,
            phase="borough_president",
            stage="ulurp_197c.borough_president_review",
            actor="Brooklyn Borough President",
            status="resolved",
        )
        context.close()

        context, page = open_case(browser, base, warm_phase="borough_president", refreshed=None)
        page.locator('#land-authority-summary[data-status="unknown"][data-reason="stale_source"]').wait_for(
            state="visible", timeout=10_000
        )
        assert current_phase(page) == "borough_president"
        assert page.locator("#land-authority .land-outcome-freshness").count() == 1
        assert page.locator("#land-outcomes .land-outcome-freshness").count() == 1
        assert "last recorded" in page.locator("#land-outcomes").inner_text().lower()
        context.close()

    print(json.dumps({"ok": True, "project_id": PROJECT_ID, "states": ["warm", "fresh", "failed"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
