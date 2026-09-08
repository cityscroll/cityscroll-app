#!/usr/bin/env python3
"""Scheduled synthetic probe for the Notice performance read-back.

Visits a committed list of Notice pages on the deployed site with headless
Chrome and lets the shipped RUM collector report its own milestones. Every
observation the visit produces is marked ``traffic_class=synthetic`` by the
probe client itself, so the read-back can partition the retained dataset into a
resident group and a synthetic group and never pool them.

The marker is installed as a page-context global before any document script
runs, which the shipped bootstrap reads and the delivery leg forwards to the
collector as an explicit query flag. It is deliberately not carried on the page
URL: the Notice route rewrites an unrecognised hash, and a query string changes
the edge cache key, so a URL-borne marker would alter the very response the
probe exists to measure. Nothing is inferred from the user agent.

This probe measures the deployed surface under one fixed device and network
profile. It is not resident experience and can never be reported as such.

The browser it drives is not the host's. Both the Playwright package and the
Chromium build live in a project-scoped runtime under ``ops/notice-probe``,
created by ``tools/setup_notice_probe_runtime.sh`` from a pinned requirements
file. The scheduler names that interpreter absolutely rather than searching a
PATH, because launchd starts an agent with the system default PATH and the
system interpreter carries no Playwright: the probe used to exit on its import
line before it could measure anything, and a missing runtime presented only as a
failed slot. It now reports itself by name instead.

  ops/notice-probe/.venv/bin/python3 tools/run_notice_synthetic_probe.py --plan
  ops/notice-probe/.venv/bin/python3 tools/run_notice_synthetic_probe.py --check-runtime
  ops/notice-probe/.venv/bin/python3 tools/run_notice_synthetic_probe.py --out result.json
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
DEFAULT_PAGES = ROOT / "data" / "performance" / "notice-synthetic-probe-pages.json"
DEFAULT_BASE = "https://cityscroll.org"
TRAFFIC_CLASS = "synthetic"
PROBE_SCHEMA = "cityscroll.notice_synthetic_probe_result.v1"
PLAN_SCHEMA = "cityscroll.notice_synthetic_probe_plan.v1"
RUNTIME_SCHEMA = "cityscroll.notice_synthetic_probe_runtime_check.v1"

# The project-scoped runtime. Both paths are inside the checkout so the probe
# depends on nothing a host happens to have installed globally, and so removing
# two directories removes the whole install.
RUNTIME_DIR = ROOT / "ops" / "notice-probe"
RUNTIME_PYTHON = RUNTIME_DIR / ".venv" / "bin" / "python3"
DEFAULT_BROWSERS_PATH = RUNTIME_DIR / "browsers"
SETUP_COMMAND = "tools/setup_notice_probe_runtime.sh"
# One named error for every way the runtime can be absent. A slot log that says
# this is unambiguous about its failure class; a ModuleNotFoundError is not.
RUNTIME_MISSING_ERROR = f"probe runtime not set up: run {SETUP_COMMAND}"


def browsers_path() -> Path:
    """Where the probe looks for its browser build.

    An explicit ``PLAYWRIGHT_BROWSERS_PATH`` wins, so a host that already
    manages the build elsewhere is not overridden; otherwise the checkout-local
    directory the setup script fills is used rather than the shared
    ``~/.cache/ms-playwright``, which another tool can install into or clear.
    """
    configured = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    return Path(configured) if configured else DEFAULT_BROWSERS_PATH


def load_playwright() -> Any:
    """Resolve the runtime, or fail by its name.

    Two absences are the same failure for an operator — the package is not
    installed, or it is installed with no browser to drive — and both are
    repaired by the same command, so both report it.
    """
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
    """Start and stop the browser without visiting anything.

    A dry invocation: it proves the runtime the next slot will use can actually
    launch, and it emits no observation, so it can be run by hand after setup
    without adding a point to the retained synthetic series.
    """
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
    if document.get("schema") != "cityscroll.notice_synthetic_probe_pages.v1":
        raise SystemExit(f"unexpected page-list schema in {path}")
    if document.get("traffic_class") != TRAFFIC_CLASS:
        raise SystemExit(f"page list is not marked {TRAFFIC_CLASS}: {path}")
    pages = document.get("pages") or []
    if not isinstance(pages, list) or not pages:
        raise SystemExit(f"page list carries no pages: {path}")
    for page in pages:
        path_value = page.get("path")
        if not isinstance(path_value, str) or not path_value.startswith("/"):
            raise SystemExit(f"page list carries a path that is not site-relative: {path_value!r}")
        if urlsplit(path_value).query or "#" in path_value:
            raise SystemExit(f"page list carries a marker on the page URL: {path_value!r}")
    return document


def build_plan(document: dict[str, Any], base: str) -> dict[str, Any]:
    """Resolve the committed list into the exact visits one slot performs.

    Kept separate from the browser so the plan is inspectable, and testable,
    without a network or a browser present.
    """
    policy = document.get("visit_policy") or {}
    origin = base.rstrip("/")
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
        "device_profile": document.get("device_profile"),
        "network_profile": document.get("network_profile"),
        "visit_policy": policy,
        "visits": [
            {
                "path": page["path"],
                "url": f"{origin}{page['path']}",
                "notice_kind": page.get("notice_kind"),
                "weight_class": page.get("weight_class"),
                "cold_cache": True,
                "visits_in_slot": int(policy.get("visits_per_page_per_slot", 1)),
            }
            for page in document["pages"]
        ],
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


def run_slot(plan: dict[str, Any], run_key: str) -> dict[str, Any]:
    sync_playwright = load_playwright()

    policy = plan.get("visit_policy") or {}
    settle_ms = int(policy.get("settle_ms", 12000))
    page_timeout_ms = int(policy.get("page_timeout_ms", 60000))
    deadline = time.monotonic() + int(policy.get("run_budget_ms", 600000)) / 1000

    device = plan.get("device_profile") or {}
    network = plan.get("network_profile") or {}
    visited: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    observations = 0
    marked_beacons = 0
    unmarked_beacons = 0
    budget_exhausted = False

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for visit in plan["visits"]:
            if time.monotonic() >= deadline:
                budget_exhausted = True
                failures.append({"path": visit["path"], "reason": "run_budget_exhausted"})
                continue
            # A fresh context per visit is the cold cache: storage, service
            # workers, and connection reuse do not survive it.
            context = browser.new_context(
                viewport=device.get("viewport") or {"width": 390, "height": 844},
                device_scale_factor=device.get("device_scale_factor", 3),
                is_mobile=bool(device.get("is_mobile", True)),
                has_touch=bool(device.get("has_touch", True)),
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
                    failures.append({"path": visit["path"], "reason": "page_unreachable", "http_status": status})
                else:
                    page.wait_for_timeout(settle_ms)
                    visited.append({"path": visit["path"], "http_status": status})
            except Exception as error:  # noqa: BLE001 - a probe failure is evidence, not a crash
                failures.append({
                    "path": visit["path"],
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
        "device_profile_id": device.get("id"),
        "network_profile_id": network.get("id"),
        "pages_listed": len(plan["visits"]),
        "pages_visited": len(visited),
        "observations_emitted": observations,
        "marked_beacons": marked_beacons,
        # A beacon leaving this probe without the marker would land in the
        # resident group, so it is counted and reported rather than ignored.
        "unmarked_beacons": unmarked_beacons,
        "budget_exhausted": budget_exhausted,
        "visits": visited,
        "failures": failures,
        "status": probe_status(len(plan["visits"]), len(visited), unmarked_beacons),
    }


def probe_status(listed: int, visited: int, unmarked_beacons: int) -> str:
    """The probe reports on itself, not on the surface it measured.

    A slow page is the measurement, not a fault. What is a fault is a probe that
    reached nothing, or one that emitted an observation into the resident group.
    """
    if unmarked_beacons:
        return "failed"
    if visited == 0:
        return "failed"
    if visited < listed:
        return "degraded"
    return "healthy"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pages", type=Path, default=DEFAULT_PAGES)
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--run-key", default=None)
    parser.add_argument("--plan", action="store_true", help="resolve and print the visit plan without launching a browser")
    parser.add_argument(
        "--check-runtime",
        action="store_true",
        help="start and stop the browser without visiting a page or emitting an observation",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(list(sys.argv[1:] if argv is None else argv))
    # The runtime check reads no page list: it answers whether the environment
    # exists at all, which is the question asked when the page list is fine.
    if args.check_runtime:
        result = check_runtime()
    else:
        document = load_pages(args.pages)
        plan = build_plan(document, args.base)
        result = plan if args.plan else run_slot(plan, args.run_key or now_iso())
    serialized = json.dumps(result, indent=2, sort_keys=False) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(serialized, encoding="utf-8")
    else:
        sys.stdout.write(serialized)
    if args.plan or args.check_runtime:
        return 0
    return 0 if result["status"] != "failed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
