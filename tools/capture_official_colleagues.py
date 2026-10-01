#!/usr/bin/env python3
"""Capture the served official-profile co-service section, as text.

What a resident needs from this section is a chain: an official's page names
another official, that name opens their page, and the shared committee opens the
committee record. None of that is visible in a screenshot of a list, so this
capture never looks at pixels. It loads the built site from this repository's own
`_site` directory, walks the chain with the keyboard, and records what each stop
actually rendered.

Each entry carries the route, the viewport, the repository revision, the source
blobs of the files that decide the section, the committee snapshot's vintage, the
assertion, and the sha256 of the rendered scope. No image is written and none is
committed.

The committee destination is rendered by the Pages edge worker in production and
is not served by the local static server, so its two documents are produced here
by the repository's own edge renderer and fulfilled into the browser. Each such
entry says so in `served_by`.

The members and committees this capture walks are selected from the committee
graph being captured, never fixed in this file: the publisher reorganizes
committees and reshuffles members on its own schedule, and a fixed pair ages out
of the snapshot the day one of them changes bodies — which is exactly how a
September 2026 reorganization stalled the scheduled dataset refresh behind a
failing capture while every first-class artifact it owns aged out. The
historical fixtures stay as preferences, so manifests remain comparable while
the data still supports them and migrate only when the data moves.

    python3 tools/capture_official_colleagues.py
    python3 tools/capture_official_colleagues.py --keep-going
    python3 tools/capture_official_colleagues.py --self-test
"""

from __future__ import annotations

from repository_revision import resolve_repository_revision

import argparse
import hashlib
import json
import subprocess
import tempfile
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "docs" / "evidence" / "official-committee-co-service"
MANIFEST = EVIDENCE / "capture-manifest.json"

SOURCE_PATHS = [
    "site/committee_coservice.mjs",
    "site/app/entities.mjs",
    "site/committee_memberships.mjs",
]

# Preferred fixtures: the members and committees this capture historically
# walked. They are preferences, not requirements — selection falls back to any
# qualifying member when the publisher's data has moved past these.
PREFERRED_SUBJECT = "7801"
PREFERRED_COLLEAGUE = "7824"
PREFERRED_ENDED_COMMITTEE = "3"
PREFERRED_ABSENT = "7803"

DESKTOP = {"name": "desktop", "width": 1440, "height": 900}
NARROW = {"name": "narrow", "width": 390, "height": 844}
SETTLE_MS = 1200


class FixtureSelectionError(RuntimeError):
    """The graph being captured cannot support the capture's fixture shapes."""


def _clean_day(value) -> str | None:
    text = str(value or "").strip()[:10]
    return text if len(text) == 10 and text[4] == "-" and text[7] == "-" else None


def committee_names(graph) -> dict[str, str]:
    names: dict[str, str] = {}
    for node in graph.get("nodes") or []:
        if node.get("type") == "committee" and node.get("id") and node.get("name"):
            names[str(node["id"]).replace("committee:", "", 1)] = str(node["name"])
    return names


def _is_caucus_name(name: str | None) -> bool:
    return "caucus" in str(name or "").lower()


def _merged_memberships(graph, day: str) -> tuple[dict[str, dict[str, dict]], dict[str, dict[str, dict]]]:
    """Mirror the served projection's membership read.

    Returns (current, history): per official, per committee, the widest merged
    {start, end} interval. `current` keeps only observations covering `day`;
    `history` keeps every dated observation. An edge missing either date is
    dropped, exactly as the served projection drops it.
    """
    current: dict[str, dict[str, dict]] = {}
    history: dict[str, dict[str, dict]] = {}

    def admit(table, official, committee, start, end):
        merged = table.setdefault(official, {}).get(committee)
        if merged is None:
            table.setdefault(official, {})[committee] = {"start": start, "end": end}
            return
        merged["start"] = min(merged["start"], start)
        merged["end"] = max(merged["end"], end)

    for edge in graph.get("public_edges") or []:
        if edge.get("type") != "member_of":
            continue
        official = str(edge.get("from") or "").replace("official:", "", 1)
        committee = str(edge.get("to") or "").replace("committee:", "", 1)
        start = _clean_day(edge.get("valid_from"))
        end = _clean_day(edge.get("valid_to"))
        if not official or not committee or not start or not end:
            continue
        admit(history, official, committee, start, end)
        if start <= day <= end:
            admit(current, official, committee, start, end)
    return current, history


def select_fixtures(graph, profiled_officials, as_of: str | None = None) -> dict:
    """Pick the capture's subject, colleague, ended committee, and absent member.

    The criteria are the capture's own shapes: a subject with at least one
    co-service colleague on the snapshot day, a committee in the subject's
    history that ended before that day, and a member with published history but
    no membership covering the day. Preferred fixtures win whenever they still
    qualify, so nothing changes while the data is still.
    """
    day = as_of or str(graph.get("generated_at") or "")[:10]
    if len(day) != 10:
        raise FixtureSelectionError("the committee graph carries no snapshot day")
    names = committee_names(graph)
    current, history = _merged_memberships(graph, day)
    profiled = {str(pid) for pid in profiled_officials}

    def shared_committees(left: str, right: str) -> list[str]:
        bodies = set(current.get(left) or {}) & set(current.get(right) or {})
        return sorted(body for body in bodies if not _is_caucus_name(names.get(body)))

    def colleague_ids(subject: str) -> list[str]:
        return sorted(
            other for other in current
            if other != subject and other in profiled and shared_committees(subject, other)
        )

    def ended_bodies(official: str) -> list[str]:
        return sorted(
            body for body, interval in (history.get(official) or {}).items()
            if interval["end"] < day and not _is_caucus_name(names.get(body)))

    subjects_with_colleagues = [pid for pid in profiled if colleague_ids(pid)]
    if not subjects_with_colleagues:
        raise FixtureSelectionError(
            "no profiled official shares a committee with anyone on the snapshot day")
    # Prefer a subject that can also exercise the ended-committee disclosure;
    # among those, the historical fixture wins, then the smallest id.
    subjects_with_colleagues.sort(key=lambda pid: (
        not ended_bodies(pid), pid != PREFERRED_SUBJECT, pid))
    subject = subjects_with_colleagues[0]

    colleagues = colleague_ids(subject)
    colleague = PREFERRED_COLLEAGUE if PREFERRED_COLLEAGUE in colleagues else colleagues[0]
    shared = shared_committees(subject, colleague)
    if not shared:
        raise FixtureSelectionError(f"subject {subject} and colleague {colleague} share no committee")

    ended = ended_bodies(subject)
    ended_committee = PREFERRED_ENDED_COMMITTEE if PREFERRED_ENDED_COMMITTEE in ended else (
        ended[0] if ended else None)

    absent_candidates = sorted(
        pid for pid in profiled
        if history.get(pid) and not current.get(pid))
    absent = PREFERRED_ABSENT if PREFERRED_ABSENT in absent_candidates else (
        absent_candidates[0] if absent_candidates else None)
    if absent is None:
        raise FixtureSelectionError(
            "no profiled official has committee history without snapshot-day membership")

    return {
        "snapshot_day": day,
        "subject": subject,
        "colleague": colleague,
        "shared_committees": shared,
        "ended_committee": ended_committee,
        "absent": absent,
        "selection_basis": {
            "preferred": {
                "subject": PREFERRED_SUBJECT,
                "colleague": PREFERRED_COLLEAGUE,
                "ended_committee": PREFERRED_ENDED_COMMITTEE,
                "absent": PREFERRED_ABSENT,
            },
            "ended_committee_in_subject_history": ended_committee is not None,
        },
    }


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def repository_revision() -> str:
    return resolve_repository_revision(ROOT)

def source_blob() -> dict:
    out = subprocess.run(["git", "hash-object", *SOURCE_PATHS], cwd=ROOT, check=True,
                         capture_output=True, text=True).stdout.split()
    return dict(zip(SOURCE_PATHS, out))


def data_vintage() -> dict:
    graph = json.loads((ROOT / "site" / "data" / "committee_graph_lookup.json").read_text())
    people = json.loads((ROOT / "site" / "data" / "person_hub_lookup.json").read_text())
    return {
        "committee_graph_generated_at": graph["generated_at"],
        "committee_graph_as_of": graph["generated_at"][:10],
        "person_hub_generated_at": people.get("generated_at") or people.get("retrieved_at"),
    }


def render_committee_documents(ids: list[str], out_dir: Path) -> dict:
    """Render the committee destinations with the repository's own edge renderer."""
    script = f"""
import {{ readFileSync, writeFileSync }} from 'node:fs';
import {{ buildCommitteeDocumentView, renderCommitteeDocument }} from './site/committee_document.mjs';
const graph = JSON.parse(readFileSync('site/data/committee_graph_lookup.json'));
const people = JSON.parse(readFileSync('site/data/person_hub_lookup.json'));
for (const id of {json.dumps(ids)}) {{
  const view = buildCommitteeDocumentView(graph, people, id);
  if (!view) throw new Error('no committee document view for ' + id);
  writeFileSync({json.dumps(str(out_dir))} + '/committee-' + id + '.html',
    renderCommitteeDocument(view, {{ currentHref: '/committees/' + id + '/' }}));
}}
process.stdout.write('ok');
"""
    subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, check=True,
                   capture_output=True, text=True)
    return {committee_id: (out_dir / f"committee-{committee_id}.html").read_text(encoding="utf-8")
            for committee_id in ids}


def start_site_server(temp_dir: Path) -> tuple[subprocess.Popen, str]:
    ready = temp_dir / "site-url.txt"
    process = subprocess.Popen(
        ["python3", "tools/local_site_server.py", "--directory", "_site",
         "--port", "0", "--ready-file", str(ready)],
        cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(400):
        if ready.exists() and ready.read_text().strip():
            return process, ready.read_text().strip()
        if process.poll() is not None:
            raise RuntimeError(f"local site server exited early: {process.stdout.read()}")
        time.sleep(0.05)
    process.terminate()
    raise TimeoutError("local site server did not become ready")


def install_committee_documents(page: Page, documents: dict) -> None:
    """Answer the edge-rendered committee routes with the edge renderer's own output."""
    def handler(route):
        committee_id = route.request.url.split("/committees/")[1].strip("/").split("?")[0]
        body = documents.get(committee_id)
        if body is None:
            return route.abort()
        return route.fulfill(status=200, headers={"Content-Type": "text/html; charset=utf-8"},
                             body=body)

    page.route("**/committees/*/**", handler)
    page.route("**/committees/*", handler)


def open_profile(page: Page, base: str, official_id: str) -> None:
    page.goto(f"{base}officials/{official_id}/", wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_selector("[data-official-coservice]", state="attached", timeout=60_000)
    page.wait_for_timeout(SETTLE_MS)


def observe_section(page: Page) -> dict:
    section = page.locator("[data-official-coservice]")
    colleagues = section.locator(".official-coservice-colleague")
    rows = []
    for index in range(colleagues.count()):
        entry = colleagues.nth(index)
        committees = entry.locator(".official-coservice-committee")
        rows.append({
            "official_id": entry.get_attribute("data-coservice-official-id"),
            "name": entry.locator(".official-coservice-official-link").inner_text().strip("◆ "),
            "shared_committees": int(entry.get_attribute("data-coservice-shared-committees")),
            "committee_ids": [committees.nth(i).get_attribute("data-coservice-committee-id")
                              for i in range(committees.count())],
            "overlaps": [
                [committees.nth(i).get_attribute("data-coservice-overlap-start"),
                 committees.nth(i).get_attribute("data-coservice-overlap-end")]
                for i in range(committees.count())
            ],
            "shared_caucuses": int(entry.locator(".official-coservice-caucuses").get_attribute(
                "data-coservice-caucus-count") or 0) if entry.locator(
                    ".official-coservice-caucuses").count() else 0,
        })
    membership_committees = sorted({
        link.get_attribute("href").rsplit("/", 2)[-2]
        for link in page.locator('.official-committee-memberships a[href^="/committees/"]').all()
    })
    return {
        "state": section.get_attribute("data-coservice-state"),
        "as_of": section.get_attribute("data-coservice-as-of"),
        "colleague_count": int(section.get_attribute("data-coservice-colleague-count")),
        "represented_officials": int(section.get_attribute("data-coservice-represented-officials")),
        "heading": section.locator(".chain-h").inner_text(),
        "summary": section.locator(".official-coservice-summary").inner_text(),
        "basis": section.locator(".official-coservice-basis").inner_text(),
        "rendered_colleagues": len(rows),
        "colleagues": rows,
        "disclosed": int(section.locator(".official-coservice-more").get_attribute(
            "data-coservice-disclosed") or 0) if section.locator(
                ".official-coservice-more").count() else 0,
        "committee_link_count": section.locator('a[href^="/committees/"]').count(),
        "official_link_count": section.locator('a[href^="/officials/"]').count(),
        "off_route_link_count": section.locator(
            'a:not([href^="/committees/"]):not([href^="/officials/"])').count(),
        "membership_section_committee_ids": membership_committees,
        "render_scope": "outerHTML of [data-official-coservice]",
        "render_sha256": sha256_text(section.evaluate("node => node.outerHTML")),
    }


def entry(capture_id, route, viewport, revision, blob, vintage, assertion, holds, observed,
          served_by="repository static build (_site) via tools/local_site_server.py",
          route_note=None):
    return {
        "id": capture_id,
        "route": route,
        "route_note": route_note,
        "viewport": viewport,
        "served_by": served_by,
        "repository_revision": revision,
        "source_blob": blob,
        "data_vintage": vintage,
        "assertion": assertion,
        "assertion_holds": holds,
        "observed": observed,
        "render_sha256": observed.get("render_sha256"),
        "render_scope": observed.get("render_scope"),
        "file": None,
    }


def capture(base: str, documents: dict, selection: dict) -> list[dict]:
    revision = repository_revision()
    blob = source_blob()
    vintage = data_vintage()
    as_of = selection["snapshot_day"]
    subject = selection["subject"]
    colleague_id = selection["colleague"]
    expected_shared = selection["shared_committees"]
    ended_committee = selection["ended_committee"]
    absent_id = selection["absent"]
    captures: list[dict] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            # 1. Desktop: the positive example, and the dated negative beside it.
            context = browser.new_context(viewport={"width": DESKTOP["width"], "height": DESKTOP["height"]})
            page = context.new_page()
            install_committee_documents(page, documents)
            open_profile(page, base, subject)
            observed = observe_section(page)
            colleague = next(row for row in observed["colleagues"] if row["official_id"] == colleague_id)
            observed["positive_example"] = colleague
            observed["selection"] = {
                "subject": subject,
                "colleague": colleague_id,
                "expected_shared_committees": expected_shared,
                "ended_committee": ended_committee,
            }
            observed["ended_in_membership_history"] = (
                ended_committee is not None and ended_committee in observed["membership_section_committee_ids"])
            observed["ended_in_co_service"] = ended_committee is not None and any(
                ended_committee in row["committee_ids"] for row in observed["colleagues"])
            holds = (
                observed["state"] == "matched"
                and observed["as_of"] == as_of
                and sorted(colleague["committee_ids"]) == sorted(expected_shared)
                and all(start <= as_of <= end for start, end in colleague["overlaps"])
                and colleague["shared_committees"] == len(expected_shared)
                and observed["off_route_link_count"] == 0
                and (ended_committee is None or (observed["ended_in_membership_history"]
                                                 and not observed["ended_in_co_service"]))
            )
            captures.append(entry(
                "desktop-subject-profile", f"/officials/{subject}/", DESKTOP, revision, blob, vintage,
                "The profile names the other member with the committees and dates both were listed "
                f"on {as_of}; a committee whose service ended before {as_of} appears in this member's "
                f"membership history and never as service together on that day.",
                holds, observed,
                route_note="Council member profile; the section reads the committee graph the page already loads."))

            # 2. Keyboard: official to colleague to shared committee to Back.
            walk = keyboard_walk(page, base, documents, selection)
            captures.append(entry(
                "keyboard-official-colleague-committee-back", f"/officials/{subject}/", DESKTOP,
                revision, blob, vintage,
                "Tab reaches the colleague link, Enter opens their profile, the reciprocal section "
                "names this member, the shared committee record lists both, and Back returns to the "
                "profile the walk started from.",
                walk["holds"], walk,
                route_note="One keyboard walk across three routes; the committee document is the edge renderer's."))
            context.close()

            # 3. Narrow viewport: the same section, no horizontal overflow.
            context = browser.new_context(
                viewport={"width": NARROW["width"], "height": NARROW["height"]},
                has_touch=True, is_mobile=True)
            page = context.new_page()
            install_committee_documents(page, documents)
            open_profile(page, base, subject)
            narrow = observe_section(page)
            narrow["document_scroll_width"] = page.evaluate("document.documentElement.scrollWidth")
            narrow["document_client_width"] = page.evaluate("document.documentElement.clientWidth")
            narrow["horizontal_overflow"] = narrow["document_scroll_width"] > narrow["document_client_width"]
            narrow_holds = (
                narrow["state"] == "matched"
                and not narrow["horizontal_overflow"]
                and narrow["render_sha256"] == observed["render_sha256"]
            )
            captures.append(entry(
                "narrow-subject-profile", f"/officials/{subject}/", NARROW, revision, blob, vintage,
                "At a touch viewport the section renders the same markup as the desktop capture and "
                "the document does not scroll sideways.",
                narrow_holds, narrow))
            context.close()

            # 4. A member of the same corpus with no co-service on the snapshot day.
            context = browser.new_context(viewport={"width": DESKTOP["width"], "height": DESKTOP["height"]})
            page = context.new_page()
            install_committee_documents(page, documents)
            page.goto(f"{base}officials/{absent_id}/", wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_timeout(SETTLE_MS * 2)
            absent = {
                "official_id": absent_id,
                "co_service_sections": page.locator("[data-official-coservice]").count(),
                "membership_sections": page.locator(".official-committee-memberships").count(),
                "profile_rendered": page.locator("#official-skim").count(),
                "render_scope": "count of [data-official-coservice] in the document",
                "render_sha256": sha256_text(page.locator("#official-skim").inner_html()
                                             if page.locator("#official-skim").count() else ""),
            }
            captures.append(entry(
                "negative-no-supported-rows", f"/officials/{absent_id}/", DESKTOP, revision, blob, vintage,
                "A profile with no supported co-service row renders no section at all rather than an "
                "empty one, and the rest of the profile is unaffected.",
                absent["co_service_sections"] == 0 and absent["profile_rendered"] == 1,
                absent,
                route_note="A member with published committee history and no membership covering the snapshot day."))
            context.close()
        finally:
            browser.close()
    return captures


def keyboard_walk(page: Page, base: str, documents: dict, selection: dict) -> dict:
    """Reach the colleague link with Tab, then walk the chain and come back."""
    subject = selection["subject"]
    colleague_id = selection["colleague"]
    walk_committee = selection["shared_committees"][0]
    expected_shared = selection["shared_committees"]
    selector = f'.official-coservice-colleague[data-coservice-official-id="{colleague_id}"] '\
               '.official-coservice-official-link'
    page.locator(selector).scroll_into_view_if_needed()
    page.evaluate("() => (document.activeElement || document.body).blur()")
    page.locator("body").click(position={"x": 4, "y": 4})
    reached = False
    presses = 0
    for presses in range(1, 401):
        page.keyboard.press("Tab")
        if page.evaluate(
            "sel => document.activeElement === document.querySelector(sel)", selector
        ):
            reached = True
            break
    focus_visible = page.evaluate(
        "sel => { const el = document.querySelector(sel);"
        " return Boolean(el && el.matches(':focus-visible')); }", selector)
    page.keyboard.press("Enter")
    page.wait_for_selector("[data-official-coservice]", state="attached", timeout=60_000)
    page.wait_for_timeout(SETTLE_MS)
    colleague_url = page.url
    reciprocal = observe_section(page)
    back_row = next((row for row in reciprocal["colleagues"] if row["official_id"] == subject), None)

    committee_selector = f'.official-coservice-colleague[data-coservice-official-id="{subject}"] '\
                         f'.official-coservice-committee[data-coservice-committee-id="{walk_committee}"] a'
    page.locator(committee_selector).scroll_into_view_if_needed()
    page.locator(committee_selector).focus()
    page.keyboard.press("Enter")
    page.wait_for_selector("main.committee-document", state="attached", timeout=60_000)
    committee_url = page.url
    committee_members = sorted(
        link.get_attribute("data-pivot-target-id")
        for link in page.locator('main.committee-document a[data-pivot-target-kind="official"]').all())
    committee_title = page.locator("main.committee-document h1").inner_text()
    committee_html = page.locator("main.committee-document").evaluate("node => node.outerHTML")

    page.go_back(wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_selector("[data-official-coservice]", state="attached", timeout=60_000)
    page.wait_for_timeout(SETTLE_MS)
    back_url = page.url
    page.go_back(wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_selector("[data-official-coservice]", state="attached", timeout=60_000)
    page.wait_for_timeout(SETTLE_MS)
    start_url = page.url
    returned = observe_section(page)

    holds = (
        reached
        and focus_visible
        and colleague_url.endswith(f"/officials/{colleague_id}/")
        and back_row is not None
        and sorted(back_row["committee_ids"]) == sorted(expected_shared)
        and committee_url.endswith(f"/committees/{walk_committee}/")
        and subject in committee_members and colleague_id in committee_members
        and back_url.endswith(f"/officials/{colleague_id}/")
        and start_url.endswith(f"/officials/{subject}/")
        and returned["render_sha256"] is not None
    )
    return {
        "holds": holds,
        "selection": {
            "subject": subject,
            "colleague": colleague_id,
            "walk_committee": walk_committee,
            "expected_shared_committees": expected_shared,
        },
        "tab_presses_to_colleague_link": presses if reached else None,
        "colleague_link_reached_by_keyboard": reached,
        "colleague_link_focus_visible": focus_visible,
        "colleague_url": colleague_url,
        "reciprocal_row": back_row,
        "committee_url": committee_url,
        "committee_title": committee_title,
        "committee_member_ids": committee_members,
        "committee_render_sha256": sha256_text(committee_html),
        "back_url": back_url,
        "start_url": start_url,
        "render_scope": "outerHTML of [data-official-coservice] after the walk returns",
        "render_sha256": returned["render_sha256"],
    }


def profiled_official_ids() -> list[str]:
    people = json.loads((ROOT / "site" / "data" / "person_hub_lookup.json").read_text())
    return sorted(str(pid) for pid in (people.get("by_person_id") or {}))


def load_selection() -> dict:
    graph = json.loads((ROOT / "site" / "data" / "committee_graph_lookup.json").read_text())
    return select_fixtures(graph, profiled_official_ids())


def _synthetic_graph(edges, nodes, day):
    return {
        "generated_at": f"{day}T06:30:00Z",
        "publication": "published",
        "nodes": [{"id": f"committee:{cid}", "type": "committee", "name": name}
                  for cid, name in nodes],
        "public_edges": [
            {"id": f"edge:{index}", "type": "member_of", "from": f"official:{official}",
             "to": f"committee:{committee}", "valid_from": start, "valid_to": end}
            for index, (official, committee, start, end) in enumerate(edges)
        ],
    }


def self_test() -> int:
    """Reproduce the fixture-aging failure and prove the selection fixes it.

    Scenario one rebuilds the shape the scheduled refresh met in September
    2026: the historically captured pair no longer shares any committee and the
    historically absent member now holds one, while other members do share
    committees. The fixed fixtures this capture used to hardcode fail every one
    of their assertions on that graph; selection derives fixtures that hold.

    The committed-graph pin at the end reads
    test/fixtures/committee-co-service/{committee_graph_lookup,person_hub_lookup}.json
    (main vintage). Refresh adds shared committee 5224 and changes absent.
    """
    day = "2026-09-24"
    nodes = [
        ("5309", "Subcommittee on Landmarks, Public Sitings, Resiliency and Dispositions"),
        ("5106", "Committee on Parks and Recreation"),
        ("3", "Committee on Aging"),
        ("42", "Committee on General Welfare"),
        ("19", "Committee on Hospice Care"),
        ("5281", "Caucus - Black, Latino and Asian Caucus"),
    ]
    stable_edges = [
        # The historically captured pair: two shared committees, plus a shared
        # caucus that must never count as co-service.
        ("7801", "5309", "2026-01-15", "2029-12-31"),
        ("7824", "5309", "2026-01-15", "2029-12-31"),
        ("7801", "5106", "2026-01-15", "2029-12-31"),
        ("7824", "5106", "2026-01-15", "2029-12-31"),
        ("7801", "5281", "2026-01-15", "2029-12-31"),
        ("7824", "5281", "2026-01-15", "2029-12-31"),
        # The subject's committee that ended before the snapshot day.
        ("7801", "3", "2024-01-01", "2025-12-31"),
        # The historically absent member: history, but nothing covering the day.
        ("7803", "5106", "2023-01-01", "2025-12-31"),
    ]
    reorganized_edges = [
        # The September reorganization: the captured pair split onto unshared
        # bodies, and the caucus is the only thing still shared (which is not
        # co-service).
        ("7801", "5309", "2026-01-15", "2029-12-31"),
        ("7824", "5106", "2026-01-15", "2029-12-31"),
        ("7801", "5281", "2026-01-15", "2029-12-31"),
        ("7824", "5281", "2026-01-15", "2029-12-31"),
        ("7801", "3", "2024-01-01", "2025-12-31"),
        # The historically absent member joined a body after the last capture —
        # one nobody else in this corpus holds.
        ("7803", "19", "2026-09-20", "2029-12-31"),
        # A different pair now shares a committee, with ended history to boot.
        ("9001", "42", "2026-01-15", "2029-12-31"),
        ("9002", "42", "2026-01-15", "2029-12-31"),
        ("9001", "5106", "2023-01-01", "2025-12-31"),
        # And a member with history but nothing current remains available.
        ("9003", "5106", "2023-01-01", "2025-12-31"),
    ]
    profiled = ["7801", "7824", "7803", "9001", "9002", "9003"]

    stable = select_fixtures(_synthetic_graph(stable_edges, nodes, day), profiled)
    assert stable["subject"] == "7801", stable
    assert stable["colleague"] == "7824", stable
    assert stable["shared_committees"] == ["5106", "5309"], stable
    assert stable["ended_committee"] == "3", stable
    assert stable["absent"] == "7803", stable

    reorganized = _synthetic_graph(reorganized_edges, nodes, day)
    current, history = _merged_memberships(reorganized, day)
    names = committee_names(reorganized)

    def shared(left, right):
        bodies = set(current.get(left) or {}) & set(current.get(right) or {})
        return sorted(body for body in bodies if not _is_caucus_name(names.get(body)))

    # The reproduced incident: every hardcoded fixture broke at once.
    assert shared("7801", "7824") == [], "the captured pair no longer co-serves"
    assert current.get("7803"), "the historically absent member now holds a body"
    # Selection finds qualifying fixtures on the same graph.
    moved = select_fixtures(reorganized, profiled)
    assert moved["subject"] == "9001", moved
    assert moved["colleague"] == "9002", moved
    assert moved["shared_committees"] == ["42"], moved
    assert moved["ended_committee"] == "5106", moved
    assert moved["absent"] == "9003", moved

    # A corpus with no co-service at all must fail loudly, not silently weaken.
    empty = _synthetic_graph([("7801", "3", "2024-01-01", "2025-12-31")], nodes[:3], day)
    try:
        select_fixtures(empty, ["7801"])
    except FixtureSelectionError:
        pass
    else:
        raise AssertionError("selection must fail when no official co-serves")

    # Main-vintage committee graph / person hub fixtures: scheduled refresh adds
    # shared committee 5224 and changes absent membership. Keep exact historical
    # pins (shared ["5106","5309"], absent PREFERRED_ABSENT) via fixtures.
    fixture_graph = ROOT / "test" / "fixtures" / "committee-co-service" / "committee_graph_lookup.json"
    fixture_people = ROOT / "test" / "fixtures" / "committee-co-service" / "person_hub_lookup.json"
    fixture_profiled = sorted(str(pid) for pid in (
        json.loads(fixture_people.read_text()).get("by_person_id") or {}
    ))
    committed = select_fixtures(
        json.loads(fixture_graph.read_text()),
        fixture_profiled)
    assert committed["subject"] == PREFERRED_SUBJECT, committed
    assert committed["colleague"] == PREFERRED_COLLEAGUE, committed
    assert committed["shared_committees"] == ["5106", "5309"], committed
    assert committed["ended_committee"] == PREFERRED_ENDED_COMMITTEE, committed
    assert committed["absent"] == PREFERRED_ABSENT, committed

    print("fixture selection self-test OK — "
          f"committed graph: subject {committed['subject']}, colleague {committed['colleague']}, "
          f"shared {committed['shared_committees']}, ended {committed['ended_committee']}, "
          f"absent {committed['absent']}; reorganized graph: subject {moved['subject']}, "
          f"colleague {moved['colleague']}, shared {moved['shared_committees']}, "
          f"absent {moved['absent']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=None,
                        help="serve an already-running base URL instead of starting one")
    parser.add_argument("--keep-going", action="store_true",
                        help="write the manifest even when an assertion does not hold")
    parser.add_argument("--self-test", action="store_true",
                        help="run the fixture-selection reproduction without a browser")
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    selection = load_selection()

    with tempfile.TemporaryDirectory() as temp:
        temp_dir = Path(temp)
        documents = render_committee_documents(selection["shared_committees"], temp_dir)
        server = None
        try:
            if args.base:
                base = args.base.rstrip("/") + "/"
            else:
                server, base = start_site_server(temp_dir)
            captures = capture(base, documents, selection)
        finally:
            if server is not None:
                server.terminate()
                server.wait(timeout=30)

    manifest = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "surface": "dated committee co-service on official profiles",
        "condition": (
            "Served from the repository's own built site directory. The committee destination is "
            "rendered by the Pages edge worker in production and is not served by the local static "
            "server, so its documents are produced here by the repository's own committee renderer "
            "and answered into the browser; every entry names what served it. No production traffic "
            "is involved and no image is written."
        ),
        "image_binaries_committed": False,
        "fixture_selection": {
            "basis": "selected from the committee graph being captured; the historical fixtures "
                     "are preferences that hold only while the data still supports them",
            "preferred": selection["selection_basis"]["preferred"],
            "selected": {
                "subject": selection["subject"],
                "colleague": selection["colleague"],
                "shared_committees": selection["shared_committees"],
                "ended_committee": selection["ended_committee"],
                "absent": selection["absent"],
                "snapshot_day": selection["snapshot_day"],
            },
        },
        "captures": captures,
    }
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    failed = [capture["id"] for capture in captures if not capture["assertion_holds"]]
    print(f"wrote {MANIFEST.relative_to(ROOT)} ({len(captures)} captures)")
    if failed:
        print(f"assertions did not hold: {', '.join(failed)}")
        return 0 if args.keep_going else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
