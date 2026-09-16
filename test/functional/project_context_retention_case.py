#!/usr/bin/env python3
"""Browser regression: wider-project context survives notice client initialization.

Journey under test (local materialized inputs only):
  initial edge document → app ready → notice context settled → unrelated notice → Back

Asserts section visibility and correct identity at desktop and 390px, keyboard reach
to the official source, no-JavaScript access, and retention when optional client
modules fail. Does not fetch civic publishers at read time.
"""

from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from ci_waits import wait_for_app_ready, wait_for_function, wait_for_locator  # noqa: E402

MUSEUM_ID = "20260810048"
UNRELATED_ID = "20240829105"
MUSEUM_ROUTE = f"/notices/{MUSEUM_ID}/"
UNRELATED_ROUTE = f"/notices/{UNRELATED_ID}/"
MUSEUM_SOURCE = f"https://a856-cityrecord.nyc.gov/RequestDetail/{MUSEUM_ID}"
MANIFEST_PATH = ROOT / "docs" / "evidence" / "notice-project-context-retention" / "capture-manifest.json"
MATERIALIZATION = json.loads((ROOT / "site" / "data" / "procurement_project_context.json").read_text())
DATA_VINTAGE = (
    "Committed project-context materialization: "
    f"{MATERIALIZATION['source_scope']['solicitations']['rows']} published procurement notices through "
    f"{MATERIALIZATION['source_scope']['solicitations']['extract_date']}, joined to the "
    f"{MATERIALIZATION['source_scope']['capital_projects']['reporting_period']} capital project reporting period"
)
MUSEUM_NEEDLES = (
    "BCM-HVAC Upgrades",
    "DCLA",
    "DDC",
    "19,905,485.81",
    "2,116,345.32",
    "June 25, 2029",
    "4369",
    "four air handler",
    "10 heat pumps",
    "Temporary cooling",
    "85026B0110",
    "85026B01107",
    "ACEDCA215",
)


def museum_payload() -> bytes:
    return json.dumps({
        "ok": True,
        "row": {
            "request_id": MUSEUM_ID,
            "short_title": "ACEDCA215 Brooklyn Childrens Museum HVAC Upgrade",
            "type_of_notice_description": "Solicitation",
            "agency_name": "Department of Design and Construction",
            "start_date": "2026-08-14",
            "pin": "85026B0110",
            "additional_description_1": "The notice body publishes PIN 85026B01107.",
        },
        "civic_time": None,
    }).encode()


def unrelated_payload() -> bytes:
    return json.dumps({
        "ok": True,
        "row": {
            "request_id": UNRELATED_ID,
            "short_title": "City Sanctuary Facility for Families with Children",
            "type_of_notice_description": "Award",
            "agency_name": "Homeless Services",
            "start_date": "2024-08-29",
            "vendor_name": "BHRAGS Operating LLC",
        },
        "civic_time": None,
    }).encode()


def stage_assets() -> pathlib.Path:
    staging = pathlib.Path(
        tempfile.mkdtemp(
            prefix="cityscroll-project-context-",
            dir=os.environ.get("CITYSCROLL_FUNCTIONAL_TMPDIR") or os.environ.get("FM_TASK_SCRATCH"),
        )
    )
    # Serve the tracked site tree directly; this case needs the edge worker plus
    # client modules, not the generated Pages document set.
    shutil.copytree(
        ROOT / "site",
        staging,
        dirs_exist_ok=True,
        symlinks=True,
        ignore=shutil.ignore_patterns(".DS_Store", "__pycache__"),
    )
    # Public Pages builds copy client capability modules into the served tree.
    # Mirror that here so notice boot can resolve the same dynamic imports.
    capabilities = ROOT / "capabilities"
    if capabilities.is_dir():
        shutil.copytree(
            capabilities,
            staging / "capabilities",
            dirs_exist_ok=True,
            symlinks=True,
            ignore=shutil.ignore_patterns(".DS_Store", "__pycache__"),
        )
    # Workers assets cap is 25 MiB; this spine file is not needed for the notice
    # project-context journey and exceeds that limit on current checkouts.
    (staging / "data" / "procurement_spine_sources.json").unlink(missing_ok=True)
    return staging


def start_server():
    staging = stage_assets()
    state_dir = pathlib.Path(
        tempfile.mkdtemp(
            prefix="cityscroll-wrangler-pcr-",
            dir=os.environ.get("CITYSCROLL_FUNCTIONAL_TMPDIR") or os.environ.get("FM_TASK_SCRATCH"),
        )
    )
    from tools.local_site_server import _RobustThreadingHTTPServer

    class ReadModelHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = self.path.split("?", 1)
            query = parsed[1] if len(parsed) > 1 else ""
            notice_id = ""
            for part in query.split("&"):
                if part.startswith("id="):
                    notice_id = part.split("=", 1)[1]
            payload = unrelated_payload() if notice_id == UNRELATED_ID else museum_payload()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format, *_args):
            return

    upstream = _RobustThreadingHTTPServer(("127.0.0.1", 0), ReadModelHandler)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    config = state_dir / "wrangler.toml"
    config.write_text(
        f'name = "cityscroll-project-context-retention"\n'
        f'main = "{ROOT / "site" / "_worker.js"}"\n'
        f'compatibility_date = "2026-07-27"\n'
        f'[assets]\nbinding = "ASSETS"\ndirectory = "{staging}"\n',
        encoding="utf-8",
    )
    process = subprocess.Popen(
        [
            "npx", "--yes", "wrangler@4.126.0", "dev",
            "--config", str(config),
            "--ip", "127.0.0.1",
            "--port", "0",
            "--compatibility-date", "2026-07-27",
            "--var", f"NOTICE_READ_MODEL=http://127.0.0.1:{upstream.server_port}/notice",
            "--persist-to", str(state_dir),
            "--show-interactive-dev-session", "false",
        ],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    base = ""
    output_lines: list[str] = []
    for _ in range(180):
        line = process.stdout.readline() if process.stdout else ""
        output_lines.append(line)
        match = re.search(r"Ready on (http://127\.0\.0\.1:\d+)", line)
        if match:
            base = f"{match.group(1)}/"
            break
        if process.poll() is not None:
            break
    if not base:
        output = "".join(output_lines) + (process.stdout.read() if process.stdout else "")
        process.terminate()
        upstream.shutdown()
        upstream.server_close()
        raise RuntimeError(f"wrangler dev did not become ready: {output[-2000:]}")
    return process, staging, state_dir, base, upstream


def section_text(page) -> str:
    section = page.locator('#noticeview [data-project-context="1"]')
    if section.count() == 0:
        return ""
    return section.first.inner_text()


def assert_museum_section(page, *, label: str) -> str:
    section = page.locator('#noticeview [data-project-context="1"]')
    wait_for_locator(section.first, state="visible", label=f"{label}: project context")
    assert section.count() == 1, f"{label}: expected one project-context section"
    assert section.first.get_attribute("data-project-context-notice-id") == MUSEUM_ID
    text = section.first.inner_text()
    for needle in MUSEUM_NEEDLES:
        assert needle in text, f"{label}: missing {needle!r}"
    assert "executed contract" not in text.lower()
    assert "bid deadline" not in text.lower()
    assert "contract amount" not in text.lower()
    assert "advertised package is one part" in text.lower()
    official = page.locator(
        f'#noticeview [data-project-context="1"] a.project-context-official-link[href="{MUSEUM_SOURCE}"]'
    )
    assert official.count() >= 1, f"{label}: official notice link missing from project context"
    return text


def render_hash(page) -> str:
    content = page.locator("#noticeview").inner_text()
    return hashlib.sha256(content.encode()).hexdigest()


def wait_for_notice_ready(page, *, label: str) -> None:
    wait_for_app_ready(page)
    wait_for_function(
        page,
        """() => {
            const ready = document.body?.dataset?.appReady === "true";
            const context = document.querySelector("#ncontext");
            const contextReady = context?.dataset?.noticeContextReady === "true";
            // showNotice replaces the edge body and mounts #nproject; wait for that
            // rebuild rather than a transient first-paint match alone.
            const clientRebuilt = Boolean(document.querySelector("#nproject"));
            const hasNotice = Boolean(document.querySelector("#noticeview .route-item, #noticeview [data-notice-id]"));
            return ready && hasNotice && clientRebuilt && contextReady;
        }""",
        label=f"{label}: notice context settled",
        timeout=45000,
    )


def assert_no_javascript(page, base: str, *, viewport: dict) -> dict[str, object]:
    response = page.goto(f"{base}{MUSEUM_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
    assert response and response.status == 200, "no-JS museum notice did not return 200"
    text = assert_museum_section(page, label="no-javascript")
    return {
        "case": "project-context-retention-no-javascript",
        "route": MUSEUM_ROUTE,
        "viewport": viewport,
        "assertion": (
            "Without JavaScript the edge document keeps the wider-project section, "
            "museum identity facts, and the official notice link."
        ),
        "render_sha256": hashlib.sha256(text.encode()).hexdigest(),
        "section_visible": True,
        "notice_id": MUSEUM_ID,
    }


def assert_failed_optional_load(page, base: str, *, viewport: dict) -> dict[str, object]:
    # Abort the optional client materialization import path and the app entry so
    # the already-served edge section must remain the source of truth.
    page.route("**/data/procurement_project_context.json*", lambda route: route.abort())
    page.route("**/app/main.mjs", lambda route: route.abort())
    response = page.goto(f"{base}{MUSEUM_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
    assert response and response.status == 200, "failed-enhancement notice did not return 200"
    text = assert_museum_section(page, label="failed-optional-load")
    official = page.locator(f'#noticeview a.ui-official-source-link[href="{MUSEUM_SOURCE}"]')
    assert official.count() >= 1, "failed-optional-load lost the official source link"
    return {
        "case": "project-context-retention-failed-optional-load",
        "route": MUSEUM_ROUTE,
        "viewport": viewport,
        "assertion": (
            "When optional client modules fail, the already-served project context and "
            "official links for the same notice remain visible."
        ),
        "render_sha256": hashlib.sha256(text.encode()).hexdigest(),
        "section_visible": True,
        "notice_id": MUSEUM_ID,
    }


def assert_retention_journey(page, base: str, *, viewport: dict) -> dict[str, object]:
    publisher_hits: list[str] = []

    def track_publisher(route):
        publisher_hits.append(route.request.url)
        route.abort()

    page.route("https://data.cityofnewyork.us/**", track_publisher)
    page.route("https://passportpublic.**/**", track_publisher)
    page.route("https://www.checkbooknyc.com/**", track_publisher)

    response = page.goto(f"{base}{MUSEUM_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
    assert response and response.status == 200, "museum notice did not return 200"
    wait_for_notice_ready(page, label="museum")
    before = assert_museum_section(page, label="after app+notice ready")

    # Keyboard reachability of the official source inside the section.
    page.locator(
        f'#noticeview [data-project-context="1"] a.project-context-official-link[href="{MUSEUM_SOURCE}"]'
    ).first.focus()
    focused = page.evaluate(
        "() => document.activeElement && document.activeElement.getAttribute('href')"
    )
    assert focused == MUSEUM_SOURCE, f"keyboard source focus landed on {focused!r}"

    page.goto(f"{base}{UNRELATED_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
    wait_for_notice_ready(page, label="unrelated")
    wait_for_function(
        page,
        f"""() => {{
            const id = document.querySelector('#noticeview [data-notice-id]')?.getAttribute('data-notice-id');
            const section = document.querySelector('#noticeview [data-project-context="1"]');
            return id === {UNRELATED_ID!r} && !section;
        }}""",
        label="unrelated notice has no project panel",
        timeout=45000,
    )
    assert section_text(page) == ""
    assert "BCM-HVAC" not in page.locator("#noticeview").inner_text()

    page.go_back(wait_until="domcontentloaded")
    wait_for_notice_ready(page, label="back-to-museum")
    after = assert_museum_section(page, label="after Back")
    assert "BCM-HVAC Upgrades" in after
    assert before and after
    assert not publisher_hits, f"read path fetched publishers: {publisher_hits[:5]}"

    return {
        "case": "project-context-retention-ready-navigate-back",
        "route": f"{MUSEUM_ROUTE} -> {UNRELATED_ROUTE} -> Back",
        "viewport": viewport,
        "assertion": (
            "After app readiness and notice-context completion the museum project context "
            "remains visible; navigating to an unrelated notice shows no project panel; "
            "Back restores the museum section with the same identity."
        ),
        "render_sha256": hashlib.sha256(after.encode()).hexdigest(),
        "section_visible": True,
        "notice_id": MUSEUM_ID,
        "publisher_fetches": 0,
    }


def build_manifest_payload(captures: list[dict[str, object]], *, revision: str) -> dict[str, object]:
    return {
        "schema": "cityscroll.render_capture_manifest.v1",
        "surface": "notice project context retention",
        "condition": (
            "Local Wrangler Worker with HTMLRewriter over the tracked site tree; "
            "no image binary is committed."
        ),
        "image_binaries_committed": False,
        "revision": revision,
        "data_vintage": DATA_VINTAGE,
        "route": MUSEUM_ROUTE,
        "browser_test_command": (
            "python3 test/functional/project_context_retention_case.py --write-manifest"
        ),
        "captures": [
            {
                "case": capture["case"],
                "route": capture["route"],
                "viewport": {
                    "name": "desktop" if capture["viewport"]["width"] >= 1000 else "narrow",
                    "width": capture["viewport"]["width"],
                    "height": capture["viewport"]["height"],
                },
                "assertion": capture["assertion"],
                "render_sha256": capture["render_sha256"],
                "section_visible": capture.get("section_visible"),
                "notice_id": capture.get("notice_id"),
                "publisher_fetches": capture.get("publisher_fetches", 0),
            }
            for capture in captures
        ],
    }


def write_manifest(captures: list[dict[str, object]], *, revision: str, path: pathlib.Path = MANIFEST_PATH) -> None:
    payload = build_manifest_payload(captures, revision=revision)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def run_writer_self_tests() -> None:
    revision = "abcdef012"
    captures = [
        {
            "case": "project-context-retention-ready-navigate-back",
            "route": MUSEUM_ROUTE,
            "viewport": {"width": 1440, "height": 1000},
            "assertion": "desktop journey",
            "render_sha256": "a" * 64,
            "section_visible": True,
            "notice_id": MUSEUM_ID,
            "publisher_fetches": 0,
        },
        {
            "case": "project-context-retention-ready-navigate-back",
            "route": MUSEUM_ROUTE,
            "viewport": {"width": 390, "height": 844},
            "assertion": "narrow journey",
            "render_sha256": "b" * 64,
            "section_visible": True,
            "notice_id": MUSEUM_ID,
            "publisher_fetches": 0,
        },
    ]
    payload = build_manifest_payload(captures, revision=revision)
    assert payload["schema"] == "cityscroll.render_capture_manifest.v1"
    assert payload["revision"] == revision
    assert "Local Wrangler" in payload["condition"]
    assert payload["image_binaries_committed"] is False
    assert "project_context_retention_case.py" in payload["browser_test_command"]
    assert len(payload["captures"]) == 2
    scratch = pathlib.Path(
        tempfile.mkdtemp(
            prefix="cityscroll-pcr-self-test-",
            dir=os.environ.get("CITYSCROLL_FUNCTIONAL_TMPDIR") or os.environ.get("FM_TASK_SCRATCH"),
        )
    )
    try:
        path = scratch / "capture-manifest.json"
        write_manifest(captures, revision=revision, path=path)
        written = json.loads(path.read_text())
        assert written["revision"] == revision
        assert len(written["captures"]) == 2
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    print("OK project-context-retention capture-manifest writer self-test", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-manifest", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        run_writer_self_tests()
        return

    process = staging = state_dir = upstream = None
    base = os.environ.get("CROL_BASE")
    owns_server = False
    if not base:
        process, staging, state_dir, base, upstream = start_server()
        owns_server = True
    base = base.rstrip("/") + "/"
    revision = subprocess.check_output(
        ["git", "rev-parse", "--short=9", "HEAD"], cwd=ROOT, text=True
    ).strip()
    try:
        from playwright.sync_api import sync_playwright

        captures: list[dict[str, object]] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for viewport in ({"width": 1440, "height": 1000}, {"width": 390, "height": 844}):
                no_js = browser.new_context(viewport=viewport, java_script_enabled=False)
                captures.append(assert_no_javascript(no_js.new_page(), base, viewport=viewport))
                no_js.close()

                failed = browser.new_context(viewport=viewport)
                captures.append(
                    assert_failed_optional_load(failed.new_page(), base, viewport=viewport)
                )
                failed.close()

                context = browser.new_context(viewport=viewport)
                result = assert_retention_journey(context.new_page(), base, viewport=viewport)
                captures.append(result)
                print(
                    f"OK project-context-retention {viewport['width']}x{viewport['height']}: "
                    f"{result['render_sha256']}",
                    flush=True,
                )
                context.close()
            browser.close()
        if args.write_manifest:
            write_manifest(captures, revision=revision)
            print(f"wrote {MANIFEST_PATH.relative_to(ROOT)}", flush=True)
    finally:
        if owns_server and process:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if upstream:
            upstream.shutdown()
            upstream.server_close()
        if staging:
            shutil.rmtree(staging, ignore_errors=True)
        if state_dir:
            shutil.rmtree(state_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
