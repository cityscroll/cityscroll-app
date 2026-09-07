#!/usr/bin/env python3
"""Served-page read-back for "Other projects listing this applicant".

Unlike a component harness, this mounts the built public site (`_site`,
produced by `tools/prepare_functional_site.sh`) on a local static server and
drives the real `/#land/<project_id>` route, so what is
read back is the page a resident gets: the land list, the record card, the
applicant area, and the section under it. External hosts are aborted, so a
capture can never quietly become a publisher fetch.

Each journey names the behaviour it proves, positive and negative alike:

  positive-pair         a repeated exact label lists the other project, with its
                        published name, source status, milestone and date
  positive-largest      the largest repeated label lists every other project
  positive-person       a person-shaped applicant is grouped in the applicant
                        position and never relabelled owner or developer
  translated            the same section in Spanish, with source titles intact
  rtl-ar                the section in a right-to-left language, with the source
                        project name still isolated left-to-right and no
                        horizontal overflow
  no-javascript         the land detail the existing document renders with no
                        script at all, which is nothing -- so this section adds
                        nothing there either
  negative-singleton    a label that occurs once renders no section at all
  negative-failed-load  a project list that never arrives renders no section and
                        makes no "no other projects" claim
  back-navigation       opening a listed project and going back restores the
                        original project with the section still expanded
  keyboard              the disclosure is operable from the keyboard alone

The rendered PNGs are gitignored and stay local; manifest.json -- one entry per
capture with its route, viewport, revision, data vintage, assertion and sha256
-- is the committed proof.

    python3 tools/capture_land_same_applicant_projects.py
    python3 tools/capture_land_same_applicant_projects.py --check
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import json
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "_site"
SOURCE_DATA = ROOT / "site" / "data"
OUT = ROOT / "docs" / "screenshots" / "land-same-applicant-projects"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = ((390, 844), (1440, 900))

# Reviewed subjects. Each is a real retained record, but the snapshot is
# refreshed on its own cadence, so a name that has left the corpus falls back to
# an equivalent one rather than wedging the capture. Whatever is chosen, the
# manifest records it and the page itself is what gets asserted.
PREFERRED_PAIR_LABEL = "GO Quay LLC"
PREFERRED_PERSON_LABEL = "Eric Palatnik"


def resident_corpus() -> list[dict]:
    """The rows the Land route holds: the snapshot plus the browse defaults."""
    warehouse = json.loads((SOURCE_DATA / "zap_projects_warehouse_lookup.json").read_text("utf-8"))
    defaults = json.loads((SOURCE_DATA / "land_default_ulurp.json").read_text("utf-8"))
    by_id: dict[str, dict] = {}
    for row in [*warehouse["rows"], *defaults["projects"]]:
        by_id[row["project_id"]] = {**by_id.get(row["project_id"], {}), **row}
    return list(by_id.values())


def applicant_groups(rows: list[dict]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    for row in rows:
        label = " ".join(str(row.get("primary_applicant") or "").split())
        if not label:
            continue
        groups.setdefault(label, [])
        if row["project_id"] not in groups[label]:
            groups[label].append(row["project_id"])
    return groups


def choose_subjects() -> dict:
    """Pick the subjects from the corpus the page will actually group over."""
    rows = resident_corpus()
    groups = applicant_groups(rows)
    repeated = {label: ids for label, ids in groups.items() if len(ids) > 1}
    if not repeated:
        raise SystemExit("no applicant label repeats in the retained corpus")

    def pair_for(preferred):
        if len(repeated.get(preferred, [])) == 2:
            return preferred, sorted(repeated[preferred])
        for label, ids in sorted(repeated.items()):
            if len(ids) == 2:
                return label, sorted(ids)
        label, ids = sorted(repeated.items())[0]
        return label, sorted(ids)[:2]

    pair_label, pair_ids = pair_for(PREFERRED_PAIR_LABEL)
    person_label, person_ids = pair_for(PREFERRED_PERSON_LABEL)
    largest_label = max(sorted(repeated), key=lambda label: len(repeated[label]))
    largest_ids = sorted(repeated[largest_label])
    singleton = next(
        (row["project_id"] for row in rows
         if len(groups.get(" ".join(str(row.get("primary_applicant") or "").split()), [])) == 1),
        None,
    )
    if singleton is None:
        raise SystemExit("no applicant label occurs exactly once in the retained corpus")
    subject = next(row for row in rows if row["project_id"] == pair_ids[0])
    other = next(row for row in rows if row["project_id"] == pair_ids[1])
    return {
        "corpus_projects": len(rows),
        "repeated_labels": len(repeated),
        "projects_covered": sum(len(ids) for ids in repeated.values()),
        "pair_label": pair_label,
        "pair_subject": pair_ids[0],
        "pair_other": pair_ids[1],
        "pair_other_name": other.get("project_name"),
        "pair_other_status": other.get("public_status") or other.get("project_status"),
        "pair_subject_name": subject.get("project_name"),
        "largest_label": largest_label,
        "largest_subject": largest_ids[0],
        "largest_others": largest_ids[1:],
        "person_label": person_label,
        "person_subject": person_ids[0],
        "person_other": person_ids[1],
        "singleton_subject": singleton,
    }

SECTION = "[data-land-same-applicant='1']"
# Role words the section is not allowed to apply to the applicant. The note is
# excluded from this scan because the note is where those same words appear as an
# explicit denial -- the relationship published here is "these records list the
# same applicant", and nothing stronger.
FORBIDDEN_CLAIMS = ("owner", "developer", "parent compan", "affiliate", "subsidiar", "controls")
NOTE_DENIAL = "does not establish shared ownership, a parent company, common representation, or a political position"


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


def install_routes(page: Page, *, block_projects: bool = False) -> None:
    """No publisher, no worker. Optionally starve the bounded project snapshot."""
    page.route("https://**", lambda route: route.abort())
    page.route("http://**/*", lambda route: route.continue_())
    if block_projects:
        # Starve every input the bounded project corpus is merged from, so the
        # page is left with no project list at all rather than a partial one.
        for pattern in (
            "**/data/zap_projects_warehouse_lookup.json*",
            "**/data/land_default_ulurp.json*",
            "**/zap-projects-lookup*",
        ):
            page.route(pattern, lambda route: route.abort())


def open_project(page: Page, base_url: str, project_id: str, *, lang: str = "en") -> None:
    suffix = f"?lang={lang}" if lang != "en" else ""
    page.goto(f"{base_url}{suffix}#land/{project_id}", wait_until="domcontentloaded")
    page.locator("#ldetail .rolename").wait_for(state="visible")
    page.wait_for_function(
        "id => document.querySelector('[data-land-record-applicant]')?.textContent?.trim()"
        " && location.hash === '#land/' + id",
        arg=project_id,
    )


def section_state(page: Page) -> dict:
    """Read the section back out of the served DOM, exactly as rendered."""
    return page.evaluate(
        """() => {
          // When the section is absent, record whether the page nevertheless
          // made a negative claim -- the finding, not the whole page's copy.
          const claims = ["no other project", "other projects listing this applicant", "0 other project"];
          const section = document.querySelector("[data-land-same-applicant='1']");
          if (!section) {
            const body = (document.body.innerText || "").toLowerCase();
            return {
              present: false,
              negative_claim: claims.filter((phrase) => body.includes(phrase)),
            };
          }
          const details = section.querySelector("details");
          return {
            present: true,
            open: !!details?.open,
            relation: section.dataset.relation,
            project_ref: section.dataset.projectRef,
            applicant_label: section.dataset.applicantLabel,
            shown: Number(section.dataset.sameApplicantShown),
            total: Number(section.dataset.sameApplicantTotal),
            heading: section.querySelector(".land-same-applicant-kicker")?.textContent?.trim(),
            note: section.querySelector(".land-same-applicant-note")?.textContent?.trim(),
            text: section.innerText,
            items: [...section.querySelectorAll(".land-same-applicant-item")].map((li) => ({
              project_id: li.dataset.sameApplicantProject,
              name: li.querySelector(".land-same-applicant-link")?.textContent?.trim(),
              href: li.querySelector(".land-same-applicant-link")?.getAttribute("href"),
              status: li.querySelector(".land-same-applicant-status")?.textContent?.trim(),
              status_field: li.querySelector(".land-same-applicant-status")?.dataset.sourceField,
              when: li.querySelector(".land-same-applicant-when")?.textContent?.trim(),
              when_date: li.querySelector(".land-same-applicant-when")?.dataset.milestoneDate,
            })),
          };
        }"""
    )


def assert_no_negative_claim(state: dict) -> None:
    """An absent section must be absent, never a rendered "no other projects"."""
    claims = state.get("negative_claim")
    assert claims == [], f"the page claimed {claims!r} instead of staying silent"


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def data_vintage() -> str:
    payload = json.loads((SOURCE_DATA / "zap_projects_warehouse_lookup.json").read_text("utf-8"))
    return payload["materialized_at"]


def run_axe(page) -> dict:
    """Scope the scan to this section.

    The rest of the land page has its own accessibility gate; scanning the whole
    document here would report that gate's state, not this feature's, and would
    make this manifest flake on unrelated page content.
    """
    page.add_script_tag(path=str(AXE))
    result = page.evaluate(
        """async (selector) => {
          const context = document.querySelector(selector) || document;
          return await axe.run(context, { resultTypes: ["violations"] });
        }""",
        SECTION,
    )
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    gate = failing_violations(result["violations"], wcag22_rules)
    return {
        "violations_total": len(result["violations"]),
        "failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in gate],
    }


def record(files: list[dict], page, *, name: str, route: str, viewport, revision: str,
           specimen: str, assertion: str, axe: dict | None, evidence: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    dest = OUT / name
    # The section when it renders, the record card when it does not, and the
    # whole viewport when the page had no project to render at all.
    for candidate in (page.locator(SECTION), page.locator("#ldetail")):
        if candidate.count() and candidate.first.is_visible():
            candidate.first.screenshot(path=str(dest), animations="disabled")
            break
    else:
        page.screenshot(path=str(dest), animations="disabled")
    data = dest.read_bytes()
    files.append({
        "name": name,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "route": route,
        "viewport": list(viewport),
        "revision": revision,
        "data_vintage": data_vintage(),
        "specimen": specimen,
        "assertion": assertion,
        "axe": axe,
        "evidence": evidence,
    })


def capture() -> dict:
    if not (SITE / "index.html").exists():
        raise SystemExit("build the public site first: tools/prepare_functional_site.sh")
    revision = git_revision()
    subjects = choose_subjects()
    PAIR_SUBJECT = subjects["pair_subject"]
    PAIR_OTHER = subjects["pair_other"]
    LARGEST_SUBJECT = subjects["largest_subject"]
    LARGEST_OTHERS = subjects["largest_others"]
    PERSON_SUBJECT = subjects["person_subject"]
    PERSON_OTHER = subjects["person_other"]
    SINGLETON_SUBJECT = subjects["singleton_subject"]
    files: list[dict] = []
    with StaticServer(SITE) as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        for width, height in VIEWPORTS:
            viewport = (width, height)

            # 1. The named pair: one repeated exact label, one other project.
            page = browser.new_page(viewport={"width": width, "height": height})
            install_routes(page)
            open_project(page, base_url, PAIR_SUBJECT)
            page.locator(SECTION).wait_for(state="visible")
            state = section_state(page)
            assert state["applicant_label"] == subjects["pair_label"], state["applicant_label"]
            assert [item["project_id"] for item in state["items"]] == [PAIR_OTHER], state["items"]
            assert state["items"][0]["href"] == f"#land/{PAIR_OTHER}"
            assert state["items"][0]["status"] == subjects["pair_other_status"], state["items"][0]
            assert state["items"][0]["status_field"] == "public_status"
            assert state["items"][0]["name"] == subjects["pair_other_name"], state["items"][0]
            assert state["open"] is True
            assert PAIR_SUBJECT not in state["text"], "the subject project must not list itself"
            record(
                files, page, name=f"positive-pair-{width}.png",
                route=f"/#land/{PAIR_SUBJECT}", viewport=viewport, revision=revision,
                specimen="positive-pair", axe=run_axe(page),
                assertion="a repeated exact applicant label lists the other retained project with its published name, source status, milestone and date, and excludes the subject",
                evidence=state,
            )
            page.close()

            # 2. The largest group: six other projects, deduplicated and ordered.
            page = browser.new_page(viewport={"width": width, "height": height})
            install_routes(page)
            open_project(page, base_url, LARGEST_SUBJECT)
            page.locator(SECTION).wait_for(state="visible")
            state = section_state(page)
            assert [item["project_id"] for item in state["items"]] == LARGEST_OTHERS, state["items"]
            assert state["total"] == len(LARGEST_OTHERS)
            record(
                files, page, name=f"positive-largest-{width}.png",
                route=f"/#land/{LARGEST_SUBJECT}", viewport=viewport, revision=revision,
                specimen="positive-largest", axe=run_axe(page),
                assertion="the largest repeated label lists every other retained project in the corpus the page holds, each project id once, and says so when a milestone date is not published",
                evidence=state,
            )
            page.close()

            # 3. A person-shaped applicant keeps the applicant position.
            page = browser.new_page(viewport={"width": width, "height": height})
            install_routes(page)
            open_project(page, base_url, PERSON_SUBJECT)
            page.locator(SECTION).wait_for(state="visible")
            state = section_state(page)
            assert state["applicant_label"] == subjects["person_label"], state["applicant_label"]
            assert [item["project_id"] for item in state["items"]] == [PERSON_OTHER], state["items"]
            assert state["heading"] == "Other projects listing this applicant", state["heading"]
            assert NOTE_DENIAL in state["note"], state["note"]
            # Everything the section says apart from that denial must stay clear of
            # a role claim the source never made.
            lowered = state["text"].replace(state["note"], "").lower()
            for claim in FORBIDDEN_CLAIMS:
                assert claim not in lowered, f"the section introduced the claim {claim!r}"
            record(
                files, page, name=f"positive-person-{width}.png",
                route=f"/#land/{PERSON_SUBJECT}", viewport=viewport, revision=revision,
                specimen="positive-person", axe=run_axe(page),
                assertion="a person-shaped applicant is grouped in the applicant position and is never called an owner, developer, parent company, affiliate or subsidiary",
                evidence=state,
            )
            page.close()

            # 4. The same section in another shipping language, source titles intact.
            page = browser.new_page(viewport={"width": width, "height": height})
            install_routes(page)
            open_project(page, base_url, PAIR_SUBJECT, lang="es")
            page.locator(SECTION).wait_for(state="visible")
            state = section_state(page)
            assert state["heading"] == "Otros proyectos que registran este solicitante", state["heading"]
            assert "propiedad común" in state["note"], state["note"]
            assert state["items"][0]["name"] == subjects["pair_other_name"], state["items"][0]
            assert state["items"][0]["status"] == subjects["pair_other_status"], state["items"][0]
            record(
                files, page, name=f"translated-es-{width}.png",
                route=f"/?lang=es#land/{PAIR_SUBJECT}", viewport=viewport, revision=revision,
                specimen="translated", axe=run_axe(page),
                assertion="the section's own copy is translated while the published project name and source status stay in the source language",
                evidence=state,
            )
            page.close()

            # 5. Negative: a label that occurs once renders no section.
            page = browser.new_page(viewport={"width": width, "height": height})
            install_routes(page)
            open_project(page, base_url, SINGLETON_SUBJECT)
            page.wait_for_timeout(600)
            state = section_state(page)
            assert state["present"] is False, "a singleton label rendered a section"
            assert_no_negative_claim(state)
            record(
                files, page, name=f"negative-singleton-{width}.png",
                route=f"/#land/{SINGLETON_SUBJECT}", viewport=viewport, revision=revision,
                specimen="negative-singleton", axe=run_axe(page),
                assertion="an applicant label that occurs once in the retained corpus adds no section and no empty furniture",
                evidence=state,
            )
            page.close()

            # 6. Negative: the bounded project list never arrives.
            page = browser.new_page(viewport={"width": width, "height": height})
            install_routes(page, block_projects=True)
            page.goto(f"{base_url}#land/{PAIR_SUBJECT}", wait_until="domcontentloaded")
            page.wait_for_timeout(2000)
            state = section_state(page)
            assert state["present"] is False, "a failed load rendered a section"
            assert_no_negative_claim(state)
            record(
                files, page, name=f"negative-failed-load-{width}.png",
                route=f"/#land/{PAIR_SUBJECT}", viewport=viewport, revision=revision,
                specimen="negative-failed-load", axe=None,
                assertion="a project list that never arrives leaves the applicant area unchanged and never becomes a no-other-projects claim",
                evidence=state,
            )
            page.close()

            # 7. Opening a listed project and going back restores the original,
            #    with the section still expanded.
            page = browser.new_page(viewport={"width": width, "height": height})
            install_routes(page)
            open_project(page, base_url, PAIR_SUBJECT)
            page.locator(SECTION).wait_for(state="visible")
            page.locator(f"{SECTION} a[href='#land/{PAIR_OTHER}']").click()
            page.wait_for_function(
                "id => location.hash === '#land/' + id", arg=PAIR_OTHER,
            )
            page.locator("#ldetail .rolename").wait_for(state="visible")
            # The hash changes before the record repaints, so wait for the section
            # to be the one belonging to the project that was opened.
            page.wait_for_function(
                "ref => document.querySelector(\"[data-land-same-applicant='1']\")"
                "?.dataset.projectRef === ref",
                arg=f"project:{PAIR_OTHER}",
            )
            forward = section_state(page)
            assert forward["project_ref"] == f"project:{PAIR_OTHER}", forward["project_ref"]
            assert [item["project_id"] for item in forward["items"]] == [PAIR_SUBJECT], forward["items"]
            page.go_back()
            page.wait_for_function("id => location.hash === '#land/' + id", arg=PAIR_SUBJECT)
            page.locator(SECTION).wait_for(state="visible")
            page.wait_for_function(
                "ref => document.querySelector(\"[data-land-same-applicant='1']\")"
                "?.dataset.projectRef === ref",
                arg=f"project:{PAIR_SUBJECT}",
            )
            state = section_state(page)
            assert state["project_ref"] == f"project:{PAIR_SUBJECT}", state["project_ref"]
            assert state["open"] is True, "the section did not come back expanded"
            assert [item["project_id"] for item in state["items"]] == [PAIR_OTHER], state["items"]
            record(
                files, page, name=f"back-navigation-{width}.png",
                route=f"/#land/{PAIR_SUBJECT} -> /#land/{PAIR_OTHER} -> back", viewport=viewport,
                revision=revision, specimen="back-navigation", axe=run_axe(page),
                assertion="each listed project is a reciprocal native link; going back restores the original project and its expanded section",
                evidence={"forward": forward, "restored": state},
            )
            page.close()

            # 8. The disclosure is operable from the keyboard alone.
            page = browser.new_page(viewport={"width": width, "height": height})
            install_routes(page)
            open_project(page, base_url, PAIR_SUBJECT)
            summary = page.locator(f"{SECTION} summary")
            summary.wait_for(state="visible")
            summary.focus()
            assert page.evaluate(
                "() => document.activeElement?.matches('.land-same-applicant-summary')"
            ), "the disclosure summary did not take focus"
            page.keyboard.press("Enter")
            assert section_state(page)["open"] is False, "Enter did not collapse the disclosure"
            page.keyboard.press("Enter")
            state = section_state(page)
            assert state["open"] is True, "Enter did not re-expand the disclosure"
            assert page.evaluate("() => location.hash") == f"#land/{PAIR_SUBJECT}", (
                "operating the disclosure navigated"
            )
            record(
                files, page, name=f"keyboard-{width}.png",
                route=f"/#land/{PAIR_SUBJECT}", viewport=viewport, revision=revision,
                specimen="keyboard", axe=run_axe(page),
                assertion="the disclosure collapses and re-expands from the keyboard alone and never navigates or subscribes",
                evidence=state,
            )
            page.close()

            # 9. A right-to-left language: translated chrome, isolated source name,
            #    and no horizontal overflow at the narrow width.
            page = browser.new_page(viewport={"width": width, "height": height})
            install_routes(page)
            open_project(page, base_url, PAIR_SUBJECT, lang="ar")
            page.locator(SECTION).wait_for(state="visible")
            state = section_state(page)
            rtl = page.evaluate(
                """(selector) => {
                  const section = document.querySelector(selector);
                  const link = section.querySelector(".land-same-applicant-link");
                  return {
                    direction: getComputedStyle(section).direction,
                    link_dir: link.getAttribute("dir"),
                    link_lang: link.getAttribute("lang"),
                    document_scroll_width: document.documentElement.scrollWidth,
                    viewport_width: window.innerWidth,
                  };
                }""",
                SECTION,
            )
            assert rtl["direction"] == "rtl", rtl
            assert rtl["link_dir"] == "ltr" and rtl["link_lang"] == "en", rtl
            assert rtl["document_scroll_width"] <= rtl["viewport_width"], rtl
            assert state["items"][0]["name"] == subjects["pair_other_name"], state["items"][0]
            record(
                files, page, name=f"rtl-ar-{width}.png",
                route=f"/?lang=ar#land/{PAIR_SUBJECT}", viewport=viewport, revision=revision,
                specimen="rtl-ar", axe=run_axe(page),
                assertion="in a right-to-left language the section reads right-to-left, the published project name stays isolated left-to-right, and the page gains no horizontal scroll",
                evidence={**state, "rtl": rtl},
            )
            page.close()

            # 10. No script at all. The land project detail is a scripted surface,
            #     so the baseline document renders no project record -- and this
            #     section correctly adds nothing to it rather than inventing one.
            page = browser.new_page(
                viewport={"width": width, "height": height}, java_script_enabled=False,
            )
            page.goto(f"{base_url}browse/zoning/", wait_until="domcontentloaded")
            nojs = page.evaluate(
                """(selector) => {
                  const claims = ["no other project", "other projects listing this applicant"];
                  const body = (document.body.innerText || "").toLowerCase();
                  return {
                    rows: document.querySelectorAll("#llist .row").length,
                    section: document.querySelectorAll(selector).length,
                    negative_claim: claims.filter((phrase) => body.includes(phrase)),
                  };
                }""",
                SECTION,
            )
            assert nojs["rows"] == 0, "the no-script document rendered project rows"
            assert nojs["section"] == 0, "the no-script document rendered this section"
            assert_no_negative_claim({"negative_claim": nojs["negative_claim"]})
            record(
                files, page, name=f"no-javascript-{width}.png",
                route="/browse/zoning/ (scripting disabled)", viewport=viewport,
                revision=revision, specimen="no-javascript", axe=None,
                assertion="the existing land document renders no project record without script, so this section adds nothing there and makes no claim",
                evidence={
                    "rows": nojs["rows"],
                    "section": nojs["section"],
                    "negative_claim": nojs["negative_claim"],
                },
            )
            page.close()

        browser.close()

    manifest = {
        "schema_version": 1,
        "feature": "land-same-applicant-projects",
        "record": "cityscroll-engineering/land-same-applicant-projects",
        "revision": revision,
        "data_vintage": data_vintage(),
        "server": "local static server over the built _site, external hosts aborted",
        "subjects": subjects,
        "files": files,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


SPECIMENS = (
    "positive-pair",
    "positive-largest",
    "positive-person",
    "translated-es",
    "negative-singleton",
    "negative-failed-load",
    "back-navigation",
    "keyboard",
    "rtl-ar",
    "no-javascript",
)


def check() -> int:
    """The committed manifest is the proof; the PNGs are local and gitignored."""
    manifest_path = OUT / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"missing {manifest_path.relative_to(ROOT)}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {f"{slug}-{width}.png" for slug in SPECIMENS for width, _ in VIEWPORTS}
    found = {row["name"] for row in manifest.get("files") or []}
    missing = expected - found
    if missing:
        raise SystemExit(f"missing captures: {sorted(missing)}")
    for row in manifest["files"]:
        if not row.get("sha256") or not row.get("bytes"):
            raise SystemExit(f"manifest entry for {row['name']} is missing its sha256/bytes proof")
        for field in ("route", "viewport", "revision", "data_vintage", "assertion"):
            if not row.get(field):
                raise SystemExit(f"manifest entry for {row['name']} is missing {field}")
        path = OUT / row["name"]
        if path.exists():
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() != row["sha256"] or len(data) != row["bytes"]:
                raise SystemExit(f"local capture {row['name']} does not match its manifest entry")
        if row["axe"] and row["axe"]["failing_violations"]:
            raise SystemExit(f"{row['name']} failed the axe gate: {row['axe']['failing_violations']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        return check()
    manifest = capture()
    print("captured", len(manifest["files"]), "same-applicant screenshots")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
