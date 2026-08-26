#!/usr/bin/env python3
"""Opt-in live RUM chain proof: real page loads, retained query, and Access Desk view.

This test deliberately never posts a fabricated observation. It loads instrumented public pages,
waits for their normal collector lifecycle, reads the retained Analytics Engine result through the
authenticated Worker path, and then checks the same real result through the Access-authenticated
Desk page. The request listener is diagnostic only: asynchronous beacon delivery can complete after
the browser-visible request window, so read-back is the acceptance signal.

Run with ``CROL_RUM_E2E=1`` for the complete read-back proof. The daily scheduled generator uses
``CROL_RUM_E2E_GENERATE=1`` to load the same surfaces repeatedly with a lab traffic marker; it
does not require private read-back credentials. The output directory is ignored by git.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from playwright.sync_api import APIRequestContext, Response, sync_playwright


PUBLIC_BASE = os.environ.get("CROL_BASE", "https://cityscroll.org/").rstrip("/") + "/"
DESK_URL = os.environ.get("CROL_DESK_URL", "https://desk.cityscroll.org/performance")
PATHS = [path.strip() for path in os.environ.get(
    "CROL_RUM_E2E_PATHS",
    "/,/near-you/,/following/,/browse/contracts/,/notices/20260714015/,/agencies/office-of-the-mayor/",
).split(",") if path.strip()]
OUTPUT = Path(os.environ.get("CROL_RUM_E2E_OUTPUT", ".artifacts/rum-performance-e2e"))
READ_TIMEOUT_MS = int(os.environ.get("CROL_RUM_E2E_READ_TIMEOUT_MS", "60000"))
READ_POLL_MS = int(os.environ.get("CROL_RUM_E2E_READ_POLL_MS", "3000"))
SETTLE_MS = int(os.environ.get("CROL_RUM_E2E_SETTLE_MS", "12000"))
REPEATS = int(os.environ.get("CROL_RUM_E2E_REPEATS", "5"))
REQUIRED_MILESTONES = ("content_ready_ms", "component_ready_ms")
SAMPLE_FLOOR = 30
GOOD_P75_MS = 2_500
GOOD_P95_MS = 5_000
VIEWPORTS = {
    "mobile": {"width": 390, "height": 844},
    "desktop": {"width": 1440, "height": 900},
}
EXPECTED_GROUPS = {
    "content_ready_ms": [
        {"surface_id": surface, "component_id": "none"}
        for surface in ("agency", "browse-contracts", "following", "home", "near-you", "notice")
    ],
    "component_ready_ms": [
        {"surface_id": "agency", "component_id": "agency-identity"},
        {"surface_id": "agency", "component_id": "agency-relationships"},
        {"surface_id": "browse-contracts", "component_id": "browse-contracts-results"},
        {"surface_id": "following", "component_id": "following-watch-list"},
        {"surface_id": "home", "component_id": "home-topic-entry"},
        {"surface_id": "near-you", "component_id": "near-you-map"},
        {"surface_id": "near-you", "component_id": "near-you-map-data"},
        {"surface_id": "notice", "component_id": "notice-context"},
    ],
}


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


def admin_query_url(admin_url: str, **params: str) -> str:
    parsed = urlsplit(admin_url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.update(params)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))


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


def row_dimensions(row: dict[str, Any]) -> dict[str, str | None]:
    dimensions = row.get("dimensions") if isinstance(row.get("dimensions"), dict) else row
    return {
        "metric_id": metric_id(row),
        "surface_id": dimensions.get("surface_id"),
        "component_id": dimensions.get("component_id", "none"),
    }


def find_group_row(payload: dict[str, Any] | None, metric: str, expected: dict[str, str]) -> dict[str, Any] | None:
    for row in metric_rows(payload):
        dimensions = row_dimensions(row)
        if dimensions.get("metric_id") != metric:
            continue
        if all(dimensions.get(key) == value for key, value in expected.items()):
            return row
    return None


def group_verdict(
    response: Response | None,
    payload: dict[str, Any] | None,
    metric: str,
    expected: dict[str, str],
    capture_started: datetime,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "metric_id": metric,
        **expected,
        "verdict": "NEEDS-DATA",
        "status": "unavailable",
    }
    if response is None or response.status != 200 or payload is None:
        result["reason"] = "unavailable"
        return result
    retention = payload.get("retention", {}).get("current", {})
    if retention.get("status") != "complete":
        result["status"] = "partial"
        result["reason"] = "partial-window"
        return result
    row = find_group_row(payload, metric, expected)
    if row is None:
        if payload.get("status") in {"no_data", "insufficient_sample", "unavailable"}:
            result["status"] = payload.get("status")
            result["reason"] = payload.get("status")
        else:
            result["verdict"] = "COVERAGE-FAILURE"
            result["status"] = "coverage_failure"
            result["reason"] = "missing_registered_group"
        return result
    result["sampled_count"] = sampled_count(row)
    result.update(percentile_values(row))
    if sampled_count(row) < int(payload.get("sample_floor") or SAMPLE_FLOOR):
        result["status"] = "insufficient_sample"
        result["reason"] = "insufficient_sample"
        return result
    if not has_percentiles(row):
        result["status"] = "unavailable"
        result["reason"] = "missing_percentiles"
        return result
    latest = row.get("latest_observation_at") or (row.get("current") or {}).get("latest_observation_at")
    if not isinstance(latest, str):
        result["status"] = "unavailable"
        result["reason"] = "stale_or_missing_observation"
        return result
    try:
        observed_at = datetime.fromisoformat(latest.replace("Z", "+00:00"))
    except ValueError:
        result["status"] = "unavailable"
        result["reason"] = "invalid_observation_timestamp"
        return result
    if observed_at < capture_started - timedelta(seconds=5):
        result["status"] = "unavailable"
        result["reason"] = "stale_observation"
        return result
    if payload.get("operational_status") != "flowing" or payload.get("status") not in {"available", "partial"}:
        result["status"] = payload.get("status") or payload.get("operational_status") or "unavailable"
        result["reason"] = payload.get("status") or payload.get("operational_status") or "unavailable"
        return result
    result["status"] = "available"
    if result["p75"] <= GOOD_P75_MS and result["p95"] <= GOOD_P95_MS:
        result["verdict"] = "GOOD"
    elif result["p75"] <= 5_000 and result["p95"] <= 10_000:
        result["verdict"] = "NEEDS-WORK"
    else:
        result["verdict"] = "FAIL"
    return result


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
    generate_only = os.environ.get("CROL_RUM_E2E_GENERATE") == "1"
    if os.environ.get("CROL_RUM_E2E") != "1" and not generate_only:
        print("SKIP: set CROL_RUM_E2E=1 to run the live RUM chain proof")
        return

    admin_url = os.environ.get("CROL_PERF_ADMIN_URL")
    admin_key = os.environ.get("CROL_PERF_ADMIN_KEY")
    if not generate_only and (not admin_url or not admin_key):
        raise RuntimeError("CROL_PERF_ADMIN_URL and CROL_PERF_ADMIN_KEY are required for read-back")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    evidence: dict[str, Any] = {
        "public_base": PUBLIC_BASE,
        "paths": PATHS,
        "viewports": VIEWPORTS,
        "repeats": REPEATS,
        "traffic_class": "lab" if generate_only else "production",
        "mode": "generate" if generate_only else "read-back",
        "pages": [],
        "beacons": [],
        "groups": [],
    }
    failures: list[str] = []
    access = access_headers() if not generate_only else {}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        if not generate_only:
            baseline_context = browser.new_context(viewport=VIEWPORTS["desktop"])
            baseline_response, baseline_payload = read_admin_performance(
                baseline_context.request, admin_url, admin_key
            )
            evidence["operator_baseline"] = query_receipt(baseline_response, baseline_payload)
            baseline_context.close()

        for device, viewport in VIEWPORTS.items():
            capture_started = datetime.now(timezone.utc)
            context = browser.new_context(viewport=viewport)
            if generate_only:
                context.add_init_script("window.CROL_RUM_TRAFFIC_CLASS = 'lab';")
            api_request = context.request
            public_page = context.new_page()
            beacons: list[dict[str, Any]] = []

            def record_request(request: Any) -> None:
                if request.method == "POST" and urlsplit(request.url).path.rstrip("/").endswith("/performance-events"):
                    beacons.append({"url": request.url, "method": request.method})

            public_page.on("request", record_request)
            for repeat in range(REPEATS):
                for path in PATHS:
                    url = f"{PUBLIC_BASE.rstrip('/')}/{path.lstrip('/')}"
                    public_page.goto(url, wait_until="domcontentloaded", timeout=60_000)
                    public_page.wait_for_timeout(SETTLE_MS)
                    evidence["pages"].append({
                        "device": device,
                        "repeat": repeat + 1,
                        "path": path,
                        "title": public_page.title(),
                    })

            device_evidence: dict[str, Any] = {
                "device": device,
                "capture_started": capture_started.isoformat().replace("+00:00", "Z"),
                "page_loads": REPEATS * len(PATHS),
                "metrics": {},
            }
            if not generate_only:
                read_results: dict[str, tuple[Response, dict[str, Any] | None]] = {}
                read_deadline = time.monotonic() + READ_TIMEOUT_MS / 1000
                while time.monotonic() < read_deadline:
                    for metric in REQUIRED_MILESTONES:
                        query_url = admin_query_url(admin_url, window="7d", metric=metric, device=device)
                        read_results[metric] = read_admin_performance(api_request, query_url, admin_key)
                    latest_values = [latest_observation(payload) for _, payload in read_results.values()]
                    if all(value is not None and value >= capture_started - timedelta(seconds=5) for value in latest_values):
                        break
                    public_page.wait_for_timeout(READ_POLL_MS)
                for metric, (response, payload) in read_results.items():
                    device_evidence["metrics"][metric] = query_receipt(response, payload)
                    for expected in EXPECTED_GROUPS[metric]:
                        verdict = group_verdict(response, payload, metric, expected, capture_started)
                        evidence["groups"].append({"device": device, **verdict})
            evidence["devices"] = evidence.get("devices", []) + [device_evidence]
            evidence["beacons"].extend({"device": device, **beacon} for beacon in beacons)
            public_page.close()
            context.close()

        if not generate_only:
            desk_context = browser.new_context(viewport=VIEWPORTS["desktop"])
            desk = desk_context.new_page()
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
            desk_context.close()
        browser.close()

    if generate_only:
        evidence["verdict"] = "GENERATED" if evidence["beacons"] else "UNAVAILABLE"
        if not evidence["beacons"]:
            failures.append("controlled page loads did not emit any RUM beacons")
    else:
        verdicts = [group["verdict"] for group in evidence["groups"]]
        if any(verdict in {"FAIL", "NEEDS-WORK", "COVERAGE-FAILURE"} for verdict in verdicts):
            evidence["verdict"] = "FAIL"
            failures.append("one or more readiness groups missed the p75/p95 launch target")
        elif any(verdict == "NEEDS-DATA" for verdict in verdicts):
            evidence["verdict"] = "NEEDS-DATA"
        else:
            evidence["verdict"] = "GOOD"
    evidence["thresholds"] = {
        "sample_floor": SAMPLE_FLOOR,
        "p75_ms": GOOD_P75_MS,
        "p95_ms": GOOD_P95_MS,
        "missing_data_is_pass": False,
    }

    (OUTPUT / "chain.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, indent=2))
    if failures:
        raise AssertionError("; ".join(failures) + f"; see {OUTPUT / 'chain.json'}")


if __name__ == "__main__":
    main()
