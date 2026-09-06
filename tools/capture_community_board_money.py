#!/usr/bin/env python3
"""Headless before/after captures for the Community Board money card.

Records Bronx CB1 (populated, separate fiscal years) and Bronx CB3 (budget
present, payment identity unobserved) at 390px and 1440px. The committed
evidence boundary is docs/screenshots/community-board-money/manifest.json.
"""

from __future__ import annotations

import argparse
import functools
import io
import json
import sys
import tarfile
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "community-board-money"
EVIDENCE_ROOT = ROOT / ".artifacts" / "evidence-store"
sys.path.insert(0, str(ROOT / "tools"))
from evidence_store import record_capture  # noqa: E402

DEFAULT_BEFORE = "0c7818a4c84a"
VIEWPORTS = ((1440, 1000), (390, 844))
CANARIES = (
    {
        "board": "bronx-cb-01",
        "route": "/community-boards/bronx-cb-01/",
        "kind": "populated",
        "after_state": "separate_fiscal_years",
    },
    {
        "board": "bronx-cb-03",
        "route": "/community-boards/bronx-cb-03/",
        "kind": "partial",
        "after_state": "unmatched_identity",
    },
)
FORBIDDEN = ("Spending in your district", "View payments", "remaining budget")


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


def run(command: list[str], cwd: Path) -> None:
    import subprocess
    subprocess.run(command, cwd=cwd, check=True)


def revision_snapshot(revision: str, destination: Path) -> None:
    import subprocess
    archive = subprocess.run(
        ["git", "archive", "--format=tar", revision],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    with tarfile.open(fileobj=io.BytesIO(archive.stdout), mode="r:") as source:
        source.extractall(destination)


def build_board_documents(tree: Path) -> None:
    run(["node", "tools/build_community_board_constellation_documents.mjs"], tree)


def visible_text(page, selector: str) -> str | None:
    locator = page.locator(selector)
    if locator.count() == 0:
        return None
    return locator.first.inner_text().strip()


def capture_page(browser, tree: Path, *, state: str, canary: dict, width: int, height: int) -> dict:
    with StaticServer(tree / "site") as base:
        context = browser.new_context(
            viewport={"width": width, "height": height},
            java_script_enabled=False,
            device_scale_factor=1,
        )
        page = context.new_page()
        response = page.goto(f"{base}{canary['route'].lstrip('/')}", wait_until="load")
        if response is None or not response.ok:
            raise AssertionError(f"{state} {canary['board']} returned {response and response.status}")
        page.locator("h1").wait_for(state="visible")
        card = page.locator("#community-board-money")
        money_card = card.count() == 1
        money_state = card.get_attribute("data-money-state") if money_card else None
        if money_card:
            page.locator(".community-board-money-provenance summary").first.click()
        card_text = visible_text(page, "#community-board-money")
        overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
        if overflow > 1:
            raise AssertionError(f"{state} {canary['board']} {width}px overflows by {overflow}px")
        if state == "before" and money_card:
            raise AssertionError(f"before {canary['board']} still shows the money card")
        if state == "after":
            if not money_card:
                raise AssertionError(f"after {canary['board']} is missing #community-board-money")
            if money_state != canary["after_state"]:
                raise AssertionError(f"{canary['board']} state {money_state} != {canary['after_state']}")
            if not card_text or "Sources and coverage" not in card_text:
                raise AssertionError(f"{canary['board']} is missing source disclosure")
            lowered = card_text.lower()
            for phrase in FORBIDDEN:
                if phrase.lower() in lowered:
                    raise AssertionError(f"{canary['board']} contains forbidden copy: {phrase}")
            if canary["board"] == "bronx-cb-01":
                for token in ("$366,943", "$95,914.68", "22 payments", "9 payees"):
                    if token not in card_text:
                        raise AssertionError(f"{canary['board']} missing {token}")
            if canary["board"] == "bronx-cb-03":
                if "$340,425" not in card_text:
                    raise AssertionError("bronx-cb-03 missing adopted budget")
                lowered_text = card_text.lower()
                if "accepted exact financial identity" not in lowered_text and "no accepted payment identity" not in lowered_text:
                    raise AssertionError("bronx-cb-03 missing identity copy")
                if "$0" in card_text:
                    raise AssertionError("bronx-cb-03 rendered $0 for an unobserved payment identity")
        with tempfile.NamedTemporaryFile(suffix=".webp", delete=False) as handle:
            shot = Path(handle.name)
        page.screenshot(path=str(shot), type="webp", quality=82, full_page=True)
        row = record_capture(
            shot,
            root=EVIDENCE_ROOT,
            pr_number=None,
            card_id="cityscroll-engineering/community-board-money-capture",
            capture_kind="community-board-money-card",
            surface=f"docs/screenshots/community-board-money/{canary['board']}",
            phase=state,
            viewport_width=width,
            viewport_height=height,
            media_type="image/webp",
        )
        shot.unlink(missing_ok=True)
        context.close()
        return {
            "state": state,
            "viewport": [width, height],
            "route": canary["route"],
            "file": row["url"],
            "money_card": money_card,
            "money_state": money_state,
            "overflow_px": overflow,
            "card_text": card_text,
            "kind": canary["kind"],
        }


def required_after_rows(captures: list[dict]) -> None:
    for canary in CANARIES:
        for width, _height in VIEWPORTS:
            match = next(
                (
                    row for row in captures
                    if row.get("state") == "after"
                    and row.get("viewport", [None])[0] == width
                    and canary["board"] in str(row.get("route") or "")
                ),
                None,
            )
            if match is None:
                raise AssertionError(f"manifest missing after {canary['board']} {width}px")
            if match.get("money_card") is not True:
                raise AssertionError(f"{canary['board']} {width}px is missing the money card")
            if match.get("money_state") != canary["after_state"]:
                raise AssertionError(f"{canary['board']} {width}px has state {match.get('money_state')}")
            before = next(
                (
                    row for row in captures
                    if row.get("state") == "before"
                    and row.get("viewport", [None])[0] == width
                    and canary["board"] in str(row.get("route") or "")
                ),
                None,
            )
            if before is None or before.get("money_card"):
                raise AssertionError(f"manifest missing honest before {canary['board']} {width}px")


def check_manifest(path: Path = OUTPUT / "manifest.json") -> dict:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    required_after_rows(manifest.get("captures") or [])
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", default=DEFAULT_BEFORE, help="revision before the money card")
    parser.add_argument("--check", action="store_true", help="validate the committed capture manifest")
    args = parser.parse_args()
    if args.check:
        check_manifest()
        print("community-board-money capture matrix OK")
        return 0

    OUTPUT.mkdir(parents=True, exist_ok=True)
    records: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="community-board-money-before-") as temp:
        before_tree = Path(temp)
        revision_snapshot(args.before, before_tree)
        build_board_documents(before_tree)
        build_board_documents(ROOT)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for canary in CANARIES:
                    for width, height in VIEWPORTS:
                        records.append(capture_page(
                            browser, before_tree, state="before", canary=canary, width=width, height=height,
                        ))
                        records.append(capture_page(
                            browser, ROOT, state="after", canary=canary, width=width, height=height,
                        ))
            finally:
                browser.close()

    import subprocess
    manifest = {
        "schema_version": 1,
        "before_revision": subprocess.check_output(
            ["git", "rev-parse", "--short=12", args.before], cwd=ROOT, text=True,
        ).strip(),
        "canaries": [
            {"board": row["board"], "route": row["route"], "kind": row["kind"], "after_state": row["after_state"]}
            for row in CANARIES
        ],
        "captures": records,
    }
    required_after_rows(records)
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
