#!/usr/bin/env python3
"""Run CityScroll's deterministic browser performance contract."""

from __future__ import annotations

import argparse
import functools
import gzip
import json
import math
from pathlib import Path
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import (
    Browser,
    BrowserContext,
    Page,
    Route,
    TimeoutError as PlaywrightTimeoutError,
    sync_playwright,
)


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BUDGETS = ROOT / "performance-budgets.json"
DEFAULT_FIXTURES = ROOT / "test" / "performance" / "fixtures"
DEFAULT_OUTPUT = ROOT / "test" / "performance" / "artifacts" / "results.json"
METRIC_KEYS = {
    "ttfbMs",
    "fcpMs",
    "lcpMs",
    "cls",
    "wireBytes",
    "visualResponseMs",
    "settledMs",
    "eventDurationMs",
}
LAND_OUTCOME_WAIT_TIMEOUT_MS = 45_000
LAND_OUTCOME_WAIT_ATTEMPTS = 2


def wait_for_land_outcome(page: Page, expression: str, label: str) -> None:
    """Retry only Playwright readiness timeouts; assertions and budgets stay hard."""
    for attempt in range(LAND_OUTCOME_WAIT_ATTEMPTS):
        try:
            page.wait_for_function(expression, timeout=LAND_OUTCOME_WAIT_TIMEOUT_MS)
            return
        except PlaywrightTimeoutError:
            if attempt + 1 >= LAND_OUTCOME_WAIT_ATTEMPTS:
                raise
            print(
                f"TRANSIENT wait timeout for {label}; retrying "
                f"(attempt {attempt + 2}/{LAND_OUTCOME_WAIT_ATTEMPTS})",
                flush=True,
            )


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path):
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--budgets", type=Path, default=DEFAULT_BUDGETS)
    parser.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES)
    parser.add_argument("--fixture", help="Run one named fixture")
    parser.add_argument("--viewport", help="Run one named viewport")
    parser.add_argument("--samples", type=int, help="Override measured sample count")
    parser.add_argument(
        "--assert",
        dest="assert_metric",
        choices=sorted(METRIC_KEYS),
        help="Check only one metric (fixture invariants are always checked)",
    )
    parser.add_argument("--site-root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        raise SystemExit(f"missing required file: {path}") from None
    except json.JSONDecodeError as error:
        raise SystemExit(f"invalid JSON in {path}: {error}") from None
    if not isinstance(value, dict):
        raise SystemExit(f"expected a JSON object in {path}")
    return value


def validate_contract(budgets: dict[str, Any], fixture_dir: Path) -> None:
    if budgets.get("version") != 1:
        raise SystemExit("performance budget version must be 1")
    statistics_config = budgets.get("statistics", {})
    if not isinstance(statistics_config.get("samples"), int):
        raise SystemExit("statistics.samples must be an integer")
    viewport_names = set(budgets.get("viewports", {}))
    if not viewport_names:
        raise SystemExit("at least one viewport is required")
    fixtures = budgets.get("fixtures", {})
    if not fixtures:
        raise SystemExit("at least one performance fixture is required")
    for name, budget in fixtures.items():
        unknown = set(budget.get("viewports", [])) - viewport_names
        if unknown:
            raise SystemExit(f"{name} names unknown viewports: {sorted(unknown)}")
        fixture_path = fixture_dir / f"{name}.json"
        fixture = load_json(fixture_path)
        if fixture.get("version") != 1:
            raise SystemExit(f"{fixture_path} must declare version 1")
        required = set(("sourceDelayMs", "editionDate", "today", "contracts", "selectionMethods"))
        missing = required - set(fixture)
        if missing:
            raise SystemExit(f"{fixture_path} is missing keys: {sorted(missing)}")


def quantile(values: list[float], probability: float) -> float:
    if not values:
        raise ValueError("cannot calculate a quantile without samples")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def fulfill_json(route: Route, value: object, delay_ms: int = 0) -> None:
    if delay_ms:
        time.sleep(delay_ms / 1000)
    route.fulfill(
        status=200,
        content_type="application/json",
        headers={"Cache-Control": "public, max-age=3600"},
        body=json.dumps(value, separators=(",", ":")),
    )


def soda_response(url: str, fixture: dict[str, Any]) -> object:
    if urlparse(url).path.endswith("/hgx4-8ukb.json"):
        return fixture.get("landProjects", [])
    query = parse_qs(urlparse(url).query)
    select = query.get("$select", [""])[0]
    where = query.get("$where", [""])[0]
    limit = query.get("$limit", [""])[0]
    today = fixture["today"]
    if "max(start_date)" in select:
        return [{"m": f"{fixture['editionDate']}T00:00:00.000"}]
    if "section_name, count(1) as n" in select:
        return today["counts"]
    if select == "agency_name" and "start_date=" in where:
        return today["agencies"]
    if select == "agency_name":
        return today["agencies"]
    if "selection_method_description, count(1) as n" in select:
        return fixture["selectionMethods"]
    if limit == "1" and "type_of_notice_description='Award'" in where:
        return today["award"]
    if limit == "1" and "type_of_notice_description='Solicitation'" in where:
        return today["closing"]
    if limit == "1" and "Public Hearings and Meetings" in where:
        return today["hearing"]
    if query.get("$q", [""])[0].lower() == "housing":
        return fixture["contracts"]
    if "type_of_notice_description='Solicitation'" in where:
        return fixture["contracts"]
    return []


def install_routes(page: Page, fixture: dict[str, Any], unexpected: list[str]) -> None:
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
    page.route("https://static.cloudflareinsights.com/**", lambda route: route.abort())
    page.route("https://challenges.cloudflare.com/**", lambda route: route.abort())
    page.route("https://scripts.clarity.ms/**", lambda route: route.abort())
    page.route("https://j.clarity.ms/**", lambda route: route.abort())

    delay = int(fixture["sourceDelayMs"])

    def city_data(route: Route) -> None:
        fulfill_json(route, soda_response(route.request.url, fixture), delay)

    def worker_data(route: Route) -> None:
        path = urlparse(route.request.url).path
        if path.endswith("/suggestions"):
            fulfill_json(route, {"suggestions": []}, delay)
        elif path.endswith("/property-locations"):
            fulfill_json(route, {"rows": []}, delay)
        else:
            fulfill_json(route, {}, delay)

    page.route("https://data.cityofnewyork.us/**", city_data)
    page.route("https://api.cityscroll.org/**", worker_data)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker_data)

    def reject_unknown(route: Route) -> None:
        unexpected.append(route.request.url)
        route.abort()

    page.route("https://**", reject_unknown)


def install_observers(page: Page) -> None:
    page.add_init_script(
        """
        (() => {
          window.__cityscrollPerf = {cls: 0, lcpMs: 0, eventDurationMs: 0};
          new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
              if (!entry.hadRecentInput) window.__cityscrollPerf.cls += entry.value;
            }
          }).observe({type: "layout-shift", buffered: true});
          new PerformanceObserver(list => {
            const entries = list.getEntries();
            if (entries.length) {
              window.__cityscrollPerf.lcpMs = entries[entries.length - 1].startTime;
            }
          }).observe({type: "largest-contentful-paint", buffered: true});
          try {
            new PerformanceObserver(list => {
              for (const entry of list.getEntries()) {
                window.__cityscrollPerf.eventDurationMs =
                  Math.max(window.__cityscrollPerf.eventDurationMs, entry.duration || 0);
              }
            }).observe({type: "event", buffered: true, durationThreshold: 0});
          } catch (_error) {}
        })();
        """
    )


def local_wire_inventory(
    page: Page, site_root: Path, base_url: str
) -> tuple[int, list[dict[str, Any]]]:
    names: list[str] = page.evaluate(
        """base => performance.getEntriesByType("resource")
          .map(entry => entry.name)
          .filter(name => name.startsWith(base))""",
        base_url,
    )
    names.append(base_url)
    files: set[Path] = set()
    base_path = urlparse(base_url).path
    for name in names:
        path = urlparse(name).path
        relative = path[len(base_path) :] if path.startswith(base_path) else path.lstrip("/")
        candidate = site_root / (relative or "index.html")
        if candidate.is_dir():
            candidate = candidate / "index.html"
        if candidate.is_file():
            files.add(candidate)
    inventory = sorted(
        (
            {
                "path": path.relative_to(site_root).as_posix(),
                "gzipBytes": len(gzip.compress(path.read_bytes(), compresslevel=9)),
            }
            for path in files
        ),
        key=lambda item: (-item["gzipBytes"], item["path"]),
    )
    return sum(item["gzipBytes"] for item in inventory), inventory


def local_wire_bytes(page: Page, site_root: Path, base_url: str) -> int:
    total, _inventory = local_wire_inventory(page, site_root, base_url)
    return total


def nav_metrics(page: Page) -> dict[str, float]:
    return page.evaluate(
        """
        () => {
          const nav = performance.getEntriesByType("navigation")[0];
          const paints = performance.getEntriesByType("paint");
          const fcp = paints.find(entry => entry.name === "first-contentful-paint");
          return {
            ttfbMs: nav ? nav.responseStart - nav.startTime : 0,
            fcpMs: fcp ? fcp.startTime : 0,
            lcpMs: window.__cityscrollPerf.lcpMs,
            cls: window.__cityscrollPerf.cls,
            eventDurationMs: window.__cityscrollPerf.eventDurationMs
          };
        }
        """
    )


def wait_for_home(page: Page) -> None:
    # Homepage: masthead CTA + default Contracts list (edition strip removed).
    page.wait_for_function(
        """() => {
          const cta = document.getElementById('homeCta');
          const listReady = document.querySelectorAll('#list .row').length > 0
            || document.querySelector('#list .empty');
          return !!cta && !!listReady;
        }"""
    )
    page.wait_for_timeout(120)


def measure_home(
    browser: Browser,
    base_url: str,
    viewport: dict[str, int],
    fixture: dict[str, Any],
    site_root: Path,
    warm: bool,
) -> tuple[dict[str, Any], list[str]]:
    unexpected: list[str] = list()
    context = browser.new_context(viewport=viewport)
    page = context.new_page()
    install_routes(page, fixture, unexpected)
    if warm:
        page.goto(base_url, wait_until="domcontentloaded")
        wait_for_home(page)
        page.close()
        page = context.new_page()
        install_routes(page, fixture, unexpected)
    install_observers(page)
    page.goto(base_url, wait_until="domcontentloaded")
    wait_for_home(page)
    metrics = nav_metrics(page)
    if not warm:
        wire_bytes, wire_files = local_wire_inventory(page, site_root, base_url)
        metrics["wireBytes"] = float(wire_bytes)
        metrics["wireFiles"] = wire_files
    context.close()
    return metrics, unexpected


def measure_contracts(
    browser: Browser,
    base_url: str,
    viewport: dict[str, int],
    fixture: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    unexpected: list[str] = list()
    context = browser.new_context(viewport=viewport)
    page = context.new_page()
    install_routes(page, fixture, unexpected)
    install_observers(page)
    page.goto(base_url, wait_until="domcontentloaded")
    page.locator("#rescount").wait_for(state="attached")
    page.wait_for_function("() => document.querySelector('#rescount').textContent.trim() !== ''")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_function("() => document.querySelector('#rescount').textContent.trim() !== ''")
    # The interaction budget starts from a settled warm page. Otherwise the initial agency,
    # Today, and detail hydrations can be charged to a later keyword event nondeterministically.
    # Prefer networkidle, but modular ES loads + suggestion/analytics side-fetches can keep the
    # network chatty past Playwright's default 30s; fall back to product-ready DOM so the
    # budget still measures a warm Contracts surface rather than a harness timeout.
    try:
        page.wait_for_load_state("networkidle", timeout=12_000)
    except Exception:
        page.wait_for_function(
            "() => {"
            "  const n = document.querySelector('#rescount')?.textContent?.trim();"
            "  const list = document.querySelector('#list');"
            "  return !!n && !!list && !list.querySelector('.loading');"
            "}"
        )
        page.wait_for_timeout(250)

    visual_response_ms = page.evaluate(
        """
        () => {
          const start = performance.now();
          document.querySelector('.tabbtn[data-tab="money"]').click();
          return performance.now() - start;
        }
        """
    )
    keyword = page.locator("#kw")
    visible = keyword.is_visible()
    state = page.evaluate(
        """
        () => {
          const input = document.querySelector("#kw");
          const controls = input.closest(".lens-toolbar");
          const toggle = controls.querySelector("#money-more-filters > summary");
          const rect = input.getBoundingClientRect();
          return {
            activeTab: document.querySelector(".tabbtn.active")?.dataset.tab || null,
            activePane: document.querySelector(".tabpane.active")?.id || null,
            keywordVisible: rect.width > 0 && rect.height > 0,
            controlsDisplay: getComputedStyle(controls).display,
            toggleVisible: !!toggle && getComputedStyle(toggle).display !== "none",
            expanded: toggle?.getAttribute("aria-expanded") || null
          };
        }
        """
    )
    if not visible or not state["keywordVisible"]:
        context.close()
        return {
            "visualResponseMs": visual_response_ms,
            "settledMs": 1_000_000_000,
            "eventDurationMs": 0,
            "invariant": 0,
            "state": state,
        }, unexpected

    page.evaluate("window.__cityscrollPerf.eventDurationMs = 0")
    # Use the public input path measured by the performance contract. Pressing Enter here would
    # start an immediate search and leave the input handler's 500 ms debounce queued, producing
    # a second request that real type-and-pause use does not make.
    start = time.perf_counter()
    keyword.fill("housing")
    page.wait_for_function(
        """() => location.pathname === "/browse/contracts/" &&
          new URLSearchParams(location.search).get("q") === "housing" &&
          document.querySelector("#rescount").textContent.trim() !== "" &&
          document.querySelector("#list .row, #list .empty")"""
    )
    settled_ms = (time.perf_counter() - start) * 1000
    page.wait_for_timeout(120)
    event_duration = page.evaluate("window.__cityscrollPerf?.eventDurationMs || 0")
    context.close()
    return {
        "visualResponseMs": visual_response_ms,
        "settledMs": settled_ms,
        "eventDurationMs": event_duration,
        "invariant": 1,
        "state": state,
    }, unexpected


def measure_land_outcomes(
    browser: Browser,
    base_url: str,
    viewport: dict[str, int],
    fixture: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    unexpected: list[str] = list()
    context = browser.new_context(viewport=viewport)
    page = context.new_page()
    install_routes(page, fixture, unexpected)
    page.route(
        "https://services5.arcgis.com/**",
        lambda route: fulfill_json(route, {"features": []}),
    )
    page.route(
        "https://geosearch.planninglabs.nyc/**",
        lambda route: fulfill_json(route, {"features": []}),
    )
    page.goto(base_url, wait_until="domcontentloaded")
    page.wait_for_selector('.tabbtn[data-tab="land"]')
    # Start from an interaction-ready page. The tab markup is static, but the
    # route-lazy handlers arrive with the application module graph.
    wait_for_land_outcome(
        page,
        "() => typeof window.showTab === 'function' && typeof window.landSearch === 'function'",
        "land module readiness",
    )
    wait_for_land_outcome(
        page,
        """() => {
          const count = document.querySelector('#rescount')?.textContent?.trim();
          const list = document.querySelector('#list');
          return !!count && !!list && !list.querySelector('.loading');
        }""",
        "land source list readiness",
    )
    started_at = page.evaluate(
        """() => {
          window.__landOutcomeFirstPaintAt = null;
          const mark = () => {
            if (window.__landOutcomeFirstPaintAt != null) return;
            const panel = document.querySelector('#land-outcomes');
            if (panel?.querySelector('[data-zap-outcomes-first-paint]') &&
                panel.querySelector('[data-zap-outcomes-state="present"], [data-zap-outcomes-state="absent"]')) {
              window.__landOutcomeFirstPaintAt = performance.now();
              observer.disconnect();
            }
          };
          const observer = new MutationObserver(mark);
          observer.observe(document.querySelector('#ldetail'), {childList: true, subtree: true});
          const started = performance.now();
          document.querySelector('.tabbtn[data-tab="land"]').click();
          mark();
          return started;
        }"""
    )
    wait_for_land_outcome(
        page,
        """() => {
          const panel = document.querySelector('#land-outcomes');
          return !!panel?.querySelector('[data-zap-outcomes-first-paint]')
            && !!panel.querySelector('[data-zap-outcomes-state="present"], [data-zap-outcomes-state="absent"]');
        }""",
        "land outcomes first paint",
    )
    settled_ms = page.evaluate("window.__landOutcomeFirstPaintAt") - started_at
    state = page.evaluate(
        """() => {
          const panel = document.querySelector('#land-outcomes');
          return {
            spinnerCount: panel?.querySelectorAll('.loading').length || 0,
            state: panel?.querySelector('[data-zap-outcomes-state]')?.dataset.zapOutcomesState || null,
            firstPaint: panel?.querySelector('[data-zap-outcomes-first-paint]')?.dataset.zapOutcomesFirstPaint || null
          };
        }"""
    )
    context.close()
    return {
        "settledMs": settled_ms,
        "invariant": int(
            state["spinnerCount"] == 0
            and state["state"] in ("present", "absent")
            and state["firstPaint"] == "1"
        ),
        "state": state,
    }, unexpected


def measure(
    browser: Browser,
    fixture_name: str,
    base_url: str,
    viewport: dict[str, int],
    fixture: dict[str, Any],
    site_root: Path,
) -> tuple[dict[str, Any], list[str]]:
    if fixture_name == "home.cold":
        return measure_home(browser, base_url, viewport, fixture, site_root, warm=False)
    if fixture_name == "home.warm":
        return measure_home(browser, base_url, viewport, fixture, site_root, warm=True)
    if fixture_name == "contracts.keyword-housing":
        return measure_contracts(browser, base_url, viewport, fixture)
    if fixture_name == "land.outcomes-first-paint":
        return measure_land_outcomes(browser, base_url, viewport, fixture)
    raise SystemExit(f"no runner exists for fixture {fixture_name}")


def main() -> int:
    args = parse_args()
    budgets = load_json(args.budgets.resolve())
    fixture_dir = args.fixtures.resolve()
    site_root = args.site_root.resolve()
    validate_contract(budgets, fixture_dir)
    samples = args.samples or budgets["statistics"]["samples"]
    if samples < 1:
        raise SystemExit("--samples must be at least 1")
    quantile_probability = float(budgets["statistics"]["quantile"])
    warmups = int(budgets["statistics"]["warmupSamples"])

    fixture_names = [args.fixture] if args.fixture else list(budgets["fixtures"])
    if any(name not in budgets["fixtures"] for name in fixture_names):
        raise SystemExit(f"unknown fixture: {args.fixture}")

    results: dict[str, Any] = {
        "version": 1,
        "statistics": {
            "quantile": quantile_probability,
            "samples": samples,
            "warmupSamples": warmups,
        },
        "runs": [],
    }
    failures: list[str] = list()

    with StaticServer(site_root) as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for fixture_name in fixture_names:
            budget = budgets["fixtures"][fixture_name]
            fixture = load_json(fixture_dir / f"{fixture_name}.json")
            viewport_names = [args.viewport] if args.viewport else budget["viewports"]
            for viewport_name in viewport_names:
                if viewport_name not in budget["viewports"]:
                    raise SystemExit(f"{fixture_name} does not support viewport {viewport_name}")
                viewport = budgets["viewports"][viewport_name]
                raw: list[dict[str, Any]] = list()
                wire_inventories: list[list[dict[str, Any]]] = list()
                unexpected: set[str] = set()
                for index in range(warmups + samples):
                    sample, sample_unexpected = measure(
                        browser, fixture_name, base_url, viewport, fixture, site_root
                    )
                    unexpected.update(sample_unexpected)
                    if index >= warmups:
                        wire_files = sample.pop("wireFiles", None)
                        if wire_files is not None:
                            wire_inventories.append(wire_files)
                        raw.append(sample)
                    if (index + 1) % 5 == 0:
                        print(
                            f"progress {fixture_name} [{viewport_name}] "
                            f"{min(index + 1, warmups + samples)}/{warmups + samples}",
                            flush=True,
                        )

                summary: dict[str, float] = dict()
                for metric in METRIC_KEYS:
                    values = [
                        float(sample[metric])
                        for sample in raw
                        if metric in sample and isinstance(sample[metric], (int, float))
                    ]
                    if values:
                        summary[metric] = quantile(values, quantile_probability)
                invariant_passed = all(sample.get("invariant", 1) == 1 for sample in raw)
                run_failures: list[str] = list()
                wire_files = wire_inventories[0] if wire_inventories else None
                if "wireBytes" in budget and len(wire_inventories) != len(raw):
                    run_failures.append(
                        "wire file inventory was not captured for every measured sample"
                    )
                elif wire_files is not None and any(
                    inventory != wire_files for inventory in wire_inventories[1:]
                ):
                    run_failures.append(
                        "wire file inventory changed across measured samples"
                    )
                if budget.get("invariant") and not invariant_passed:
                    state = next(
                        (sample.get("state") for sample in raw if sample.get("invariant") != 1),
                        {},
                    )
                    run_failures.append(
                        f"invariant {budget['invariant']} failed with state {json.dumps(state, sort_keys=True)}"
                    )
                for metric, ceiling in budget.items():
                    if metric not in METRIC_KEYS:
                        continue
                    if args.assert_metric and metric != args.assert_metric:
                        continue
                    measured = summary.get(metric)
                    if measured is None:
                        run_failures.append(f"{metric} was not measured")
                    elif measured > float(ceiling):
                        run_failures.append(
                            f"{metric} p95 {measured:.3f} exceeds {float(ceiling):.3f}"
                        )
                if unexpected:
                    run_failures.append(
                        "unexpected external requests: " + ", ".join(sorted(unexpected))
                    )
                status = "PASS" if not run_failures else "FAIL"
                print(
                    f"{status} {fixture_name} [{viewport_name}] "
                    + ", ".join(f"{key}={value:.3f}" for key, value in sorted(summary.items()))
                )
                for failure in run_failures:
                    print(f"  {failure}", file=sys.stderr)
                failures.extend(
                    f"{fixture_name} [{viewport_name}]: {failure}" for failure in run_failures
                )
                run_result = {
                    "fixture": fixture_name,
                    "viewport": viewport_name,
                    "status": status,
                    "budget": budget,
                    "p95": summary,
                    "samples": raw,
                    "failures": run_failures,
                }
                if wire_files is not None:
                    run_result["wireFiles"] = wire_files
                results["runs"].append(run_result)
        browser.close()

    results["status"] = "FAIL" if failures else "PASS"
    results["failures"] = failures
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2, allow_nan=False) + "\n")
    print(f"Raw results: {args.output}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
