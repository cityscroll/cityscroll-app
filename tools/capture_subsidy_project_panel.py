#!/usr/bin/env python3
"""Capture the receipt-backed subsidy project panel at desktop and mobile widths."""
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

from playwright.sync_api import Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "subsidy-project-panel"
NOTICE_ID = "20251229015"
PORT = 8779


def fulfill_json(route: Route, payload: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))


def lifecycle_payload() -> dict:
    lookup = json.loads((ROOT / "site" / "data" / "subsidy_project_lookup.json").read_text())
    projects = lookup["by_notice"][NOTICE_ID]
    first = projects[0]
    board = first["milestones"]["board_decision"]
    return {
        "ok": True,
        "request_id": NOTICE_ID,
        "project_identity": projects,
        "project": {
            "id": first["project_id"],
            "name": first["project_name"],
            "company": first["company"],
        },
        "stage": "board_decision",
        "join": {
            "matched": True,
            "method": "receipt-backed-name-address-date",
            "source": "NYCEDC/NYCIDA/Build NYC project records",
            "confidence": 1,
            "anchor_date": "2026-01-22",
        },
        "company": {"status": "matched", "value": first["company"]},
        "place": {"status": "matched", "address": first["address"], "addresses": [first["address"]]},
        "money": {
            "requested_benefit": {"status": "matched", "value": first["requested_benefit"]},
            "estimated_cost": {"status": "matched", "value": first["estimated_public_cost"]},
        },
        "timeline": [
            {"stage": "application", "status": "unknown", "date": None, "outcome": "unknown"},
            {"stage": "hearing", "status": "matched", "date": "2026-01-22", "outcome": "held"},
            {
                "stage": "board_decision",
                "status": "matched",
                "date": board["date"],
                "outcome": board["outcome"],
                "source": {"status": "matched", "url": first["official_documents_url"]},
            },
            {"stage": "closing", "status": "unknown", "date": None, "outcome": "unknown"},
            {"stage": "compliance", "status": "unknown", "date": None, "outcome": "unknown"},
        ],
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    notice = {
        "request_id": NOTICE_ID,
        "start_date": "2025-12-29T00:00:00.000",
        "event_date": "2026-01-22T10:00:00.000",
        "agency_name": "Build NYC Resource Corporation",
        "type_of_notice_description": "Public Hearing",
        "section_name": "Public Hearings and Meetings",
        "short_title": "Build NYC public hearing — January 22, 2026",
        "additional_description_1": "Public hearing for Build NYC project applications.",
    }
    lifecycle = lifecycle_payload()
    server = subprocess.Popen(
        ["python3", "-m", "http.server", str(PORT), "--directory", str(ROOT / "site")],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(0.4)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for width, height, label in ((1440, 1000, "desktop"), (390, 844, "mobile")):
                page = browser.new_page(viewport={"width": width, "height": height})
                page.route(
                    "**/resource/dg92-zbpx.json**",
                    lambda route: fulfill_json(route, [notice]),
                )

                def worker(route: Route) -> None:
                    if "/subsidy-lifecycle" in route.request.url:
                        fulfill_json(route, lifecycle)
                    else:
                        route.abort()

                page.route("https://api.cityscroll.org/**", worker)
                page.route("https://api.crol-list.org/**", worker)
                page.route("https://crol-worker.crol-worker.workers.dev/**", worker)
                page.goto(
                    f"http://127.0.0.1:{PORT}/#notice/{NOTICE_ID}",
                    wait_until="domcontentloaded",
                )
                panel = page.locator("[data-subsidy-project-panel='1']")
                panel.wait_for(state="visible", timeout=15_000)
                assert panel.get_attribute("data-project-count") == "2"
                assert panel.locator("[data-subsidy-project='1']").count() == 2
                assert "Board decision · January 27, 2026" in panel.inner_text()
                panel.screenshot(path=str(OUT / f"after-{label}.png"))
                page.close()
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=5)


if __name__ == "__main__":
    main()
