#!/usr/bin/env python3
"""Capture Civic Action Path after-state evidence at desktop and mobile widths.

Renders committed meeting, Community Board, and DOT outcome documents through
the repository headless capture path. Interactive browser tooling is not used.
"""

from __future__ import annotations

import argparse
import functools
import json
import subprocess
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "evidence" / "civic-action-paths" / "after"
EVIDENCE_ROOT = ROOT / ".artifacts" / "evidence-store"
sys.path.insert(0, str(ROOT / "tools"))
from evidence_store import record_capture  # noqa: E402

VIEWPORTS = ((1440, 1000, "desktop"), (390, 844, "mobile"))
SCHEMA = "cityscroll.civic_action_paths_after_capture.v1"
FORBIDDEN = (
    "because you commented",
    "your comment caused",
    "follow all DOT rules",
    "follow all DOT hearings",
)
PAGES = (
    {
        "fixture": "strict_matter_join",
        "route": "/meetings/strict-matter/",
        "selector": "[data-council-matter-continuation]",
        "expect": {"follow_cta": True, "continuation_state": "single", "later_state": True},
    },
    {
        "fixture": "unmatched_hearing",
        "route": "/meetings/unmatched/",
        "selector": "[data-council-matter-continuation]",
        "expect": {"follow_cta": False, "continuation_state": "unmatched"},
    },
    {
        "fixture": "cb_source_backed",
        "route": "/community-boards/manhattan-cb-02/",
        "selector": "[data-community-board-participation]",
        "expect": {"attend": True, "apply_now": False},
    },
    {
        "fixture": "cb_unknown",
        "route": "/community-boards/bronx-cb-02/",
        "selector": "[data-community-board-participation]",
        "expect": {"attend": False, "apply_now": False, "public_committee_membership": False},
    },
    {
        "fixture": "dot_t2_adoption",
        "route": "/rules/dot-t2-adoption/",
        "selector": "[data-civic-outcome]",
        "expect": {"adopted": True, "causal": False},
    },
    {
        "fixture": "dot_t3_effective",
        "route": "/rules/dot-t3-effective/",
        "selector": "[data-civic-outcome]",
        "expect": {"effective": True, "causal": False},
    },
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


def observe(page, spec: dict) -> dict:
    body = page.locator("body").inner_text()
    lowered = body.lower()
    for phrase in FORBIDDEN:
        if phrase in lowered:
            raise AssertionError(f"{spec['fixture']} contains forbidden copy: {phrase}")
    follow = page.get_by_text("Follow what happens next").count()
    calendar = page.get_by_text("Add to calendar").count()
    apply_now = page.get_by_text("Apply now").count()
    attend = page.get_by_text("Attend the next board meeting").count()
    public_committee = page.get_by_text("Public committee membership").count()
    continuation = page.locator("[data-continuation-state]")
    continuation_state = continuation.get_attribute("data-continuation-state") if continuation.count() else None
    observations = {
        "follow_cta": follow > 0,
        "calendar": calendar > 0,
        "calendar_creates_watch": False,
        "apply_now": apply_now > 0,
        "attend": attend > 0,
        "public_committee_membership": public_committee > 0,
        "continuation_state": continuation_state,
        "later_state": "Laid Over by Subcommittee" in body,
        "adopted": "Rulemaking adopted" in body,
        "effective": "Rulemaking effective" in body,
        "causal": any(phrase in lowered for phrase in FORBIDDEN),
        "reports_what_happened": "reports what happened to the rulemaking" in lowered,
    }
    expected = spec["expect"]
    for key, value in expected.items():
        if observations.get(key) != value:
            raise AssertionError(f"{spec['fixture']} {key}={observations.get(key)!r} != {value!r}")
    if spec["fixture"] == "strict_matter_join" and calendar and follow and not page.locator("[data-action-path-continuation]").count():
        raise AssertionError("strict hearing Follow control is missing continuation provenance")
    return observations


def required_rows(captures: list[dict]) -> None:
    expected = {(page["fixture"], suffix) for page in PAGES for _width, _height, suffix in VIEWPORTS}
    actual = {(row.get("fixture"), row.get("viewport")) for row in captures}
    if actual != expected:
        raise AssertionError(f"after capture matrix drifted: expected {sorted(expected)}, got {sorted(actual)}")
    for row in captures:
        file_url = str(row.get("file") or "")
        if not file_url.startswith("backstage://cityscroll-evidence/objects/sha256/"):
            raise AssertionError(f"capture is not an evidence object: {file_url}")
        if row["fixture"] == "strict_matter_join" and row.get("observations", {}).get("follow_cta") is not True:
            raise AssertionError("strict hearing after-state lost Follow what happens next")
        if row["fixture"] == "cb_unknown" and row.get("observations", {}).get("apply_now"):
            raise AssertionError("negative board fabricated Apply now")


def check_manifest(path: Path = OUT / "capture-manifest.json") -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema") != SCHEMA:
        raise AssertionError("unexpected after-capture schema")
    required_rows(payload.get("captures") or [])
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate the committed after-capture matrix")
    args = parser.parse_args()
    if args.check:
        check_manifest()
        print("civic-action-paths after capture matrix OK")
        return 0

    OUT.mkdir(parents=True, exist_ok=True)
    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    with tempfile.TemporaryDirectory() as tmp:
        served = Path(tmp) / "site"
        served.mkdir()
        subprocess.run(
            ["node", str(ROOT / "tools/render_civic_action_paths_after.mjs"), str(served)],
            cwd=ROOT,
            check=True,
        )
        captures: list[dict] = []
        board_receipts: list[dict] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            with StaticServer(served) as base:
                for spec in PAGES:
                    for width, height, suffix in VIEWPORTS:
                        page = browser.new_page(viewport={"width": width, "height": height})
                        response = page.goto(f"{base}{spec['route'].lstrip('/')}", wait_until="load")
                        if response is None or not response.ok:
                            raise AssertionError(f"{spec['fixture']} returned {response and response.status}")
                        page.locator(spec["selector"]).wait_for(timeout=20_000)
                        if page.locator(spec["selector"]).count() != 1:
                            raise AssertionError(f"{spec['fixture']} is missing {spec['selector']}")
                        observations = observe(page, spec)
                        with tempfile.NamedTemporaryFile(suffix=".webp", delete=False) as handle:
                            shot = Path(handle.name)
                        page.screenshot(path=str(shot), type="webp", quality=82, full_page=True, animations="disabled")
                        row = record_capture(
                            shot,
                            root=EVIDENCE_ROOT,
                            pr_number=None,
                            card_id="cityscroll-civic-action-paths/cap-9",
                            capture_kind="civic-action-path-after",
                            surface=f"docs/evidence/civic-action-paths/after/{spec['fixture']}",
                            phase="after",
                            viewport_width=width,
                            viewport_height=height,
                            commit=commit,
                            media_type="image/webp",
                        )
                        shot.unlink(missing_ok=True)
                        captures.append({
                            "fixture": spec["fixture"],
                            "route": spec["route"],
                            "viewport": suffix,
                            "file": row["url"],
                            "sha256": row["sha256"],
                            "commit": commit,
                            "observations": observations,
                        })
                        if spec["fixture"] in {"cb_source_backed", "cb_unknown"}:
                            board_receipts.append({
                                "board": "manhattan-cb-02" if spec["fixture"] == "cb_source_backed" else "bronx-cb-02",
                                "viewport": suffix,
                                "path": row["url"],
                            })
                        page.close()
            browser.close()
        (OUT / "capture-manifest.json").write_text(
            json.dumps({
                "schema": SCHEMA,
                "capture_mode": "headless_playwright_loopback_static_server",
                "viewports": [{"name": name, "width": width, "height": height} for width, height, name in VIEWPORTS],
                "captures": captures,
            }, indent=2) + "\n",
            encoding="utf-8",
        )
        (OUT / "ways-to-participate-capture.json").write_text(
            json.dumps({
                "schema": "cityscroll.community_board_participation_capture.v1",
                "captures": board_receipts,
            }, indent=2) + "\n",
            encoding="utf-8",
        )
        required_rows(captures)
        print("wrote", OUT.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
