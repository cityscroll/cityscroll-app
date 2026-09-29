#!/usr/bin/env python3
"""Measure the 59-board coverage view and read the served census fail-closed.

Fixture mode renders the actual generated Desk document and its inline product
stylesheet in Chromium. Production mode is a read-only data observation: it
requires a landed commit, proves the served Pages revision contains it, and
refuses an absent or incomplete served census. Every served request keeps its
own edge receipt, and the served revision is read again after the census so a
redeploy during the read cannot pass.
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
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "test" / "browser"))
sys.path.insert(0, str(ROOT / "tools"))

from deployed_capture_ancestor import (  # noqa: E402
    DEFAULT_BRANCH_REF,
    PAGE_ARTIFACT_MANIFEST,
    CaptureAncestorError,
    DeployPendingError,
    ServedDataMissingError,
    require_served_page_revision_contains_delivery,
    served_page_revision,
)
from repository_revision import resolve_repository_revision  # noqa: E402

DEFAULT_BASE = "https://cityscroll.org"
DATA_PATH = "/data/connected_history_coverage.json"
REPOSITORY_DATA_PATH = "site/data/connected_history_coverage.json"
BOARD_REGISTRY_PATH = "site/data/community_board_constellation_lookup.json"
CANONICAL_BOARD_COUNT = 59
STAGES = ("registered", "acquired", "extractable", "admitted", "discoverable")
STAGE_STATES = frozenset({"observed", "partial", "measured_zero", "unknown"})
RECEIPT_HEADERS = ("Date", "CF-Ray", "CF-Cache-Status", "Age", "ETag", "Last-Modified", "Content-Type")
USER_AGENT = "cityscroll-history-coverage-capture/1"
PRODUCTION_RUNNER = "python3 tools/capture_connected_history_coverage.py --production --landed-commit {commit} --write-manifest"
PRODUCTION_REQUIREMENT = (
    "The production read refuses a non-main pin, a served revision that does not contain it, "
    "absent served data, incomplete board enumeration, or unsupported zero-denominator scores; "
    "it also refuses a served revision change during the read and missing or repeated edge receipts."
)
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


class ServedRevisionChangedError(CaptureAncestorError):
    """The served Pages revision moved between the start and end of a read."""


class RequestReceiptError(CaptureAncestorError):
    """A served request lacks its own edge receipt."""


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_now_precise() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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


def require_board_enumeration(boards, canonical_ids: list[str] | None = None) -> None:
    """Refuse a census that does not enumerate every canonical board exactly once."""

    if not isinstance(boards, list) or len(boards) != CANONICAL_BOARD_COUNT:
        count = len(boards) if isinstance(boards, list) else "no"
        raise ServedDataMissingError(
            f"served coverage board enumeration is incomplete: {count} boards, "
            f"expected {CANONICAL_BOARD_COUNT}"
        )
    ids = [row.get("board_id") if isinstance(row, dict) else None for row in boards]
    if len(set(ids)) != CANONICAL_BOARD_COUNT or ids != sorted(ids, key=str):
        raise ServedDataMissingError(
            "served coverage board enumeration is incomplete: identities are missing, duplicated, or unordered"
        )
    if canonical_ids is not None and ids != sorted(canonical_ids):
        missing = sorted(set(canonical_ids) - set(ids))
        extra = sorted(set(ids) - set(canonical_ids))
        raise ServedDataMissingError(
            "served coverage board enumeration is incomplete: "
            f"differs from the canonical board registry (missing {missing}, unexpected {extra})"
        )


def require_estimable_scores(evaluation: dict) -> None:
    """Refuse a zero-denominator metric presented as anything but not estimable."""

    for name in ("precision", "recall"):
        metric = evaluation.get(name, {})
        if not isinstance(metric.get("numerator"), int) or not isinstance(metric.get("denominator"), int):
            raise ServedDataMissingError(f"served coverage {name} lacks numerator and denominator")
        if metric["denominator"] != 0:
            continue
        scored = any(isinstance(metric.get(key), (int, float)) for key in ("value", "score", "rate"))
        if metric.get("status") != "not_estimable" or scored:
            raise ServedDataMissingError(
                f"served coverage {name} converts a zero denominator into a score"
            )


def served_absences(boards: list[dict]) -> dict:
    """Report what the served census does not supply, board by board."""

    unavailable: dict[str, list[str]] = {}
    for row in boards:
        for stratum in row.get("unavailable_strata") or []:
            unavailable.setdefault(stratum, []).append(row["board_id"])
    unknown_by_stage = {
        stage: sorted(row["board_id"] for row in boards if row["stages"][stage]["state"] == "unknown")
        for stage in STAGES
    }
    measured_zero_boards = sorted(
        row["board_id"]
        for row in boards
        if all(row["stages"][stage]["state"] == "measured_zero" for stage in STAGES)
    )
    observations = [
        {"kind": "unavailable_stratum", "stratum": stratum, "board_count": len(ids), "board_ids": sorted(ids)}
        for stratum, ids in sorted(unavailable.items())
    ]
    observations.extend(
        {"kind": "unknown_stage", "stage": stage, "board_count": len(ids), "board_ids": ids}
        for stage, ids in unknown_by_stage.items()
        if ids
    )
    if measured_zero_boards:
        observations.append({
            "kind": "measured_zero_board",
            "board_count": len(measured_zero_boards),
            "board_ids": measured_zero_boards,
        })
    return {"negative_observation_count": len(observations), "observations": observations}


def verify_payload(payload: dict, canonical_ids: list[str] | None = None) -> dict:
    if not isinstance(payload, dict) or payload.get("schema") != "cityscroll.connected_history_coverage.v1":
        raise ServedDataMissingError("served coverage has the wrong or absent schema")
    post = payload.get("snapshots", {}).get("post_change", {})
    boards = post.get("boards")
    require_board_enumeration(boards, canonical_ids)
    for row in boards:
        if set(row.get("stages", {})) != set(STAGES):
            raise ServedDataMissingError(f"served coverage stages are incomplete for {row.get('board_id')}")
        if any(row["stages"][stage].get("state") not in STAGE_STATES for stage in STAGES):
            raise ServedDataMissingError(f"served coverage state is invalid for {row.get('board_id')}")
    evaluation = payload.get("evaluation", {}).get("post_change", {})
    require_estimable_scores(evaluation)
    if evaluation.get("example_search_triggered") is not False:
        raise ServedDataMissingError("served coverage does not preserve the no-example-search boundary")
    return {
        "board_count": len(boards),
        "board_ids": [row["board_id"] for row in boards],
        "selection_hash": payload.get("selection_hash"),
        "unknown_stage_cells": sum(
            1 for row in boards for stage in STAGES if row["stages"][stage]["state"] == "unknown"
        ),
        "measured_zero_stage_cells": sum(
            1 for row in boards for stage in STAGES if row["stages"][stage]["state"] == "measured_zero"
        ),
        "precision": evaluation["precision"],
        "recall": evaluation["recall"],
        "sample_denominator": evaluation.get("sample_denominator"),
        "source_judgment": evaluation.get("source_judgment"),
        "absences": served_absences(boards),
    }


def canonical_board_ids(cwd: Path = ROOT) -> list[str]:
    registry = json.loads((Path(cwd) / BOARD_REGISTRY_PATH).read_text(encoding="utf-8"))
    return sorted(registry["by_id"])


def http_get(url: str) -> dict:
    """Fetch one served URL without following the edge cache's stale copy."""

    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "Cache-Control": "no-cache", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return {"status": int(response.status), "headers": response.headers, "body": response.read()}
    except urllib.error.HTTPError as error:
        return {"status": int(error.code), "headers": error.headers, "body": error.read()}


def require_served_coverage_present(url: str, response: dict) -> None:
    """Refuse a missing census, including Pages' 200 HTML answer for an absent path."""

    status = response["status"]
    content_type = str(response["headers"].get("Content-Type") or "")
    body = response["body"] or b""
    if status != 200:
        raise ServedDataMissingError(f"served coverage is absent at {url}: HTTP {status}")
    if "json" not in content_type.lower() or not body.lstrip().startswith(b"{"):
        raise ServedDataMissingError(
            f"served coverage is absent at {url}: the origin answered {content_type or 'an untyped body'}"
        )


def require_distinct_receipts(receipts: list[dict]) -> None:
    for receipt in receipts:
        if not receipt.get("edge_ray") or not receipt.get("observed_at") or not receipt.get("headers", {}).get("Date"):
            raise RequestReceiptError(
                f"served request {receipt.get('request')} lacks its own edge receipt (ray, timestamp, date)"
            )
    rays = [receipt["edge_ray"] for receipt in receipts]
    if len(set(rays)) != len(rays):
        raise RequestReceiptError("served request receipts repeat an edge ray identifier across requests")


def repository_copy_sha256(revision: str, cwd: Path) -> str | None:
    shown = subprocess.run(
        ["git", "-C", str(cwd), "show", f"{revision}:{REPOSITORY_DATA_PATH}"],
        capture_output=True,
        check=False,
    )
    return sha256_bytes(shown.stdout) if shown.returncode == 0 else None


def production_read(
    base: str,
    landed_commit: str,
    *,
    get=http_get,
    cwd: Path = ROOT,
    main_ref: str = DEFAULT_BRANCH_REF,
    canonical_ids: list[str] | None = None,
) -> dict:
    """Read the served census once, bracketed by two served-revision reads."""

    receipts: list[dict] = []

    def fetch(request_name: str, path: str) -> tuple[str, dict]:
        url = urllib.parse.urljoin(base.rstrip("/") + "/", path.lstrip("/"))
        try:
            response = get(url)
        except (OSError, urllib.error.URLError) as error:
            raise ServedDataMissingError(f"served coverage is absent at {url}: {error}") from error
        headers = response["headers"]
        receipts.append({
            "request": request_name,
            "url": url,
            "http_status": response["status"],
            "observed_at": utc_now_precise(),
            "edge_ray": headers.get("CF-Ray"),
            "sha256": sha256_bytes(response["body"] or b""),
            "bytes": len(response["body"] or b""),
            "headers": {key: headers.get(key) for key in RECEIPT_HEADERS if headers.get(key) is not None},
        })
        return url, response

    def served_manifest(request_name: str):
        def fetch_json(_url: str) -> dict:
            url, response = fetch(request_name, PAGE_ARTIFACT_MANIFEST)
            try:
                manifest = json.loads((response["body"] or b"").decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise DeployPendingError(f"served page artifact-manifest is not JSON: {url}") from error
            if response["status"] != 200 or not isinstance(manifest, dict):
                raise DeployPendingError(f"served page artifact-manifest unavailable: {url} (HTTP {response['status']})")
            return manifest

        return fetch_json

    required = landed_commit.lower()
    served_revision = require_served_page_revision_contains_delivery(
        base,
        required,
        cwd=cwd,
        main_ref=main_ref,
        fetch_json=served_manifest("served_revision_start"),
    )
    url, response = fetch("coverage_census", DATA_PATH)
    require_served_coverage_present(url, response)
    try:
        payload = json.loads(response["body"].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ServedDataMissingError(f"served coverage body is not valid JSON at {url}") from error
    observed = verify_payload(payload, canonical_ids)
    served_revision_after = served_page_revision(base, fetch_json=served_manifest("served_revision_end"))
    if served_revision_after != served_revision:
        raise ServedRevisionChangedError(
            f"served revision changed during the production read: {served_revision} -> {served_revision_after}"
        )
    require_distinct_receipts(receipts)
    census_sha256 = sha256_bytes(response["body"])
    repository_sha256 = repository_copy_sha256(served_revision, Path(cwd))
    exact = required == served_revision == served_revision_after
    return {
        "schema": "cityscroll.connected_history_coverage_production_read.v1",
        "evidence_class": "deployed-production-read-back",
        "observed_at": utc_now(),
        "origin": base.rstrip("/"),
        "required_landed_commit": required,
        "served_revision": served_revision,
        "served_revision_after": served_revision_after,
        "revision_pin": {
            "state": "exact" if exact else "descendant",
            "required_landed_commit": required,
            "served_revision_start": served_revision,
            "served_revision_end": served_revision_after,
        },
        "served_census": {
            "url": url,
            "bytes": len(response["body"]),
            "sha256": census_sha256,
            "repository_path": REPOSITORY_DATA_PATH,
            "repository_sha256_at_served_revision": repository_sha256,
            "byte_identical_to_repository": repository_sha256 == census_sha256,
            "data_vintage": payload.get("input_vintages"),
        },
        "request_receipts": receipts,
        "observed": observed,
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
    previous = json.loads(MANIFEST_PATH.read_text(encoding="utf-8")) if MANIFEST_PATH.exists() else {}
    manifest = {
        "schema": "cityscroll.connected_history_coverage_render_manifest.v1",
        "evidence_class": "runtime_browser_measurement",
        "surface": "authenticated Desk connected-history coverage extension",
        "image_binaries_committed": False,
        "capture_policy": "Screenshot binaries remain in task scratch; this manifest retains their hashes and runtime assertions.",
        "production_measurement": previous.get("production_measurement") or {
            "state": "awaiting_landed_deploy",
            "runner": PRODUCTION_RUNNER.format(commit="<40-hex landed commit>"),
            "requirement": PRODUCTION_REQUIREMENT,
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


def write_production_manifest(read: dict) -> None:
    """Retain the served read beside the unchanged hermetic browser measurement."""

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    run_receipt = {
        **read,
        "repository_revision": resolve_repository_revision(ROOT),
        "retained_measurement": {
            "revision": manifest["measurement_provenance"]["revision"],
            "inputs_ref": "#/measurement_provenance/inputs",
        },
        "image_binaries_committed": False,
    }
    manifest["production_measurement"] = {
        "state": "measured",
        "runner": PRODUCTION_RUNNER.format(commit=read["required_landed_commit"]),
        "requirement": PRODUCTION_REQUIREMENT,
        "run_receipt_sha256": sha256_bytes(
            json.dumps(run_receipt, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        ),
        "run_receipt": run_receipt,
    }
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
        if not args.landed_commit:
            raise SystemExit("--production requires --landed-commit")
        base = require_production_base(args.base_url)
        read = production_read(base, args.landed_commit, canonical_ids=canonical_board_ids())
        if args.write_manifest:
            write_production_manifest(read)
        print(json.dumps(read, indent=2, sort_keys=True))
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
        # The production read needs no browser; only the hermetic path loads Playwright.
        from browser_support import launched_chromium

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

        repository_revision = resolve_repository_revision(ROOT)
        receipt = {
            "schema": "cityscroll.connected_history_coverage_measurement.v1",
            "evidence_class": "runtime_browser_measurement",
            "mode": "hermetic_fixture",
            "browser": "Chromium",
            "repository_revision": repository_revision,
            "capture_revision": repository_revision,
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
