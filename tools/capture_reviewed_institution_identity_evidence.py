#!/usr/bin/env python3
"""Headless browser evidence that the same institution is recognizable
across the directory, People & organizations, and its profile.

Drives the real static pages this repository publishes, served from the
working tree. Search ranking is proven over the committed producer in
test/civic_institution_resident_identity.test.mjs; this tool proves the
browser journeys: acronym and former-name results, profile headings, Back,
keyboard, no-scripting anchors, 200 percent zoom, and a failed search that
keeps its query.

    python3 tools/capture_reviewed_institution_identity_evidence.py
    python3 tools/capture_reviewed_institution_identity_evidence.py --check
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
MANIFEST = ROOT / "docs" / "evidence" / "reviewed-institution-identity" / "manifest.json"
IMAGES = ROOT / ".artifacts" / "reviewed-institution-identity"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"

MANIFEST_SCHEMA = "cityscroll.reviewed_institution_identity_evidence.v1"
SUBJECT = "the same reviewed institution identity across search, browse and profiles"
DIRECTORY = "/agencies/"
PEOPLE = "/browse/people/"

CPC = {
    "id": "city-planning-commission",
    "name": "City Planning Commission",
    "route": "/agencies/city-planning-commission/",
    "query": "CPC",
    "kind": "Commission",
}
DCP = {
    "id": "city-planning",
    "name": "Department of City Planning",
    "route": "/agencies/city-planning/",
    "query": "DCP",
    "kind": "City department",
}
NYCEDC = {
    "id": "economic-development-corporation",
    "name": "Economic Development Corporation",
    "route": "/agencies/economic-development-corporation/",
    "query": "NYCEDC",
    "kind": "Nonprofit organization",
}
OTI = {
    "id": "information-technology-and-telecommunications",
    "name": "Office of Technology and Innovation",
    "route": "/agencies/information-technology-and-telecommunications/",
    "query": "DoITT",
    "kind": None,
}

VIEWPORTS = ((390, 844), (1440, 900))
TARGET_MIN = 43.5
ZOOM = 2.0
DIR_QUERY = "[data-directory-query]"
DIR_ROW = "[data-directory-row]"
PEOPLE_QUERY = "[data-people-organizations-search]"
PEOPLE_EMPTY = "[data-people-organizations-no-results]"
NO_MATCH = "zzzz no such public body"


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # People & organizations imports ../capabilities from site modules.
        # Serve those from the repository while the rest of the tree is site/.
        relative = path.split("?", 1)[0].split("#", 1)[0].lstrip("/")
        if relative.startswith("capabilities/"):
            return str(ROOT / relative)
        return super().translate_path(path)

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
          const selector = ['button:not([disabled])','summary','a.act','.civic-object-action',
                            '.agency-directory-group-link'].join(',');
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


def directory_state(page) -> dict:
    return page.evaluate(
        """() => {
          const rows = [...document.querySelectorAll('[data-directory-row]')];
          const visible = rows.filter(row => !row.hidden);
          return {
            visible_ids: visible.map(row => row.getAttribute('data-canonical-id')),
            visible_count: visible.length,
            total_rows: rows.length,
            query: document.querySelector('[data-directory-query]')?.value || '',
            search: location.search,
            summary: (document.querySelector('[data-directory-summary]')?.textContent || '').trim(),
            empty_shown: !document.querySelector('[data-directory-empty]')?.hidden,
            scroll_y: Math.round(window.scrollY),
            focus_id: document.activeElement?.closest?.('[data-directory-row]')
              ?.getAttribute('data-canonical-id') || null,
          };
        }"""
    )


def profile_copy(page) -> dict:
    return page.evaluate(
        """() => ({
          kicker: (document.querySelector('.node-kicker')?.textContent || '').trim(),
          heading: (document.querySelector('h1')?.textContent || '').trim(),
          identity: (document.querySelector(
            '.institution-resident-identity, .institution-statutory-identity'
          )?.textContent || '').trim(),
          generic_agency_copy: /City agency organization|Agency with public records/i
            .test(document.body.innerText || ''),
        })"""
    )


def type_directory_query(page, text):
    page.fill(DIR_QUERY, text)
    page.wait_for_function(
        "(value) => new URL(location.href).searchParams.get('q') === (value || null)",
        arg=text or None,
    )


def directory_to_profile_and_back(body):
    def specimen(page, base, width):
        page.goto(f"{base}{DIRECTORY}", wait_until="load")
        page.wait_for_selector(DIR_ROW, state="attached")
        opening = directory_state(page)
        type_directory_query(page, body["query"])
        narrowed = directory_state(page)
        entry = page.locator(f'{DIR_ROW}[data-canonical-id="{body["id"]}"] a.agency-index-link')
        if entry.count() != 1:
            raise SystemExit(f'{body["id"]}: directory must offer this body exactly once for {body["query"]}')
        entry.first.click()
        page.wait_for_url(f'{base}{body["route"]}', timeout=15000)
        landed = page.url
        copy = profile_copy(page)
        shot = page.screenshot(full_page=True)
        page.go_back()
        page.wait_for_selector(DIR_ROW, state="attached")
        page.wait_for_function(
            "(id) => document.activeElement?.closest?.('[data-directory-row]')"
            "?.getAttribute('data-canonical-id') === id",
            arg=body["id"],
            timeout=15000,
        )
        after = directory_state(page)
        observations = {
            "search_kept_this_body": body["id"] in narrowed["visible_ids"],
            "search_narrowed_the_directory": narrowed["visible_count"] < opening["total_rows"],
            "opened_the_canonical_destination": landed.rstrip("/") == f'{base}{body["route"]}'.rstrip("/"),
            "profile_heading_names_the_body": body["name"] in copy["heading"],
            "profile_omits_generic_agency_copy": not copy["generic_agency_copy"],
            "back_restored_the_query": after["query"] == body["query"],
            "back_restored_focus_to_the_row_opened": after["focus_id"] == body["id"],
            "touch_target_failures": target_failures(page),
            "no_horizontal_overflow": no_horizontal_overflow(page),
        }
        if body.get("kind"):
            observations["profile_kicker_is_the_reviewed_type"] = copy["kicker"] == body["kind"]
            observations["profile_states_the_reviewed_purpose"] = bool(copy["identity"])
        return shot, observations, (
            f'at {width}px a reader searching “{body["query"]}” reaches {body["name"]}, '
            "sees the same reviewed identity on the profile, and browser Back restores the query"
        )
    return specimen


def people_to_profile_and_back(body):
    def specimen(page, base, width):
        page.goto(f"{base}{PEOPLE}", wait_until="load")
        page.wait_for_selector(PEOPLE_QUERY, state="attached")
        page.wait_for_function("() => Boolean(document.querySelector('[data-people-organizations][data-bound]') || document.querySelector('[data-people-organizations-search]'))")
        page.fill(PEOPLE_QUERY, body["query"])
        page.locator(PEOPLE_QUERY).dispatch_event("input")
        page.wait_for_function(
            "(value) => new URL(location.href).searchParams.get('q') === value",
            arg=body["query"],
            timeout=15000,
        )
        link = page.locator(f'a[href="{body["route"]}"]')
        if link.count() < 1:
            raise SystemExit(f'{body["id"]}: People & organizations missed {body["query"]}')
        context = page.evaluate(
            """(href) => {
              const a = document.querySelector('a[href="' + href + '"]');
              const row = a?.closest('li, article, .browse-row, [data-civic-object-kind]');
              return (row?.innerText || a?.closest('div')?.innerText || '').trim();
            }""",
            body["route"],
        )
        link.first.click()
        page.wait_for_url(f'{base}{body["route"]}', timeout=15000)
        landed = page.url
        copy = profile_copy(page)
        shot = page.screenshot(full_page=True)
        page.go_back()
        page.wait_for_selector(PEOPLE_QUERY, state="attached")
        page.wait_for_function(
            "(value) => (document.querySelector('[data-people-organizations-search]')?.value || '') === value",
            arg=body["query"],
            timeout=15000,
        )
        restored = page.locator(PEOPLE_QUERY).input_value()
        return shot, {
            "people_result_names_the_body": body["name"] in context,
            "people_result_omits_generic_agency_copy": "City agency organization" not in context,
            "people_result_states_the_reviewed_type": (not body.get("kind")) or body["kind"] in context,
            "opened_the_canonical_destination": body["route"] in landed,
            "profile_heading_names_the_body": body["name"] in copy["heading"],
            "back_restored_the_query": restored == body["query"],
            "touch_target_failures": target_failures(page),
            "no_horizontal_overflow": no_horizontal_overflow(page),
        }, (
            f'at {width}px searching “{body["query"]}” in People & organizations reaches '
            f'{body["name"]} with the same reviewed description, and Back keeps the query'
        )
    return specimen


def distinct_planning_bodies(page, base, width):
    page.goto(f"{base}{DCP['route']}", wait_until="load")
    dcp = profile_copy(page)
    page.goto(f"{base}{CPC['route']}", wait_until="load")
    cpc = profile_copy(page)
    shot = page.screenshot(full_page=True)
    return shot, {
        "department_kicker": dcp["kicker"] == DCP["kind"],
        "commission_kicker": cpc["kicker"] == CPC["kind"],
        "headings_name_different_bodies": dcp["heading"] != cpc["heading"],
        "department_heading": DCP["name"] in dcp["heading"],
        "commission_heading": CPC["name"] in cpc["heading"],
        "no_generic_agency_copy": (not dcp["generic_agency_copy"]) and (not cpc["generic_agency_copy"]),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the planning department and planning commission profiles use different "
        "reviewed types and names rather than one generic agency heading"
    )


def people_failure_keeps_query(page, base, width):
    page.goto(f"{base}{PEOPLE}", wait_until="load")
    page.wait_for_selector(PEOPLE_QUERY, state="attached")
    page.fill(PEOPLE_QUERY, NO_MATCH)
    page.locator(PEOPLE_QUERY).dispatch_event("input")
    page.wait_for_function(
        "(value) => new URL(location.href).searchParams.get('q') === value",
        arg=NO_MATCH,
        timeout=15000,
    )
    empty = page.locator(PEOPLE_EMPTY)
    empty_shown = empty.count() and empty.first.is_visible()
    shot = page.screenshot(full_page=True)
    return shot, {
        "query_stayed_in_the_field": page.locator(PEOPLE_QUERY).input_value() == NO_MATCH,
        "query_stayed_in_the_url": f"q={NO_MATCH.replace(' ', '+')}" in page.url
        or "q=" in page.url,
        "empty_state_is_shown": bool(empty_shown),
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a People & organizations search that matches nothing keeps the query "
        "in the field and the URL instead of looking like a successful empty load"
    )


def keyboard_directory(page, base, width):
    page.goto(f"{base}{DIRECTORY}", wait_until="load")
    page.wait_for_selector(DIR_QUERY, state="attached")
    page.locator(DIR_QUERY).focus()
    page.keyboard.type(CPC["query"])
    page.wait_for_function("() => (new URL(location.href).searchParams.get('q') || '') !== ''")
    reached = None
    for _ in range(16):
        page.keyboard.press("Tab")
        reached = page.evaluate(
            "() => document.activeElement?.closest?.('[data-directory-row]')"
            "?.getAttribute('data-canonical-id') || null"
        )
        if reached == CPC["id"]:
            break
    if reached != CPC["id"]:
        raise SystemExit("keyboard journey never focused the commission row")
    page.keyboard.press("Enter")
    page.wait_for_url(f'{base}{CPC["route"]}', timeout=15000)
    copy = profile_copy(page)
    shot = page.screenshot(full_page=True)
    return shot, {
        "keyboard_opened_the_commission": CPC["route"] in page.url,
        "profile_kicker_is_the_reviewed_type": copy["kicker"] == CPC["kind"],
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the commission is reachable from the directory with the keyboard alone"
    )


def without_scripting(page, base, width):
    page.goto(f"{base}{CPC['route']}", wait_until="load")
    copy = profile_copy(page)
    hrefs = page.evaluate("() => [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))")
    shot = page.screenshot(full_page=True)
    return shot, {
        "profile_is_a_real_document": bool(copy["heading"]),
        "heading_names_the_commission": CPC["name"] in copy["heading"],
        "kicker_is_the_reviewed_type": copy["kicker"] == CPC["kind"],
        "back_link_is_an_ordinary_href": "/agencies/" in hrefs,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px, with scripting unavailable, the commission profile is still a real "
        "document that names the commission as a commission"
    )


def zoom_specimen(page, base, width):
    page.goto(f"{base}{DIRECTORY}", wait_until="load")
    page.wait_for_selector(DIR_ROW, state="attached")
    page.evaluate("(zoom) => { document.documentElement.style.zoom = String(zoom); }", ZOOM)
    page.wait_for_timeout(200)
    type_directory_query(page, CPC["query"])
    narrowed = directory_state(page)
    shot = page.screenshot(full_page=True)
    return shot, {
        "search_kept_the_commission_at_zoom": CPC["id"] in narrowed["visible_ids"],
        "no_horizontal_overflow": no_horizontal_overflow(page),
        "touch_target_failures": target_failures(page),
    }, (
        f"at {width}px and {int(ZOOM * 100)} percent zoom a CPC search still reaches the commission"
    )


SPECIMENS = (
    ("directory-cpc-and-back", directory_to_profile_and_back(CPC)),
    ("directory-nycedc-and-back", directory_to_profile_and_back(NYCEDC)),
    ("directory-doitt-and-back", directory_to_profile_and_back(OTI)),
    ("people-cpc-and-back", people_to_profile_and_back(CPC)),
    ("people-nycedc-and-back", people_to_profile_and_back(NYCEDC)),
    ("distinct-planning-bodies", distinct_planning_bodies),
    ("people-no-match-keeps-query", people_failure_keeps_query),
    ("keyboard-directory-cpc", keyboard_directory),
    ("without-scripting-cpc-profile", without_scripting),
    ("two-hundred-percent-zoom", zoom_specimen),
)
NO_SCRIPT_SPECIMENS = {"without-scripting-cpc-profile"}


def capture() -> dict:
    sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
    from a11y_gate import failing_violations
    from playwright.sync_api import sync_playwright

    required = [
        SITE / "agencies" / "index.html",
        SITE / "agencies" / CPC["id"] / "index.html",
        SITE / "agencies" / DCP["id"] / "index.html",
        SITE / "agencies" / NYCEDC["id"] / "index.html",
        SITE / "agencies" / OTI["id"] / "index.html",
        SITE / "browse" / "people" / "index.html",
    ]
    for document in required:
        if not document.is_file():
            raise SystemExit(f"missing {document.relative_to(ROOT)}; generate it before capture")

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
                    route = PEOPLE if slug.startswith("people-") else (
                        CPC["route"] if "cpc-profile" in slug or slug == "distinct-planning-bodies"
                        else DIRECTORY
                    )
                    files.append({
                        "name": name,
                        "specimen": slug,
                        "route": route,
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

    manifest = {
        "schema": MANIFEST_SCHEMA,
        "subject": SUBJECT,
        "routes": [DIRECTORY, PEOPLE, CPC["route"], DCP["route"], NYCEDC["route"], OTI["route"]],
        "revision": revision,
        "data_vintage": vintage,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "image_directory": str(IMAGES.relative_to(ROOT)),
        "image_policy": (
            "Capture images are written to the ignored local directory above and are never "
            "committed. This manifest is the tracked proof: route, viewport, revision, data "
            "vintage, assertion and SHA-256 for each capture."
        ),
        "search_note": (
            "Which documents an acronym or former-name query keeps is proven over the committed "
            "search producer in test/civic_institution_resident_identity.test.mjs. The captures "
            "below prove browser navigation and rendering, and claim nothing about a live search "
            "API they did not call."
        ),
        "files": files,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


REQUIRED_FIELDS = ("name", "specimen", "route", "viewport", "revision", "data_vintage",
                   "assertion", "observations", "sha256", "axe")


def check() -> int:
    if not MANIFEST.exists():
        raise SystemExit(f"missing {MANIFEST.relative_to(ROOT)}; run this tool without --check")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("schema") != MANIFEST_SCHEMA:
        raise SystemExit(f"unexpected manifest schema {manifest.get('schema')!r}")
    files = manifest.get("files") or []
    expected = {f"{slug}-{width}x{height}.png" for slug, _ in SPECIMENS for width, height in VIEWPORTS}
    found = {row.get("name") for row in files}
    if expected - found:
        raise SystemExit(f"missing capture entries: {sorted(expected - found)}")
    for row in files:
        absent = [field for field in REQUIRED_FIELDS if not row.get(field)]
        if absent:
            raise SystemExit(f"{row.get('name')}: manifest entry is missing {absent}")
        if len(row["sha256"]) != 64:
            raise SystemExit(f"{row['name']}: sha256 is not a digest")
        if row["axe"].get("failing_violations"):
            raise SystemExit(f"{row['name']} failed the accessibility gate: {row['axe']['failing_violations']}")
        for key, value in row["observations"].items():
            if value is False:
                raise SystemExit(f"{row['name']}: the capture observed {key} as false")
            if key.endswith("touch_target_failures") and value:
                raise SystemExit(f"{row['name']}: undersized targets {value}")
        image = IMAGES / row["name"]
        if image.exists() and hashlib.sha256(image.read_bytes()).hexdigest() != row["sha256"]:
            raise SystemExit(f"{row['name']}: the local image does not match its recorded digest")
    committed = sorted(path.name for path in MANIFEST.parent.glob("*")
                       if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp"})
    if committed:
        raise SystemExit(f"capture images must not be committed: {committed}")
    print(f"reviewed institution identity evidence OK ({len(files)} captures, "
          f"{len(SPECIMENS)} specimens x {len(VIEWPORTS)} viewports, "
          f"revision {manifest['revision'][:12]})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        return check()
    manifest = capture()
    print(f"captured {len(manifest['files'])} specimens into {IMAGES.relative_to(ROOT)} "
          f"(manifest: {MANIFEST.relative_to(ROOT)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
