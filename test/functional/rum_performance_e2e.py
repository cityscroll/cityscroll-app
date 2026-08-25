#!/usr/bin/env python3
"""Opt-in live RUM chain proof: real page loads, retained query, and Access Desk view.

This test deliberately never posts a fabricated observation. It only loads instrumented public
pages and records the collector's own POST /performance-events requests. Run it with
``CROL_RUM_E2E=1`` and a short-lived Access service-token file supplied through
``CROL_ACCESS_SERVICE_TOKEN_FILE``. The output directory is ignored by git.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from playwright.sync_api import Response, sync_playwright


PUBLIC_BASE = os.environ.get("CROL_BASE", "https://cityscroll.org/").rstrip("/") + "/"
DESK_URL = os.environ.get("CROL_DESK_URL", "https://desk.cityscroll.org/performance")
PATHS = [path.strip() for path in os.environ.get(
    "CROL_RUM_E2E_PATHS", "/,/about.html"
).split(",") if path.strip()]
OUTPUT = Path(os.environ.get("CROL_RUM_E2E_OUTPUT", ".artifacts/rum-performance-e2e"))


def access_headers() -> dict[str, str]:
    token_file = os.environ.get("CROL_ACCESS_SERVICE_TOKEN_FILE")
    if not token_file:
        raise RuntimeError("CROL_ACCESS_SERVICE_TOKEN_FILE is required for the Desk proof")
    token = json.loads(Path(token_file).read_text(encoding="utf-8"))
    client_id = token.get("client_id")
    client_secret = token.get("client_secret")
    if not isinstance(client_id, str) or not isinstance(client_secret, str):
        raise RuntimeError("service-token file is missing client_id or client_secret")
    return {
        "CF-Access-Client-Id": client_id,
        "CF-Access-Client-Secret": client_secret,
    }


def response_json(response: Response) -> dict[str, Any] | None:
    try:
        body = response.json()
    except Exception:
        return None
    return body if isinstance(body, dict) else None


def series_with_samples(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not payload:
        return []
    return [
        row for row in payload.get("series", [])
        if isinstance(row, dict)
        and isinstance(row.get("current"), dict)
        and (row["current"].get("sampled_count") or 0) > 0
    ]


def main() -> None:
    if os.environ.get("CROL_RUM_E2E") != "1":
        print("SKIP: set CROL_RUM_E2E=1 to run the live RUM chain proof")
        return

    OUTPUT.mkdir(parents=True, exist_ok=True)
    evidence: dict[str, Any] = {"public_base": PUBLIC_BASE, "pages": [], "beacons": []}
    failures: list[str] = []
    access = access_headers()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        public_page = context.new_page()
        beacons: list[dict[str, Any]] = []

        def record_request(request: Any) -> None:
            if request.method == "POST" and request.url.rstrip("/").endswith("/performance-events"):
                beacons.append({"url": request.url, "method": request.method})

        public_page.on("request", record_request)
        for path in PATHS:
            url = f"{PUBLIC_BASE.rstrip('/')}/{path.lstrip('/')}"
            public_page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            public_page.wait_for_timeout(7_000)
            evidence["pages"].append({"path": path, "title": public_page.title()})
        public_page.close()

        evidence["beacons"] = beacons
        if not beacons:
            failures.append(
                "no real POST /performance-events was observed after loading "
                f"{PATHS}"
            )

        query_payload: dict[str, Any] | None = None
        admin_url = os.environ.get("CROL_PERF_ADMIN_URL")
        admin_key = os.environ.get("CROL_PERF_ADMIN_KEY")
        if admin_url and admin_key:
            query_response = context.request.get(
                admin_url,
                headers={"Authorization": f"Bearer {admin_key}"},
            )
            query_payload = response_json(query_response)
            evidence["operator_query"] = {
                "status_code": query_response.status,
                "status": query_payload.get("status") if query_payload else None,
                "unavailable_reason": query_payload.get("unavailable_reason") if query_payload else None,
                "read_path": query_payload.get("read_path") if query_payload else None,
                "data_health_status": query_payload.get("data_health", {}).get("status") if query_payload else None,
                "series_with_samples": len(series_with_samples(query_payload)),
            }
            if query_response.status != 200 or not series_with_samples(query_payload):
                failures.append("authenticated performance query did not return retained samples")

        desk = context.new_page()
        desk.set_extra_http_headers(access)
        desk_payloads: list[dict[str, Any]] = []

        def record_desk_response(response: Response) -> None:
            if "/admin/performance" not in response.url:
                return
            payload = response_json(response)
            if payload:
                desk_payloads.append(payload)

        desk.on("response", record_desk_response)
        desk.goto(DESK_URL, wait_until="domcontentloaded", timeout=60_000)
        desk.wait_for_timeout(5_000)
        desk.screenshot(path=str(OUTPUT / "desk-performance.png"), full_page=True)
        desk_payload = desk_payloads[-1] if desk_payloads else query_payload
        evidence["desk"] = {
            "url": DESK_URL,
            "title": desk.title(),
            "api_status": desk_payload.get("status") if desk_payload else None,
            "unavailable_reason": desk_payload.get("unavailable_reason") if desk_payload else None,
            "read_path": desk_payload.get("read_path") if desk_payload else None,
            "data_health_status": desk_payload.get("data_health", {}).get("status") if desk_payload else None,
            "series_with_samples": len(series_with_samples(desk_payload)),
        }
        (OUTPUT / "chain.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
        if not desk_payload or not series_with_samples(desk_payload):
            failures.append("Desk performance view did not receive retained samples")
        desk.close()
        browser.close()

    print(json.dumps(evidence, indent=2))
    if failures:
        raise AssertionError("; ".join(failures) + f"; see {OUTPUT / 'chain.json'}")


if __name__ == "__main__":
    main()
