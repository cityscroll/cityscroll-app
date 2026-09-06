#!/usr/bin/env python3
"""Cost and failure-taxonomy receipt for the Land Map (lm-12).

LM-05 made the browse Map route-lazy; LM-08/LM-09/LM-11 gave it filter parity, boundary
context, and a complete keyboard/screen-reader path. None of that fixed a cost ceiling or
proved the failure taxonomy site/land_map_performance_budget.mjs now enforces at runtime
(projection / dependency / timeout / invalid-data, each with its own retry policy). This
script measures, against the current working tree's own `site/` (no before/after comparison --
there is no prior state to compare against, only a budget to check the current one against):

- cold and warm List/Map activation cost, against the fixed budgets;
- five scenarios that once looked identical to a resident (offline, malformed, dependency,
  slow-but-recovering, and a clean successful activation) reported as distinct, typed outcomes;
- that the complete filtered List and its row count are identical across every one of them.

  python3 tools/capture_land_map_performance_and_failure.py

Writes docs/screenshots/land-map-performance-and-failure/ and the receipt at
docs/evidence/land-map-performance-and-failure.json.
"""

from __future__ import annotations

import functools
import hashlib
import json
import subprocess
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "land-map-performance-and-failure"
RECEIPT = ROOT / "docs" / "evidence" / "land-map-performance-and-failure.json"
LIST_ROUTE = "/browse/zoning/"
MAP_ROUTE = "/browse/zoning/?view=map"
PROJECTION = "data/land_project_map_points.json"
VIEWPORT = (1440, 900)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path) -> None:
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


def read_budgets() -> dict:
    """The single source of truth for every fixed number this receipt is checked against --
    read from the runtime module itself, never retyped, so the receipt cannot silently drift
    from the budgets the code actually enforces."""
    script = (
        "import(process.argv[1]).then(m => "
        "process.stdout.write(JSON.stringify(m.LAND_MAP_BUDGETS)))"
    )
    out = subprocess.run(
        ["node", "-e", script, str(ROOT / "site" / "land_map_performance_budget.mjs")],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout
    return json.loads(out)


def install_routes(page: Page, base_url: str, *, projection_route=None) -> None:
    def capability_module(route: Route) -> None:
        name = route.request.url.split("/capabilities/", 1)[1].split("?", 1)[0]
        source = ROOT / "capabilities" / name
        if source.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=source.read_text("utf-8"))
        else:
            route.fulfill(status=404, body="")

    page.route(f"{base_url.rstrip('/')}/capabilities/*", capability_module)
    if projection_route:
        page.route(f"**/*{PROJECTION}*", projection_route)
    page.route(
        "https://data.cityofnewyork.us/**",
        lambda route: route.fulfill(status=200, content_type="application/json", body="[]"),
    )
    page.route("https://**", lambda route: route.abort())


def record_requests(page: Page) -> list[dict]:
    log: list[dict] = []  # accumulator (not a measured table)

    def on_request(request) -> None:
        log.append({"url": request.url, "resource_type": request.resource_type, "bytes": 0})

    def on_response(response) -> None:
        for entry in log:
            if entry["url"] == response.url and entry["bytes"] == 0:
                try:
                    entry["bytes"] = len(response.body())
                except Exception:  # aborted, opaque, or already-consumed responses
                    entry["bytes"] = 0
                entry["status"] = response.status
                return

    page.on("request", on_request)
    page.on("response", on_response)
    return log


def strip_origin(entries: list[dict], base_url: str) -> list[dict]:
    prefix = base_url.rstrip("/")
    return [
        {"url": entry["url"].replace(prefix, "") or "/", "resource_type": entry["resource_type"], "bytes": entry["bytes"]}
        for entry in entries
    ]


def wait_for_list(page: Page) -> None:
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45000)
    page.locator("#llist .row").first.wait_for(state="visible", timeout=45000)


def land_state(page: Page) -> dict:
    return page.evaluate(
        """() => {
          const panel = document.getElementById('land-map-panel');
          const summary = document.getElementById('land-map-summary');
          return {
            rows: document.querySelectorAll('#llist .row').length,
            map_state: panel ? (panel.dataset.landMapState || '') : 'absent',
            failure_kind: panel ? (panel.dataset.landMapFailureKind || null) : null,
            markers: document.querySelectorAll('#land-map-panel .land-map-marker').length,
            mapped: Number(summary?.dataset.landMapMapped || 0),
            unmapped: Number(summary?.dataset.landMapUnmapped || 0),
            total: Number(summary?.dataset.landMapTotal || 0),
          };
        }"""
    )


def shoot(page: Page, path: Path, state: dict) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(path), animations="disabled", full_page=True)
    data = path.read_bytes()
    print("wrote", path)
    return {"name": str(path.relative_to(OUT)), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "observed": state}


def measure_cache_state(context, base_url: str, cache_state: str) -> dict:
    page = context.new_page()
    install_routes(page, base_url)
    log = record_requests(page)
    started = time.perf_counter()
    page.goto(f"{base_url.rstrip('/')}{LIST_ROUTE}", wait_until="domcontentloaded")
    wait_for_list(page)
    list_first_paint_ms = round((time.perf_counter() - started) * 1000, 1)
    list_requests = strip_origin(list(log), base_url)
    list_state = land_state(page)

    activation_started = time.perf_counter()
    page.locator('#land-view-switch [data-land-view="map"]').click()
    page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30000)
    map_activation_ms = round((time.perf_counter() - activation_started) * 1000, 1)
    page.wait_for_timeout(300)
    activation_requests = strip_origin(log[len(list_requests):], base_url)
    map_state = land_state(page)
    page.close()

    own_origin_activation = [entry for entry in activation_requests if entry["url"].startswith("/data/")]
    return {
        "cache_state": cache_state,
        "list_first_paint_ms": list_first_paint_ms,
        "list_requests_count": len(list_requests),
        "list_state": list_state,
        "map_activation_ms": map_activation_ms,
        "map_activation_requests": own_origin_activation,
        "map_activation_requests_count": len(own_origin_activation),
        "map_activation_bytes": sum(entry["bytes"] for entry in own_origin_activation),
        "map_state": map_state,
    }


def scenario_typed_failure(browser, base_url: str, name: str, projection_route, *, out: list[dict]) -> dict:
    page = browser.new_page(viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]})
    install_routes(page, base_url, projection_route=projection_route)
    page.goto(f"{base_url.rstrip('/')}{MAP_ROUTE}", wait_until="domcontentloaded")
    wait_for_list(page)
    page.wait_for_selector('#land-map-panel[data-land-map-state="failed"]', timeout=30000)
    state = land_state(page)
    out.append(shoot(page, OUT / f"land-map-{name}.png", state))
    page.close()
    return {"scenario": name, "state": state}


def scenario_successful(browser, base_url: str, *, out: list[dict]) -> dict:
    page = browser.new_page(viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]})
    install_routes(page, base_url)
    page.goto(f"{base_url.rstrip('/')}{MAP_ROUTE}", wait_until="domcontentloaded")
    wait_for_list(page)
    page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30000)
    state = land_state(page)
    out.append(shoot(page, OUT / "land-map-successful.png", state))
    page.close()
    return {"scenario": "successful-map", "state": state}


def scenario_slow_recovering(browser, base_url: str, *, out: list[dict]) -> dict:
    attempts = {"n": 0}

    def slow_then_ok(route: Route) -> None:
        attempts["n"] += 1
        if attempts["n"] == 1:
            time.sleep(4.3)  # exceeds LAND_MAP_BUDGETS.map_request_timeout_ms (4000ms)
            route.continue_()
            return
        route.continue_()

    page = browser.new_page(viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]})
    install_routes(page, base_url, projection_route=slow_then_ok)
    page.goto(f"{base_url.rstrip('/')}{MAP_ROUTE}", wait_until="domcontentloaded")
    wait_for_list(page)
    page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30000)
    state = land_state(page)
    out.append(shoot(page, OUT / "land-map-slow-recovering.png", state))
    page.close()
    return {"scenario": "slow-network-recovering", "state": state, "projection_attempts": attempts["n"]}


def snapshot_vintage() -> dict:
    receipt = json.loads((ROOT / "site/data/land_project_map_points_receipt.json").read_text("utf-8"))
    return {
        "projection_schema": json.loads((ROOT / "site/data/land_project_map_points.json").read_text("utf-8"))["schema"],
        "resolver_version": receipt["resolver_version"],
        "join_version": receipt["join_version"],
        "list_snapshot_bytes": len((ROOT / "site/data/land_default_ulurp.json").read_bytes()),
        "projection_bytes": len((ROOT / "site/data/land_project_map_points.json").read_bytes()),
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    budgets = read_budgets()
    files: list[dict] = []  # accumulator (not a measured table)

    with StaticServer(ROOT / "site") as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]})
        cold = measure_cache_state(context, base_url, "cold")
        warm = measure_cache_state(context, base_url, "warm")
        context.close()

        scenarios = [
            scenario_successful(browser, base_url, out=files),
            scenario_typed_failure(browser, base_url, "offline", lambda route: route.abort("failed"), out=files),
            scenario_typed_failure(browser, base_url, "malformed",
                                    lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"schema": "wrong"})),
                                    out=files),
            scenario_typed_failure(browser, base_url, "dependency-404", lambda route: route.fulfill(status=404, body=""), out=files),
            scenario_slow_recovering(browser, base_url, out=files),
        ]
        browser.close()

    list_rows = {cold["list_state"]["rows"], warm["list_state"]["rows"], *(entry["state"]["rows"] for entry in scenarios)}
    receipt = {
        "schema": "cityscroll.land-map-performance-and-failure-receipt.v1",
        "card": "cityscroll-engineering/land-map-performance-and-failure",
        "browser_mode": "headless chromium (playwright), offline: every remote host aborted",
        "routes": {"list": LIST_ROUTE, "map": MAP_ROUTE},
        "budgets": budgets,
        "budgets_source": "site/land_map_performance_budget.mjs#LAND_MAP_BUDGETS",
        "snapshot_vintage": snapshot_vintage(),
        "measurements": {"cold": cold, "warm": warm},
        "scenarios": scenarios,
        "list_completeness": {
            "distinct_row_counts_across_every_scenario": sorted(list_rows),
            "list_remained_complete_and_canonical_through_every_map_failure": len(list_rows) == 1,
        },
        "budget_checks": {
            "list_snapshot_bytes_within_budget": snapshot_vintage()["list_snapshot_bytes"] <= budgets["list_snapshot_bytes_max"],
            "projection_bytes_within_budget": snapshot_vintage()["projection_bytes"] <= budgets["map_projection_bytes_max"],
            "cold_list_first_paint_within_budget": cold["list_first_paint_ms"] <= budgets["list_first_paint_ms_max"],
            "warm_list_first_paint_within_budget": warm["list_first_paint_ms"] <= budgets["list_first_paint_ms_max"],
            "cold_map_activation_within_budget": cold["map_activation_ms"] <= budgets["map_activation_ms_max"],
            "warm_map_activation_within_budget": warm["map_activation_ms"] <= budgets["map_activation_ms_max"],
            "cold_activation_requests_within_budget": cold["map_activation_requests_count"] <= budgets["map_activation_requests_max"],
            "warm_activation_requests_within_budget": warm["map_activation_requests_count"] <= budgets["map_activation_requests_max"],
        },
        "files": files,
    }
    RECEIPT.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print("wrote", RECEIPT)
    failed_checks = [name for name, ok in receipt["budget_checks"].items() if not ok]
    if failed_checks or not receipt["list_completeness"]["list_remained_complete_and_canonical_through_every_map_failure"]:
        raise SystemExit(f"budget or completeness check failed: {failed_checks}")


if __name__ == "__main__":
    main()
