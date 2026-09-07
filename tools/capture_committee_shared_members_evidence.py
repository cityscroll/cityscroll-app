#!/usr/bin/env python3
"""Headless read-back of the committee shared-membership section, as served.

The pages under test are the edge request handler's own responses, rendered by
tools/render_committee_shared_members_fixtures.mjs and served from disk at the
routes they answer, so a link between two committee records is a real
navigation rather than a simulated one. The Pages edge worker, not the static
server, produces `/committees/:id/` in production; every entry names what served
it.

What is read back:

  positive        /committees/5309/ names the other committees its members sit
                  on, each expandable to the distinct people, their roles and
                  the days both memberships cover
  reciprocal      /committees/5106/ reports the same connection back
  negatives       a committee whose roster is entirely historical at this
                  vintage, a caucus, and a graph asset that cannot be read
  the walk        committee -> shared people -> another committee -> Back, and
                  committee -> shared person -> official record -> Back
  no JavaScript   the section and its expansion both work with scripting off

Every page is checked at a desktop and a narrow viewport, for keyboard
reachability of the links a reader can see, for native link behaviour (an href
the browser owns and no new-tab target, so a modified click and the back button
keep working), and with the vendored axe-core rule set.

No image binary is committed. Screenshots are written under an ignored path for
local inspection; the receipt is the manifest, and each entry carries the route,
the viewport, the repository revision, the source blobs, the data vintage, the
assertion and the sha256 of the rendered scope.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".artifacts" / "committee-shared-members"
FIXTURES = OUT / "fixtures"
SITE = ROOT / "_site"
MANIFEST = ROOT / "docs" / "evidence" / "committee-shared-membership" / "capture-manifest.json"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

DESKTOP = {"name": "desktop", "width": 1440, "height": 900}
NARROW = {"name": "narrow", "width": 390, "height": 844}

LANDMARKS = "5309"
PARKS = "5106"
FINANCE = "11"
PUBLIC_SAFETY = "19"
GENERAL_WELFARE = "12"
PROGRESSIVE_CAUCUS = "5285"
MARTE = "7801"

SECTION = "#committee-shared-membership"
DOCUMENT_SCOPE = "main.committee-document"
ROSTER = 'section[aria-labelledby="committee-members"]'
SOURCES = [
    "site/committee_coservice.mjs",
    "site/committee_document.mjs",
    "site/civic-documents.css",
]
SERVED_BY = ("site/pages_edge.mjs responses rendered by "
             "tools/render_committee_shared_members_fixtures.mjs, answered over the built site")


class OverlayHandler(SimpleHTTPRequestHandler):
    """Serve the rendered routes first, then the built site's own assets."""

    def translate_path(self, path):
        relative = Path(super().translate_path(path)).relative_to(Path.cwd())
        fixture = FIXTURES / relative
        if fixture.is_dir():
            fixture = fixture / "index.html"
        return str(fixture if fixture.is_file() else SITE / relative)

    def log_message(self, fmt, *args):  # noqa: A003
        return


def serve():
    server = ThreadingHTTPServer(("127.0.0.1", 0), OverlayHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def git(*args) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True,
                          check=True).stdout.strip()


def base_revision() -> str:
    """The commit this branch answers from.

    A manifest committed alongside the change cannot name its own commit, so the
    revision recorded here is the base the branch was cut from. Exactness comes
    from `source_blob` below, which content-addresses every file the captures
    depend on.
    """
    for ref in ("origin/main", "main"):
        result = subprocess.run(["git", "merge-base", "HEAD", ref], cwd=ROOT,
                                capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return git("rev-parse", "HEAD")


def source_blobs() -> dict:
    return {path: git("hash-object", path) for path in SOURCES}


def data_vintage() -> dict:
    """The vintage of the two lookups the section reads.

    The person hub stamps the acquisition (`retrieved_at`), not a publisher
    clock, so that field is read first and `generated_at` is only a fallback for
    an older shape. A null here would mean the artifact carries no vintage at
    all, which is a reason to stop rather than a value to record.
    """
    graph = json.loads((ROOT / "site/data/committee_graph_lookup.json").read_text())
    people = json.loads((ROOT / "site/data/person_hub_lookup.json").read_text())
    people_vintage = people.get("retrieved_at") or people.get("generated_at")
    if not graph.get("generated_at") or not people_vintage:
        raise SystemExit("capture: a source lookup carries no vintage stamp")
    return {
        "committee_graph_generated_at": graph["generated_at"],
        "committee_graph_as_of": str(graph["generated_at"])[:10],
        "person_hub_retrieved_at": people_vintage,
    }


def run_axe(page) -> dict:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22 = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    gate = failing_violations(result["violations"], wcag22)
    return {"failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in gate],
            "passes": len(gate) == 0}


# A collapsed disclosure's contents are deliberately out of the tab order; what
# matters is that every link a reader can currently see is reachable, and that
# opening a disclosure brings its own links into the order.
KEYBOARD_PROBE = """(selector) => {
  const all = [...document.querySelectorAll(selector)];
  const links = all.filter((link) => link.offsetParent !== null);
  let reachable = 0;
  for (const link of links) {
    link.focus();
    if (document.activeElement === link) reachable += 1;
  }
  return {
    visible: links.length,
    reachable,
    disclosed: all.length - links.length,
    native: all.every((link) => link.tagName === 'A' && (link.getAttribute('href') || '').length > 0),
    new_tab: all.filter((link) => link.hasAttribute('target')).length,
  };
}"""

SECTION_PROBE = """() => {
  const section = document.querySelector('#committee-shared-membership');
  if (!section) return null;
  const wrapper = section.querySelector('[data-committee-shared-membership]');
  return {
    heading: section.querySelector('h2').textContent,
    summary: section.querySelector('.committee-shared-summary').textContent.trim(),
    basis: section.querySelector('.committee-shared-basis').textContent.trim(),
    as_of: wrapper.dataset.sharedAsOf,
    committee_count: Number(wrapper.dataset.sharedCommitteeCount),
    subject_members: Number(wrapper.dataset.sharedSubjectMembers),
    represented_officials: Number(wrapper.dataset.sharedRepresentedOfficials),
    excluded_caucus_bodies: Number(wrapper.dataset.sharedExcludedCaucusBodies),
    rows: [...section.querySelectorAll('.committee-shared-row')].map((row) => ({
      committee_id: row.dataset.sharedCommitteeId,
      shared_members: Number(row.dataset.sharedMemberCount),
      href: row.querySelector('a.committee-shared-committee-link').getAttribute('href'),
    })),
    details_elements: section.querySelectorAll('details').length,
    scripts: section.querySelectorAll('script').length,
    horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
}"""

EXPANSION_PROBE = """(id) => {
  const row = document.getElementById(id);
  if (!row) return null;
  const members = row.querySelector('.committee-shared-members');
  return {
    open: Boolean(members && members.getBoundingClientRect().height > 0),
    count_label: row.querySelector('.committee-shared-count').textContent.trim(),
    people: [...row.querySelectorAll('.committee-shared-member')].map((item) => ({
      href: item.querySelector('a[href^="/officials/"]').getAttribute('href'),
      name: item.querySelector('a[href^="/officials/"]').textContent.replace(/^\\s*◆\\s*/, '').trim(),
      detail: item.querySelector('.committee-shared-member-detail').textContent.trim(),
    })),
  };
}"""

# The committee record gains one heading; the document must still read as one
# outline with a single main landmark and no repeated visible heading.
OUTLINE_PROBE = """() => {
  const headings = [...document.querySelectorAll('main h1, main h2, main h3')]
    .filter((node) => node.offsetParent !== null)
    .map((node) => `${node.tagName}:${node.textContent.trim()}`);
  return {
    headings: headings.length,
    unique_headings: new Set(headings).size,
    h1: document.querySelectorAll('main h1').length,
    main: document.querySelectorAll('main').length,
  };
}"""

SCOPE_HTML = """(selector) => {
  const node = document.querySelector(selector);
  return node ? node.outerHTML : '';
}"""


def digest(page, selector) -> str:
    return hashlib.sha256(page.evaluate(SCOPE_HTML, selector).encode("utf-8")).hexdigest()


def screenshot(page, name) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=True)


class Run:
    def __init__(self, blobs, vintage):
        self.revision = base_revision()
        self.blobs = blobs
        self.vintage = vintage
        self.captures: list[dict] = []
        self.failures: list[str] = []
        self.signals: list[str] = []

    def signal(self, message):
        self.signals.append(message)
        print(f"  signal {message}")

    def check(self, condition, message) -> bool:
        if not condition:
            self.failures.append(message)
        return bool(condition)

    def record(self, *, id, route, route_note, viewport, assertion, holds, observed,
               scope, scope_selector=None, page=None, axe=None, javascript="enabled",
               scope_sha256=None):
        self.captures.append({
            "id": id,
            "route": route,
            "route_note": route_note,
            "viewport": viewport,
            "javascript": javascript,
            "served_by": SERVED_BY,
            "repository_revision": self.revision,
            "source_blob": self.blobs,
            "data_vintage": self.vintage,
            "assertion": assertion,
            "assertion_holds": bool(holds),
            "render_scope": scope,
            "render_sha256": scope_sha256 if scope_sha256
                else (digest(page, scope_selector) if page is not None and scope_selector else None),
            "observed": observed if axe is None else {**observed, "axe": axe},
        })


def open_row(page, committee_id):
    page.click(f'a.committee-shared-open[href="#committee-shared-membership-{committee_id}"]')
    return page.evaluate(EXPANSION_PROBE, f"committee-shared-membership-{committee_id}")


def main() -> int:
    if not FIXTURES.exists():
        print("run tools/render_committee_shared_members_fixtures.mjs first", file=sys.stderr)
        return 1
    fixtures = json.loads((FIXTURES / "manifest.json").read_text())
    expectations = {case["id"]: case.get("expect") for case in fixtures["cases"]}
    run = Run(source_blobs(), data_vintage())
    server, port = serve()
    base = f"http://127.0.0.1:{port}/"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            capture_positive(browser, base, run, expectations["committee-landmarks"])
            capture_walks(browser, base, run, expectations["committee-finance"])
            capture_reciprocal(browser, base, run, expectations["committee-parks"])
            capture_no_javascript(browser, base, run, expectations["committee-landmarks"])
            capture_negatives(browser, base, run)
            browser.close()
    finally:
        server.shutdown()

    for capture in run.captures:
        axe = capture["observed"].get("axe")
        if axe and not axe["passes"]:
            run.failures.append(f"{capture['id']}: axe {axe['failing_violations']}")
        keyboard = capture["observed"].get("keyboard")
        if keyboard:
            if keyboard["visible"] != keyboard["reachable"]:
                run.failures.append(f"{capture['id']}: a visible link is not focusable")
            if not keyboard["native"] or keyboard["new_tab"]:
                run.failures.append(f"{capture['id']}: a section link is not a plain same-tab anchor")

    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps({
        "schema": "cityscroll.render_capture_manifest.v1",
        "surface": "committees linked through shared members, on a committee record",
        "condition": (
            "Served from the repository's own edge-handler responses over the built site directory. "
            "No production traffic is involved and no image binary is committed; each entry carries "
            "the sha256 of the rendered scope it asserts about."
        ),
        "image_binaries_committed": False,
        "signals": run.signals,
        "captures": run.captures,
    }, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {MANIFEST.relative_to(ROOT)} — {len(run.captures)} captures, "
          f"{len(run.failures)} failures, {len(run.signals)} signals")
    for failure in run.failures:
        print(f"  FAIL {failure}")
    return 1 if run.failures else 0


# The committees this section was built to show. The snapshot is a rolling
# publisher window, so each is read back while the record is in it and reported
# as a signal when it leaves, rather than failing the capture.
NAMED_CONNECTIONS = [FINANCE, PUBLIC_SAFETY, PARKS, GENERAL_WELFARE]


def capture_positive(browser, base, run, expect):
    for viewport in (DESKTOP, NARROW):
        page = browser.new_page(viewport={"width": viewport["width"], "height": viewport["height"]})
        page.goto(f"{base}committees/{LANDMARKS}/", wait_until="domcontentloaded")
        section = page.evaluate(SECTION_PROBE)
        keyboard = page.evaluate(KEYBOARD_PROBE, f"{SECTION} a")
        outline = page.evaluate(OUTLINE_PROBE)
        holds = run.check(section is not None, "the subcommittee rendered no connections section")
        holds &= run.check(outline["headings"] == outline["unique_headings"],
                           f"the record repeats a visible heading at {viewport['name']}")
        holds &= run.check(outline["h1"] == 1 and outline["main"] == 1,
                           "the record no longer reads as one document outline")
        if section:
            rows = {row["committee_id"]: row["shared_members"] for row in section["rows"]}
            wanted = {row["committee_id"]: row["shared_member_count"] for row in expect["rows"]}
            holds &= run.check(section["committee_count"] == expect["committee_count"],
                               f"the page shows {section['committee_count']} linked committees, "
                               f"the projection {expect['committee_count']}")
            holds &= run.check(rows == wanted, "the page and the projection disagree about a shared-member count")
            holds &= run.check(section["subject_members"] == expect["subject_member_count"],
                               "the page and the projection disagree about the roster it reads")
            holds &= run.check(PROGRESSIVE_CAUCUS not in rows, "a caucus was listed as a linked committee")
            holds &= run.check(section["excluded_caucus_bodies"] == expect["excluded_caucus_bodies"],
                               "the caucuses these members share were not held out of the count")
            holds &= run.check(section["excluded_caucus_bodies"] > 0,
                               "the control needs at least one shared caucus to hold out")
            holds &= run.check(section["scripts"] == 0, "the section shipped a script")
            holds &= run.check(section["details_elements"] == 0,
                               "the expansion is element state rather than a URL target")
            holds &= run.check(not section["horizontal_overflow"],
                               f"the document scrolls sideways at {viewport['name']}")
        screenshot(page, f"{viewport['name']}-committee-connections")
        run.record(
            id=f"{viewport['name']}-committee-connections",
            route=f"/committees/{LANDMARKS}/",
            route_note=("City Council subcommittee record; the section reads the committee graph and "
                        "people lookup the document already loads."),
            viewport=viewport,
            assertion=("The record names the 22 other committees its own members sit on, gives each the "
                       "count of distinct people behind it, lists no caucus among them, keeps one "
                       "document outline with a single main landmark, and does not scroll sideways."),
            holds=holds,
            observed={"section": section, "keyboard": keyboard, "outline": outline},
            scope=f"outerHTML of {SECTION}",
            scope_selector=SECTION,
            page=page,
            axe=run_axe(page))
        page.close()

    # The expansions themselves, read as a resident opens them.
    page = browser.new_page(viewport={"width": DESKTOP["width"], "height": DESKTOP["height"]})
    page.goto(f"{base}committees/{LANDMARKS}/", wait_until="domcontentloaded")
    observed = {}
    holds = True
    by_id = {row["committee_id"]: row for row in expect["rows"]}
    opened_any = False
    for committee_id in NAMED_CONNECTIONS:
        row = by_id.get(committee_id)
        if row is None:
            run.signal(f"committee {committee_id} is no longer connected on {expect['as_of']}")
            continue
        opened_any = True
        opened = open_row(page, committee_id)
        holds &= run.check(opened["open"], f"committee {committee_id} did not expand in place")
        holds &= run.check(sorted(person["name"] for person in opened["people"]) == row["people"],
                           f"committee {committee_id} expanded to "
                           f"{[person['name'] for person in opened['people']]}, "
                           f"the projection says {row['people']}")
        holds &= run.check(
            all(f"{start} to {end}" in person["detail"]
                for person, (start, end) in zip(opened["people"], row["overlaps"])),
            f"committee {committee_id} lost the days both memberships cover")
        holds &= run.check(all(person["href"].startswith("/officials/") for person in opened["people"]),
                           f"committee {committee_id} linked a person somewhere other than their record")
        observed[committee_id] = opened
    holds &= run.check(opened_any, "no named connection survives in the current window")
    keyboard = page.evaluate(KEYBOARD_PROBE, f"#committee-shared-membership-{GENERAL_WELFARE} a")
    holds &= run.check(keyboard["visible"] == keyboard["reachable"] and keyboard["visible"] > 0,
                       "an opened expansion is not keyboard reachable")
    screenshot(page, "desktop-expansions-open")
    run.record(
        id="desktop-expansions-open",
        route=f"/committees/{LANDMARKS}/#committee-shared-membership-{GENERAL_WELFARE}",
        route_note="The same record with four of its linked committees expanded in place.",
        viewport=DESKTOP,
        assertion=("Each named committee expands in place to exactly the people the projection reports, "
                   "with both roles and the days both memberships cover, each name linking to that "
                   "person's own record, and every revealed link focusable."),
        holds=holds,
        observed={"expansions": observed, "keyboard": keyboard},
        scope=f"outerHTML of {SECTION}",
        scope_selector=SECTION,
        page=page)
    page.close()


def capture_walks(browser, base, run, expect):
    page = browser.new_page(viewport={"width": DESKTOP["width"], "height": DESKTOP["height"]})
    page.goto(f"{base}committees/{LANDMARKS}/", wait_until="domcontentloaded")
    open_row(page, FINANCE)
    page.click(f'a.committee-shared-committee-link[href="/committees/{FINANCE}/"]')
    page.wait_for_url(f"{base}committees/{FINANCE}/")
    arrived = page.evaluate(SECTION_PROBE)
    holds = run.check(arrived is not None and arrived["committee_count"] == expect["committee_count"],
                      "the linked committee does not answer the same question from its own roster")
    page.go_back()
    page.wait_for_url(lambda url: url.startswith(f"{base}committees/{LANDMARKS}/"))
    returned = page.evaluate(EXPANSION_PROBE, f"committee-shared-membership-{FINANCE}")
    holds &= run.check(returned["open"], "the originating expansion was lost on Back")
    holds &= run.check(page.url.endswith(f"#committee-shared-membership-{FINANCE}"),
                       f"the expansion did not survive in the URL, saw {page.url}")
    screenshot(page, "desktop-walk-committee-back")
    run.record(
        id="desktop-walk-committee-back",
        route=f"/committees/{LANDMARKS}/ → /committees/{FINANCE}/ → Back",
        route_note="Both records are published committee routes; the walk uses plain anchors only.",
        viewport=DESKTOP,
        assertion=("Opening a shared-member expansion, following the linked committee, and pressing Back "
                   "returns to the originating record with the same expansion still open, because the "
                   "expansion lives in the URL."),
        holds=holds,
        observed={"destination": arrived, "returned_url_fragment": page.url.split("#")[-1],
                  "expansion": returned},
        scope=f"outerHTML of {SECTION}",
        scope_selector=SECTION,
        page=page)

    page.click(f'#committee-shared-membership-{FINANCE} a[href="/officials/{MARTE}/"]')
    page.wait_for_url(f"{base}officials/{MARTE}/")
    holds = run.check(page.url == f"{base}officials/{MARTE}/", f"the member link went to {page.url}")
    page.go_back()
    page.wait_for_url(lambda url: url.startswith(f"{base}committees/{LANDMARKS}/"))
    returned = page.evaluate(EXPANSION_PROBE, f"committee-shared-membership-{FINANCE}")
    holds &= run.check(returned["open"], "the originating expansion was lost on Back from the member record")
    screenshot(page, "desktop-walk-official-back")
    run.record(
        id="desktop-walk-official-back",
        route=f"/committees/{LANDMARKS}/ → /officials/{MARTE}/ → Back",
        route_note="The member link opens that person's existing published record.",
        viewport=DESKTOP,
        assertion=("Following a shared member to their own record and pressing Back returns to the "
                   "originating committee with the same expansion still open."),
        holds=holds,
        observed={"member_route": f"/officials/{MARTE}/", "expansion": returned},
        scope=f"outerHTML of {SECTION}",
        scope_selector=SECTION,
        page=page)
    page.close()


def capture_reciprocal(browser, base, run, expect):
    page = browser.new_page(viewport={"width": NARROW["width"], "height": NARROW["height"]})
    page.goto(f"{base}committees/{PARKS}/", wait_until="domcontentloaded")
    section = page.evaluate(SECTION_PROBE)
    back = next((row for row in expect["rows"] if row["committee_id"] == LANDMARKS), None)
    holds = run.check(back is not None, "the reciprocal record no longer names the subcommittee")
    if back:
        opened = open_row(page, LANDMARKS)
        holds &= run.check(sorted(person["name"] for person in opened["people"]) == back["people"],
                           f"the reciprocal record named {[p['name'] for p in opened['people']]}, "
                           f"the projection says {back['people']}")
        holds &= run.check(opened["count_label"].startswith(str(back["shared_member_count"])),
                           f"the reciprocal count read {opened['count_label']}")
    else:
        opened = None
    holds &= run.check(not section["horizontal_overflow"], "the reciprocal record scrolls sideways")
    screenshot(page, "narrow-reciprocal-committee")
    run.record(
        id="narrow-reciprocal-committee",
        route=f"/committees/{PARKS}/#committee-shared-membership-{LANDMARKS}",
        route_note="The committee the subcommittee links to, read back from its own record.",
        viewport=NARROW,
        assertion=("The Parks record identifies the same two members, Marte and Nurse, as shared with "
                   "the subcommittee, with the two roles swapped and the same overlapping days."),
        holds=holds,
        observed={"section": section, "expansion": opened},
        scope=f"outerHTML of {SECTION}",
        scope_selector=SECTION,
        page=page,
        axe=run_axe(page))
    page.close()


def capture_no_javascript(browser, base, run, expect):
    context = browser.new_context(java_script_enabled=False,
                                  viewport={"width": NARROW["width"], "height": NARROW["height"]})
    page = context.new_page()
    page.goto(f"{base}committees/{LANDMARKS}/#committee-shared-membership-{FINANCE}",
              wait_until="domcontentloaded")
    open_expansion = page.locator(
        f"#committee-shared-membership-{FINANCE} .committee-shared-members").is_visible()
    listed = page.locator(f"{SECTION} .committee-shared-row").count()
    named = page.locator(f"#committee-shared-membership-{FINANCE} .committee-shared-member").count()
    row = next((entry for entry in expect["rows"] if entry["committee_id"] == FINANCE), None)
    holds = run.check(open_expansion, "the expansion does not open without scripting")
    holds &= run.check(listed == expect["committee_count"],
                       f"{listed} linked committees without scripting, "
                       f"{expect['committee_count']} with it")
    holds &= run.check(row is not None and named == row["shared_member_count"],
                       f"{named} shared members revealed without scripting")
    screenshot(page, "narrow-no-javascript")
    run.record(
        id="narrow-no-javascript",
        route=f"/committees/{LANDMARKS}/#committee-shared-membership-{FINANCE}",
        route_note="The committee record is server-rendered; the expansion is a CSS target, not a script.",
        viewport=NARROW,
        javascript="disabled",
        assertion=("With scripting unavailable the section still lists every linked committee and the "
                   "URL still opens one of them onto its three named people."),
        holds=holds,
        observed={"expansion_open": open_expansion, "linked_committees": listed, "revealed_people": named},
        scope=f"outerHTML of {SECTION}",
        scope_sha256=hashlib.sha256(
            page.locator(SECTION).evaluate("node => node.outerHTML").encode("utf-8")).hexdigest())
    context.close()


NEGATIVES = [
    ("negative-historical-roster", f"/committees/20/",
     "Committee on Rules, Privileges and Elections",
     ("Its recorded roster is entirely historical at this vintage, so the record keeps every recorded "
      "membership period and renders no connections section at all — not an empty one, and not a zero.")),
    ("negative-caucus", f"/committees/{PROGRESSIVE_CAUCUS}/",
     "Caucus - Progressive Caucus",
     ("A caucus reaches the reader through the same office-record family as a committee, and never "
      "lends its roster to a committee connection, so this record renders no connections section.")),
]


def capture_negatives(browser, base, run):
    for capture_id, route, note, assertion in NEGATIVES:
        page = browser.new_page(viewport={"width": DESKTOP["width"], "height": DESKTOP["height"]})
        page.goto(f"{base}{route.lstrip('/')}", wait_until="domcontentloaded")
        section = page.locator(SECTION).count()
        roster = page.locator(ROSTER).count()
        periods = page.locator(f"{ROSTER} .node-record-list > li").count()
        holds = run.check(section == 0, f"{capture_id} rendered a connections section")
        holds &= run.check(roster == 1 and periods > 0, f"{capture_id} lost its existing roster")
        screenshot(page, capture_id)
        run.record(
            id=capture_id,
            route=route,
            route_note=note,
            viewport=DESKTOP,
            assertion=assertion,
            holds=holds,
            observed={"connections_section": section, "roster_members": periods},
            scope=f"outerHTML of {DOCUMENT_SCOPE}",
            scope_selector=DOCUMENT_SCOPE,
            page=page,
            axe=run_axe(page))
        page.close()

    page = browser.new_page(viewport={"width": DESKTOP["width"], "height": DESKTOP["height"]})
    page.goto(f"{base}failed-load/committees/{LANDMARKS}/", wait_until="domcontentloaded")
    section = page.locator(SECTION).count()
    partial = page.locator(".committee-shared-row").count()
    heading = page.locator("h1").inner_text()
    holds = run.check(section == 0 and partial == 0, "a failed graph read painted connection furniture")
    screenshot(page, "negative-failed-load")
    run.record(
        id="negative-failed-load",
        route=f"/committees/{LANDMARKS}/ with the committee graph asset unavailable",
        route_note="The same request with the document's own graph asset answering 503.",
        viewport=DESKTOP,
        assertion=("A committee whose own graph asset cannot be read answers plainly and paints no "
                   "partial connections section."),
        holds=holds,
        observed={"connections_section": section, "partial_rows": partial, "heading": heading},
        scope="outerHTML of main",
        scope_selector="main",
        page=page)
    page.close()


if __name__ == "__main__":
    raise SystemExit(main())
