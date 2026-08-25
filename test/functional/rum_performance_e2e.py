#!/usr/bin/env python3
"""Opt-in live RUM chain proof: real page loads, retained query, and Access Desk view.

This test deliberately never posts a fabricated observation. It loads instrumented public pages,
waits for their normal collector lifecycle, reads the retained Analytics Engine result through the
authenticated Worker path, and then checks the same real result through the Access-authenticated
Desk page. The request listener is diagnostic only: asynchronous beacon delivery can complete after
the browser-visible request window, so read-back is the acceptance signal.

Run with ``CROL_RUM_E2E=1``, ``CROL_PERF_ADMIN_URL``, ``CROL_PERF_ADMIN_KEY``, and a short-lived
Access service-token file supplied through ``CROL_ACCESS_SERVICE_TOKEN_FILE``. The output directory
is ignored by git.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from playwright.sync_api import APIRequestContext, Response, sync_playwright


PUBLIC_BASE = os.environ.get("CROL_BASE", "https://cityscroll.org/").rstrip("/") + "/"
DESK_URL = os.environ.get("CROL_DESK_URL", "https://desk.cityscroll.org/performance")
PATHS = [path.strip() for path in os.environ.get(
    "CROL_RUM_E2E_PATHS", "/,/near-you/,/browse/contracts/"
).split(",") if path.strip()]
OUTPUT = Path(os.environ.get("CROL_RUM_E2E_OUTPUT", ".artifacts/rum-performance-e2e"))
READ_TIMEOUT_MS = int(os.environ.get("CROL_RUM_E2E_READ_TIMEOUT_MS", "60000"))
READ_POLL_MS = int(os.environ.get("CROL_RUM_E2E_READ_POLL_MS", "3000"))
SETTLE_MS = int(os.environ.get("CROL_RUM_E2E_SETTLE_MS", "12000"))
REQUIRED_MILESTONES = ("content_ready_ms", "component_ready_ms")


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


def metric_rows(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not payload:
        return []
    coarse_rows = payload.get("coarse_summary", {}).get("rows")
    if isinstance(coarse_rows, list):
        return [row for row in coarse_rows if isinstance(row, dict)]
    return [
        row for row in payload.get("series", [])
        if isinstance(row, dict) and isinstance(row.get("dimensions"), dict)
    ]


def series_with_samples(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    return [
        row for row in metric_rows(payload)
        if (row.get("sampled_count") or (row.get("current") or {}).get("sampled_count") or 0) > 0
    ]


def metric_id(row: dict[str, Any]) -> str | None:
    return row.get("metric_id") or row.get("dimensions", {}).get("metric_id")


def sampled_count(row: dict[str, Any]) -> int:
    return int(row.get("sampled_count") or (row.get("current") or {}).get("sampled_count") or 0)


def percentile_values(row: dict[str, Any]) -> dict[str, Any]:
    return (
        row.get("percentiles")
        or (row.get("current") or {}).get("percentiles")
        or {field: row.get(field) for field in ("p50", "p75", "p95") if field in row}
    )


def has_percentiles(row: dict[str, Any]) -> bool:
    percentiles = percentile_values(row)
    return all(isinstance(percentiles.get(field), (int, float)) for field in ("p50", "p75", "p95"))


def latest_observation(payload: dict[str, Any] | None) -> datetime | None:
    if not payload:
        return None
    values: list[str] = []
    freshness = payload.get("freshness")
    if isinstance(freshness, dict) and isinstance(freshness.get("latest_observation_at"), str):
        values.append(freshness["latest_observation_at"])
    for row in metric_rows(payload):
        value = row.get("latest_observation_at") or (row.get("current") or {}).get("latest_observation_at")
        if isinstance(value, str):
            values.append(value)
    parsed: list[datetime] = []
    for value in values:
        try:
            parsed.append(datetime.fromisoformat(value.replace("Z", "+00:00")))
        except ValueError:
            continue
    return max(parsed) if parsed else None


def required_metric_rows(payload: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    return {
        metric: row
        for row in metric_rows(payload)
        if (metric := metric_id(row)) in REQUIRED_MILESTONES
        and sampled_count(row) > 0
        and has_percentiles(row)
    }


def query_receipt(response: Response, payload: dict[str, Any] | None) -> dict[str, Any]:
    rows = series_with_samples(payload)
    return {
        "status_code": response.status,
        "status": payload.get("status") if payload else None,
        "operational_status": payload.get("operational_status") if payload else None,
        "unavailable_reason": payload.get("unavailable_reason") if payload else None,
        "read_path": payload.get("read_path") if payload else None,
        "data_health_status": payload.get("data_health", {}).get("status") if payload else None,
        "series_with_samples": len(rows),
        "milestones_with_samples": sorted(required_metric_rows(payload)),
        "metrics": [
            {
                "metric_id": metric_id(row),
                "sampled_count": sampled_count(row),
                "status": row.get("status") or (row.get("current") or {}).get("status"),
                **percentile_values(row),
                "latest_observation_at": row.get("latest_observation_at")
                or (row.get("current") or {}).get("latest_observation_at"),
            }
            for row in rows
        ],
        "latest_observation_at": (
            latest_observation(payload).isoformat().replace("+00:00", "Z")
            if latest_observation(payload) else None
        ),
    }


def read_admin_performance(
    request: APIRequestContext, admin_url: str, admin_key: str
) -> tuple[Response, dict[str, Any] | None]:
    response = request.get(admin_url, headers={"Authorization": f"Bearer {admin_key}"})
    return response, response_json(response)


def main() -> None:
    if os.environ.get("CROL_RUM_E2E") != "1":
        print("SKIP: set CROL_RUM_E2E=1 to run the live RUM chain proof")
        return

    admin_url = os.environ.get("CROL_PERF_ADMIN_URL")
    admin_key = os.environ.get("CROL_PERF_ADMIN_KEY")
    if not admin_url or not admin_key:
        raise RuntimeError("CROL_PERF_ADMIN_URL and CROL_PERF_ADMIN_KEY are required for read-back")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    evidence: dict[str, Any] = {"public_base": PUBLIC_BASE, "pages": [], "beacons": []}
    failures: list[str] = []
    access = access_headers()
    capture_started = datetime.now(timezone.utc)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        api_request = context.request
        baseline_response, baseline_payload = read_admin_performance(api_request, admin_url, admin_key)
        baseline_latest = latest_observation(baseline_payload)
        evidence["operator_baseline"] = query_receipt(baseline_response, baseline_payload)

        public_page = context.new_page()
        beacons: list[dict[str, Any]] = []

        def record_request(request: Any) -> None:
            if request.method == "POST" and request.url.rstrip("/").endswith("/performance-events"):
                beacons.append({"url": request.url, "method": request.method})

        public_page.on("request", record_request)
        for path in PATHS:
            url = f"{PUBLIC_BASE.rstrip('/')}/{path.lstrip('/')}"
            public_page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            public_page.wait_for_timeout(SETTLE_MS)
            evidence["pages"].append({"path": path, "title": public_page.title()})
        evidence["beacons"] = beacons

        read_deadline = time.monotonic() + READ_TIMEOUT_MS / 1000
        read_response: Response | None = None
        read_payload: dict[str, Any] | None = None
        while time.monotonic() < read_deadline:
            read_response, read_payload = read_admin_performance(api_request, admin_url, admin_key)
            latest = latest_observation(read_payload)
            if (
                read_response.status == 200
                and read_payload
                and read_payload.get("operational_status") == "flowing"
                and len(series_with_samples(read_payload)) > 0
                and required_metric_rows(read_payload).keys() >= set(REQUIRED_MILESTONES)
                and latest is not None
                and latest >= capture_started - timedelta(seconds=5)
            ):
                break
            public_page.wait_for_timeout(READ_POLL_MS)

        public_page.close()

        if read_response is None or read_payload is None:
            failures.append("authenticated performance query returned no response")
        else:
            evidence["operator_query"] = query_receipt(read_response, read_payload)
            latest = latest_observation(read_payload)
            if read_response.status != 200 or not series_with_samples(read_payload):
                failures.append("authenticated performance query did not return retained samples")
            if read_payload.get("operational_status") != "flowing":
                failures.append("authenticated performance query was not operationally flowing")
            if not required_metric_rows(read_payload).keys() >= set(REQUIRED_MILESTONES):
                failures.append("coarse summary did not retain content_ready_ms and component_ready_ms")
            if latest is None or latest < capture_started - timedelta(seconds=5):
                failures.append("read-back latest observation was not fresh after the real page loads")
            if baseline_latest and latest and latest < baseline_latest:
                failures.append("read-back latest observation regressed from the baseline")

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
        desk_payload = desk_payloads[-1] if desk_payloads else None
        desk_text = desk.locator("body").inner_text()
        evidence["desk"] = {
            "url": DESK_URL,
            "title": desk.title(),
            "api_status": desk_payload.get("status") if desk_payload else None,
            "operational_status": desk_payload.get("operational_status") if desk_payload else None,
            "series_with_samples": len(series_with_samples(desk_payload)),
            "milestones_with_samples": sorted(required_metric_rows(desk_payload)),
            "latest_observation_at": (
                latest_observation(desk_payload).isoformat().replace("+00:00", "Z")
                if latest_observation(desk_payload) else None
            ),
            "body_contains_content_ready": "content" in desk_text.lower(),
            "body_contains_component_ready": "component" in desk_text.lower(),
        }
        if not desk_payload or not series_with_samples(desk_payload):
            failures.append("Desk performance view did not receive retained samples")
        if not desk_payload or desk_payload.get("operational_status") != "flowing":
            failures.append("Desk performance view did not render a flowing status")
        if not desk_payload or required_metric_rows(desk_payload).keys() < set(REQUIRED_MILESTONES):
            failures.append("Desk performance view did not receive the coarse readiness milestones")
        if "content" not in desk_text.lower() or "component" not in desk_text.lower():
            failures.append("Desk performance view did not render readiness metric labels")
        desk.close()
        browser.close()

    (OUTPUT / "chain.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, indent=2))
    if failures:
        raise AssertionError("; ".join(failures) + f"; see {OUTPUT / 'chain.json'}")


if __name__ == "__main__":
    main()
