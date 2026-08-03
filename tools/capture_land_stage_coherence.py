#!/usr/bin/env python3
"""Before/after captures for land stage pointer coherence (#land/2019K0190).

- before/: live production page (stranded Community Board current stage)
- after/:  local site with fixed derivation + mocked /zap-outcomes payload

  python3 tools/capture_land_stage_coherence.py
"""

from __future__ import annotations

import functools
import hashlib
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "land-stage-coherence"
PROJECT_ID = "2019K0190"
FIXTURE = ROOT / "test" / "fixtures" / "land_phase_spine" / "2019K0190.json"
LIVE_URL = f"https://cityscroll.org/#land/{PROJECT_ID}"


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


def load_record() -> dict:
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return {
        "join": {"matched": True, "method": "exact_project_id", "reason": None},
        "project_id": raw["project_id"],
        "project_name": "862-868 Kent Avenue",
        "public_status": raw.get("public_status") or "In Public Review",
        "portal_url": raw.get("portal_url"),
        "open_data": raw.get("open_data") or {},
        "spine": raw.get("spine") or {"events": []},
        "statutory_clock": raw.get("statutory_clock"),
        "filled": True,
        "useful": True,
        "city_record_notices": [],
        "predictions": [],
        "zoning_statistics": None,
        "milestones": [],
        "dispositions": [],
        "documents": [],
        "actions": [],
        "approved_actions": [],
        "n_documents": 0,
        "n_dispositions": 0,
        "dob": {"matched": False},
        "certified_referred": (raw.get("open_data") or {}).get("certified_referred")
        or "2026-03-02",
    }


RECORD = load_record()
PROJECT_LIST_ROW = {
    "project_id": PROJECT_ID,
    "project_name": RECORD["project_name"],
    "project_brief": "Zoning map and text amendments for 862-868 Kent Avenue.",
    "primary_applicant": "Kent Development LLC",
    "public_status": RECORD["public_status"],
    "project_status": "Active",
    "borough": "Brooklyn",
    "community_district": "K03",
    "actions": "ZM; ZR",
    "mih_flag": "true",
    "current_milestone": (RECORD.get("open_data") or {}).get("current_milestone"),
    "current_milestone_date": (RECORD.get("open_data") or {}).get("current_milestone_date"),
    "ulurp_numbers": "C240283ZMK; N240284ZRK",
}


def json_response(route: Route, body: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def install_routes(page: Page) -> None:
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
        where = query.get("$where", "")
        if PROJECT_ID in where or f"project_id='{PROJECT_ID}'" in where:
            json_response(route, [PROJECT_LIST_ROW])
        else:
            json_response(route, [PROJECT_LIST_ROW])

    def worker(route: Route) -> None:
        path = urlparse(route.request.url).path
        if path.endswith("/zap-outcomes") or "/zap-outcomes" in path:
            json_response(route, {"ok": True, "cached": True, "record": RECORD})
        else:
            json_response(route, {})

    page.route("https://data.cityofnewyork.us/resource/hgx4-8ukb.json*", zap)
    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker)


def capture_live_before() -> list[dict]:
    before_dir = OUT / "before"
    before_dir.mkdir(parents=True, exist_ok=True)
    files: list[dict] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for width, height in ((390, 844), (1440, 900)):
            page = browser.new_page(viewport={"width": width, "height": height})
            page.goto(LIVE_URL, wait_until="domcontentloaded", timeout=60000)
            try:
                page.locator(
                    ".land-spine-lead, #land-outcomes .land-spine-event, .land-phase-stepper"
                ).first.wait_for(state="visible", timeout=45000)
            except Exception:
                page.wait_for_timeout(2500)
            out = before_dir / f"land-2019K0190-{width}.png"
            target = page.locator("#land-outcomes, #ldetail, main").first
            if target.count():
                target.screenshot(path=str(out), animations="disabled")
            else:
                page.screenshot(path=str(out), full_page=True)
            data = out.read_bytes()
            files.append(
                {
                    "name": f"before/{out.name}",
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "viewport": [width, height],
                }
            )
            print("wrote", out)
            page.close()
        browser.close()
    return files


def capture_local_after() -> list[dict]:
    after_dir = OUT / "after"
    after_dir.mkdir(parents=True, exist_ok=True)
    files: list[dict] = []
    with StaticServer() as base_url, sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for width, height in ((390, 844), (1440, 900)):
            page = browser.new_page(viewport={"width": width, "height": height})
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            install_routes(page)
            page.goto(f"{base_url}#land/{PROJECT_ID}", wait_until="domcontentloaded")
            page.locator(".land-spine-lead, .land-phase-stepper").first.wait_for(
                state="visible", timeout=45000
            )
            lead = page.locator(".land-spine-now-phase").first
            if lead.count():
                text = lead.inner_text().strip()
                print(f"after lead phase ({width}):", text)
                # Must not still claim Community Board as current
                if "community board" in text.lower():
                    raise AssertionError(f"after capture still shows CB as current: {text}")
            out = after_dir / f"land-2019K0190-{width}.png"
            target = page.locator("#land-outcomes, #ldetail").first
            target.screenshot(path=str(out), animations="disabled")
            data = out.read_bytes()
            files.append(
                {
                    "name": f"after/{out.name}",
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "viewport": [width, height],
                }
            )
            print("wrote", out)
            if errors:
                print("page errors:", errors[:5])
            page.close()
        browser.close()
    return files


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "README.md").write_text(
        """# Land stage pointer coherence — field case 2019K0190

User report (2026-08-03): Community Board review was shown as the **current**
stage with a statutory deadline of 2026-05-01 while City Planning Commission
steps on the same card already showed completed 2026-07-15.

- `before/` — production capture of the stranded pointer
- `after/` — local capture with the pipeline pointer advanced past missing CB
  outcomes when later stages have terminal completions

Re-run: `python3 tools/capture_land_stage_coherence.py`
""",
        encoding="utf-8",
    )
    files: list[dict] = []
    print("capturing before (live)…")
    try:
        files.extend(capture_live_before())
    except Exception as exc:
        print("live before capture failed:", exc)
    print("capturing after (local fixed)…")
    files.extend(capture_local_after())
    (OUT / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "feature": "land-stage-coherence",
                "project_id": PROJECT_ID,
                "files": files,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print("done", OUT, "files", len(files))


if __name__ == "__main__":
    main()
