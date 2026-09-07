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

    python3 tools/capture_official_colleagues.py
    python3 tools/capture_official_colleagues.py --keep-going
"""

from __future__ import annotations

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

SUBJECT = "7801"
COLLEAGUE = "7824"
LANDMARKS = "5309"
PARKS = "5106"
AGING = "3"
# A member whose committee history is published but whose terms do not cover the
# snapshot day: the memberships list still renders, and co-service has nothing to say.
ABSENT = "7803"

DESKTOP = {"name": "desktop", "width": 1440, "height": 900}
NARROW = {"name": "narrow", "width": 390, "height": 844}
SETTLE_MS = 1200


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def repository_revision() -> str:
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, check=True,
                          capture_output=True, text=True).stdout.strip()


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


def capture(base: str, documents: dict) -> list[dict]:
    revision = repository_revision()
    blob = source_blob()
    vintage = data_vintage()
    as_of = vintage["committee_graph_as_of"]
    captures: list[dict] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            # 1. Desktop: the positive example, and the dated negative beside it.
            context = browser.new_context(viewport={"width": DESKTOP["width"], "height": DESKTOP["height"]})
            page = context.new_page()
            install_committee_documents(page, documents)
            open_profile(page, base, SUBJECT)
            observed = observe_section(page)
            colleague = next(row for row in observed["colleagues"] if row["official_id"] == COLLEAGUE)
            observed["positive_example"] = colleague
            observed["aging_in_membership_history"] = AGING in observed["membership_section_committee_ids"]
            observed["aging_in_co_service"] = any(
                AGING in row["committee_ids"] for row in observed["colleagues"])
            holds = (
                observed["state"] == "matched"
                and observed["as_of"] == as_of
                and sorted(colleague["committee_ids"]) == sorted([LANDMARKS, PARKS])
                and all(start <= as_of <= end for start, end in colleague["overlaps"])
                and colleague["shared_committees"] == 2
                and observed["off_route_link_count"] == 0
                and observed["aging_in_membership_history"]
                and not observed["aging_in_co_service"]
            )
            captures.append(entry(
                "desktop-subject-profile", f"/officials/{SUBJECT}/", DESKTOP, revision, blob, vintage,
                "The profile names the other member with both shared committees and the dates both "
                f"were listed; the Committee on Aging appears in this member's membership history and "
                f"never as service together on {as_of}.",
                holds, observed,
                route_note="Council member profile; the section reads the committee graph the page already loads."))

            # 2. Keyboard: official to colleague to shared committee to Back.
            walk = keyboard_walk(page, base, documents)
            captures.append(entry(
                "keyboard-official-colleague-committee-back", f"/officials/{SUBJECT}/", DESKTOP,
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
            open_profile(page, base, SUBJECT)
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
                "narrow-subject-profile", f"/officials/{SUBJECT}/", NARROW, revision, blob, vintage,
                "At a touch viewport the section renders the same markup as the desktop capture and "
                "the document does not scroll sideways.",
                narrow_holds, narrow))
            context.close()

            # 4. A member of the same corpus with no co-service on the snapshot day.
            context = browser.new_context(viewport={"width": DESKTOP["width"], "height": DESKTOP["height"]})
            page = context.new_page()
            install_committee_documents(page, documents)
            page.goto(f"{base}officials/{ABSENT}/", wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_timeout(SETTLE_MS * 2)
            absent = {
                "co_service_sections": page.locator("[data-official-coservice]").count(),
                "membership_sections": page.locator(".official-committee-memberships").count(),
                "profile_rendered": page.locator("#official-skim").count(),
                "render_scope": "count of [data-official-coservice] in the document",
                "render_sha256": sha256_text(page.locator("#official-skim").inner_html()
                                             if page.locator("#official-skim").count() else ""),
            }
            captures.append(entry(
                "negative-no-supported-rows", f"/officials/{ABSENT}/", DESKTOP, revision, blob, vintage,
                "A profile with no supported co-service row renders no section at all rather than an "
                "empty one, and the rest of the profile is unaffected.",
                absent["co_service_sections"] == 0 and absent["profile_rendered"] == 1,
                absent,
                route_note="A member with published committee history and no membership covering the snapshot day."))
            context.close()
        finally:
            browser.close()
    return captures


def keyboard_walk(page: Page, base: str, documents: dict) -> dict:
    """Reach the colleague link with Tab, then walk the chain and come back."""
    selector = f'.official-coservice-colleague[data-coservice-official-id="{COLLEAGUE}"] '\
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
    back_row = next((row for row in reciprocal["colleagues"] if row["official_id"] == SUBJECT), None)

    committee_selector = f'.official-coservice-colleague[data-coservice-official-id="{SUBJECT}"] '\
                         f'.official-coservice-committee[data-coservice-committee-id="{LANDMARKS}"] a'
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
        and colleague_url.endswith(f"/officials/{COLLEAGUE}/")
        and back_row is not None
        and sorted(back_row["committee_ids"]) == sorted([LANDMARKS, PARKS])
        and committee_url.endswith(f"/committees/{LANDMARKS}/")
        and SUBJECT in committee_members and COLLEAGUE in committee_members
        and back_url.endswith(f"/officials/{COLLEAGUE}/")
        and start_url.endswith(f"/officials/{SUBJECT}/")
        and returned["render_sha256"] is not None
    )
    return {
        "holds": holds,
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=None,
                        help="serve an already-running base URL instead of starting one")
    parser.add_argument("--keep-going", action="store_true",
                        help="write the manifest even when an assertion does not hold")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as temp:
        temp_dir = Path(temp)
        documents = render_committee_documents([LANDMARKS, PARKS], temp_dir)
        server = None
        try:
            if args.base:
                base = args.base.rstrip("/") + "/"
            else:
                server, base = start_site_server(temp_dir)
            captures = capture(base, documents)
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
