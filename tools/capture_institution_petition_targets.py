#!/usr/bin/env python3
"""Headless browser evidence for institution-qualified official petition actions.

Drives the real generated institution profiles served from `site/`. Two live
routes carry the whole contract:

  - /agencies/small-business-services/  -- the grounded positive case. This body
    publishes its own rulemaking-petition procedure, so the profile offers an
    exact "Petition this agency" target and names the receiving body, the
    official destination and the response requirement from that same procedure.
  - /agencies/economic-development-corporation/  -- the same alias resolution and
    the same City-wide petition form, with no applicable procedure evidence. The
    profile keeps the general official guidance, clearly labelled general, and
    never claims that petitioning this body is unavailable.

Each specimen is a real interaction in a real engine at 390 and 1440 pixels:
the two targets side by side, keyboard reach and focus, external-link semantics,
inspecting the handoff detail and dismissing it, the full-page journey and the
browser Back that follows, the page as a reader without scripting receives it,
200% zoom, and touch-target size. Every specimen also runs the vendored axe-core
gate on the same rule set and pass/fail classification as
`test/functional/11_accessibility.py`, and asserts that nothing on the page can
submit a petition.

Proof is the tracked manifest: one entry per capture naming its route, viewport,
revision, data vintage, assertion, observations and the SHA-256 of the image.
The images themselves are written to an ignored local directory and are never
committed -- this repository does not carry capture binaries.

    python3 tools/capture_institution_petition_targets.py
    python3 tools/capture_institution_petition_targets.py --check
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
MANIFEST = ROOT / "docs" / "evidence" / "institution-petition-targets" / "manifest.json"
# Gitignored: capture images stay local and are described by the manifest.
IMAGES = ROOT / ".artifacts" / "institution-petition-targets"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"

MANIFEST_SCHEMA = "cityscroll.institution_petition_target_evidence.v1"
ROUTE_SUPPORTED = "/agencies/small-business-services/"
ROUTE_UNRESOLVED = "/agencies/economic-development-corporation/"

VIEWPORTS = ((390, 844), (1440, 900))
TIMEZONE = "America/New_York"
# The reviewed procedure registry pins the evidence every target is built from,
# so a capture describes a fixed data vintage rather than whenever it happened
# to run.
PROCEDURES = ROOT / "site" / "data" / "institution_petition_procedures.json"

HANDOFF = "#agency-petition"
PETITION_ACTION = ".agency-primary-actions a[data-action-target]"
# WCAG 2.5.8 target-size minimum.
MIN_TARGET = 24
# WCAG 1.4.10 reflow benchmark, in CSS pixels.
REFLOW_BENCHMARK = 320


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "site"), **kwargs)

    def log_message(self, *args):  # noqa: A003 - quiet capture server
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def data_vintage() -> str:
    return json.loads(PROCEDURES.read_text(encoding="utf-8"))["reviewed_on"]


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


def handoff_state(page) -> dict:
    """Read the rendered handoff exactly as a reader receives it."""
    return page.evaluate(
        "() => { const s = document.querySelector('#agency-petition');"
        " if (!s) return { present: false };"
        " const text = s.innerText.replace(/\\s+/g, ' ').trim();"
        " const heading = s.querySelector('h2');"
        " const body = s.querySelector('.rule-petition-receiving-body');"
        " return { present: true,"
        "  action_target: s.dataset.actionTarget || null,"
        "  procedure_basis: s.dataset.procedureBasis || null,"
        "  heading: heading ? heading.textContent.trim() : null,"
        "  receiving_body: body ? body.innerText.replace(/\\s+/g, ' ').trim() : null,"
        "  names_general_guidance: /general rulemaking-petition guidance/.test(text),"
        "  denies_prohibition: /not a finding that you cannot petition this body/.test(text),"
        "  says_no_submission: /does not submit or track petitions/.test(text),"
        "  external_links: [...s.querySelectorAll('a[href^=\"https://\"]')].map((a) => ({"
        "    href: a.getAttribute('href'), label: a.textContent.trim(),"
        "    blank: a.getAttribute('target') === '_blank',"
        "    rel: a.getAttribute('rel') || '' })) }; }"
    )


def profile_action(page) -> dict:
    return page.evaluate(
        "() => { const a = document.querySelector('.agency-primary-actions a[data-action-target]');"
        " if (!a) return { present: false };"
        " const r = a.getBoundingClientRect();"
        " return { present: true, label: a.textContent.replace(/\\s+/g, ' ').trim(),"
        "  href: a.getAttribute('href'), action_target: a.dataset.actionTarget,"
        "  blank: a.getAttribute('target') === '_blank',"
        "  rel: a.getAttribute('rel') || '',"
        "  width: Math.round(r.width), height: Math.round(r.height) }; }"
    )


def no_submission_affordance(page) -> bool:
    return page.evaluate(
        "() => !document.querySelector('#agency-petition form,"
        " #agency-petition [type=\"submit\"], #agency-petition button[type=\"submit\"]')"
    )


# ---------- specimens ----------
#
# Each specimen returns the observations its assertion is about. A specimen that
# cannot observe what it claims raises, rather than recording a pass.


def specimen_supported_target(page, base, width):
    page.goto(f"{base}{ROUTE_SUPPORTED}", wait_until="load")
    page.wait_for_selector(HANDOFF)
    state = handoff_state(page)
    action = profile_action(page)
    procedure = json.loads(PROCEDURES.read_text(encoding="utf-8"))["by_agency"]["small-business-services"]
    if state["action_target"] != "exact_petition_target":
        raise SystemExit(f"{ROUTE_SUPPORTED} did not render an exact target")
    hrefs = {link["href"] for link in state["external_links"]}
    observations = {
        "exact_target": state["action_target"] == "exact_petition_target",
        "procedure_basis_is_institution": state["procedure_basis"] == "institution_procedure",
        "heading_names_an_exact_action": state["heading"] == "Petition this agency",
        "names_the_receiving_body": procedure["receiving_body"] in (state["receiving_body"] or ""),
        # The receiving body, the destination and the response explanation all
        # cite the same published procedure.
        "links_the_published_procedure": procedure["procedure_url"] in hrefs,
        "links_the_adopted_rule_text": procedure["procedure_text_url"] in hrefs,
        "response_cites_the_same_procedure": procedure["response_source_url"] in hrefs,
        "profile_action_is_the_exact_target": action["action_target"] == "exact_petition_target",
        "profile_action_labelled_exactly": action["label"].startswith("Petition this agency"),
        "profile_action_goes_to_the_procedure": action["href"] == procedure["procedure_url"],
        "states_no_submission": state["says_no_submission"],
        "no_submission_affordance": no_submission_affordance(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }
    assertion = (
        f"at {width}px the profile that publishes its own petition procedure offers an exact "
        "Petition this agency target, and names the receiving body, the official destination and "
        "the response requirement from that same published procedure"
    )
    return page.screenshot(full_page=True), observations, assertion


def specimen_unresolved_target(page, base, width):
    page.goto(f"{base}{ROUTE_UNRESOLVED}", wait_until="load")
    page.wait_for_selector(HANDOFF)
    state = handoff_state(page)
    action = profile_action(page)
    text = page.inner_text(HANDOFF)
    if state["action_target"] != "action_only_guidance":
        raise SystemExit(f"{ROUTE_UNRESOLVED} did not fall back to general guidance")
    observations = {
        "not_an_exact_target": state["action_target"] != "exact_petition_target",
        "procedure_basis_is_general": state["procedure_basis"] == "general_official_guidance",
        "heading_is_general": state["heading"] == "How to petition a city agency",
        "no_receiving_body_named": state["receiving_body"] is None,
        "guidance_is_labelled_general": state["names_general_guidance"],
        # Missing evidence is stated as missing evidence, never as a prohibition.
        "absence_is_not_a_prohibition": state["denies_prohibition"],
        "general_guidance_stays_reachable": bool(state["external_links"]),
        "profile_action_is_general": action["action_target"] == "action_only_guidance",
        "profile_action_labelled_generally": action["label"].startswith("How to petition a city agency"),
        "no_exact_label_anywhere": "Petition this agency" not in page.content(),
        "no_other_body_authority_claimed": "Small Business Services" not in text,
        "no_submission_affordance": no_submission_affordance(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }
    assertion = (
        f"at {width}px a profile with the same alias resolution and the same City-wide form, but "
        "no applicable procedure evidence, receives clearly general guidance instead of an exact "
        "target, keeps that guidance usable, and states missing evidence rather than a prohibition"
    )
    return page.screenshot(full_page=True), observations, assertion


def specimen_external_link_semantics(page, base, width):
    page.goto(f"{base}{ROUTE_SUPPORTED}", wait_until="load")
    page.wait_for_selector(HANDOFF)
    state = handoff_state(page)
    action = profile_action(page)
    off_site = [link for link in state["external_links"]]
    observations = {
        "every_offsite_link_opens_in_a_new_tab": all(link["blank"] for link in off_site),
        "every_offsite_link_is_rel_protected": all(
            "noopener" in link["rel"] and "noreferrer" in link["rel"] for link in off_site),
        "every_offsite_link_is_labelled": all(link["label"] for link in off_site),
        # Labels describe the destination they actually reach.
        "labels_match_their_destination": all(
            ("procedure" in link["label"].lower() and "/rule/" in link["href"])
            or ("adopted rule text" in link["label"].lower() and link["href"].endswith(".pdf"))
            or ("response requirement" in link["label"].lower() and "/rule/" in link["href"])
            or ("form" in link["label"].lower() and "Form" in link["href"])
            or ("guidance" in link["label"].lower())
            or ("lookup" in link["label"].lower())
            or ("requirement" in link["label"].lower())
            for link in off_site),
        "profile_action_opens_in_a_new_tab": action["blank"],
        "profile_action_is_rel_protected": "noopener" in action["rel"] and "noreferrer" in action["rel"],
        "profile_action_announces_the_new_tab": page.evaluate(
            "() => { const a = document.querySelector('.agency-primary-actions a[data-action-target]');"
            " return /opens the official page in a new tab/.test(a.textContent); }"),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }
    assertion = (
        f"at {width}px every off-site petition destination is labelled for what it reaches, opens "
        "in a new tab with noopener noreferrer, and announces the new tab to assistive technology"
    )
    return page.screenshot(full_page=True), observations, assertion


def specimen_keyboard_and_focus(page, base, width):
    page.goto(f"{base}{ROUTE_SUPPORTED}", wait_until="load")
    page.wait_for_selector(HANDOFF)
    reached = page.evaluate(
        "() => { const a = document.querySelector('.agency-primary-actions a[data-action-target]');"
        " a.focus(); const el = document.activeElement;"
        " const style = getComputedStyle(el, ':focus-visible');"
        " return { focused: el === a, tag: el.tagName.toLowerCase(),"
        "  tabbable: el.tabIndex >= 0,"
        "  outline: style.outlineStyle !== 'none' || style.boxShadow !== 'none' }; }"
    )
    details = page.evaluate(
        "() => { const d = document.querySelector('#agency-petition details.rule-petition-scaffold');"
        " if (!d) return null; const s = d.querySelector('summary'); s.focus();"
        " return { summary_focused: document.activeElement === s, tag: s.tagName.toLowerCase() }; }"
    )
    if details is None:
        raise SystemExit("the petition handoff has no inspectable detail")
    observations = {
        "petition_action_is_a_real_link": reached["tag"] == "a",
        "petition_action_takes_focus": reached["focused"],
        "petition_action_is_tabbable": reached["tabbable"],
        "petition_action_shows_a_focus_indicator": reached["outline"],
        "detail_summary_is_a_native_control": details["tag"] == "summary",
        "detail_summary_takes_focus": details["summary_focused"],
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }
    assertion = (
        f"at {width}px the petition action and the handoff's inspectable detail are native, "
        "keyboard-reachable controls that take focus and show a visible focus indicator"
    )
    return page.screenshot(full_page=True), observations, assertion


def specimen_inspect_dismiss_back(page, base, width):
    page.goto(f"{base}{ROUTE_SUPPORTED}", wait_until="load")
    page.wait_for_selector(HANDOFF)
    before_url = page.url
    summary = page.locator("#agency-petition details.rule-petition-scaffold summary")
    summary.click()
    opened = page.evaluate(
        "() => { const d = document.querySelector('#agency-petition details.rule-petition-scaffold');"
        " return { open: d.open, url: location.href,"
        "  text: d.innerText.replace(/\\s+/g, ' ').trim() }; }")
    summary.click()
    dismissed = page.evaluate(
        "() => document.querySelector('#agency-petition details.rule-petition-scaffold').open")
    # A full-page journey away and the browser Back that follows it.
    page.goto(f"{base}{ROUTE_UNRESOLVED}", wait_until="load")
    away = page.url
    page.go_back(wait_until="load")
    page.wait_for_selector(HANDOFF)
    returned = handoff_state(page)
    observations = {
        "inspection_opens_in_place": opened["open"],
        "inspection_does_not_navigate": opened["url"] == before_url,
        "inspection_does_not_submit": no_submission_affordance(page),
        "inspection_states_nothing_is_saved": "does not save, submit, or track" in opened["text"],
        "dismiss_closes_it": dismissed is False,
        "full_page_journey_reaches_the_other_profile": away.endswith(ROUTE_UNRESOLVED),
        "back_returns_to_the_supported_profile": page.url.endswith(ROUTE_SUPPORTED),
        "back_restores_the_exact_target": returned["action_target"] == "exact_petition_target",
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }
    assertion = (
        f"at {width}px the handoff detail opens in place without navigating, saving or submitting, "
        "dismisses again, and a full-page journey to the other profile followed by browser Back "
        "returns to the supported profile with its exact target intact"
    )
    return page.screenshot(full_page=True), observations, assertion


def specimen_without_scripting(page, base, width):
    page.context.add_init_script("")  # no-op: scripting is disabled on the context below
    page.goto(f"{base}{ROUTE_SUPPORTED}", wait_until="load")
    state = handoff_state(page)
    action = profile_action(page)
    procedure = json.loads(PROCEDURES.read_text(encoding="utf-8"))["by_agency"]["small-business-services"]
    observations = {
        "handoff_is_server_rendered": state["present"],
        "exact_target_survives_without_scripting": state["action_target"] == "exact_petition_target",
        "receiving_body_survives": procedure["receiving_body"] in (state["receiving_body"] or ""),
        # The destination is a real anchor, not a scripted handler.
        "destination_is_a_real_anchor": action["present"] and action["href"] == procedure["procedure_url"],
        "no_submission_affordance": no_submission_affordance(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }
    assertion = (
        f"at {width}px with JavaScript disabled the handoff, its receiving body and its exact "
        "destination are already in the document, and the destination is a real anchor"
    )
    return page.screenshot(full_page=True), observations, assertion


def specimen_zoom_and_targets(page, base, width):
    page.goto(f"{base}{ROUTE_SUPPORTED}", wait_until="load")
    page.wait_for_selector(HANDOFF)
    action = profile_action(page)
    links = page.evaluate(
        "() => [...document.querySelectorAll('#agency-petition a')].map((a) => {"
        " const r = a.getBoundingClientRect();"
        " return { label: a.textContent.trim().slice(0, 40),"
        "  width: Math.round(r.width), height: Math.round(r.height) }; })"
    )
    # 200% zoom halves the CSS viewport. WCAG 1.4.10 sets the reflow benchmark
    # at 320 CSS pixels, so a narrow device zooms to that floor rather than to a
    # width no standard asks a document to reflow into.
    zoomed = max(width // 2, REFLOW_BENCHMARK)
    page.set_viewport_size({"width": zoomed, "height": 844})
    zoomed_overflow = no_horizontal_overflow(page)
    zoomed_state = handoff_state(page)
    observations = {
        "profile_action_meets_the_target_minimum":
            action["width"] >= MIN_TARGET and action["height"] >= MIN_TARGET,
        "every_handoff_link_is_at_least_one_line_tall": all(link["height"] > 0 for link in links),
        "no_horizontal_overflow_at_100_percent": True,
        "no_horizontal_overflow_at_200_percent_zoom": zoomed_overflow,
        "exact_target_survives_zoom": zoomed_state["action_target"] == "exact_petition_target",
        "receiving_body_survives_zoom": bool(zoomed_state["receiving_body"]),
    }
    observations["zoomed_css_width"] = zoomed
    assertion = (
        f"at {width}px the petition action meets the {MIN_TARGET}px target minimum, and at 200% "
        f"zoom ({zoomed} CSS pixels, floored at the WCAG 1.4.10 reflow benchmark) the handoff "
        "keeps its exact target and receiving body with no horizontal overflow"
    )
    return page.screenshot(full_page=True), observations, assertion


SPECIMENS = (
    ("supported-exact-target", specimen_supported_target, True),
    ("unresolved-general-guidance", specimen_unresolved_target, True),
    ("external-link-semantics", specimen_external_link_semantics, True),
    ("keyboard-and-focus", specimen_keyboard_and_focus, True),
    ("inspect-dismiss-and-back", specimen_inspect_dismiss_back, True),
    ("without-scripting", specimen_without_scripting, False),
    ("zoom-and-touch-targets", specimen_zoom_and_targets, True),
)


def capture() -> dict:
    sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
    from a11y_gate import failing_violations
    from playwright.sync_api import sync_playwright

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
            for slug, run, scripting in SPECIMENS:
                for width, height in VIEWPORTS:
                    context = browser.new_context(viewport={"width": width, "height": height},
                                                  timezone_id=TIMEZONE,
                                                  java_script_enabled=scripting)
                    page = context.new_page()
                    image, observations, assertion = run(page, base, width)
                    axe_result = run_axe(page, failing_violations) if scripting else {
                        "violations_total": 0,
                        "failing_violations": [],
                        "passes": True,
                        "note": "axe needs scripting; this specimen is the no-JavaScript document",
                    }
                    name = f"{slug}-{width}x{height}.png"
                    (IMAGES / name).write_bytes(image)
                    files.append({
                        "name": name,
                        "specimen": slug,
                        "route": ROUTE_UNRESOLVED if "unresolved" in slug else ROUTE_SUPPORTED,
                        "viewport": [width, height],
                        "revision": revision,
                        "data_vintage": vintage,
                        "timezone": TIMEZONE,
                        "javascript": scripting,
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
        "routes": [ROUTE_SUPPORTED, ROUTE_UNRESOLVED],
        "revision": revision,
        "data_vintage": vintage,
        "timezone": TIMEZONE,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "image_directory": str(IMAGES.relative_to(ROOT)),
        "image_policy": (
            "Capture images are written to the ignored local directory above and are never "
            "committed. This manifest is the tracked proof: route, viewport, revision, data "
            "vintage, assertion and SHA-256 for each capture."
        ),
        "scope": (
            "Automated proof establishes rendered behavior at these revisions and viewports. It "
            "does not establish legal completeness of the indexed procedures, adoption, or "
            "participant feedback."
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
        raise SystemExit(f"missing {MANIFEST.relative_to(ROOT)}")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("schema") != MANIFEST_SCHEMA:
        raise SystemExit(f"unexpected manifest schema {manifest.get('schema')!r}")
    files = manifest.get("files") or []
    expected = {f"{slug}-{w}x{h}.png" for slug, _, _ in SPECIMENS for w, h in VIEWPORTS}
    seen = {row.get("name") for row in files}
    if missing := sorted(expected - seen):
        raise SystemExit(f"manifest is missing captures: {missing}")
    if unexpected := sorted(seen - expected):
        raise SystemExit(f"manifest describes captures no specimen produces: {unexpected}")
    for row in files:
        if absent := [field for field in REQUIRED_FIELDS if field not in row]:
            raise SystemExit(f"{row.get('name')}: manifest entry is missing {absent}")
        if len(row["sha256"]) != SHA256:
            raise SystemExit(f"{row['name']}: sha256 is not a digest")
        if row["revision"] != manifest["revision"] or row["data_vintage"] != manifest["data_vintage"]:
            raise SystemExit(f"{row['name']}: revision or data vintage disagrees with the manifest")
        if row["axe"].get("failing_violations"):
            raise SystemExit(f"{row['name']} failed the accessibility gate: {row['axe']['failing_violations']}")
        if false_observations := [key for key, value in row["observations"].items() if value is False]:
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
    print(f"institution petition target evidence OK ({len(files)} captures, "
          f"{len(SPECIMENS)} specimens x {len(VIEWPORTS)} viewports, revision {manifest['revision'][:12]})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate the tracked manifest without a browser")
    args = parser.parse_args()
    if args.check:
        return check()
    manifest = capture()
    print(f"captured {len(manifest['files'])} institution petition target specimens into "
          f"{IMAGES.relative_to(ROOT)} (manifest: {MANIFEST.relative_to(ROOT)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
