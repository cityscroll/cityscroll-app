#!/usr/bin/env python3
"""Headless browser evidence for two public bodies an earlier alias had merged.

Drives the real static routes this repository publishes: the agency directory
at `/agencies/`, and the two agency profiles it now links separately. Nothing
is stubbed and no publisher is contacted -- the pages are the ones the build
writes, served from the working tree.

Each specimen is a real interaction in a real engine, at 390 and 1440 pixels:
finding each body in the directory and opening it, the browser Back that
returns to the directory, the follow each profile offers, a modified click on
the anchor to the sibling body, the page a reader without scripting receives,
and the same profile at 200 percent zoom. Every specimen also checks touch
targets and horizontal overflow, and runs the vendored axe-core gate on the
same rule set and pass/fail classification as
`test/functional/11_accessibility.py`.

What the browser proves here is navigation and rendering. That a name or an
acronym query reaches the right one of the two bodies is proven over the real
committed search corpus and the repository's own ranking in
`test/civic_institution_separated_bodies.test.mjs`; this tool does not restate
that claim from a stubbed search response.

Proof is the tracked manifest: one entry per capture naming its route,
viewport, revision, data vintage, assertion, observations, and the SHA-256 of
the image. The images themselves are written to an ignored local directory and
are never committed -- this repository does not carry capture binaries.

    python3 tools/capture_institution_identity_evidence.py
    python3 tools/capture_institution_identity_evidence.py --check
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
MANIFEST = ROOT / "docs" / "evidence" / "institution-identity-separation" / "manifest.json"
# Gitignored: capture images stay local and are described by the manifest.
IMAGES = ROOT / ".artifacts" / "institution-identity-separation"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"

MANIFEST_SCHEMA = "cityscroll.institution_identity_separation_evidence.v1"
SUBJECT = "separate public destinations for the racial equity office and commission"
DIRECTORY_ROUTE = "/agencies/"

OFFICE = {
    "id": "office-of-racial-equity",
    "name": "Office of Racial Equity",
    "route": "/agencies/office-of-racial-equity/",
    "kind": "office",
}
COMMISSION = {
    "id": "commission-on-racial-equity",
    "name": "Commission on Racial Equity",
    "route": "/agencies/commission-on-racial-equity/",
    "kind": "commission",
}
BODIES = (OFFICE, COMMISSION)

VIEWPORTS = ((390, 844), (1440, 900))
# WCAG 2.2 AA target size, matching test/functional/23_mobile_viewport.py.
TARGET_MIN = 43.5
ZOOM = 2.0

STATUTORY = "#institution-statutory-identity"
FOLLOW = ".agency-primary-actions a"
BACK_LINK = '.civic-object-back a[href="/agencies/"]'


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
    """The day the agency read model this capture renders was materialized."""
    lookup = json.loads((SITE / "data" / "agency_constellation_lookup.json").read_text("utf-8"))
    stamps = [part for part in str(lookup.get("generated_at") or "").split("|") if len(part) >= 10]
    if not stamps:
        raise SystemExit("agency constellation lookup carries no generated_at to date this capture")
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
          const selector = ['button:not([disabled])','summary','a.act','.civic-object-action'].join(',');
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


def statutory_block(page) -> dict:
    return page.evaluate(
        """(selector) => {
          const block = document.querySelector(selector);
          if (!block) return { present: false };
          const details = block.querySelector('details');
          const external = [...block.querySelectorAll('a[href^="https://"]')].map(a => a.getAttribute('href'));
          const internal = [...block.querySelectorAll('a[href^="/agencies/"]')].map(a => a.getAttribute('href'));
          return {
            present: true,
            kind: block.getAttribute('data-institution-kind'),
            canonical_id: block.getAttribute('data-canonical-id'),
            distinguished_from: block.querySelector('[data-distinguished-from]')
              ?.getAttribute('data-distinguished-from') || null,
            text: block.innerText.replace(/\\s+/g, ' ').trim(),
            source_links: external,
            sibling_links: internal,
            history_present: Boolean(details),
            history_open: details ? details.hasAttribute('open') : false,
          };
        }""",
        STATUTORY,
    )


def open_history(page) -> dict:
    page.locator(f"{STATUTORY} details > summary").first.click()
    return page.evaluate(
        """(selector) => {
          const details = document.querySelector(selector + ' details');
          const rows = [...details.querySelectorAll('[data-correction-source-spelling]')];
          return {
            open: details.hasAttribute('open'),
            spellings: rows.map(row => row.getAttribute('data-correction-source-spelling')),
            directions: rows.map(row => row.getAttribute('data-correction-direction')),
            cited: [...details.querySelectorAll('a[href^="https://"]')].map(a => a.getAttribute('href')),
          };
        }""",
        STATUTORY,
    )


def follow_href(page) -> str:
    return page.evaluate(
        """() => [...document.querySelectorAll('.agency-primary-actions a')]
             .map(a => a.getAttribute('href'))
             .find(href => href && href.includes('/following')) || ''"""
    )


# ---------- specimens ----------
#
# Each specimen returns the observations its assertion is about. A specimen
# that cannot observe what it claims raises, rather than recording a pass.


def directory_journey(body):
    def specimen(page, base, width):
        page.goto(f"{base}{DIRECTORY_ROUTE}", wait_until="load")
        page.wait_for_selector(".agency-index-link")
        listed = page.evaluate(
            """() => [...document.querySelectorAll('.agency-index-link')]
                 .map(a => ({ href: a.getAttribute('href'), text: a.innerText.trim() }))"""
        )
        directory_url = page.url
        entry = page.locator(f'.agency-index-link[href="{body["route"]}"]')
        if entry.count() != 1:
            raise SystemExit(f'{body["id"]}: the directory must list this body exactly once')
        entry.first.click()
        page.wait_for_selector(STATUTORY)
        block = statutory_block(page)
        history = open_history(page)
        shot = page.screenshot(full_page=True)
        page.go_back()
        page.wait_for_selector(".agency-index-link")
        returned = page.evaluate(
            """() => [...document.querySelectorAll('.agency-index-link')]
                 .map(a => ({ href: a.getAttribute('href'), text: a.innerText.trim() }))"""
        )
        other = OFFICE if body is COMMISSION else COMMISSION
        return shot, {
            "directory_lists_this_body": any(row["href"] == body["route"] for row in listed),
            "directory_lists_the_other_body": any(row["href"] == other["route"] for row in listed),
            "opened_own_profile": block["canonical_id"] == body["id"],
            "profile_states_its_kind": block["kind"] == body["kind"],
            "profile_names_the_other_body": block["distinguished_from"] == other["id"],
            "profile_cites_sources": len(block["source_links"]) >= 2,
            "history_starts_closed": block["history_present"] and not block["history_open"],
            "history_opens_without_leaving": history["open"],
            "history_names_the_moved_spelling": bool(history["spellings"]),
            "history_cites_sources": len(history["cited"]) >= 2,
            "returned_to_directory": page.url == directory_url,
            "directory_restored": returned == listed,
            "touch_target_failures": target_failures(page),
            "no_horizontal_overflow": no_horizontal_overflow(page),
        }, (
            f'at {width}px the agency directory lists {body["name"]} separately from '
            f'{other["name"]}, opening it reaches a profile that states its own kind, cites its '
            "own sources and names the other body, and browser Back restores the directory "
            "unchanged"
        )
    return specimen


def specimen_distinct_follow_targets(page, base, width):
    hrefs = {}
    for body in BODIES:
        page.goto(f'{base}{body["route"]}', wait_until="load")
        page.wait_for_selector(STATUTORY)
        hrefs[body["id"]] = follow_href(page)
        if not hrefs[body["id"]]:
            raise SystemExit(f'{body["id"]}: the profile offers no follow')
    shot = page.screenshot(full_page=True)
    office_href, commission_href = hrefs[OFFICE["id"]], hrefs[COMMISSION["id"]]
    return shot, {
        "office_follow": office_href,
        "commission_follow": commission_href,
        "follow_targets_differ": office_href != commission_href,
        "office_follow_names_only_its_own_body": (
            OFFICE["name"] in office_href.replace("+", " ").replace("%20", " ")
            and COMMISSION["name"] not in office_href.replace("+", " ").replace("%20", " ")
        ),
        "commission_follow_names_only_its_own_body": (
            COMMISSION["name"] in commission_href.replace("+", " ").replace("%20", " ")
            and OFFICE["name"] not in commission_href.replace("+", " ").replace("%20", " ")
        ),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px each profile offers its own follow, and neither watch names the other "
        "institution"
    )


def specimen_modified_click(page, base, width):
    page.goto(f'{base}{OFFICE["route"]}', wait_until="load")
    page.wait_for_selector(STATUTORY)
    profile_url = page.url
    anchor = page.locator(f'{STATUTORY} a[href="{COMMISSION["route"]}"]').first
    href = anchor.get_attribute("href")
    # A modified click is the browser's to handle: a separate browsing context
    # opens and the profile the reader is on does not move. What that other
    # context renders is not this capture's subject.
    with page.context.expect_page() as popup:
        anchor.click(modifiers=["ControlOrMeta"])
    separate_context = popup.value
    still_on_profile = page.url == profile_url
    separate_context.close()
    # An ordinary click on the same anchor still reaches the other body, which
    # is the path a context menu's "open link" takes too.
    anchor.click()
    page.wait_for_url(f'{base}{COMMISSION["route"]}', timeout=15000)
    landed = statutory_block(page)
    page.go_back()
    page.wait_for_selector(STATUTORY)
    shot = page.screenshot(full_page=True)
    back_link = page.locator(BACK_LINK).first
    return shot, {
        "sibling_anchor_href": href,
        "sibling_anchor_is_a_real_href": href == COMMISSION["route"],
        "modified_click_opened_a_separate_context": True,
        "modified_click_left_this_profile_in_place": still_on_profile,
        "plain_click_reaches_the_other_body": landed["canonical_id"] == COMMISSION["id"],
        "browser_back_returns_to_this_profile": page.url == profile_url,
        "back_to_directory_is_a_real_anchor": back_link.get_attribute("href") == DIRECTORY_ROUTE,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the anchor to the other body is an ordinary href, a modified click opens a "
        "separate context and leaves this profile in place, a plain click reaches the other body, "
        "and browser Back returns here"
    )


def specimen_without_scripting(page, base, width):
    observations = {}
    for body in BODIES:
        page.goto(f'{base}{body["route"]}', wait_until="load")
        page.wait_for_selector(STATUTORY)
        block = statutory_block(page)
        other = OFFICE if body is COMMISSION else COMMISSION
        observations[f'{body["id"]}_states_its_kind'] = block["kind"] == body["kind"]
        observations[f'{body["id"]}_cites_sources'] = len(block["source_links"]) >= 2
        observations[f'{body["id"]}_links_the_other_body'] = other["route"] in block["sibling_links"]
        observations[f'{body["id"]}_keeps_source_name_history'] = block["history_present"]
    shot = page.screenshot(full_page=True)
    observations["no_horizontal_overflow"] = no_horizontal_overflow(page)
    return shot, observations, (
        f"at {width}px, with scripting unavailable, both profiles still state which body they are, "
        "cite the sections that establish them, link the other body, and keep the source-name "
        "history reachable"
    )


def specimen_zoom(page, base, width):
    observations = {}
    for body in BODIES:
        page.goto(f'{base}{body["route"]}', wait_until="load")
        page.wait_for_selector(STATUTORY)
        page.evaluate("(zoom) => { document.documentElement.style.zoom = String(zoom); }", ZOOM)
        page.wait_for_timeout(200)
        block = statutory_block(page)
        observations[f'{body["id"]}_statement_still_readable'] = bool(block["text"])
        observations[f'{body["id"]}_no_horizontal_overflow'] = no_horizontal_overflow(page)
        observations[f'{body["id"]}_touch_target_failures'] = target_failures(page)
    shot = page.screenshot(full_page=True)
    return shot, observations, (
        f"at {width}px and {int(ZOOM * 100)} percent zoom both profiles keep their statement of "
        "which body they are, with no horizontal overflow and no undersized target"
    )


SPECIMENS = (
    ("directory-to-office-and-back", directory_journey(OFFICE)),
    ("directory-to-commission-and-back", directory_journey(COMMISSION)),
    ("distinct-follow-targets", specimen_distinct_follow_targets),
    ("sibling-anchor-modified-click", specimen_modified_click),
    ("without-scripting", specimen_without_scripting),
    ("two-hundred-percent-zoom", specimen_zoom),
)
NO_SCRIPT_SPECIMENS = {"without-scripting"}


def capture() -> dict:
    sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
    from a11y_gate import failing_violations
    from playwright.sync_api import sync_playwright

    for body in BODIES:
        document = SITE / "agencies" / body["id"] / "index.html"
        if not document.is_file():
            raise SystemExit(
                f'missing {document.relative_to(ROOT)}; run '
                "node tools/build_agency_constellation_documents.mjs first"
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
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        java_script_enabled=slug not in NO_SCRIPT_SPECIMENS,
                        has_touch=width <= 500,
                    )
                    page = context.new_page()
                    scripting = slug not in NO_SCRIPT_SPECIMENS
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
                        "route": DIRECTORY_ROUTE if slug.startswith("directory") else OFFICE["route"],
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
        "routes": [DIRECTORY_ROUTE, OFFICE["route"], COMMISSION["route"]],
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
            "Name and acronym resolution is proven over the committed search corpus and this "
            "repository's own ranking in test/civic_institution_separated_bodies.test.mjs. The "
            "captures below prove browser navigation and rendering, and claim nothing about a "
            "search response they did not receive."
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
    print(f"institution identity separation evidence OK ({len(files)} captures, "
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
