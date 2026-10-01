#!/usr/bin/env python3
"""Scheduled synthetic probe for Near You geography-navigation field vitals.

Visits the committed Near You path on the deployed site at both binding
viewports (desktop and mobile), stamps every observation
``traffic_class=synthetic``, and drives one real interaction per visit so INP
can retain observations. Load-and-idle alone leaves the INP cell unclosable.

The marker is installed as a page-context global before document scripts run
(same mechanism as the Notice synthetic probe). It is not carried on the page
URL.

  ops/notice-probe/.venv/bin/python3 tools/run_near_you_synthetic_probe.py --plan
  ops/notice-probe/.venv/bin/python3 tools/run_near_you_synthetic_probe.py --check-runtime
  ops/notice-probe/.venv/bin/python3 tools/run_near_you_synthetic_probe.py --out result.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PAGES = ROOT / "data" / "performance" / "near-you-synthetic-probe.json"
DEFAULT_BASE = "https://cityscroll.org"
TRAFFIC_CLASS = "synthetic"
PROBE_SCHEMA = "cityscroll.near_you_synthetic_probe_result.v1"
PLAN_SCHEMA = "cityscroll.near_you_synthetic_probe_plan.v1"
RUNTIME_SCHEMA = "cityscroll.near_you_synthetic_probe_runtime_check.v1"
PAGES_SCHEMA = "cityscroll.near_you_synthetic_probe_pages.v1"

RUNTIME_DIR = ROOT / "ops" / "notice-probe"
RUNTIME_PYTHON = RUNTIME_DIR / ".venv" / "bin" / "python3"
DEFAULT_BROWSERS_PATH = RUNTIME_DIR / "browsers"
SETUP_COMMAND = "tools/setup_notice_probe_runtime.sh"
RUNTIME_MISSING_ERROR = f"probe runtime not set up: run {SETUP_COMMAND}"


def browsers_path() -> Path:
    configured = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    return Path(configured) if configured else DEFAULT_BROWSERS_PATH


def load_playwright() -> Any:
    path = browsers_path()
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(path)
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        raise SystemExit(f"{RUNTIME_MISSING_ERROR} (no Playwright for {sys.executable}: {error})")
    if not any(path.glob("chromium-*")):
        raise SystemExit(f"{RUNTIME_MISSING_ERROR} (no Chromium build under {path})")
    return sync_playwright


def check_runtime() -> dict[str, Any]:
    sync_playwright = load_playwright()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        version = browser.version
        browser.close()
    return {
        "schema": RUNTIME_SCHEMA,
        "observed_at": now_iso(),
        "python": sys.executable,
        "browsers_path": str(browsers_path()),
        "browser_version": version,
        "observations_emitted": 0,
        "status": "ready",
    }


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_pages(path: Path) -> dict[str, Any]:
    document = json.loads(path.read_text(encoding="utf-8"))
    if document.get("schema") != PAGES_SCHEMA:
        raise SystemExit(f"unexpected page-list schema in {path}")
    if document.get("traffic_class") != TRAFFIC_CLASS:
        raise SystemExit(f"page list is not marked {TRAFFIC_CLASS}: {path}")
    pages = document.get("pages") or []
    profiles = document.get("device_profiles") or []
    if not isinstance(pages, list) or not pages:
        raise SystemExit(f"page list carries no pages: {path}")
    if not isinstance(profiles, list) or len(profiles) < 2:
        raise SystemExit(f"page list must declare desktop and mobile device_profiles: {path}")
    classes = {profile.get("device_class") for profile in profiles}
    if classes != {"desktop", "mobile"}:
        raise SystemExit(f"device_profiles must cover desktop and mobile exactly once each: {sorted(classes)}")
    for page in pages:
        path_value = page.get("path")
        if not isinstance(path_value, str) or not path_value.startswith("/"):
            raise SystemExit(f"page list carries a path that is not site-relative: {path_value!r}")
        if urlsplit(path_value).query or "#" in path_value:
            raise SystemExit(f"page list carries a marker on the page URL: {path_value!r}")
    return document


def build_plan(document: dict[str, Any], base: str) -> dict[str, Any]:
    policy = document.get("visit_policy") or {}
    origin = base.rstrip("/")
    visits: list[dict[str, Any]] = []
    for profile in document["device_profiles"]:
        for page in document["pages"]:
            visits.append({
                "path": page["path"],
                "url": f"{origin}{page['path']}",
                "device_class": profile["device_class"],
                "device_profile_id": profile["id"],
                "device_profile": profile,
                "cold_cache": True,
                "interaction_required": bool((policy.get("interaction") or {}).get("required", True)),
            })
    return {
        "schema": PLAN_SCHEMA,
        "surface_id": document.get("surface_id"),
        "traffic_class": TRAFFIC_CLASS,
        "marker": {
            "mechanism": "page-context global installed before document scripts",
            "global": "CROL_RUM_TRAFFIC_CLASS",
            "value": TRAFFIC_CLASS,
            "delivery_flag": f"traffic_class={TRAFFIC_CLASS}",
            "inferred_from_user_agent": False,
            "carried_on_page_url": False,
        },
        "base": origin,
        "device_profiles": document.get("device_profiles"),
        "network_profile": document.get("network_profile"),
        "visit_policy": policy,
        "visits": visits,
    }


def emulate_network(page: Any, profile: dict[str, Any]) -> None:
    session = page.context.new_cdp_session(page)
    session.send("Network.enable")
    session.send("Network.emulateNetworkConditions", {
        "offline": False,
        "latency": profile.get("latency_ms", 0),
        "downloadThroughput": profile.get("download_throughput_bytes_per_second", -1),
        "uploadThroughput": profile.get("upload_throughput_bytes_per_second", -1),
    })


def count_observations(body: str | None) -> int:
    if not body:
        return 0
    try:
        batch = json.loads(body)
    except ValueError:
        return 0
    observations = batch.get("observations") if isinstance(batch, dict) else None
    return len(observations) if isinstance(observations, list) else 0


def drive_interaction(page: Any, selectors: list[str]) -> dict[str, Any]:
    """Click the first visible preferred control so INP can retain an observation."""
    for selector in selectors:
        locator = page.locator(selector).first
        try:
            if locator.count() == 0:
                continue
            if not locator.is_visible():
                continue
            locator.click(timeout=5000)
            return {"status": "clicked", "selector": selector}
        except Exception as error:  # noqa: BLE001
            last = {"status": "click_failed", "selector": selector, "detail": type(error).__name__}
            continue
    return {"status": "no_target", "selector": None}


def run_slot(plan: dict[str, Any], run_key: str) -> dict[str, Any]:
    sync_playwright = load_playwright()
    policy = plan.get("visit_policy") or {}
    settle_ms = int(policy.get("settle_ms", 8000))
    interaction_settle_ms = int(policy.get("interaction_settle_ms", 4000))
    page_timeout_ms = int(policy.get("page_timeout_ms", 60000))
    deadline = time.monotonic() + int(policy.get("run_budget_ms", 600000)) / 1000
    interaction = policy.get("interaction") or {}
    selectors = list(interaction.get("preferred_selectors") or ["button", "a[href]"])
    network = plan.get("network_profile") or {}

    visited: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    observations = 0
    marked_beacons = 0
    unmarked_beacons = 0
    budget_exhausted = False
    interactions: list[dict[str, Any]] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for visit in plan["visits"]:
            if time.monotonic() >= deadline:
                budget_exhausted = True
                failures.append({
                    "path": visit["path"],
                    "device_class": visit["device_class"],
                    "reason": "run_budget_exhausted",
                })
                continue
            device = visit.get("device_profile") or {}
            context = browser.new_context(
                viewport=device.get("viewport") or {"width": 390, "height": 844},
                device_scale_factor=device.get("device_scale_factor", 1),
                is_mobile=bool(device.get("is_mobile", False)),
                has_touch=bool(device.get("has_touch", False)),
            )
            context.add_init_script(
                f"window.CROL_RUM_TRAFFIC_CLASS = {json.dumps(TRAFFIC_CLASS)};"
            )
            page = context.new_page()

            def record(request: Any) -> None:
                nonlocal observations, marked_beacons, unmarked_beacons
                if request.method != "POST":
                    return
                parts = urlsplit(request.url)
                if not parts.path.rstrip("/").endswith("/performance-events"):
                    return
                if f"traffic_class={TRAFFIC_CLASS}" in parts.query:
                    marked_beacons += 1
                    observations += count_observations(request.post_data)
                else:
                    unmarked_beacons += 1

            page.on("request", record)
            try:
                emulate_network(page, network)
                response = page.goto(visit["url"], wait_until="domcontentloaded", timeout=page_timeout_ms)
                status = response.status if response else None
                if status != 200:
                    failures.append({
                        "path": visit["path"],
                        "device_class": visit["device_class"],
                        "reason": "page_unreachable",
                        "http_status": status,
                    })
                else:
                    page.wait_for_timeout(settle_ms)
                    interaction_result = {"status": "skipped"}
                    if visit.get("interaction_required", True):
                        interaction_result = drive_interaction(page, selectors)
                        page.wait_for_timeout(interaction_settle_ms)
                    interactions.append({
                        "path": visit["path"],
                        "device_class": visit["device_class"],
                        **interaction_result,
                    })
                    visited.append({
                        "path": visit["path"],
                        "device_class": visit["device_class"],
                        "http_status": status,
                        "interaction": interaction_result.get("status"),
                    })
            except Exception as error:  # noqa: BLE001
                failures.append({
                    "path": visit["path"],
                    "device_class": visit["device_class"],
                    "reason": "visit_failed",
                    "detail": type(error).__name__,
                })
            finally:
                page.close()
                context.close()
        browser.close()

    return {
        "schema": PROBE_SCHEMA,
        "run_key": run_key,
        "observed_at": now_iso(),
        "traffic_class": TRAFFIC_CLASS,
        "surface_id": plan.get("surface_id"),
        "base": plan.get("base"),
        "pages_listed": len(plan["visits"]),
        "pages_visited": len(visited),
        "observations_emitted": observations,
        "retained_observation_count": observations,
        "marked_beacons": marked_beacons,
        "unmarked_beacons": unmarked_beacons,
        "budget_exhausted": budget_exhausted,
        "visits": visited,
        "interactions": interactions,
        "failures": failures,
        "status": probe_status(len(plan["visits"]), len(visited), unmarked_beacons, interactions),
    }


def probe_status(
    listed: int,
    visited: int,
    unmarked_beacons: int,
    interactions: list[dict[str, Any]],
) -> str:
    if unmarked_beacons:
        return "failed"
    if visited == 0:
        return "failed"
    if any(item.get("status") == "no_target" for item in interactions):
        return "degraded"
    if visited < listed:
        return "degraded"
    return "healthy"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pages", type=Path, default=DEFAULT_PAGES)
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--run-key", default=None)
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--check-runtime", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.check_runtime:
        print(json.dumps(check_runtime(), indent=2))
        return 0

    document = load_pages(args.pages)
    plan = build_plan(document, args.base)
    if args.plan:
        print(json.dumps(plan, indent=2))
        return 0

    run_key = args.run_key or f"near-you-synthetic-{now_iso()}"
    result = run_slot(plan, run_key)
    text = json.dumps(result, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0 if result["status"] in {"healthy", "degraded"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
