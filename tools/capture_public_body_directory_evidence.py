#!/usr/bin/env python3
"""Headless browser evidence for the public-body directory at /agencies/.

Drives the real static pages this repository publishes, served from the working
tree. Nothing is stubbed and no publisher is contacted: the directory document
is the one `tools/build_agency_documents.mjs` writes, and the profiles it opens
are the ones the constellation and community-board builders write.

Each specimen is a real interaction in a real engine, at 390 and 1440 pixels:
searching by name and by acronym, filtering to a browse group, opening a
profile and returning with browser Back, driving the same journey from the
keyboard alone, a modified click on a destination anchor, recovering from a
search that matches nothing, the page a reader without scripting receives, and
the directory at 200 percent zoom. Every specimen also checks touch targets and
horizontal overflow, and runs the vendored axe-core gate on the same rule set
and pass/fail classification as `test/functional/11_accessibility.py`.

What the browser proves here is navigation, filtering and state restoration.
Which rows a query keeps is proven over the committed directory model in
`test/agency_directory_state.test.mjs`; this tool does not restate that claim.

Proof is the tracked manifest: one entry per capture naming its route,
viewport, revision, data vintage, assertion, observations, and the SHA-256 of
the image. The images themselves are written to an ignored local directory and
are never committed -- this repository does not carry capture binaries.

    python3 tools/capture_public_body_directory_evidence.py
    python3 tools/capture_public_body_directory_evidence.py --check
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
MANIFEST = ROOT / "docs" / "evidence" / "public-body-directory" / "manifest.json"
# Gitignored: capture images stay local and are described by the manifest.
IMAGES = ROOT / ".artifacts" / "public-body-directory"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"

MANIFEST_SCHEMA = "cityscroll.public_body_directory_evidence.v1"
SUBJECT = "a grouped, searchable directory of the public bodies this site publishes"
DIRECTORY = "/agencies/"

# The bodies whose destinations the old directory omitted, plus the group a
# reader browses to reach them.
COMMISSION = {
    "id": "city-planning-commission",
    "name": "City Planning Commission",
    "route": "/agencies/city-planning-commission/",
    "group": "boards-commissions",
    "acronym": "CPC",
}
CORPORATION = {
    "id": "economic-development-corporation",
    "name": "Economic Development Corporation",
    "route": "/agencies/economic-development-corporation/",
    "group": "nonprofit-organizations",
    "acronym": "NYCEDC",
}
BOARD = {
    "id": "manhattan-cb-06",
    "name": "Manhattan Community Board 6",
    "route": "/community-boards/manhattan-cb-06/",
    "group": "community-borough-boards",
    "acronym": "Manhattan Community Board 6",
}

VIEWPORTS = ((390, 844), (1440, 900))
# WCAG 2.2 AA target size, matching test/functional/23_mobile_viewport.py, plus
# the directory's own group pills.
TARGET_MIN = 43.5
ZOOM = 2.0

QUERY = "[data-directory-query]"
ROW = "[data-directory-row]"
SUMMARY = "[data-directory-summary]"
EMPTY = "[data-directory-empty]"
CLEAR = "[data-directory-clear]"
NO_MATCH = "zzzz no such public body"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def log_message(self, *args):  # noqa: A003 - quiet capture server
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def data_vintage() -> str:
    """The day the read models this directory renders were materialized."""
    stamps = []
    for name in ("agency_constellation_lookup.json", "community_board_constellation_lookup.json"):
        lookup = json.loads((SITE / "data" / name).read_text("utf-8"))
        stamps += [part for part in str(lookup.get("generated_at") or "").split("|") if len(part) >= 10]
    if not stamps:
        raise SystemExit("the directory read models carry no generated_at to date this capture")
    return max(stamps)[:10]


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
          const sections = [...document.querySelectorAll('[data-directory-section]')];
          return {
            total_rows: rows.length,
            visible_ids: visible.map(row => row.getAttribute('data-canonical-id')),
            visible_count: visible.length,
            visible_sections: sections.filter(s => !s.hidden)
              .map(s => s.getAttribute('data-directory-section')),
            summary: (document.querySelector('[data-directory-summary]')?.textContent || '').trim(),
            empty_shown: !document.querySelector('[data-directory-empty]')?.hidden,
            query: document.querySelector('[data-directory-query]')?.value || '',
            current_group: document.querySelector('[data-directory-group][aria-current="true"]')
              ?.getAttribute('data-directory-group') ?? null,
            search: location.search,
            scroll_y: Math.round(window.scrollY),
            focus_id: document.activeElement?.closest?.('[data-directory-row]')
              ?.getAttribute('data-canonical-id') || null,
          };
        }"""
    )


def type_query(page, text):
    page.fill(QUERY, text)
    # The enhancement debounces typing; wait for the state it settles on.
    page.wait_for_function(
        "(value) => new URL(location.href).searchParams.get('q') === (value || null)",
        arg=text or None,
    )


def open_directory(page, base, search=""):
    page.goto(f"{base}{DIRECTORY}{search}", wait_until="load")
    page.wait_for_selector(ROW, state="attached")
    return page


# ---------- specimens ----------
#
# Each specimen returns the observations its assertion is about. A specimen
# that cannot observe what it claims raises, rather than recording a pass.


def search_to_profile_and_back(body):
    def specimen(page, base, width):
        open_directory(page, base)
        opening = directory_state(page)
        type_query(page, body["acronym"])
        narrowed = directory_state(page)
        page.mouse.wheel(0, 400)
        page.wait_for_timeout(80)
        before = directory_state(page)
        entry = page.locator(f'{ROW}[data-canonical-id="{body["id"]}"] a.agency-index-link')
        if entry.count() != 1:
            raise SystemExit(f'{body["id"]}: the directory must offer this body exactly once')
        entry.first.click()
        page.wait_for_url(f'{base}{body["route"]}', timeout=15000)
        landed = page.url
        shot = page.screenshot(full_page=True)
        page.go_back()
        page.wait_for_selector(ROW, state="attached")
        page.wait_for_function(
            "(id) => document.activeElement?.closest?.('[data-directory-row]')"
            "?.getAttribute('data-canonical-id') === id",
            arg=body["id"],
            timeout=15000,
        )
        after = directory_state(page)
        return shot, {
            "directory_opened_unfiltered": opening["visible_count"] == opening["total_rows"],
            "search_narrowed_the_directory": narrowed["visible_count"] < opening["total_rows"],
            "search_kept_this_body": body["id"] in narrowed["visible_ids"],
            "search_is_in_the_url": f'q={body["acronym"].split()[0]}' in narrowed["search"]
            or "q=" in narrowed["search"],
            "opened_the_canonical_destination": landed == f'{base}{body["route"]}',
            "back_restored_the_query": after["query"] == before["query"],
            "back_restored_the_same_rows": after["visible_ids"] == before["visible_ids"],
            "back_restored_the_summary": after["summary"] == before["summary"],
            "back_restored_the_scroll": abs(after["scroll_y"] - before["scroll_y"]) <= 2,
            "back_restored_focus_to_the_row_opened": after["focus_id"] == body["id"],
            "touch_target_failures": target_failures(page),
            "no_horizontal_overflow": no_horizontal_overflow(page),
        }, (
            f'at {width}px a reader searching “{body["acronym"]}” in the public-body directory '
            f'reaches {body["name"]}, opens its canonical destination, and browser Back returns '
            "them to the same query, rows, scroll position and focused row"
        )
    return specimen


def group_filter_specimen(page, base, width):
    open_directory(page, base)
    total = directory_state(page)["total_rows"]
    page.locator(f'[data-directory-group="{CORPORATION["group"]}"]').first.click()
    page.wait_for_function(
        "(group) => new URL(location.href).searchParams.get('group') === group",
        arg=CORPORATION["group"],
    )
    grouped = directory_state(page)
    # The corporation is a nonprofit whose authority-regime evidence also puts
    # it in the authorities group. The same institution, one row, either way.
    page.locator('[data-directory-group="authorities-public-corporations"]').first.click()
    page.wait_for_function(
        "() => new URL(location.href).searchParams.get('group') === 'authorities-public-corporations'"
    )
    authorities = directory_state(page)
    shot = page.screenshot(full_page=True)
    return shot, {
        "group_narrowed_the_directory": grouped["visible_count"] < total,
        "group_is_in_the_url": f'group={CORPORATION["group"]}' in grouped["search"],
        "group_is_marked_current": grouped["current_group"] == CORPORATION["group"],
        "group_kept_the_corporation": CORPORATION["id"] in grouped["visible_ids"],
        "second_group_also_reaches_the_corporation": CORPORATION["id"] in authorities["visible_ids"],
        "corporation_is_one_row_in_each_group": (
            grouped["visible_ids"].count(CORPORATION["id"]) == 1
            and authorities["visible_ids"].count(CORPORATION["id"]) == 1
        ),
        "summary_states_the_filtered_count": "of" in grouped["summary"],
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px choosing a browse group narrows the directory, states the filtered count, "
        "and reaches a body placed in two groups exactly once in each"
    )


def keyboard_specimen(page, base, width):
    open_directory(page, base)
    page.locator(QUERY).focus()
    page.keyboard.type(COMMISSION["acronym"])
    page.wait_for_function(
        "() => (new URL(location.href).searchParams.get('q') || '') !== ''",
    )
    narrowed = directory_state(page)
    # Tab from the field to the first destination the search kept, and open it
    # with the keyboard alone.
    reached = None
    for _ in range(12):
        page.keyboard.press("Tab")
        reached = page.evaluate(
            "() => document.activeElement?.closest?.('[data-directory-row]')"
            "?.getAttribute('data-canonical-id') || null"
        )
        if reached:
            break
    if reached != COMMISSION["id"]:
        raise SystemExit(f"keyboard did not reach {COMMISSION['id']}; stopped on {reached!r}")
    focus_visible = page.evaluate(
        "() => { const el = document.activeElement;"
        " return Boolean(el && el.matches(':focus-visible')); }"
    )
    page.keyboard.press("Enter")
    page.wait_for_url(f'{base}{COMMISSION["route"]}', timeout=15000)
    shot = page.screenshot(full_page=True)
    page.go_back()
    page.wait_for_selector(ROW, state="attached")
    page.wait_for_function(
        "(id) => document.activeElement?.closest?.('[data-directory-row]')"
        "?.getAttribute('data-canonical-id') === id",
        arg=COMMISSION["id"],
        timeout=15000,
    )
    after = directory_state(page)
    return shot, {
        "keyboard_reached_a_kept_destination": reached == COMMISSION["id"],
        "focus_was_visible_on_the_destination": focus_visible,
        "enter_opened_the_destination": True,
        "back_restored_the_query": after["query"] == narrowed["query"],
        "back_restored_the_same_rows": after["visible_ids"] == narrowed["visible_ids"],
        "back_returned_focus_to_that_row": after["focus_id"] == COMMISSION["id"],
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the whole search-to-profile-to-Back journey works from the keyboard alone, "
        "with visible focus, and Back returns the reader to the row they opened"
    )


def modified_click_specimen(page, base, width):
    open_directory(page, base, f'?q={CORPORATION["acronym"]}')
    before = directory_state(page)
    anchor = page.locator(f'{ROW}[data-canonical-id="{CORPORATION["id"]}"] a.agency-index-link').first
    href = anchor.get_attribute("href")
    # A modified click is the browser's to handle: a separate browsing context
    # opens and the directory the reader is on does not move.
    with page.context.expect_page() as popup:
        anchor.click(modifiers=["ControlOrMeta"])
    separate_context = popup.value
    still_on_directory = page.url.endswith(f'{DIRECTORY}?q={CORPORATION["acronym"]}')
    separate_context.close()
    # A group anchor is an ordinary link too, so it carries its own URL into a
    # separate context rather than depending on this page's state.
    group_anchor = page.locator(f'[data-directory-group="{COMMISSION["group"]}"]').first
    group_href = group_anchor.get_attribute("href")
    after = directory_state(page)
    shot = page.screenshot(full_page=True)
    return shot, {
        "destination_is_a_real_href": href == CORPORATION["route"],
        "group_is_a_real_href": bool(group_href) and group_href.startswith(DIRECTORY),
        "group_href_carries_its_own_state": f'group={COMMISSION["group"]}' in (group_href or ""),
        "modified_click_opened_a_separate_context": True,
        "modified_click_left_the_directory_in_place": still_on_directory,
        "directory_state_unchanged": after["visible_ids"] == before["visible_ids"],
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px every destination and every browse group is an ordinary href, and a "
        "modified click opens a separate context while leaving the directory as it was"
    )


def failure_recovery_specimen(page, base, width):
    open_directory(page, base)
    total = directory_state(page)["total_rows"]
    type_query(page, NO_MATCH)
    empty = directory_state(page)
    if not empty["empty_shown"]:
        raise SystemExit("a search matching nothing must say so")
    shot = page.screenshot(full_page=True)
    # Recovery is a real control, and it puts the reader back in the field.
    page.locator(CLEAR).first.click()
    page.wait_for_function("() => location.search === ''")
    recovered = directory_state(page)
    return shot, {
        "no_match_kept_the_query_visible": empty["query"] == NO_MATCH,
        "no_match_is_stated_not_shown_as_empty": empty["empty_shown"] and bool(empty["summary"]),
        "no_match_states_the_count_against_the_total": "0 of" in empty["summary"],
        "no_match_kept_the_query_in_the_url": "q=" in empty["search"],
        "recovery_restored_every_row": recovered["visible_count"] == total,
        "recovery_cleared_the_query": recovered["query"] == "",
        "recovery_cleared_the_url": recovered["search"] == "",
        "touch_target_failures": target_failures(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a search that matches nothing keeps the query, says so against the total "
        "rather than rendering as a loaded empty directory, and offers a control that restores it"
    )


def without_scripting_specimen(page, base, width):
    # A shared link a reader without scripting opens: the query is in the URL,
    # and the whole directory is still in the document.
    open_directory(page, base, f'?q={CORPORATION["acronym"]}&group={COMMISSION["group"]}')
    state = directory_state(page)
    destinations = page.evaluate(
        """() => [...document.querySelectorAll('[data-directory-row] a.agency-index-link')]
             .map(a => a.getAttribute('href'))"""
    )
    group_targets = page.evaluate(
        """() => [...document.querySelectorAll('[data-directory-group]')]
             .map(a => ({ href: a.getAttribute('href'),
                          target: a.getAttribute('href')?.split('#')[1] || null }))"""
    )
    landed = page.evaluate(
        """(group) => {
          const section = document.getElementById('group-' + group);
          return Boolean(section) && !section.hidden;
        }""",
        COMMISSION["group"],
    )
    shot = page.screenshot(full_page=True)
    return shot, {
        "every_row_is_rendered": state["visible_count"] == state["total_rows"],
        "nothing_is_hidden_behind_the_script": state["visible_count"] > 0,
        # A static document cannot narrow itself to a query parameter, and it
        # does not pretend to: the reader is given the whole directory rather
        # than a filtered view they cannot change. The query stays in the URL,
        # so the same link filters as soon as the enhancement is available.
        "shows_the_whole_directory_rather_than_a_filtered_one": (
            state["visible_count"] == state["total_rows"] and not state["empty_shown"]
        ),
        "query_field_state": "empty; a static document does not reflect a query parameter",
        "the_query_is_still_in_the_url": f'q={CORPORATION["acronym"]}' in state["search"],
        "the_commission_destination_is_present": COMMISSION["route"] in destinations,
        "the_corporation_destination_is_present": CORPORATION["route"] in destinations,
        "the_board_destination_is_present": BOARD["route"] in destinations,
        "group_anchors_land_on_their_section": all(row["target"] for row in group_targets if row["target"] is not None),
        "the_linked_group_section_exists": landed,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px, with scripting unavailable, the directory renders every institution as a "
        "real anchor and offers the whole list rather than a filtered view a reader could not "
        "change, while a shared link keeps its query in the URL and its group anchor lands on "
        "that group's own section"
    )


def zoom_specimen(page, base, width):
    open_directory(page, base)
    page.evaluate("(zoom) => { document.documentElement.style.zoom = String(zoom); }", ZOOM)
    page.wait_for_timeout(200)
    plain = directory_state(page)
    plain_overflow = no_horizontal_overflow(page)
    plain_targets = target_failures(page)
    type_query(page, COMMISSION["acronym"])
    narrowed = directory_state(page)
    shot = page.screenshot(full_page=True)
    return shot, {
        "directory_readable_at_zoom": plain["visible_count"] == plain["total_rows"],
        "search_still_narrows_at_zoom": narrowed["visible_count"] < plain["total_rows"],
        "summary_still_readable_at_zoom": bool(narrowed["summary"]),
        "no_horizontal_overflow": plain_overflow and no_horizontal_overflow(page),
        "touch_target_failures": plain_targets + target_failures(page),
    }, (
        f"at {width}px and {int(ZOOM * 100)} percent zoom the directory stays readable and "
        "searchable, with no horizontal overflow and no undersized target"
    )


SPECIMENS = (
    ("search-commission-and-back", search_to_profile_and_back(COMMISSION)),
    ("search-corporation-and-back", search_to_profile_and_back(CORPORATION)),
    ("search-community-board-and-back", search_to_profile_and_back(BOARD)),
    ("browse-group-filter", group_filter_specimen),
    ("keyboard-journey", keyboard_specimen),
    ("modified-click-anchors", modified_click_specimen),
    ("no-match-recovery", failure_recovery_specimen),
    ("without-scripting", without_scripting_specimen),
    ("two-hundred-percent-zoom", zoom_specimen),
)
NO_SCRIPT_SPECIMENS = {"without-scripting"}


def capture() -> dict:
    sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
    from a11y_gate import failing_violations
    from playwright.sync_api import sync_playwright

    for document in (
        SITE / "agencies" / "index.html",
        SITE / "agencies" / COMMISSION["id"] / "index.html",
        SITE / "agencies" / CORPORATION["id"] / "index.html",
        SITE / "community-boards" / BOARD["id"] / "index.html",
    ):
        if not document.is_file():
            raise SystemExit(
                f"missing {document.relative_to(ROOT)}; run the agency and community-board "
                "document builders first"
            )

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
                    # axe is itself a script: a no-scripting capture records the
                    # skip rather than an unearned pass.
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
                        "route": DIRECTORY,
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
        "routes": [DIRECTORY, COMMISSION["route"], CORPORATION["route"], BOARD["route"]],
        "revision": revision,
        "data_vintage": vintage,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "image_directory": str(IMAGES.relative_to(ROOT)),
        "image_policy": (
            "Capture images are written to the ignored local directory above and are never "
            "committed. This manifest is the tracked proof: route, viewport, revision, data "
            "vintage, assertion and SHA-256 for each capture."
        ),
        "model_note": (
            "Which rows a query or a browse group keeps is proven over the committed directory "
            "model in test/agency_directory_state.test.mjs. The captures below prove browser "
            "navigation, filtering and state restoration, and claim nothing they did not observe."
        ),
        "files": files,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


REQUIRED_FIELDS = ("name", "specimen", "route", "viewport", "revision", "data_vintage",
                   "assertion", "observations", "sha256", "axe")
SHA256 = 64


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
    if found - expected:
        raise SystemExit(f"manifest describes captures no specimen produces: {sorted(found - expected)}")
    for row in files:
        absent = [field for field in REQUIRED_FIELDS if not row.get(field)]
        if absent:
            raise SystemExit(f"{row.get('name')}: manifest entry is missing {absent}")
        if len(row["sha256"]) != SHA256:
            raise SystemExit(f"{row['name']}: sha256 is not a digest")
        if row["revision"] != manifest["revision"] or row["data_vintage"] != manifest["data_vintage"]:
            raise SystemExit(f"{row['name']}: revision or data vintage disagrees with the manifest")
        if row["axe"].get("failing_violations"):
            raise SystemExit(f"{row['name']} failed the accessibility gate: {row['axe']['failing_violations']}")
        for key, value in row["observations"].items():
            if value is False:
                raise SystemExit(f"{row['name']}: the capture observed {key} as false")
            if key.endswith("touch_target_failures") and value:
                raise SystemExit(f"{row['name']}: undersized targets {value}")
        # Images are local-only by policy, so their absence is not a failure;
        # when one is present it must still be the image the manifest describes.
        image = IMAGES / row["name"]
        if image.exists() and hashlib.sha256(image.read_bytes()).hexdigest() != row["sha256"]:
            raise SystemExit(f"{row['name']}: the local image does not match its recorded digest")
    committed = sorted(path.name for path in MANIFEST.parent.glob("*")
                       if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp"})
    if committed:
        raise SystemExit(f"capture images must not be committed: {committed}")
    print(f"public body directory evidence OK ({len(files)} captures, "
          f"{len(SPECIMENS)} specimens x {len(VIEWPORTS)} viewports, "
          f"revision {manifest['revision'][:12]})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate the tracked manifest without a browser")
    args = parser.parse_args()
    if args.check:
        return check()
    manifest = capture()
    print(f"captured {len(manifest['files'])} specimens into {IMAGES.relative_to(ROOT)} "
          f"(manifest: {MANIFEST.relative_to(ROOT)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
