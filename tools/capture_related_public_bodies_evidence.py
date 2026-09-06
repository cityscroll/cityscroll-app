#!/usr/bin/env python3
"""Headless browser evidence that related public bodies are navigable.

Drives the real static pages this repository publishes, served from the
working tree. Relationship membership is proven over
test/civic_institution_related_bodies.test.mjs; this tool proves the
browser journeys: DCP to CPC, MTA to an operating body, and a borough
office to its board, Community Board and geography, then Back.

    python3 tools/capture_related_public_bodies_evidence.py
    python3 tools/capture_related_public_bodies_evidence.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
MANIFEST = ROOT / "docs" / "evidence" / "related-public-bodies" / "manifest.json"
IMAGES = ROOT / ".artifacts" / "related-public-bodies"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"

MANIFEST_SCHEMA = "cityscroll.related_public_bodies_evidence.v1"
SUBJECT = "sourced relationship links between related public bodies"

DCP = "/agencies/city-planning/"
CPC = "/agencies/city-planning-commission/"
MTA = "/agencies/metropolitan-transportation-authority/"
NYCT = "/agencies/n-y-c-transit-authority/"
OFFICE = "/agencies/borough-president-brooklyn/"
BOARD = "/agencies/brooklyn-borough-board/"
CB15 = "/community-boards/brooklyn-cb-15/"
GEO = "/near-you/borough/brooklyn/"

VIEWPORTS = ((390, 844), (1440, 900))
TARGET_MIN = 43.5
ZOOM = 2.0


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def log_message(self, *args):  # noqa: A003
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def data_vintage() -> str:
    lookup = json.loads((SITE / "data" / "agency_constellation_lookup.json").read_text("utf-8"))
    stamp = str(lookup.get("generated_at") or "")
    day = max((part[:10] for part in stamp.split("|") if len(part) >= 10), default="")
    if not day:
        raise SystemExit("the agency read model carries no generated_at to date this capture")
    return day


def run_axe(page, a11y_gate) -> dict:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    failing = a11y_gate(result["violations"], wcag22_rules)
    return {
        "violations_total": len(result["violations"]),
        "failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in failing],
        "passes": not failing,
    }


def no_horizontal_overflow(page) -> bool:
    return not page.evaluate(
        "() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1"
    )


def target_failures(page) -> list:
    return page.evaluate(
        """(min) => {
          const selector = ['.related-public-bodies-link','.related-public-bodies-source > summary'].join(',');
          const rendered = el => {
            const style = getComputedStyle(el), rect = el.getBoundingClientRect();
            const closed = el.closest('details:not([open])');
            if (closed && !closed.querySelector(':scope > summary')?.contains(el)) return false;
            return style.display !== 'none' && style.visibility !== 'hidden'
              && rect.width > 0 && rect.height > 0;
          };
          return [...document.querySelectorAll(selector)].filter(rendered).flatMap(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width >= min && rect.height >= min) return [];
            return [{ tag: el.tagName.toLowerCase(),
                      text: String(el.innerText || '').trim().slice(0, 60),
                      width: Math.round(rect.width * 10) / 10,
                      height: Math.round(rect.height * 10) / 10 }];
          });
        }""",
        TARGET_MIN,
    )


def related_state(page) -> dict:
    return page.evaluate(
        """() => {
          const panel = document.querySelector('#related-public-bodies');
          const items = [...document.querySelectorAll('.related-public-bodies-item')];
          const open = [...document.querySelectorAll('.related-public-bodies-source[open]')];
          return {
            has_panel: Boolean(panel),
            relations: items.map(item => item.getAttribute('data-relation')),
            hrefs: [...document.querySelectorAll('.related-public-bodies-link')].map(a => a.getAttribute('href')),
            source_open: open.length,
            heading: (document.querySelector('h1')?.textContent || '').trim(),
            path: location.pathname + location.hash,
          };
        }"""
    )


def prepare_specimens() -> None:
    subprocess.run(
        ["node", "tools/render_related_public_bodies_specimens.mjs"],
        cwd=ROOT, check=True,
    )


def dcp_to_cpc_and_back(page, base, width):
    page.goto(f"{base}{DCP}", wait_until="load")
    start = related_state(page)
    link = page.locator('.related-public-bodies-item[data-relation="staffs"] .related-public-bodies-link')
    link.click()
    page.wait_for_url(f"{base}{CPC}", timeout=15000)
    landed = related_state(page)
    details = page.locator(".related-public-bodies-source").first
    summary = details.locator("summary")
    summary.click()
    page.wait_for_function("() => document.querySelectorAll('.related-public-bodies-source[open]').length > 0")
    opened = related_state(page)
    summary.click()
    page.wait_for_function("() => document.querySelectorAll('.related-public-bodies-source[open]').length === 0")
    dismissed = related_state(page)
    shot = page.screenshot(full_page=True)
    page.go_back()
    page.wait_for_url(f"{base}{DCP}", timeout=15000)
    back = related_state(page)
    return shot, {
        "started_on_dcp": start["path"].rstrip("/") == DCP.rstrip("/"),
        "opened_cpc": landed["path"].rstrip("/") == CPC.rstrip("/"),
        "cpc_links_back_to_dcp": DCP in landed["hrefs"],
        "inspected_source": opened["source_open"] > 0,
        "dismissed_source": dismissed["source_open"] == 0,
        "back_returned_to_dcp": back["path"].rstrip("/") == DCP.rstrip("/"),
        "back_kept_related_panel": back["has_panel"],
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, f"at {width}px DCP staffs CPC, source details inspect and dismiss, and Back restores DCP"


def mta_to_operating_body_and_back(page, base, width):
    page.goto(f"{base}{MTA}", wait_until="load")
    start = related_state(page)
    page.locator('.related-public-bodies-item[data-object-id="n-y-c-transit-authority"] .related-public-bodies-link').click()
    page.wait_for_url(f"{base}{NYCT}", timeout=15000)
    landed = related_state(page)
    shot = page.screenshot(full_page=True)
    page.go_back()
    page.wait_for_url(f"{base}{MTA}", timeout=15000)
    back = related_state(page)
    return shot, {
        "started_on_mta": start["has_panel"],
        "opened_operating_body": landed["path"].rstrip("/") == NYCT.rstrip("/"),
        "operating_body_keeps_own_heading": "Transit" in landed["heading"],
        "operating_body_links_to_mta": MTA in landed["hrefs"],
        "back_returned_to_mta": back["path"].rstrip("/") == MTA.rstrip("/"),
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, f"at {width}px MTA lists an operating body with its own identity, and Back restores MTA"


def open_related(page, base, selector, expected_path):
    page.locator(selector).click()
    page.wait_for_function(
        "(expected) => (location.pathname + location.hash).indexOf(expected) !== -1",
        arg=expected_path,
        timeout=15000,
    )
    landed = related_state(page)
    page.go_back()
    page.wait_for_url(f"{base}{OFFICE}", timeout=15000)
    restored = related_state(page)
    return landed, restored


def borough_office_journey(page, base, width):
    page.goto(f"{base}{OFFICE}", wait_until="load")
    office = related_state(page)
    board, after_board = open_related(
        page, base, '.related-public-bodies-item[data-relation="chairs_body"] .related-public-bodies-link', BOARD,
    )
    community, after_community = open_related(
        page, base,
        '.related-public-bodies-item[data-relation="appoints_members_of"] .related-public-bodies-link',
        CB15,
    )
    geography, after_geo = open_related(
        page, base,
        '.related-public-bodies-item[data-relation="serves_territory"] .related-public-bodies-link',
        GEO,
    )
    shot = page.screenshot(full_page=True)
    return shot, {
        "office_links_to_board": BOARD in office["hrefs"],
        "office_links_to_community_board": CB15 in office["hrefs"],
        "office_links_to_geography": GEO in office["hrefs"],
        "opened_borough_board": BOARD.rstrip("/") in board["path"],
        "opened_community_board": CB15.rstrip("/") in community["path"],
        "opened_geography": GEO.rstrip("/") in geography["path"],
        "four_distinct_destinations": len({OFFICE, BOARD, CB15, GEO}) == 4,
        "back_restored_office_after_board": after_board["path"].rstrip("/") == OFFICE.rstrip("/"),
        "back_restored_office_after_community_board": after_community["path"].rstrip("/") == OFFICE.rstrip("/"),
        "back_restored_office_after_geography": after_geo["path"].rstrip("/") == OFFICE.rstrip("/"),
        "back_kept_related_panel": after_geo["has_panel"],
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, f"at {width}px the Brooklyn office, borough board, Community Board and borough geography stay distinct, and Back restores the office"


def keyboard_dcp_to_cpc(page, base, width):
    page.goto(f"{base}{DCP}", wait_until="load")
    page.locator('.related-public-bodies-item[data-relation="staffs"] .related-public-bodies-link').focus()
    page.keyboard.press("Enter")
    page.wait_for_url(f"{base}{CPC}", timeout=15000)
    shot = page.screenshot(full_page=True)
    return shot, {
        "keyboard_opened_cpc": related_state(page)["path"].rstrip("/") == CPC.rstrip("/"),
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, f"at {width}px keyboard activation of Staffs opens the City Planning Commission"


def without_scripting(page, base, width):
    page.goto(f"{base}{DCP}", wait_until="load")
    href = page.locator('.related-public-bodies-item[data-relation="staffs"] .related-public-bodies-link').get_attribute("href")
    shot = page.screenshot(full_page=True)
    return shot, {
        "staffs_anchor_is_in_the_document": href == CPC,
        "related_panel_present": related_state(page)["has_panel"],
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, f"at {width}px with scripting unavailable the DCP staffing link remains a real CPC anchor"


def zoom_specimen(page, base, width):
    page.goto(f"{base}{DCP}", wait_until="load")
    native_overflow = no_horizontal_overflow(page)
    page.evaluate("(zoom) => { document.documentElement.style.zoom = String(zoom); }", ZOOM)
    shot = page.screenshot(full_page=True)
    return shot, {
        "related_panel_present_at_zoom": related_state(page)["has_panel"],
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": native_overflow,
    }, f"at {width}px and 200 percent zoom the DCP related-bodies panel stays in column"


SPECIMENS = (
    ("dcp-to-cpc-and-back", dcp_to_cpc_and_back),
    ("mta-to-operating-body-and-back", mta_to_operating_body_and_back),
    ("borough-office-board-community-geography", borough_office_journey),
    ("keyboard-dcp-to-cpc", keyboard_dcp_to_cpc),
    ("without-scripting-dcp", without_scripting),
    ("two-hundred-percent-zoom", zoom_specimen),
)
NO_SCRIPT_SPECIMENS = {"without-scripting-dcp"}
ROUTES = {
    "dcp-to-cpc-and-back": DCP,
    "mta-to-operating-body-and-back": MTA,
    "borough-office-board-community-geography": OFFICE,
    "keyboard-dcp-to-cpc": DCP,
    "without-scripting-dcp": DCP,
    "two-hundred-percent-zoom": DCP,
}


def capture() -> dict:
    sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
    from a11y_gate import failing_violations
    from playwright.sync_api import sync_playwright

    prepare_specimens()
    IMAGES.mkdir(parents=True, exist_ok=True)
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    revision = git_revision()
    vintage = data_vintage()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    files = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for slug, run in SPECIMENS:
                for width, height in VIEWPORTS:
                    scripting = slug not in NO_SCRIPT_SPECIMENS
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        java_script_enabled=scripting,
                        has_touch=width <= 500,
                    )
                    page = context.new_page()
                    image, observations, assertion = run(page, base, width)
                    axe_result = run_axe(page, failing_violations) if scripting else {
                        "violations_total": None,
                        "failing_violations": [],
                        "passes": None,
                        "skipped": "scripting disabled for this specimen",
                    }
                    name = f"{slug}-{width}x{height}.png"
                    (IMAGES / name).write_bytes(image)
                    files.append({
                        "name": name,
                        "specimen": slug,
                        "route": ROUTES[slug],
                        "viewport": [width, height],
                        "scripting": scripting,
                        "revision": revision,
                        "data_vintage": vintage,
                        "assertion": assertion,
                        "observations": observations,
                        "bytes": len(image),
                        "sha256": hashlib.sha256(image).hexdigest(),
                        "axe": axe_result,
                    })
                    context.close()
            browser.close()
    finally:
        server.shutdown()

    return {
        "schema": MANIFEST_SCHEMA,
        "subject": SUBJECT,
        "routes": [DCP, CPC, MTA, NYCT, OFFICE, BOARD, CB15, GEO],
        "revision": revision,
        "data_vintage": vintage,
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "image_directory": ".artifacts/related-public-bodies",
        "image_policy": (
            "Capture images are written to the ignored local directory above and are never committed. "
            "This manifest is the tracked proof: route, viewport, revision, data vintage, assertion and SHA-256 for each capture."
        ),
        "files": files,
    }


def write_manifest(payload: dict) -> None:
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def check_manifest() -> int:
    if not MANIFEST.is_file():
        print("missing related-public-bodies evidence manifest", file=sys.stderr)
        return 1
    payload = json.loads(MANIFEST.read_text("utf-8"))
    if payload.get("schema") != MANIFEST_SCHEMA:
        print("related-public-bodies manifest schema mismatch", file=sys.stderr)
        return 1
    if not payload.get("files"):
        print("related-public-bodies manifest has no captures", file=sys.stderr)
        return 1
    for row in payload["files"]:
        for key in ("route", "viewport", "revision", "data_vintage", "assertion", "sha256"):
            if not row.get(key):
                print(f"capture {row.get('name')} missing {key}", file=sys.stderr)
                return 1
        if Path(row["name"]).suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
            committed = MANIFEST.parent / row["name"]
            if committed.is_file():
                print(f"image binary {row['name']} must not be committed", file=sys.stderr)
                return 1
    print(f"related-public-bodies evidence manifest is current ({len(payload['files'])} captures)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        return check_manifest()
    payload = capture()
    write_manifest(payload)
    print(f"wrote {MANIFEST.relative_to(ROOT)} ({len(payload['files'])} captures)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
