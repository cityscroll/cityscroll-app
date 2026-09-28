#!/usr/bin/env python3
"""Measure the 59-board coverage view and read the served census fail-closed.

Fixture mode renders the actual generated Desk document and its inline product
stylesheet in Chromium. Production mode is a read-only data observation: it
requires a landed commit, proves the served Pages revision contains it, and
refuses an absent or incomplete served census.
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "test" / "browser"))
sys.path.insert(0, str(ROOT / "tools"))

from browser_support import launched_chromium  # noqa: E402
from deployed_capture_ancestor import (  # noqa: E402
    ServedDataMissingError,
    require_served_page_revision_contains_delivery,
)
from repository_revision import branch_head, resolve_repository_revision  # noqa: E402

DEFAULT_BASE = "https://cityscroll.org"
DATA_PATH = "/data/connected_history_coverage.json"
MANIFEST_PATH = ROOT / "docs" / "evidence" / "connected-history-coverage" / "capture-manifest.json"
PRODUCTION_HOSTS = frozenset({"cityscroll.org", "www.cityscroll.org"})
VIEWPORTS = (
    ("narrow-touch", 390, 844, True),
    ("desktop-keyboard", 1440, 900, False),
)
MEASURED_INPUTS = (
    "data/data-source-graph-desk-contract.v1.json",
    "site/data/connected_history_coverage.json",
    "tools/connected_history_coverage.mjs",
    "tools/data_source_graph.mjs",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def input_receipts() -> list[dict[str, str]]:
    return [
        {"path": path, "sha256": sha256_bytes((ROOT / path).read_bytes())}
        for path in sorted(MEASURED_INPUTS)
    ]


def require_production_base(base: str) -> str:
    normalized = base.rstrip("/")
    host = (urllib.parse.urlsplit(normalized).hostname or "").lower()
    if host not in PRODUCTION_HOSTS:
        raise SystemExit(f"production capture requires cityscroll.org, got {base}")
    return normalized


def verify_payload(payload: dict) -> dict:
    if payload.get("schema") != "cityscroll.connected_history_coverage.v1":
        raise ServedDataMissingError("served coverage has the wrong or absent schema")
    post = payload.get("snapshots", {}).get("post_change", {})
    boards = post.get("boards")
    if not isinstance(boards, list) or len(boards) != 59:
        raise ServedDataMissingError("served coverage does not enumerate 59 boards")
    ids = [row.get("board_id") for row in boards]
    if len(set(ids)) != 59 or ids != sorted(ids):
        raise ServedDataMissingError("served coverage board identities are missing, duplicated, or unordered")
    stages = ("registered", "acquired", "extractable", "admitted", "discoverable")
    allowed = {"observed", "partial", "measured_zero", "unknown"}
    for row in boards:
        if set(row.get("stages", {})) != set(stages):
            raise ServedDataMissingError(f"served coverage stages are incomplete for {row.get('board_id')}")
        if any(row["stages"][stage].get("state") not in allowed for stage in stages):
            raise ServedDataMissingError(f"served coverage state is invalid for {row.get('board_id')}")
    evaluation = payload.get("evaluation", {}).get("post_change", {})
    for name in ("precision", "recall"):
        metric = evaluation.get(name, {})
        if not isinstance(metric.get("numerator"), int) or not isinstance(metric.get("denominator"), int):
            raise ServedDataMissingError(f"served coverage {name} lacks numerator and denominator")
        if metric.get("denominator") == 0 and metric.get("status") != "not_estimable":
            raise ServedDataMissingError(f"served coverage {name} converts a zero denominator into a score")
    if evaluation.get("example_search_triggered") is not False:
        raise ServedDataMissingError("served coverage does not preserve the no-example-search boundary")
    return {
        "board_count": len(boards),
        "selection_hash": payload.get("selection_hash"),
        "unknown_stage_cells": sum(
            1 for row in boards for stage in stages if row["stages"][stage]["state"] == "unknown"
        ),
        "measured_zero_stage_cells": sum(
            1 for row in boards for stage in stages if row["stages"][stage]["state"] == "measured_zero"
        ),
        "precision": evaluation["precision"],
        "recall": evaluation["recall"],
    }


def fetch_production(base: str, served_revision: str) -> tuple[dict, dict]:
    url = urllib.parse.urljoin(base.rstrip("/") + "/", DATA_PATH.lstrip("/"))
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "cityscroll-history-coverage-capture/1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
            status = int(response.status)
            headers = {key: response.headers.get(key) for key in ("Date", "ETag", "Last-Modified", "CF-Ray")}
    except Exception as error:
        raise ServedDataMissingError(f"served coverage unavailable at {url}: {error}") from error
    if status != 200:
        raise ServedDataMissingError(f"served coverage missing at {url} (HTTP {status})")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as error:
        raise ServedDataMissingError("served coverage is not JSON") from error
    observed = verify_payload(payload)
    return observed, {
        "url": url,
        "http_status": status,
        "observed_at": utc_now(),
        "served_revision": served_revision,
        "sha256": sha256_bytes(raw),
        "headers": headers,
    }


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A003
        return


def generated_desk_html() -> str:
    script = (
        'import { generatedGraphFiles, HTML_OUTPUT } from "./tools/data_source_graph.mjs";'
        "process.stdout.write(generatedGraphFiles()[HTML_OUTPUT]);"
    )
    run = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return run.stdout


def browser_measurement(browser, base: str, screenshot_dir: Path | None) -> list[dict]:
    captures = []
    for name, width, height, has_touch in VIEWPORTS:
        context = browser.new_context(viewport={"width": width, "height": height}, has_touch=has_touch)
        page = context.new_page()
        response = page.goto(f"{base}/desk.html", wait_until="domcontentloaded", timeout=60_000)
        assert response is not None and response.status == 200
        toggle = page.locator("#coverageToggle")
        if name == "desktop-keyboard":
            toggle.focus()
            toggle.press("Enter")
        else:
            toggle.click()
        page.locator("#historyCoverageView").wait_for(state="visible", timeout=30_000)
        measured = page.evaluate(
            """() => {
              const rows = [...document.querySelectorAll('[data-coverage-board]')];
              const states = [...document.querySelectorAll('[data-stage-state]')].map((node) => node.dataset.stageState);
              return {
                width: window.innerWidth,
                height: window.innerHeight,
                board_count: rows.length,
                unique_board_count: new Set(rows.map((row) => row.dataset.coverageBoard)).size,
                unknown_stage_cells: states.filter((state) => state === 'unknown').length,
                measured_zero_stage_cells: states.filter((state) => state === 'measured_zero').length,
                horizontal_page_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
                table_scrollable: document.querySelector('.history-coverage-table').scrollWidth >= document.querySelector('.history-coverage-table').clientWidth,
                stylesheet_font: getComputedStyle(document.body).fontFamily,
                background_color: getComputedStyle(document.body).backgroundColor,
                active_toggle: document.getElementById('coverageToggle').getAttribute('aria-pressed'),
                disclaimer: document.getElementById('historyCoverageView').innerText.includes('not measures of civic activity'),
              };
            }"""
        )
        assert measured["width"] == width and measured["height"] == height
        assert measured["board_count"] == 59 and measured["unique_board_count"] == 59
        assert measured["unknown_stage_cells"] > 0
        assert measured["measured_zero_stage_cells"] > 0
        assert measured["horizontal_page_overflow"] is False
        assert measured["table_scrollable"] is True
        assert measured["active_toggle"] == "true"
        assert measured["disclaimer"] is True
        section = page.locator("#historyCoverageView").evaluate("node => node.outerHTML")
        screenshot_hash = None
        if screenshot_dir is not None:
            screenshot_dir.mkdir(parents=True, exist_ok=True)
            shot = screenshot_dir / f"coverage-{name}.png"
            page.screenshot(path=str(shot), full_page=True)
            screenshot_hash = sha256_bytes(shot.read_bytes())
        captures.append({
            "case": f"coverage-{name}",
            "route": "/data-sources#history-coverage",
            "viewport": {"name": name, "width": width, "height": height},
            "assertion": "Chromium measured all 59 board rows, distinct unknown and measured-zero cells, the civic-activity disclaimer, and contained horizontal table scrolling with the generated Desk stylesheet.",
            "render_sha256": sha256_bytes(section.encode("utf-8")),
            "capture_sha256": screenshot_hash,
            "runtime": measured,
        })
        page.close()
        context.close()
    return captures


def write_manifest(receipt: dict) -> None:
    manifest = {
        "schema": "cityscroll.connected_history_coverage_render_manifest.v1",
        "evidence_class": "runtime_browser_measurement",
        "surface": "authenticated Desk connected-history coverage extension",
        "image_binaries_committed": False,
        "capture_policy": "Screenshot binaries remain in task scratch; this manifest retains their hashes and runtime assertions.",
        "production_measurement": {
            "state": "awaiting_landed_deploy",
            "runner": "python3 tools/capture_connected_history_coverage.py --production --landed-commit <40-hex landed commit>",
            "requirement": "The production read refuses a non-main pin, a served revision that does not contain it, absent served data, incomplete board enumeration, or unsupported zero-denominator scores.",
        },
        "measurement_provenance": {
            "revision": receipt["capture_revision"],
            "inputs": receipt["measured_inputs"],
        },
        "captures": [
            {
                "case": row["case"],
                "route": row["route"],
                "viewport": row["viewport"],
                "revision": receipt["capture_revision"],
                "data_vintage": receipt["data_vintage"],
                "assertion": row["assertion"],
                "sha256": row["render_sha256"],
                "local_capture_sha256": row["capture_sha256"],
            }
            for row in receipt["captures"]
        ],
    }
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--production", action="store_true")
    parser.add_argument("--base-url", default=DEFAULT_BASE)
    parser.add_argument("--landed-commit")
    parser.add_argument("--write-manifest", action="store_true")
    parser.add_argument("--screenshot-dir")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.production:
        if args.write_manifest:
            raise SystemExit("--write-manifest is only available for the hermetic browser measurement")
        if not args.landed_commit:
            raise SystemExit("--production requires --landed-commit")
        base = require_production_base(args.base_url)
        served_revision = require_served_page_revision_contains_delivery(base, args.landed_commit.lower(), cwd=ROOT)
        observed, request_receipt = fetch_production(base, served_revision)
        print(json.dumps({
            "schema": "cityscroll.connected_history_coverage_production_read.v1",
            "evidence_class": "live-production-read",
            "observed_at": utc_now(),
            "required_landed_commit": args.landed_commit.lower(),
            "served_revision": served_revision,
            "request_receipts": [request_receipt],
            "observed": observed,
        }, indent=2, sort_keys=True))
        return 0

    html = generated_desk_html()
    payload = json.loads((ROOT / "site" / "data" / "connected_history_coverage.json").read_text(encoding="utf-8"))
    verified = verify_payload(payload)
    temporary = tempfile.TemporaryDirectory(prefix="connected-history-coverage-")
    temporary_shots = None
    try:
        directory = Path(temporary.name)
        (directory / "desk.html").write_text(html, encoding="utf-8")
        server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            functools.partial(Handler, directory=str(directory)),
        )
        threading.Thread(target=server.serve_forever, daemon=True).start()
        screenshot_dir = Path(args.screenshot_dir) if args.screenshot_dir else None
        if screenshot_dir is None and os.environ.get("FM_TASK_SCRATCH"):
            screenshot_dir = Path(os.environ["FM_TASK_SCRATCH"]) / "connected-history-coverage-captures"
        if screenshot_dir is None:
            temporary_shots = tempfile.TemporaryDirectory(prefix="connected-history-coverage-shots-")
            screenshot_dir = Path(temporary_shots.name)
        try:
            with launched_chromium() as browser:
                captures = browser_measurement(
                    browser,
                    f"http://127.0.0.1:{server.server_address[1]}",
                    screenshot_dir,
                )
        finally:
            server.shutdown()
            server.server_close()

        receipt = {
            "schema": "cityscroll.connected_history_coverage_measurement.v1",
            "evidence_class": "runtime_browser_measurement",
            "mode": "hermetic_fixture",
            "browser": "Chromium",
            "repository_revision": resolve_repository_revision(ROOT),
            "capture_revision": branch_head(ROOT),
            "measured_inputs": input_receipts(),
            "observed_at": utc_now(),
            "data_vintage": payload.get("input_vintages"),
            "payload_verification": verified,
            "image_binaries_committed": False,
            "captures": captures,
        }
        if args.write_manifest:
            write_manifest(receipt)
        print(json.dumps(receipt, indent=2, sort_keys=True))
    finally:
        if temporary_shots is not None:
            temporary_shots.cleanup()
        temporary.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
