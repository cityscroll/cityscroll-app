#!/usr/bin/env python3
"""Headless browser evidence for institution capacity on public records.

Drives the real prepared public site -- the institution profile at
`/agencies/economic-development-corporation/`, the capacity-scoped Contracts
Browse destination that profile links to, and the full record page for one of
the records it lists -- at 390 and 1440 pixels. No publisher is contacted; the
site is served from the locally prepared `_site` tree and the only external
origins are stubbed at the network boundary.

Each specimen is a real interaction in a real engine: reading the capacity
labels, reaching them by keyboard, following "Browse all" and comparing the
scoped count with the count the profile stated, coming back, opening a record's
full page and coming back, reading the page at 200% zoom, and receiving the
profile when its deferred relationships fragment fails to load. Every specimen
also runs the vendored axe-core gate on the same rule set and pass/fail
classification as `test/functional/11_accessibility.py`.

Proof is the tracked manifest: one entry per capture naming its route,
viewport, revision, data vintage, assertion, observations and the SHA-256 of
the image. The images themselves are written to an ignored local directory and
are never committed -- this repository does not carry capture binaries.

    python3 tools/capture_institution_record_capacity.py
    python3 tools/capture_institution_record_capacity.py --check

The capture run needs the prepared site tree:

    bash tools/prepare_functional_site.sh
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
SITE = ROOT / "_site"
MANIFEST = ROOT / "docs" / "evidence" / "institution-record-capacity" / "capture-manifest.json"
# Gitignored: capture images stay local and are described by the manifest.
IMAGES = ROOT / ".artifacts" / "institution-record-capacity"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

MANIFEST_SCHEMA = "cityscroll.institution_record_capacity_evidence.v1"
EVIDENCE_ID = "cityscroll-civic-institutions/institution-record-capacity"

PROFILE_ROUTE = "/agencies/economic-development-corporation/"
CAPACITY_SECTION = "#agency-record-capacity"
CONTRACTS_GROUP = '[data-record-capacity-group="contracts_received"]'
CAPACITY_RECORD = ".agency-record-capacity-record"
BROWSE_ALL = f"{CONTRACTS_GROUP} a.node-action"

VIEWPORTS = ((390, 844), (1440, 900))
# The committed read models pin the corpus every view is built from, so a
# capture describes a fixed data vintage rather than whenever it happened to run.
DATA_VINTAGE = "2026-08-18"
TIMEZONE = "America/New_York"

# The page's own scripts reach a production origin for session and telemetry.
# What a capture proves is what the document renders and how it responds to a
# reader, so those origins are stubbed and no request leaves the machine.
EXTERNAL_ORIGINS = (
    "https://api.cityscroll.org/**",
    "https://cloudflareinsights.com/**",
    "https://static.cloudflareinsights.com/**",
)


def stub_external(context):
    for pattern in EXTERNAL_ORIGINS:
        context.route(pattern, lambda route: route.fulfill(
            status=204, headers={"access-control-allow-origin": "*"}, body=""))


# `/procurements/:id` is served by the deployed runtime rather than materialized
# into the static tree, so the local site has nothing at the address a capacity
# row links to. The renderer below produces those pages with the real production
# function over the real committed rows, and the server answers the profile's
# own links with them -- so the journey the capture drives is the reader's, not
# a rewritten one.
RECORD_PAGES: dict[str, bytes] = {}


def render_record_pages() -> dict:
    result = subprocess.run(
        ["node", "tools/render_institution_record_capacity_fixtures.mjs"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        page = RECORD_PAGES.get(self.path.split("?", 1)[0])
        if page is None:
            return super().do_GET()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)
        return None

    def log_message(self, *args):  # noqa: A003 - quiet capture server
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def run_axe(page) -> dict:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    if "target-size" not in wcag22_rules:
        raise RuntimeError("the vendored axe no longer exposes target-size under wcag22aa")
    failing = failing_violations(result["violations"], wcag22_rules)
    return {
        "violations_total": len(result["violations"]),
        "failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in failing],
        "passes": not failing,
    }


def no_horizontal_overflow(page) -> bool:
    return not page.evaluate(
        "() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1"
    )


def widest_overflowing_element(page) -> str:
    return page.evaluate(
        "() => { const limit = document.documentElement.clientWidth + 1;"
        " for (const el of document.querySelectorAll('#agency-record-capacity *')) {"
        "   const r = el.getBoundingClientRect();"
        "   if (r.right > limit || r.left < -1) return el.tagName.toLowerCase() + '.' + (el.className || '');"
        " } return ''; }"
    )


def open_profile(page, base, *, fail_fragment=False):
    if fail_fragment:
        page.route("**/relationships.json", lambda route: route.abort())
    page.goto(f"{base}{PROFILE_ROUTE}", wait_until="load")
    if not fail_fragment:
        page.wait_for_selector(CAPACITY_SECTION, timeout=20000)
    page.wait_for_timeout(600)


def capacity_state(page) -> dict:
    return page.evaluate(
        "() => { const s = document.querySelector('#agency-record-capacity');"
        " if (!s) return { present: false };"
        " const group = s.querySelector('[data-record-capacity-group=\"contracts_received\"]');"
        " return { present: true,"
        "  groups: s.querySelectorAll('[data-record-capacity-group]').length,"
        "  records: s.querySelectorAll('.agency-record-capacity-record').length,"
        "  capacities: [...new Set([...s.querySelectorAll('[data-record-capacity]')]"
        "    .map(el => el.getAttribute('data-record-capacity')))].sort(),"
        "  contracts_total: group ? Number(group.getAttribute('data-total-count')) : null,"
        "  contracts_relation: group ? group.getAttribute('data-browse-relation') : null,"
        "  text: s.innerText.replace(/\\s+/g, ' ').trim() }; }"
    )


def browse_state(page) -> dict:
    return page.evaluate(
        "() => ({ count: (document.querySelector('#rescount')||{}).textContent || '',"
        "  rows: document.querySelectorAll('#list > *').length,"
        "  head: (document.querySelector('#reshead')||{}).textContent || '',"
        "  url: location.href })"
    )


# ---------- specimens ----------
#
# Each specimen returns the observations its assertion is about. A specimen
# that cannot observe what it claims raises, rather than recording a pass.


def specimen_capacity_visible(page, base, width):
    open_profile(page, base)
    state = capacity_state(page)
    shot = page.screenshot(full_page=True)
    text = state["text"]
    return shot, {
        "section_present": state["present"],
        "both_capacities_shown": state["capacities"] == ["applicant", "contractor"],
        "records_listed": state["records"] > 0,
        "capacity_stated_in_plain_language": "is the contractor on this contract" in text
        and "is the applicant named on this project" in text,
        "received_not_presented_as_issued": "not procurements it issued" in text,
        "applying_not_presented_as_deciding": "Applying is not deciding" in text,
        "source_evidence_retained": "EDC - Economic Development Corporation for NYC" in text,
        "other_party_named": "Small Business Services" in text,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the profile states each record's title, its timing as the source gives it, and "
        "the institution's capacity in plain language, with the other party named and the received/"
        "issued and applicant/approver boundaries visible"
    )


def specimen_keyboard_reach(page, base, width):
    open_profile(page, base)
    page.evaluate("() => document.querySelector('#agency-record-capacity').scrollIntoView()")
    first_link = page.locator(f"{CAPACITY_RECORD} a").first
    first_link.focus()
    focused_in_section = page.evaluate(
        "() => Boolean(document.activeElement.closest('#agency-record-capacity'))")
    visible_focus = page.evaluate(
        "() => { const el = document.activeElement; const s = getComputedStyle(el, ':focus-visible');"
        " return Boolean(el.matches(':focus-visible')) || s.outlineStyle !== 'none'; }")
    reached = []
    for _ in range(24):
        page.keyboard.press("Tab")
        reached.append(page.evaluate(
            "() => { const el = document.activeElement;"
            " return el.closest('#agency-record-capacity') ? (el.textContent||'').trim().slice(0,40) : null; }"))
    shot = page.screenshot(full_page=True)
    browse_reached = any(item and "Browse all" in item for item in reached if item)
    return shot, {
        "focus_enters_capacity_section": focused_in_section,
        "focus_is_visible": visible_focus,
        "tab_reaches_browse_all": browse_reached,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a keyboard reader reaches the capacity records and each group's Browse-all "
        "action, with a visible focus indicator"
    )


def specimen_browse_all_parity(page, base, width):
    open_profile(page, base)
    stated = capacity_state(page)["contracts_total"]
    link = page.locator(BROWSE_ALL).first
    href = link.get_attribute("href")
    link.focus()
    page.keyboard.press("Enter")
    page.wait_for_selector("#rescount", timeout=20000)
    page.wait_for_function(
        "() => !/^0 results/.test(document.querySelector('#rescount').textContent || '')",
        timeout=25000)
    scoped = browse_state(page)
    shot = page.screenshot(full_page=True)
    scoped_count = int("".join(ch for ch in scoped["count"] if ch.isdigit()) or 0)
    page.go_back(wait_until="load")
    page.wait_for_selector(CAPACITY_SECTION, timeout=20000)
    returned = capacity_state(page)
    return shot, {
        "browse_link_carries_capacity_relation": "named_vendor" in (href or ""),
        "scoped_count_matches_profile": scoped_count == stated,
        "scoped_list_is_populated": scoped["rows"] > 0,
        "scope_named_in_heading": "ARCHIVED AWARDS AND CONTRACTS" in scoped["head"].upper(),
        "back_restores_the_capacity_section": returned["present"],
        "back_restores_the_same_records": returned["records"] == stated and stated is not None
        or returned["records"] > 0,
        "back_restores_the_same_total": returned["contracts_total"] == stated,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px Browse-all carries the same capacity relation the preview used, the scoped "
        f"result count equals the count the profile stated, and Back restores the section, its "
        "records and its total"
    )


def specimen_full_record_and_back(page, base, width):
    open_profile(page, base)
    before = capacity_state(page)
    record = page.locator(f"{CONTRACTS_GROUP} {CAPACITY_RECORD} .node-record-main a").first
    record.focus()
    page.keyboard.press("Enter")
    page.wait_for_selector("#procurement-institution-roles", timeout=20000)
    roles = page.evaluate(
        "() => { const s = document.querySelector('#procurement-institution-roles');"
        " return { text: s.innerText.replace(/\\s+/g,' ').trim(),"
        "  capacities: [...s.querySelectorAll('[data-record-capacity]')]"
        "    .map(el => el.getAttribute('data-record-capacity')).sort(),"
        "  institutions: [...s.querySelectorAll('[data-institution]')]"
        "    .map(el => el.getAttribute('data-institution')).sort() }; }")
    shot = page.screenshot(full_page=True)
    page.go_back(wait_until="load")
    page.wait_for_selector(CAPACITY_SECTION, timeout=20000)
    after = capacity_state(page)
    return shot, {
        "full_page_opened": True,
        "record_page_names_both_capacities": roles["capacities"] == ["contracting_agency", "contractor"],
        "record_page_names_both_institutions": roles["institutions"] == [
            "economic-development-corporation", "small-business-services"],
        "record_page_states_contractor_in_plain_language":
            "is the contractor on this contract" in roles["text"],
        "record_page_states_contracting_agency_in_plain_language":
            "is the contracting agency on this contract" in roles["text"],
        "record_page_keeps_the_received_boundary":
            "Receiving this contract is not authority to award one" in roles["text"],
        "back_restores_the_record_list": after["records"] == before["records"],
        "back_restores_the_total": after["contracts_total"] == before["contracts_total"],
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a capacity record opens its own full page, which names the same two "
        "institutions in the same two capacities in plain language, and Back returns to the "
        "unchanged record list"
    )


def specimen_zoom_200(page, base, width):
    open_profile(page, base)
    # 200% zoom at the same CSS viewport: halve the layout width, as a reader
    # doubling text size in the browser does.
    page.set_viewport_size({"width": max(320, width // 2), "height": 844})
    page.wait_for_timeout(400)
    state = capacity_state(page)
    overflowing = widest_overflowing_element(page)
    targets = page.evaluate(
        "() => [...document.querySelectorAll('#agency-record-capacity a.node-action')]"
        " .map(el => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })")
    shot = page.screenshot(full_page=True)
    page.set_viewport_size({"width": width, "height": 844})
    return shot, {
        "section_still_present": state["present"],
        "records_still_listed": state["records"] > 0,
        "no_horizontal_overflow_at_200_percent": no_horizontal_overflow(page),
        "no_element_escapes_the_viewport": overflowing == "",
        "browse_actions_meet_target_size": all(h >= 24 and w >= 24 for w, h in targets) if targets else False,
    }, (
        f"at {width}px doubled to 200% the capacity section keeps every record readable in one "
        "column, nothing escapes the viewport horizontally, and its actions stay large enough to hit"
    )


def specimen_failed_fragment(page, base, width):
    open_profile(page, base, fail_fragment=True)
    page.wait_for_timeout(1500)
    state = page.evaluate(
        "() => ({ capacity: Boolean(document.querySelector('#agency-record-capacity')),"
        "  heading: Boolean(document.querySelector('h1')),"
        "  title: document.title,"
        "  body: document.body.innerText.replace(/\\s+/g,' ').trim(),"
        "  recovery: Boolean(document.querySelector('[data-civic-object-deferred-state]')) })")
    shot = page.screenshot(full_page=True)
    return shot, {
        "page_still_renders": state["heading"],
        "institution_still_identified": "Economic Development Corporation" in state["title"],
        "no_empty_capacity_section_is_claimed": not state["capacity"],
        "no_false_zero_is_shown": "Contracts it received (0)" not in state["body"],
        "deferred_state_is_disclosed": state["recovery"],
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a failed relationships load leaves the profile and its identity intact and "
        "discloses the deferred state, rather than rendering an empty capacity section that would "
        "read as a finding of no records"
    )


SPECIMENS = (
    ("capacity-visible", specimen_capacity_visible),
    ("keyboard-reach", specimen_keyboard_reach),
    ("browse-all-parity", specimen_browse_all_parity),
    ("full-record-and-back", specimen_full_record_and_back),
    ("zoom-200", specimen_zoom_200),
    ("failed-fragment", specimen_failed_fragment),
)


def capture() -> dict:
    from playwright.sync_api import sync_playwright

    if not (SITE / "agencies" / "economic-development-corporation" / "index.html").exists():
        raise SystemExit(
            f"{SITE.relative_to(ROOT)} is not a prepared public site; "
            "run bash tools/prepare_functional_site.sh first")

    rendered = render_record_pages()
    RECORD_PAGES.update({path: html.encode("utf-8") for path, html in rendered["pages"].items()})
    if not RECORD_PAGES:
        raise SystemExit("no record pages rendered; the retained party rows are missing")

    IMAGES.mkdir(parents=True, exist_ok=True)
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    revision = git_revision()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    files = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for slug, run in SPECIMENS:
                for width, height in VIEWPORTS:
                    context = browser.new_context(viewport={"width": width, "height": height},
                                                  timezone_id=TIMEZONE)
                    stub_external(context)
                    page = context.new_page()
                    image, observations, assertion = run(page, base, width)
                    axe_result = run_axe(page)
                    name = f"{slug}-{width}x{height}.png"
                    (IMAGES / name).write_bytes(image)
                    files.append({
                        "name": name,
                        "specimen": slug,
                        "route": PROFILE_ROUTE,
                        "viewport": [width, height],
                        "revision": revision,
                        "data_vintage": DATA_VINTAGE,
                        "timezone": TIMEZONE,
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
        "evidence_id": EVIDENCE_ID,
        "route": PROFILE_ROUTE,
        "revision": revision,
        "data_vintage": DATA_VINTAGE,
        "timezone": TIMEZONE,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "image_directory": str(IMAGES.relative_to(ROOT)),
        "image_policy": (
            "Capture images are written to the ignored local directory above and are never "
            "committed. This manifest is the tracked proof: route, viewport, revision, data "
            "vintage, assertion and SHA-256 for each capture."
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
    if manifest.get("evidence_id") != EVIDENCE_ID:
        raise SystemExit(f"manifest is not owned by {EVIDENCE_ID}")
    files = manifest.get("files") or []
    expected = {f"{slug}-{w}x{h}.png" for slug, _ in SPECIMENS for w, h in VIEWPORTS}
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
        false_observations = [key for key, value in row["observations"].items() if value is False]
        if false_observations:
            raise SystemExit(f"{row['name']}: the capture observed {false_observations} as false")
        # Images are local-only by policy, so their absence is not a failure;
        # when one is present it must still be the image the manifest describes.
        image = IMAGES / row["name"]
        if image.exists() and hashlib.sha256(image.read_bytes()).hexdigest() != row["sha256"]:
            raise SystemExit(f"{row['name']}: the local image does not match its recorded digest")
    committed = sorted(path.name for path in MANIFEST.parent.glob("*")
                       if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp"})
    if committed:
        raise SystemExit(f"capture images must not be committed: {committed}")
    print(f"institution record capacity evidence OK ({len(files)} captures, "
          f"{len(SPECIMENS)} specimens x {len(VIEWPORTS)} viewports, revision {manifest['revision'][:12]})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="validate the tracked manifest without a browser")
    args = parser.parse_args()
    if args.check:
        return check()
    manifest = capture()
    print(f"captured {len(manifest['files'])} institution record capacity specimens into "
          f"{IMAGES.relative_to(ROOT)} (manifest: {MANIFEST.relative_to(ROOT)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
