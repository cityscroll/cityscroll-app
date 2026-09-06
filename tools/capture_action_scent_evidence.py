#!/usr/bin/env python3
"""Headless browser evidence for the action-naming contract.

Drives `test/harness/action_scent_harness.html` -- a neutral, unshipped fixture
page that mounts the real Now listing renderer and the real shared month
component against the committed fixtures in
`test/fixtures/now_action_scent_fixtures.mjs` and
`test/fixtures/compact_calendar_fixtures.mjs`. No public route is mounted and no
publisher is contacted: every request that would leave the harness is
intercepted, recorded, and answered locally, so a specimen can assert that a
preview reached no publisher rather than assuming it.

Each specimen is a real interaction in a real engine, at 390 and 1440 pixels:
the named next step on every kind of Now card, an external submission beside
internal navigation, inspection that inspects and nothing else, close and the
focus that comes back, the full page and the Back that returns the reader to
where they were, keyboard-only operation, a modified click, the page as a
reader without scripting receives it, a failed optional enrichment, the 200
percent zoom reading, and touch targets. Every specimen also runs the vendored
axe-core gate, on the same rule set and pass/fail classification as
`test/functional/11_accessibility.py`.

Proof is the tracked manifest: one entry per capture naming its route,
viewport, revision, data vintage, assertion, observations, and the SHA-256 of
the image. The images themselves are written to an ignored local directory and
are never committed -- this repository does not carry capture binaries.

    python3 tools/capture_action_scent_evidence.py
    python3 tools/capture_action_scent_evidence.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs" / "evidence" / "action-naming" / "manifest.json"
# Gitignored: capture images stay local and are described by the manifest.
IMAGES = ROOT / ".artifacts" / "action-naming"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"

MANIFEST_SCHEMA = "cityscroll.action_naming_evidence.v1"
RECORD = "cityscroll-engineering/named-next-step-actions"
HARNESS = "test/harness/action_scent_harness.html"
ROUTE = "component-harness:action-naming"

VIEWPORTS = ((390, 844), (1440, 900))
# A browser at 200 percent zoom reports half the CSS viewport width, which is
# what decides every media query and every wrap in the component.
ZOOM_FACTOR = 2
# The committed fixture corpus pins the days every view is built for, so a
# capture describes a fixed data vintage rather than whenever it happened to run.
DATA_VINTAGE = "2026-08-03 (Now lane) / 2026-03-15 (shared month)"
TIMEZONE = "America/New_York"

CARD = ".now-card"
ACTION = ".now-card .act"
PRIMARY_ACTION = ".now-card .act.primary"
PREVIEW_BUTTON = ".compact-month-occ-preview:visible"
PREVIEW = "#calendar-event-preview"
PREVIEW_CLOSE = "[data-calendar-event-preview-close]"
PREVIEW_OPEN = "[data-calendar-event-preview-open]"
OCCURRENCE_LINK = ".compact-month-occ-link:visible"

# WCAG 2.5.8 target-size minimum.
TOUCH_TARGET_MINIMUM = 44

# Publisher hosts the fixtures name. A preview must reach none of them.
PUBLISHER_HOSTS = ("rules.cityofnewyork.us", "a860-gpp.nyc.gov", "a856-cityrecord.nyc.gov",
                   "www.nyc.gov", "cityscroll.org")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):  # noqa: A003 - quiet test server
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


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


def active_element(page) -> dict:
    return page.evaluate(
        "() => { const el = document.activeElement; return el ? {"
        " tag: el.tagName.toLowerCase(),"
        " klass: el.getAttribute('class'),"
        " uid: el.getAttribute('data-calendar-event-preview-uid'),"
        " text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),"
        " inPreview: Boolean(el.closest('#calendar-event-preview')) } : null; }"
    )


# Every control the Now lane offers, read the way a reader reads it: the visible
# name without the decorative glyph or the assistive-technology disclosure, the
# accessible name with the disclosure, and what the destination actually is.
LANE_CONTROLS = """
() => {
  const visible = (el) => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.sr-only, [aria-hidden="true"]').forEach((node) => node.remove());
    return (clone.textContent || '').replace(/\\s+/g, ' ').trim();
  };
  const accessible = (el) => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
    return (clone.textContent || '').replace(/\\s+/g, ' ').trim();
  };
  return [...document.querySelectorAll('.now-card')].map((card) => ({
    id: card.getAttribute('data-now-item'),
    lane: card.getAttribute('data-now-lane'),
    badge: visible(card.querySelector('.now-card-tags .tag')),
    date: (card.querySelector('.now-card-when b') || {}).textContent || '',
    dateLabel: visible(card.querySelector('.now-card-when span') || document.createElement('span')),
    title: visible(card.querySelector('h3')),
    agency: visible(card.querySelector('.now-card-agency') || document.createElement('p')),
    controls: [...card.querySelectorAll('.act')].map((a) => ({
      name: visible(a),
      accessibleName: accessible(a),
      href: a.getAttribute('href'),
      external: a.getAttribute('target') === '_blank',
      rel: a.getAttribute('rel'),
      glyph: Boolean(a.querySelector('[aria-hidden="true"]')),
      announced: Boolean(a.querySelector('.sr-only')),
      tag: a.tagName.toLowerCase(),
    })),
  }));
}
"""

SMALLEST_TARGET = """
() => {
  const controls = [...document.querySelectorAll('.now-card .act, .compact-month-occ-preview,'
    + ' .compact-month-day-more, #calendar-event-preview button, #calendar-event-preview a')]
    .filter((el) => el.getBoundingClientRect().height > 0);
  if (!controls.length) return { measured: 0, smallest: null, selector: null };
  let smallest = controls[0];
  for (const el of controls) {
    if (el.getBoundingClientRect().height < smallest.getBoundingClientRect().height) smallest = el;
  }
  const box = smallest.getBoundingClientRect();
  return {
    measured: controls.length,
    smallest: Math.round(box.height),
    width: Math.round(box.width),
    selector: smallest.getAttribute('class') || smallest.tagName.toLowerCase(),
  };
}
"""

POSITIONAL = re.compile(r"\b(?:below|above|further down|overleaf|on this page)\b", re.IGNORECASE)


def comparable(value: str) -> str:
    return re.sub(r"[^0-9a-z]+", " ", (value or "").lower()).strip()


def wait_for_preview_closed(page):
    """A closed dialog is not a hidden element to wait on; it is a state."""
    page.wait_for_function(
        "() => { const d = document.querySelector('#calendar-event-preview');"
        " return Boolean(d) && !d.open; }")


def wait_for_lane(page):
    page.wait_for_selector(CARD)
    page.wait_for_selector("#page[data-harness-state]")


# ---------- specimens ----------
#
# Each specimen returns the observations its assertion is about. A specimen that
# cannot observe what it claims raises, rather than recording a pass.


def specimen_named_next_step(page, base, width, requests):
    """Every act-by card states three different things and names its next step."""
    page.goto(f"{base}", wait_until="load")
    wait_for_lane(page)
    cards = page.evaluate(LANE_CONTROLS)
    act_by = [card for card in cards if card["lane"] == "act_by"]
    if not act_by:
        raise SystemExit("the Now fixture no longer produces an act-by card")

    positional = [control["accessibleName"] for card in cards for control in card["controls"]
                  if POSITIONAL.search(control["accessibleName"])]
    duplicates = [card["id"] for card in act_by
                  if any(comparable(control["name"]) == comparable(card["badge"])
                         or (card["dateLabel"] and comparable(control["name"]) == comparable(card["dateLabel"]))
                         for control in card["controls"])]
    reported = next((card for card in act_by if card["id"] == "money:bid-open"), None)
    if not reported:
        raise SystemExit("the reported procurement card is no longer in the lane")
    shot = page.screenshot(full_page=True)
    return shot, {
        "act_by_cards": len(act_by),
        "no_control_promises_material_elsewhere_on_the_page": not positional,
        "no_control_repeats_a_fact_beside_it": not duplicates,
        "every_card_states_its_window_kind": all(card["badge"] for card in act_by),
        "every_card_keeps_its_title": all(card["title"] for card in cards),
        "every_card_keeps_its_exact_date": all(card["date"] for card in cards),
        "every_card_keeps_its_agency": all(card["agency"] for card in cards),
        "reported_card_badge": reported["badge"],
        "reported_card_next_step": reported["controls"][0]["name"],
        "reported_card_destination": reported["controls"][0]["href"],
        "reported_card_names_its_destination":
            reported["controls"][0]["name"] == "View response instructions",
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px each of the {len(act_by)} act-by cards states its window kind, its exact "
        "date and its next step as three different things; the reported procurement card now reads "
        f"\"{reported['controls'][0]['name']}\" and points at {reported['controls'][0]['href']}, "
        "and no control on the lane promises material positioned elsewhere on the page"
    )


def specimen_handoff_versus_navigation(page, base, width, requests):
    """External submission and internal navigation are visibly different."""
    page.goto(f"{base}", wait_until="load")
    wait_for_lane(page)
    controls = [control for card in page.evaluate(LANE_CONTROLS) for control in card["controls"]]
    external = [control for control in controls if control["external"]]
    internal = [control for control in controls if not control["external"]]
    if not external or not internal:
        raise SystemExit("the fixture no longer offers both an external and an internal next step")
    shot = page.screenshot(full_page=True)
    return shot, {
        "external_controls": len(external),
        "internal_controls": len(internal),
        "every_handoff_carries_a_visible_signifier": all(control["glyph"] for control in external),
        "every_handoff_announces_the_new_tab": all(control["announced"] for control in external),
        "every_handoff_isolates_the_opener":
            all("noopener" in (control["rel"] or "") for control in external),
        "no_internal_control_is_dressed_as_a_handoff":
            not any(control["glyph"] or control["announced"] for control in internal),
        "every_handoff_keeps_an_internal_way_on_beside_it":
            all(any(not other["external"] for other in card["controls"])
                for card in page.evaluate(LANE_CONTROLS)
                if any(control["external"] for control in card["controls"])),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the {len(external)} external submission controls each carry the arrow, the "
        "isolated new tab and the announcement that goes with one, while the "
        f"{len(internal)} internal controls carry none of that — and every card offering a handoff "
        "still offers an ordinary internal link beside it"
    )


def specimen_preview_inspects_only(page, base, width, requests):
    """Inspection answers in place: no navigation, no subscription, no publisher."""
    page.goto(f"{base}?handoff=on", wait_until="load")
    page.wait_for_selector(PREVIEW_BUTTON)
    before_url = page.url
    requests.clear()
    page.locator(PREVIEW_BUTTON).first.click()
    page.wait_for_selector(f"{PREVIEW}[open]")
    body = page.evaluate(
        "() => { const d = document.querySelector('#calendar-event-preview');"
        " return { text: d.innerText.replace(/\\s+/g, ' ').trim(),"
        " forms: d.querySelectorAll('form, input').length,"
        " subscriptions: d.innerHTML.match(/webcal:|\\\\.ics\\\\b/i) ? 1 : 0,"
        " buttons: [...d.querySelectorAll('button')].map((b) => b.getAttribute('type')),"
        " links: [...d.querySelectorAll('a')].map((a) => ({"
        "   name: a.textContent.replace(/\\\\s+/g, ' ').trim(),"
        "   href: a.getAttribute('href'), external: a.getAttribute('target') === '_blank' })),"
        " labelled: d.getAttribute('aria-labelledby') }; }")
    publisher_requests = [url for url in requests if any(host in url for host in PUBLISHER_HOSTS)]
    shot = page.screenshot(full_page=True)
    return shot, {
        "the_reader_stayed_on_the_page": page.url == before_url,
        "the_preview_is_labelled_by_its_own_heading": bool(body["labelled"]),
        "the_preview_submits_nothing": body["forms"] == 0,
        "the_preview_changes_no_subscription": body["subscriptions"] == 0,
        "every_control_in_it_is_an_explicit_button":
            all(kind == "button" for kind in body["buttons"]),
        "no_publisher_was_contacted": not publisher_requests,
        "requests_made_while_inspecting": len(requests),
        "the_publisher_record_is_offered_as_a_handoff":
            any(link["external"] for link in body["links"]),
        "the_page_for_the_event_is_named_for_what_it_opens":
            any(link["name"].startswith("Open the") for link in body["links"]),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px activating a preview opens a bounded summary in place: the reader stays on "
        f"the same URL, the panel submits nothing and subscribes to nothing, {len(requests)} "
        "requests were made and none of them reached a publisher, and the publisher's record inside "
        "the panel is offered as the handoff it is rather than as another page of this site"
    )


def specimen_close_and_return_focus(page, base, width, requests):
    page.goto(f"{base}", wait_until="load")
    page.wait_for_selector(PREVIEW_BUTTON)
    trigger = page.locator(PREVIEW_BUTTON).first
    uid = trigger.get_attribute("data-calendar-event-preview-uid")
    trigger.click()
    page.wait_for_selector(f"{PREVIEW}[open]")
    focus_in = active_element(page)
    page.locator(PREVIEW_CLOSE).click()
    wait_for_preview_closed(page)
    focus_back = active_element(page)

    # And again with Escape, which a native modal dialog handles itself.
    trigger.click()
    page.wait_for_selector(f"{PREVIEW}[open]")
    page.keyboard.press("Escape")
    wait_for_preview_closed(page)
    focus_after_escape = active_element(page)
    shot = page.screenshot(full_page=True)
    return shot, {
        "focus_moves_into_the_panel": focus_in["inPreview"],
        "focus_lands_on_close_first": focus_in["text"] == "Close",
        "close_returns_focus_to_the_control_that_opened_it": focus_back["uid"] == uid,
        "escape_closes_and_returns_focus_too": focus_after_escape["uid"] == uid,
        "focus_never_falls_to_the_document_body": focus_back["tag"] != "body",
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the preview takes focus onto its Close control, and both Close and Escape "
        "return focus to the exact trigger that opened it rather than dropping it on the document"
    )


def specimen_full_page_back_and_continue(page, base, width, requests):
    """The whole journey: inspect, open the full page, come back, carry on."""
    page.goto(f"{base}", wait_until="load")
    wait_for_lane(page)
    page.wait_for_selector(PREVIEW_BUTTON)
    trigger = page.locator(PREVIEW_BUTTON).first
    uid = trigger.get_attribute("data-calendar-event-preview-uid")
    trigger.click()
    page.wait_for_selector(f"{PREVIEW}[open]")
    destination = page.locator(PREVIEW_OPEN).get_attribute("href")
    page.locator(PREVIEW_OPEN).click()
    page.wait_for_selector("#stub")
    arrived = page.evaluate("() => document.querySelector('#stub').getAttribute('data-url')")

    page.go_back()
    wait_for_lane(page)
    page.wait_for_selector(PREVIEW_BUTTON)
    lane_after = page.evaluate(LANE_CONTROLS)
    # Continue the original task: the same event can be inspected again.
    # The shared renderer emits the month twice — a grid and a parallel agenda —
    # so one occurrence carries more than one trigger; only the one this
    # viewport actually shows is the one a reader can return to.
    page.locator(f'[data-calendar-event-preview-uid="{uid}"]:visible').first.click()
    page.wait_for_selector(f"{PREVIEW}[open]")
    reopened = page.evaluate(
        "() => document.querySelector('#calendar-event-preview-title').textContent")
    shot = page.screenshot(full_page=True)
    return shot, {
        "the_preview_offers_the_full_page_as_a_real_link": bool(destination),
        "the_full_page_link_went_where_it_said": arrived == destination,
        "back_restores_the_lane": len(lane_after) > 0,
        "back_restores_the_calendar": page.locator(".compact-month").count() > 0,
        "the_same_event_can_be_inspected_again": bool(reopened),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a reader inspects an event in place, follows the named full-page link to "
        f"{destination}, returns with Back to the same lane and month, and continues the original "
        "task by inspecting the same event again"
    )


def specimen_keyboard_only(page, base, width, requests):
    page.goto(f"{base}", wait_until="load")
    page.wait_for_selector(PREVIEW_BUTTON)
    page.locator(PREVIEW_BUTTON).first.focus()
    focused_trigger = active_element(page)
    page.keyboard.press("Enter")
    page.wait_for_selector(f"{PREVIEW}[open]")
    focus_in = active_element(page)
    contained = []
    for _ in range(6):
        page.keyboard.press("Tab")
        contained.append(active_element(page)["inPreview"])
    page.keyboard.press("Shift+Tab")
    contained.append(active_element(page)["inPreview"])
    reachable = page.evaluate(
        "() => { const links = [...document.querySelectorAll('#calendar-event-preview a')];"
        " return { total: links.length, hrefs: links.filter((a) => a.getAttribute('href')).length,"
        " focusable: links.filter((a) => a.tabIndex >= 0).length }; }")
    page.keyboard.press("Escape")
    wait_for_preview_closed(page)

    # The Now lane's controls are ordinary focusable links, in document order.
    lane_focusable = page.evaluate(
        "() => [...document.querySelectorAll('.now-card .act')]"
        ".filter((a) => a.tabIndex >= 0 && a.getAttribute('href')).length")
    lane_total = page.locator(ACTION).count()
    shot = page.screenshot(full_page=True)
    return shot, {
        "the_preview_trigger_takes_keyboard_focus":
            focused_trigger["klass"] == "compact-month-occ-preview",
        "enter_opens_the_preview": focus_in["inPreview"],
        "focus_is_contained_while_it_is_open": all(contained),
        "every_link_in_the_panel_is_a_real_destination": reachable["total"] == reachable["hrefs"],
        "every_link_in_the_panel_is_keyboard_reachable":
            reachable["total"] == reachable["focusable"],
        "every_next_step_on_the_lane_is_keyboard_reachable": lane_focusable == lane_total,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the preview opens from the keyboard alone and keeps focus inside it, and all "
        f"{lane_total} of the lane's next steps are ordinary focusable destinations"
    )


def specimen_modified_click_and_without_scripting(page, base, width, requests):
    """A link stays a link: nothing here intercepts a modified click."""
    page.goto(f"{base}", wait_until="load")
    page.wait_for_selector(OCCURRENCE_LINK)
    before_url = page.url
    # A modified click is the browser's, not this component's: no preview opens
    # and the reader is not navigated away from the month they were reading.
    page.locator(OCCURRENCE_LINK).first.click(modifiers=["Alt"])
    modified = {
        "opened_a_preview": page.locator(f"{PREVIEW}[open]").count() > 0,
        "navigated": page.url != before_url,
    }

    page.goto(f"{base}?enhance=off", wait_until="load")
    wait_for_lane(page)
    unscripted = page.evaluate(
        "() => ({ previews: document.querySelectorAll('.compact-month-occ-preview').length,"
        " visiblePreviews: [...document.querySelectorAll('.compact-month-occ-preview')]"
        "   .filter((b) => b.getBoundingClientRect().height > 0).length,"
        " occurrenceLinks: document.querySelectorAll('.compact-month-occ-link[href]').length,"
        " laneLinks: document.querySelectorAll('.now-card .act[href]').length })")
    lane = page.evaluate(LANE_CONTROLS)
    shot = page.screenshot(full_page=True)
    return shot, {
        "a_modified_click_opens_no_preview": not modified["opened_a_preview"],
        "a_modified_click_does_not_navigate_the_reader_away": not modified["navigated"],
        "without_scripting_no_inspection_control_is_offered": unscripted["visiblePreviews"] == 0,
        "without_scripting_every_occurrence_is_still_a_real_link":
            unscripted["occurrenceLinks"] > 0,
        "without_scripting_every_next_step_is_still_a_real_link":
            unscripted["laneLinks"] == sum(len(card["controls"]) for card in lane),
        "without_scripting_every_next_step_is_still_named":
            all(control["name"] for card in lane for control in card["controls"]),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a modified click on an occurrence is left to the browser — no preview opens "
        "and the reader is not navigated away — and with scripting off no inspection control is "
        f"offered at all while all {unscripted['laneLinks']} named next steps still work as links"
    )


def specimen_failed_enrichment(page, base, width, requests):
    """A failed optional enrichment leaves the facts and the link untouched."""
    page.goto(f"{base}?detail=fail", wait_until="load")
    page.wait_for_selector(PREVIEW_BUTTON)
    page.locator(PREVIEW_BUTTON).first.click()
    page.wait_for_selector(".calendar-event-preview-detail-status")
    body = page.evaluate(
        "() => { const d = document.querySelector('#calendar-event-preview');"
        " const open = d.querySelector('[data-calendar-event-preview-open]');"
        " return { title: d.querySelector('#calendar-event-preview-title').textContent,"
        " rows: d.querySelectorAll('.calendar-event-preview-row').length,"
        " status: d.querySelector('.calendar-event-preview-detail-status').textContent,"
        " openName: open.textContent.replace(/\\s+/g, ' ').trim(),"
        " openHref: open.getAttribute('href') }; }")
    shot = page.screenshot(full_page=True)
    return shot, {
        "the_selected_item_is_preserved": bool(body["title"]),
        "the_facts_it_was_admitted_with_are_preserved": body["rows"] > 0,
        "the_failure_is_stated_plainly": "did not load" in body["status"],
        "the_failure_says_the_link_is_unaffected": "unaffected" in body["status"],
        "the_canonical_link_still_works": bool(body["openHref"]),
        "the_canonical_link_is_still_named_for_what_it_opens":
            body["openName"].startswith("Open the"),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a preview whose optional enrichment fails keeps the selected item, every "
        "fact the cell was admitted with, and a working full-page link that is still named for "
        "what it opens; the failure is stated in its own line rather than replacing anything"
    )


def specimen_two_hundred_percent_zoom(page, base, width, requests):
    zoomed = max(1, width // ZOOM_FACTOR)
    page.set_viewport_size({"width": zoomed, "height": 844 // ZOOM_FACTOR + 200})
    page.goto(f"{base}", wait_until="load")
    wait_for_lane(page)
    lane_overflow = no_horizontal_overflow(page)
    lane = page.evaluate(LANE_CONTROLS)
    page.locator(PREVIEW_BUTTON).first.click()
    page.wait_for_selector(f"{PREVIEW}[open]")
    panel = page.evaluate(
        "() => { const d = document.querySelector('#calendar-event-preview');"
        " const box = d.getBoundingClientRect();"
        " return { width: Math.round(box.width), viewport: document.documentElement.clientWidth }; }")
    targets = page.evaluate(SMALLEST_TARGET)
    shot = page.screenshot(full_page=True)
    return shot, {
        "css_viewport_width": zoomed,
        "emulates": f"{ZOOM_FACTOR * 100}% browser zoom of a {width}px window",
        "lane_has_no_horizontal_overflow": lane_overflow,
        "panel_has_no_horizontal_overflow": no_horizontal_overflow(page),
        "panel_fits_the_viewport": panel["width"] <= panel["viewport"],
        "every_next_step_is_still_named":
            all(control["name"] for card in lane for control in card["controls"]),
        "smallest_visible_control_px": targets["smallest"],
    }, (
        f"at the {zoomed}px CSS viewport a 200 percent zoom of a {width}px window produces, the Now "
        "lane and the opened preview both read without any horizontal page scrolling, and every "
        "next step keeps its name"
    )


def specimen_touch_targets(page, base, width, requests):
    page.goto(f"{base}", wait_until="load")
    wait_for_lane(page)
    lane_targets = page.evaluate(SMALLEST_TARGET)
    page.locator(PREVIEW_BUTTON).first.click()
    page.wait_for_selector(f"{PREVIEW}[open]")
    panel_targets = page.evaluate(SMALLEST_TARGET)
    shot = page.screenshot(full_page=True)
    narrow = width <= 640
    floor = TOUCH_TARGET_MINIMUM if narrow else 24
    return shot, {
        "reading": "narrow" if narrow else "desktop",
        "controls_measured_on_the_lane": lane_targets["measured"],
        "smallest_lane_control_px": lane_targets["smallest"],
        "smallest_lane_control": lane_targets["selector"],
        "controls_measured_with_the_panel_open": panel_targets["measured"],
        "smallest_control_px": panel_targets["smallest"],
        "floor_px": floor,
        "every_control_meets_the_floor":
            lane_targets["smallest"] >= floor and panel_targets["smallest"] >= floor,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px every control this contract adds or renames — each named next step, the "
        f"inspection trigger and every control in the panel — is at least {floor}px tall, so none "
        "of them is a target a finger cannot land on"
    )


SPECIMENS = (
    ("named-next-step", specimen_named_next_step),
    ("handoff-versus-navigation", specimen_handoff_versus_navigation),
    ("preview-inspects-only", specimen_preview_inspects_only),
    ("close-and-return-focus", specimen_close_and_return_focus),
    ("full-page-back-and-continue", specimen_full_page_back_and_continue),
    ("keyboard-only", specimen_keyboard_only),
    ("modified-click-and-without-scripting", specimen_modified_click_and_without_scripting),
    ("failed-optional-enrichment", specimen_failed_enrichment),
    ("two-hundred-percent-zoom", specimen_two_hundred_percent_zoom),
    ("touch-targets", specimen_touch_targets),
)


def install_offline_routing(context, origin: str, requests: list):
    """Answer every destination locally, and record what was requested.

    Nothing here contacts a publisher, and a full-page link can still be
    followed and returned from: a request the harness itself does not serve is
    answered with a stub that names the URL it was asked for, so a specimen can
    assert that a link went where its name said it would.
    """
    def handler(route, request):
        url = request.url
        served = url.startswith(origin) and ("/site/" in url or "/test/" in url or url.startswith(f"{origin}/test"))
        if served:
            route.continue_()
            return
        requests.append(url)
        route.fulfill(
            status=200,
            content_type="text/html; charset=utf-8",
            body=("<!doctype html><html lang=\"en\"><head><title>Stub destination</title></head>"
                  f"<body><main id=\"stub\" data-url=\"{url}\"><h1>Stub destination</h1>"
                  f"<p>{url}</p></main></body></html>"),
        )

    context.route("**/*", handler)


def capture() -> dict:
    sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
    from a11y_gate import failing_violations
    from playwright.sync_api import sync_playwright

    IMAGES.mkdir(parents=True, exist_ok=True)
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    revision = git_revision()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    base = f"{origin}/{HARNESS}"

    files = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for slug, run in SPECIMENS:
                for width, height in VIEWPORTS:
                    context = browser.new_context(viewport={"width": width, "height": height},
                                                  timezone_id=TIMEZONE)
                    requests = []
                    install_offline_routing(context, origin, requests)
                    page = context.new_page()
                    image, observations, assertion = run(page, base, width, requests)
                    axe_result = run_axe(page, failing_violations)
                    name = f"{slug}-{width}x{height}.png"
                    (IMAGES / name).write_bytes(image)
                    files.append({
                        "name": name,
                        "specimen": slug,
                        "route": ROUTE,
                        "harness": HARNESS,
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
        "record": RECORD,
        "route": ROUTE,
        "harness": HARNESS,
        "revision": revision,
        "data_vintage": DATA_VINTAGE,
        "timezone": TIMEZONE,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "image_directory": str(IMAGES.relative_to(ROOT)),
        "image_policy": (
            "Capture images are written to the ignored local directory above and are never "
            "committed. This manifest is the tracked proof: route, viewport, revision, data "
            "vintage, assertion, observations and SHA-256 for each capture."
        ),
        "measurement_policy": (
            "Every observation is a measurement of what the rendered document does. No participant "
            "evaluation was run and no usability gain is claimed."
        ),
        "network_policy": (
            "Every destination outside the harness's own files is intercepted and answered locally, "
            "so no publisher is contacted and a full-page link can still be followed and returned "
            "from. The preview specimen records the requests made while inspecting."
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
    if manifest.get("record") != RECORD:
        raise SystemExit(f"manifest is not owned by {RECORD}")
    files = manifest.get("files") or []
    expected = {f"{slug}-{width}x{height}.png" for slug, _ in SPECIMENS for width, height in VIEWPORTS}
    found = {row.get("name") for row in files}
    missing = expected - found
    if missing:
        raise SystemExit(f"missing capture entries: {sorted(missing)}")
    unexpected = found - expected
    if unexpected:
        raise SystemExit(f"manifest describes captures no specimen produces: {sorted(unexpected)}")
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
    print(f"action naming evidence OK ({len(files)} captures, "
          f"{len(SPECIMENS)} specimens x {len(VIEWPORTS)} viewports, revision {manifest['revision'][:12]})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate the tracked manifest without a browser")
    args = parser.parse_args()
    if args.check:
        return check()
    manifest = capture()
    print(f"captured {len(manifest['files'])} action naming specimens into "
          f"{IMAGES.relative_to(ROOT)} (manifest: {MANIFEST.relative_to(ROOT)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
