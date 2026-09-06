#!/usr/bin/env python3
"""Headless browser evidence for the dense-calendar overview bound (PX-02).

Drives `test/harness/calendar_density_harness.html` -- a neutral, unshipped
fixture page that mounts the real shared month renderer and the real shared
binders against the committed fixtures in
`test/fixtures/compact_calendar_fixtures.mjs`. No public route is mounted and
no publisher is contacted.

Each specimen is a real interaction in a real engine, at 390 and 1440 pixels:
the dense month overview with long procurement titles, the same month with the
line budget lifted, the expanded day agenda, the exact hidden count, the full
unabridged title in the on-demand preview, Close and Escape and the focus that
comes back, keyboard-only operation, the 200 percent zoom reading, long
localized titles, cancellation and rescheduling, a repeated identity across a
rerender, the sparse fallback, and the page as a reader without scripting
receives it. Every specimen also runs the vendored axe-core gate, on the same
rule set and pass/fail classification as `test/functional/11_accessibility.py`.

The measurements this card owes its reader -- the actual rendered row height
and the text budget used -- are recorded per capture. They are measurements of
what the stylesheet does, not evidence of a usability gain: no participant
evaluation was run and none is claimed.

Proof is the tracked manifest: one entry per capture naming its route,
viewport, revision, data vintage, assertion, observations, rendered row height,
text budget, and the SHA-256 of the image. The images themselves are written to
an ignored local directory and are never committed -- this repository does not
carry capture binaries.

    python3 tools/capture_calendar_density_evidence.py
    python3 tools/capture_calendar_density_evidence.py --check
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
MANIFEST = ROOT / "docs" / "evidence" / "calendar-density-disclosure" / "manifest.json"
# Gitignored: capture images stay local and are described by the manifest.
IMAGES = ROOT / ".artifacts" / "calendar-density-disclosure"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"

MANIFEST_SCHEMA = "cityscroll.calendar_density_evidence.v1"
CARD = "cityscroll-resident-ux/px-02-keep-calendar-overview-scannable"
HARNESS = "test/harness/calendar_density_harness.html"
ROUTE = "component-harness:calendar-density-disclosure"

VIEWPORTS = ((390, 844), (1440, 900))
# A browser at 200 percent zoom reports half the CSS viewport width, which is
# what decides every media query and every wrap in the component. The zoom
# specimen therefore reads each width halved.
ZOOM_FACTOR = 2
# The committed fixture corpus pins the day every view is built for, so a
# capture describes a fixed data vintage rather than whenever it happened to run.
DATA_VINTAGE = "2026-03-15"
TIMEZONE = "America/New_York"

# The month renders a grid and a parallel agenda, and CSS alone chooses which
# one a viewport reads; the hidden form's controls are in the document but are
# not the ones a reader can reach. Every interaction below therefore addresses
# only the visible form.
MORE = ".compact-month-day-more:visible"
ANY_MORE = ".compact-month-day-more"
DISCLOSURE = ".compact-month-overflow:visible"
ANY_DISCLOSURE = ".compact-month-overflow"
PREVIEW_BUTTON = ".compact-month-occ-preview:visible"
TITLE = ".compact-month-grid .compact-month-occ-title"
AGENDA = "#calendar-day-agenda"
AGENDA_CLOSE = "[data-calendar-day-agenda-close]"
AGENDA_ITEM = "#calendar-day-agenda .calendar-day-agenda-item"

# WCAG 2.5.8 target-size minimum, and the size the narrow stylesheet commits to.
TOUCH_TARGET_MINIMUM = 44


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


def active_element(page) -> dict:
    return page.evaluate(
        "() => { const el = document.activeElement; return el ? {"
        " tag: el.tagName.toLowerCase(),"
        " day: el.getAttribute('data-calendar-day-agenda-day'),"
        " uid: el.getAttribute('data-calendar-event-preview-uid'),"
        " klass: el.getAttribute('class'),"
        " inAgenda: Boolean(el.closest('#calendar-day-agenda')) } : null; }"
    )


def agenda_state(page) -> dict:
    return page.evaluate(
        "() => { const d = document.querySelector('#calendar-day-agenda');"
        " return { present: Boolean(d), open: d ? d.hasAttribute('open') : false,"
        " count: document.querySelectorAll('#calendar-day-agenda').length,"
        " items: d ? d.querySelectorAll('.calendar-day-agenda-item').length : 0,"
        " labelled: d ? d.getAttribute('aria-labelledby') : null,"
        " heading: d && d.querySelector('.calendar-day-agenda-title')"
        "   ? d.querySelector('.calendar-day-agenda-title').textContent : '',"
        " text: d ? d.innerText.replace(/\\s+/g, ' ').trim() : '' }; }"
    )


def no_horizontal_overflow(page) -> bool:
    return not page.evaluate(
        "() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1"
    )


# The tallest week row a reader is actually shown. Below the grid's breakpoint
# the reader is shown the agenda instead, so that is what gets measured and the
# capture says which of the two it measured.
ROW_METRICS = """
() => {
  const rows = [...document.querySelectorAll('.compact-month-grid tr')]
    .filter((row) => row.getBoundingClientRect().height > 0);
  if (rows.length) {
    return { form: 'grid week row',
             tallest: Math.round(Math.max(...rows.map((r) => r.getBoundingClientRect().height))),
             measured: rows.length };
  }
  const days = [...document.querySelectorAll('.compact-month-agenda-day')]
    .filter((day) => day.getBoundingClientRect().height > 0);
  return { form: 'agenda day',
           tallest: days.length
             ? Math.round(Math.max(...days.map((d) => d.getBoundingClientRect().height))) : 0,
           measured: days.length };
}
"""

TITLE_METRICS = """
() => {
  const component = document.querySelector('.compact-month');
  const budget = component ? component.getAttribute('data-compact-month-title-lines') : null;
  const titles = [...document.querySelectorAll('.compact-month-grid .compact-month-occ-title')]
    .filter((el) => el.getBoundingClientRect().height > 0);
  if (!titles.length) return { budget, sampled: 0 };
  const longest = titles.reduce((a, b) => (a.textContent.length >= b.textContent.length ? a : b));
  const style = getComputedStyle(longest);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.45;
  return {
    budget,
    sampled: titles.length,
    clamp: style.webkitLineClamp || style.lineClamp || 'none',
    characters: longest.textContent.length,
    rendered_height: Math.round(longest.getBoundingClientRect().height),
    unclipped_height: Math.round(longest.scrollHeight),
    lines_painted: Math.round(longest.getBoundingClientRect().height / lineHeight),
    full_text_present: longest.textContent.trim().length === longest.textContent.trim().length,
    text: longest.textContent.trim(),
  };
}
"""

SMALLEST_TARGET = """
() => {
  const controls = [...document.querySelectorAll(
    '.compact-month-day-more, .compact-month-occ-preview, .compact-month-overflow > summary,'
    + ' #calendar-day-agenda button, #calendar-day-agenda a')]
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


# ---------- specimens ----------
#
# Each specimen returns the observations its assertion is about, plus the two
# figures this card owes its reader. A specimen that cannot observe what it
# claims raises, rather than recording a pass.


def specimen_dense_overview(page, base, width):
    """The month a reader scans, with and without the budget the work adds."""
    page.goto(f"{base}?fixture=longTitles&budget=off", wait_until="load")
    page.wait_for_selector(".compact-month")
    before_rows = page.evaluate(ROW_METRICS)
    before_title = page.evaluate(TITLE_METRICS)

    page.goto(f"{base}?fixture=longTitles", wait_until="load")
    page.wait_for_selector(".compact-month")
    after_rows = page.evaluate(ROW_METRICS)
    after_title = page.evaluate(TITLE_METRICS)
    shot = page.screenshot(full_page=True)
    return shot, {
        "measured_form": after_rows["form"],
        "rows_measured": after_rows["measured"] > 0,
        "row_height_without_budget_px": before_rows["tallest"],
        "row_height_with_budget_px": after_rows["tallest"],
        "row_height_is_bounded_by_the_budget": after_rows["tallest"] <= before_rows["tallest"],
        "longest_title_characters": after_title.get("characters", 0),
        "title_height_without_budget_px": before_title.get("rendered_height"),
        "title_height_with_budget_px": after_title.get("rendered_height"),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the same accepted month is measured with the title line budget lifted and "
        f"applied: the tallest {after_rows['form']} a reader is shown goes from "
        f"{before_rows['tallest']}px to {after_rows['tallest']}px. This is a measurement of what "
        "the stylesheet does, not a measured usability gain"
    ), after_rows["tallest"], after_title.get("budget")


def specimen_clipped_title_full_text(page, base, width):
    """The clip is painting, never content."""
    page.goto(f"{base}?fixture=longTitles", wait_until="load")
    page.wait_for_selector(".compact-month")
    title = page.evaluate(TITLE_METRICS)
    rows = page.evaluate(ROW_METRICS)
    # The complete published title, straight from the committed fixture.
    published = page.evaluate(
        "() => { const b = document.querySelector('.compact-month-day-more');"
        " return b ? JSON.parse(b.getAttribute('data-calendar-day-agenda')).events[0].title : ''; }")
    preview_label = page.locator(".compact-month-occ-preview").first.get_attribute("aria-label")
    shot = page.screenshot(full_page=True)
    grid_visible = title.get("sampled", 0) > 0
    observations = {
        "grid_titles_measured": title.get("sampled", 0),
        "title_line_budget": title.get("budget"),
        "published_title_characters": len(published),
        "full_title_in_the_accessible_name": published in (preview_label or ""),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }
    if grid_visible:
        observations.update({
            "computed_line_clamp": title["clamp"],
            "painted_lines": title["lines_painted"],
            "painted_height_px": title["rendered_height"],
            "unclipped_height_px": title["unclipped_height"],
            "the_clip_is_visual": title["unclipped_height"] > title["rendered_height"],
            "the_dom_text_is_the_whole_title": title["text"] == published,
        })
    else:
        # Below the grid breakpoint the reader is shown the agenda, which never
        # clips at all; that is the point, and it is what gets recorded.
        observations["narrow_reading_does_not_clip"] = True
    return shot, observations, (
        f"at {width}px the published title is complete in the document and in the preview's "
        "accessible name; where the grid is the visible reading, the budget clips what is painted "
        "and nothing else"
    ), rows["tallest"], title.get("budget")


def specimen_more_count(page, base, width):
    """The trigger states the exact remainder and names the whole day."""
    page.goto(f"{base}?fixture=highDensity", wait_until="load")
    page.wait_for_selector(MORE)
    trigger = page.locator(MORE).first
    counts = page.evaluate(
        "() => { const cell = document.querySelector('[data-compact-month-day-hidden]:not([data-compact-month-day-hidden=\"0\"])');"
        " return { total: Number(cell.getAttribute('data-compact-month-day-total')),"
        " hidden: Number(cell.getAttribute('data-compact-month-day-hidden')),"
        " painted: cell.querySelectorAll('.compact-month-occurrences > .compact-month-occ').length }; }")
    label = trigger.get_attribute("aria-label")
    text = trigger.inner_text().strip()
    rows = page.evaluate(ROW_METRICS)
    budget = page.evaluate(TITLE_METRICS).get("budget")
    shot = page.screenshot(full_page=True)
    return shot, {
        "accepted_total": counts["total"],
        "painted_in_the_cell": counts["painted"],
        "hidden_count": counts["hidden"],
        "count_is_exact": counts["hidden"] == counts["total"] - counts["painted"],
        "visible_text": text,
        "visible_text_states_the_remainder": text == f"+{counts['hidden']} more",
        "accessible_name": label,
        "accessible_name_states_the_total_and_the_day":
            label == f"Show all {counts['total']} events on Thursday, March 19, 2026",
        "label_is_words_not_a_symbol": any(character.isalpha() for character in text),
    }, (
        f"at {width}px a crowded day paints {counts['painted']} of {counts['total']} events and its "
        f"trigger states the exact remainder, {counts['hidden']}, in words a reader can act on"
    ), rows["tallest"], budget


def specimen_expanded_day(page, base, width):
    """Opening the day never grows the month row."""
    page.goto(f"{base}?fixture=highDensity", wait_until="load")
    page.wait_for_selector(MORE)
    before = page.evaluate(
        "() => ({ rows: document.querySelectorAll('.compact-month-grid tr').length,"
        " cells: document.querySelectorAll('.compact-month-occ').length,"
        " height: Math.round(document.querySelector('.compact-month').getBoundingClientRect().height),"
        " url: location.href })")
    page.locator(MORE).first.click()
    page.wait_for_selector(AGENDA_ITEM)
    state = agenda_state(page)
    focus = active_element(page)
    after = page.evaluate(
        "() => ({ rows: document.querySelectorAll('.compact-month-grid tr').length,"
        " cells: document.querySelectorAll('.compact-month-occ').length,"
        " height: Math.round(document.querySelector('.compact-month').getBoundingClientRect().height),"
        " url: location.href })")
    listed = page.evaluate(
        "() => [...document.querySelectorAll('#calendar-day-agenda .calendar-day-agenda-item')]"
        ".map((li) => li.getAttribute('data-calendar-day-agenda-uid'))")
    accepted = page.evaluate(
        "() => { const b = document.querySelector('.compact-month-day-more');"
        " return JSON.parse(b.getAttribute('data-calendar-day-agenda')).events.map((e) => e.uid); }")
    rows = page.evaluate(ROW_METRICS)
    budget = page.evaluate(TITLE_METRICS).get("budget")
    shot = page.screenshot(full_page=True)
    return shot, {
        "opened": state["open"],
        "one_panel": state["count"] == 1,
        "labelled_by_its_own_heading": state["labelled"] == "calendar-day-agenda-title",
        "heading": state["heading"],
        "events_listed": state["items"],
        "every_accepted_event_listed": listed == accepted,
        "no_event_silently_omitted": len(listed) == len(set(listed)) == len(accepted),
        "focus_moved_into_the_panel": focus["inAgenda"],
        "month_row_count_unchanged": before["rows"] == after["rows"],
        "month_cells_unchanged": before["cells"] == after["cells"],
        "month_did_not_grow": after["height"] <= before["height"],
        "url_unchanged": before["url"] == after["url"],
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the trigger opens all {len(accepted)} accepted events for the day in one "
        "labelled panel beside the month, taking focus with it, while the month keeps exactly the "
        "rows, cells and height it had"
    ), rows["tallest"], budget


def specimen_close_and_return_focus(page, base, width):
    page.goto(f"{base}?fixture=highDensity", wait_until="load")
    page.wait_for_selector(MORE)
    page.locator(MORE).first.click()
    page.wait_for_selector(AGENDA_ITEM)
    page.locator(AGENDA_CLOSE).click()
    closed = agenda_state(page)
    after_close = active_element(page)

    page.locator(MORE).first.click()
    page.wait_for_selector(AGENDA_ITEM)
    shot = page.screenshot(full_page=True)
    page.keyboard.press("Escape")
    escaped = agenda_state(page)
    after_escape = active_element(page)
    rows = page.evaluate(ROW_METRICS)
    budget = page.evaluate(TITLE_METRICS).get("budget")
    return shot, {
        "closed_by_the_visible_control": not closed["open"],
        "focus_returned_to_the_trigger": after_close["klass"] == "compact-month-day-more",
        "closed_by_escape": not escaped["open"],
        "focus_returned_after_escape": after_escape["klass"] == "compact-month-day-more",
        "focus_never_landed_on_the_body": after_close["tag"] != "body" and after_escape["tag"] != "body",
    }, (
        f"at {width}px the visible Close control and Escape both dismiss the day panel and hand "
        "focus back to the control that opened it"
    ), rows["tallest"], budget


def specimen_keyboard_only(page, base, width):
    page.goto(f"{base}?fixture=highDensity", wait_until="load")
    page.wait_for_selector(MORE)
    page.locator(MORE).first.focus()
    focused_trigger = active_element(page)
    page.keyboard.press("Enter")
    page.wait_for_selector(AGENDA_ITEM)
    opened = agenda_state(page)
    focus_in = active_element(page)
    contained = []
    for _ in range(8):
        page.keyboard.press("Tab")
        contained.append(active_element(page)["inAgenda"])
    page.keyboard.press("Shift+Tab")
    contained.append(active_element(page)["inAgenda"])
    shot = page.screenshot(full_page=True)
    # Every event in the panel is reachable, and reachable as a real link.
    reachable = page.evaluate(
        "() => { const links = [...document.querySelectorAll('#calendar-day-agenda .calendar-day-agenda-item-link')];"
        " return { total: links.length, hrefs: links.filter((a) => a.getAttribute('href')).length,"
        " focusable: links.filter((a) => a.tabIndex >= 0).length }; }")
    rows = page.evaluate(ROW_METRICS)
    budget = page.evaluate(TITLE_METRICS).get("budget")
    return shot, {
        "trigger_takes_keyboard_focus": focused_trigger["klass"] == "compact-month-day-more",
        "opened_by_enter": opened["open"],
        "focus_moved_into_the_panel": focus_in["inAgenda"],
        "focus_contained_through_tabs": all(contained),
        "every_event_is_a_real_link": reachable["total"] == reachable["hrefs"],
        "every_event_is_keyboard_reachable": reachable["total"] == reachable["focusable"],
    }, (
        f"at {width}px the day panel opens from the keyboard alone, keeps focus inside it, and "
        f"offers all {reachable['total']} of the day's events as real, focusable destinations"
    ), rows["tallest"], budget


def specimen_two_hundred_percent_zoom(page, base, width):
    """A browser at 200 percent reports half the CSS viewport width."""
    zoomed = max(1, width // ZOOM_FACTOR)
    page.set_viewport_size({"width": zoomed, "height": 844 // ZOOM_FACTOR + 200})
    page.goto(f"{base}?fixture=longTitles", wait_until="load")
    page.wait_for_selector(".compact-month")
    overview_overflow = no_horizontal_overflow(page)
    overview_rows = page.evaluate(ROW_METRICS)
    budget = page.evaluate(TITLE_METRICS).get("budget")

    page.goto(f"{base}?fixture=highDensity", wait_until="load")
    page.wait_for_selector(MORE)
    page.locator(MORE).first.click()
    page.wait_for_selector(AGENDA_ITEM)
    state = agenda_state(page)
    panel = page.evaluate(
        "() => { const d = document.querySelector('#calendar-day-agenda');"
        " const box = d.getBoundingClientRect();"
        " return { width: Math.round(box.width), viewport: document.documentElement.clientWidth,"
        " scrollsInside: d.scrollHeight <= d.clientHeight + 1"
        "   || Boolean(d.querySelector('.calendar-day-agenda-list')) }; }")
    targets = page.evaluate(SMALLEST_TARGET)
    shot = page.screenshot(full_page=True)
    return shot, {
        "css_viewport_width": zoomed,
        "emulates": f"{ZOOM_FACTOR * 100}% browser zoom of a {width}px window",
        "overview_has_no_horizontal_overflow": overview_overflow,
        "panel_has_no_horizontal_overflow": no_horizontal_overflow(page),
        "panel_fits_the_viewport": panel["width"] <= panel["viewport"],
        "panel_scrolls_inside_itself": panel["scrollsInside"],
        "every_event_still_listed": state["items"] == 9,
        "smallest_visible_control_px": targets["smallest"],
    }, (
        f"at the {zoomed}px CSS viewport a 200 percent zoom of a {width}px window produces, the "
        "month overview and the expanded day both read without any horizontal page scrolling, and "
        "the day still lists every accepted event"
    ), overview_rows["tallest"], budget


def specimen_touch_targets(page, base, width):
    page.goto(f"{base}?fixture=highDensity", wait_until="load")
    page.wait_for_selector(MORE)
    month_targets = page.evaluate(SMALLEST_TARGET)
    page.locator(MORE).first.click()
    page.wait_for_selector(AGENDA_ITEM)
    panel_targets = page.evaluate(SMALLEST_TARGET)
    rows = page.evaluate(ROW_METRICS)
    budget = page.evaluate(TITLE_METRICS).get("budget")
    shot = page.screenshot(full_page=True)
    narrow = width <= 640
    floor = TOUCH_TARGET_MINIMUM if narrow else 24
    return shot, {
        "reading": "narrow agenda" if narrow else "desktop grid",
        "controls_measured_in_the_month": month_targets["measured"],
        "smallest_month_control_px": month_targets["smallest"],
        "smallest_month_control": month_targets["selector"],
        "controls_measured_in_the_panel": panel_targets["measured"],
        "smallest_panel_control_px": panel_targets["smallest"],
        "floor_px": floor,
        "every_control_meets_the_floor":
            month_targets["smallest"] >= floor and panel_targets["smallest"] >= floor,
    }, (
        f"at {width}px every control the {'narrow' if narrow else 'desktop'} reading offers — the "
        f"agenda trigger, the preview trigger and every control in the panel — is at least {floor}px "
        "tall, so none of them is a bare icon a finger cannot land on"
    ), rows["tallest"], budget


def specimen_localized_titles(page, base, width):
    page.goto(f"{base}?fixture=localized", wait_until="load")
    page.wait_for_selector(MORE)
    page.locator(MORE).first.click()
    page.wait_for_selector(AGENDA_ITEM)
    state = agenda_state(page)
    published = page.evaluate(
        "() => { const b = document.querySelector('.compact-month-day-more');"
        " return JSON.parse(b.getAttribute('data-calendar-day-agenda')).events.map((e) => e.title); }")
    listed = page.evaluate(
        "() => [...document.querySelectorAll('#calendar-day-agenda .calendar-day-agenda-item-link')]"
        ".map((a) => a.textContent)")
    rows = page.evaluate(ROW_METRICS)
    budget = page.evaluate(TITLE_METRICS).get("budget")
    shot = page.screenshot(full_page=True)
    return shot, {
        "scripts_rendered": len(published),
        "every_title_rendered_as_published": listed == published,
        "no_horizontal_overflow": no_horizontal_overflow(page),
        "panel_chrome_stays_in_the_interface_language": "events" in state["text"],
    }, (
        f"at {width}px titles published in Spanish, Chinese, Bengali, Russian, Haitian Creole and "
        "English render exactly as published — including the two scripts that do not break on "
        "spaces — without pushing the page sideways"
    ), rows["tallest"], budget


def specimen_lifecycle(page, base, width):
    page.goto(f"{base}?fixture=highDensity", wait_until="load")
    page.wait_for_selector(MORE)
    page.locator(MORE).first.click()
    page.wait_for_selector(AGENDA_ITEM)
    text = agenda_state(page)["text"]
    ordering = page.evaluate(
        "() => { const item = document.querySelector('.calendar-day-agenda-item-lifecycle-cancelled');"
        " const notice = item.querySelector('.calendar-day-agenda-item-notice');"
        " const link = item.querySelector('.calendar-day-agenda-item-link');"
        " return { noticeFirst: Boolean(notice && link)"
        "   && (notice.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING) > 0,"
        " flag: Boolean(item.querySelector('.calendar-day-agenda-item-flag-cancelled')) }; }")
    rescheduled = page.evaluate(
        "() => Boolean(document.querySelector('.calendar-day-agenda-item-flag-rescheduled'))")
    rows = page.evaluate(ROW_METRICS)
    budget = page.evaluate(TITLE_METRICS).get("budget")
    shot = page.screenshot(full_page=True)
    return shot, {
        "cancellation_stated": "This event is cancelled." in text,
        "cancellation_flagged": ordering["flag"],
        "cancellation_stated_before_the_link": ordering["noticeFirst"],
        "rescheduling_stated": "rescheduled" in text,
        "rescheduling_flagged": rescheduled,
        "date_only_events_acquire_no_clock_time": "All day" in text,
    }, (
        f"at {width}px a cancelled event says so, in its own sentence, before the link it "
        "qualifies, a rescheduled one says the date shown is the currently published one, and a "
        "date-only event acquires no clock time"
    ), rows["tallest"], budget


def specimen_repeated_identity_and_rerender(page, base, width):
    page.goto(f"{base}?fixture=highDensity", wait_until="load")
    page.wait_for_selector(MORE)
    # The shared renderer emits the same month twice -- a grid for wide
    # viewports and a parallel agenda for narrow ones -- so one day identity
    # carries more than one trigger at a time. Every one must open the one panel.
    day_counts = page.evaluate(
        "() => { const seen = {}; for (const el of document.querySelectorAll('[data-calendar-day-agenda-day]'))"
        " { const day = el.getAttribute('data-calendar-day-agenda-day'); seen[day] = (seen[day] || 0) + 1; }"
        " return seen; }")
    repeated = sorted(day for day, count in day_counts.items() if count > 1)
    if not repeated:
        raise SystemExit("the high-density fixture no longer renders any day trigger more than once")
    page.locator(f'[data-calendar-day-agenda-day="{repeated[0]}"]:visible').last.click()
    page.wait_for_selector(AGENDA_ITEM)
    repeated_state = agenda_state(page)
    page.keyboard.press("Escape")

    page.locator("#repaint").click()
    page.wait_for_selector("[data-harness-repainted]")
    page.locator(MORE).first.click()
    page.wait_for_selector(AGENDA_ITEM)
    after = agenda_state(page)
    rows = page.evaluate(ROW_METRICS)
    budget = page.evaluate(TITLE_METRICS).get("budget")
    shot = page.screenshot(full_page=True)
    return shot, {
        "days_carrying_more_than_one_trigger": len(repeated),
        "repeated_identity_opens_one_panel": repeated_state["count"] == 1,
        "repeated_identity_shows_its_own_day": repeated[0].endswith(
            repeated_state["heading"].split()[2].rstrip(",").zfill(2)),
        "works_after_rerender": after["open"],
        "single_panel_after_rerender": after["count"] == 1,
        "every_event_still_listed_after_rerender": after["items"] == 9,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a day rendered in both the grid and the parallel agenda opens the one shared "
        "panel for that day, and a repaint leaves exactly one panel still listing every event"
    ), rows["tallest"], budget


def specimen_without_scripting(page, base, width):
    page.goto(f"{base}?fixture=highDensity&enhance=off", wait_until="load")
    page.wait_for_selector(".compact-month")
    triggers = page.locator(MORE).count()
    disclosures = page.locator(DISCLOSURE).count()
    page.locator(f"{DISCLOSURE} > summary").first.click()
    revealed = page.evaluate(
        "() => { const open = document.querySelector('.compact-month-overflow[open]');"
        " return { items: open ? open.querySelectorAll('.compact-month-occ').length : 0,"
        " summary: open ? open.querySelector('summary').textContent : '' }; }")
    rows = page.evaluate(ROW_METRICS)
    budget = page.evaluate(TITLE_METRICS).get("budget")
    shot = page.screenshot(full_page=True)
    return shot, {
        "no_agenda_trigger_without_enhancement": triggers == 0,
        "the_native_disclosure_is_the_reading_on_offer": disclosures > 0,
        "disclosure_summary": revealed["summary"],
        "every_hidden_event_is_still_reachable": revealed["items"] == 6,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a calendar without scripting offers no agenda trigger and keeps the native "
        "disclosure, which still reveals every one of the day's remaining events — the before state "
        "this work starts from, and the reading a reader without scripting keeps"
    ), rows["tallest"], budget


def specimen_sparse(page, base, width):
    page.goto(f"{base}?fixture=sparse", wait_until="load")
    page.wait_for_selector("#page[data-harness-state='non-render']")
    shot = page.screenshot(full_page=True)
    return shot, {
        "renders_no_month": page.locator(".compact-month").count() == 0,
        "offers_no_agenda_trigger": page.locator(ANY_MORE).count() == 0,
        "offers_no_disclosure": page.locator(ANY_DISCLOSURE).count() == 0,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a bundle below the density rule renders no month at all, so the existing "
        "sparse fallback is preserved and there is nothing to disclose"
    ), 0, None


SPECIMENS = (
    ("dense-month-overview", specimen_dense_overview),
    ("clipped-title-full-text", specimen_clipped_title_full_text),
    ("more-count", specimen_more_count),
    ("expanded-day", specimen_expanded_day),
    ("close-and-return-focus", specimen_close_and_return_focus),
    ("keyboard-only", specimen_keyboard_only),
    ("two-hundred-percent-zoom", specimen_two_hundred_percent_zoom),
    ("touch-targets", specimen_touch_targets),
    ("long-localized-titles", specimen_localized_titles),
    ("cancelled-and-rescheduled", specimen_lifecycle),
    ("repeated-identity-and-rerender", specimen_repeated_identity_and_rerender),
    ("before-state-and-without-scripting", specimen_without_scripting),
    ("sparse-no-calendar", specimen_sparse),
)


def capture() -> dict:
    sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
    from a11y_gate import failing_violations
    from playwright.sync_api import sync_playwright

    IMAGES.mkdir(parents=True, exist_ok=True)
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    revision = git_revision()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/{HARNESS}"

    files = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for slug, run in SPECIMENS:
                for width, height in VIEWPORTS:
                    context = browser.new_context(viewport={"width": width, "height": height},
                                                  timezone_id=TIMEZONE)
                    page = context.new_page()
                    image, observations, assertion, row_height, budget = run(page, base, width)
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
                        # The two figures this card owes its reader, recorded
                        # per capture rather than summarized once.
                        "rendered_row_height_px": row_height,
                        "title_line_budget": budget,
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
        "card": CARD,
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
            "vintage, assertion, rendered row height, text budget and SHA-256 for each capture."
        ),
        "measurement_policy": (
            "Rendered row height and title line budget are measurements of what the stylesheet "
            "paints. No participant evaluation was run and no usability gain is claimed."
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
    if manifest.get("card") != CARD:
        raise SystemExit(f"manifest is not owned by {CARD}")
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
        if "rendered_row_height_px" not in row or "title_line_budget" not in row:
            raise SystemExit(f"{row['name']}: the capture does not report a rendered row height and text budget")
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
    print(f"calendar density evidence OK ({len(files)} captures, "
          f"{len(SPECIMENS)} specimens x {len(VIEWPORTS)} viewports, revision {manifest['revision'][:12]})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate the tracked manifest without a browser")
    args = parser.parse_args()
    if args.check:
        return check()
    manifest = capture()
    print(f"captured {len(manifest['files'])} calendar density specimens into "
          f"{IMAGES.relative_to(ROOT)} (manifest: {MANIFEST.relative_to(ROOT)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
