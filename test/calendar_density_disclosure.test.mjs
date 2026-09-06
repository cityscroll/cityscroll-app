// PX-02: keeping a dense calendar month scannable without hiding the events.
//
// One shared bound, mounted through the one shared month renderer, so the
// eight calendar-bearing surfaces get the same contract. This suite pins:
//
//   A1 a tested visual line budget on grid titles, with the unabridged title
//      still in the document and in the on-demand preview, and kind, supplied
//      clock time, cancellation and rescheduling legible outside the clip
//   A2 stable ordering, exact hidden counts, a labelled agenda trigger that
//      opens every accepted event for the day beside the month rather than by
//      expanding the month row, the modal focus contract, and the retained
//      unenhanced disclosure and sparse non-render
//   A3 the narrow and zoomed reading: no hover-only title, no tooltip-only
//      fact, no bare-glyph target, and every action reachable by keyboard
//   A4 before/after equivalence over the same accepted occurrence set —
//      counts, ordering, dates, identities, lifecycle, canonical links
//   A5 the capture contract this card's evidence is recorded under
//
//   node --test test/calendar_density_disclosure.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  COMPACT_MONTH_TITLE_LINES_PROPERTY,
  COMPACT_MONTH_TITLE_LINE_BUDGET,
  MAX_VISIBLE_OCCURRENCES_PER_DAY,
  bindCompactMonthCalendar,
  bindCalendarEventPreview,
  buildCompactMonthView,
  renderCompactMonth,
} from "../site/compact_calendar.mjs";
import {
  CALENDAR_DAY_AGENDA_ATTRIBUTE,
  CALENDAR_DAY_AGENDA_DAY_ATTRIBUTE,
  CALENDAR_DAY_AGENDA_DIALOG_ID,
  CALENDAR_DAY_AGENDA_READY_ATTRIBUTE,
  CALENDAR_DAY_AGENDA_TITLE_ID,
  CALENDAR_DAY_AGENDA_UID_ATTRIBUTE,
  CALENDAR_DAY_AGENDA_VERSION,
  bindCalendarDayAgenda,
  calendarDayAgendaFacts,
  parseCalendarDayAgenda,
  renderCalendarDayAgendaBody,
  renderCalendarDayAgendaButton,
} from "../site/calendar_day_agenda.mjs";
import { CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE } from "../site/calendar_event_preview.mjs";
import { FIXTURE_TODAY, fixtureOccurrences } from "./fixtures/compact_calendar_fixtures.mjs";
import { click, describeNode, keydown, mountDocument } from "./helpers/preview_dom.mjs";
import { forbiddenVocabularyPattern } from "./helpers/internal_vocabulary.mjs";

const CSS = readFileSync(new URL("../site/compact_calendar.css", import.meta.url), "utf8");

function viewFor(name, today = FIXTURE_TODAY) {
  return buildCompactMonthView(fixtureOccurrences(name), { today });
}

function htmlFor(name, today = FIXTURE_TODAY) {
  return renderCompactMonth(viewFor(name, today));
}

function crowdedDay(view) {
  const day = view.weeks.flat().find((entry) => entry.hidden_count > 0);
  assert.ok(day, "the fixture is expected to produce a crowded day");
  return day;
}

/** Every day cell in the view, flattened, in grid order. */
function daysOf(view) {
  return view.weeks.flat();
}

/* ================= A1 — the visual line budget ================= */

test("A1: the renderer declares one reviewed line budget and paints it into the component", () => {
  assert.equal(COMPACT_MONTH_TITLE_LINE_BUDGET, 2);
  const html = htmlFor("longTitles");
  assert.match(html, new RegExp(`data-compact-month-title-lines="${COMPACT_MONTH_TITLE_LINE_BUDGET}"`));
  assert.match(html, new RegExp(`style="${COMPACT_MONTH_TITLE_LINES_PROPERTY}:${COMPACT_MONTH_TITLE_LINE_BUDGET}"`));
});

test("A1: the stylesheet clamps to the declared budget rather than a number of its own", () => {
  // The custom property is the whole point: a capture that measures the
  // rendered clip is measuring the number this module declares, not a second
  // number a stylesheet chose independently.
  assert.match(CSS, /-webkit-line-clamp:\s*var\(--compact-month-title-lines,\s*2\)/);
  assert.match(CSS, /\n\s*line-clamp:\s*var\(--compact-month-title-lines,\s*2\)/);
  const clampRule = CSS.slice(CSS.indexOf(".compact-month-grid .compact-month-occ-title"));
  assert.ok(clampRule.startsWith(".compact-month-grid .compact-month-occ-title"),
    "the clamp is scoped to the grid — the overview — and not to the component as a whole");
});

test("A1: the clip is visual only — the unabridged title stays in the document", () => {
  const view = viewFor("longTitles");
  const html = htmlFor("longTitles");
  const titles = daysOf(view).flatMap((day) => [...day.visible_occurrences, ...day.overflow_occurrences])
    .map((occurrence) => occurrence.title);
  assert.ok(titles.length >= 6);
  for (const title of titles) {
    assert.ok(html.includes(title), `the whole published title is in the document: ${title.slice(0, 40)}…`);
  }
  // Nothing abbreviates, elides or summarizes on the way to the page.
  assert.ok(!html.includes("…"), "no ellipsis is written into the content");
  assert.ok(!/\.\.\.<\/span>/.test(html), "no ellipsis is written into the content");
});

test("A1: kind, supplied clock time and lifecycle stay outside the clipped title", () => {
  const html = htmlFor("longTitles");
  // Kind and time are their own siblings of the title inside the link, and the
  // lifecycle flag is a sibling of the link itself, so the clamp — which
  // applies to the title element alone — can never take one of them.
  // A timed occurrence: kind, then the published clock time, then the title —
  // three siblings, so the clamp on the third can never take the first two.
  assert.match(html, /<span class="compact-month-occ-kind">Event<\/span><span class="compact-month-occ-time">6:30\s?PM<\/span><span class="compact-month-occ-title">/);
  // A date-only occurrence has no time span at all, which is itself the
  // distinction, and its kind still sits outside the title.
  assert.match(html, /<span class="compact-month-occ-kind">Deadline<\/span><span class="compact-month-occ-title">/);
  const lifecycle = renderCompactMonth(viewFor("lifecycle"));
  assert.match(lifecycle, /<span class="compact-month-occ-flag compact-month-occ-flag-cancelled">Cancelled<\/span>/);
  assert.match(lifecycle, /<span class="compact-month-occ-flag compact-month-occ-flag-rescheduled">Rescheduled<\/span>/);
  // Both flags sit after the closing anchor, never inside the clipped title.
  for (const flag of ["Cancelled", "Rescheduled"]) {
    const index = lifecycle.indexOf(`compact-month-occ-flag-${flag.toLowerCase()}`);
    assert.ok(lifecycle.lastIndexOf("</a>", index) > lifecycle.lastIndexOf("compact-month-occ-title", index),
      `${flag} is rendered outside the title element`);
  }
});

test("A1: only the grid clips — the narrow agenda, the day panel and print read in full", () => {
  assert.ok(!/\.compact-month-agenda[^{]*\{[^}]*line-clamp/.test(CSS),
    "the narrow agenda never clamps");
  assert.ok(!/\.calendar-day-agenda-item-link\s*\{[^}]*line-clamp/.test(CSS),
    "the day agenda panel never clamps");
  const printBlock = CSS.slice(CSS.lastIndexOf("@media print"));
  assert.match(CSS, /@media print[\s\S]*-webkit-line-clamp:\s*none\s*!important/,
    "print lifts the budget so every title prints complete");
  assert.ok(printBlock.length > 0);
});

/* ================= A2 — the day agenda ================= */

test("A2: a crowded day states the exact number of events its cell could not show", () => {
  const view = viewFor("highDensity");
  const day = crowdedDay(view);
  assert.equal(day.occurrence_count, 9);
  assert.equal(day.visible_occurrences.length, MAX_VISIBLE_OCCURRENCES_PER_DAY);
  assert.equal(day.hidden_count, 6);

  const facts = calendarDayAgendaFacts(day);
  assert.equal(facts.hidden, 6, "the count is the real remainder, never rounded or capped");
  assert.equal(facts.total, 9);
  assert.equal(facts.events.length, 9);

  const html = renderCompactMonth(view);
  // The visible text is the exact remainder; the accessible name states the
  // complete total and names the day, so the control is never a bare glyph.
  assert.match(html, />\+6 more<\/button>/);
  assert.match(html, /aria-label="Show all 9 events on Thursday, March 19, 2026"/);
});

test("A2: the agenda carries every accepted event for the day, in the cell's own order", () => {
  const view = viewFor("highDensity");
  const day = crowdedDay(view);
  const facts = calendarDayAgendaFacts(day);
  const expected = [...day.visible_occurrences, ...day.overflow_occurrences].map((entry) => entry.uid);
  assert.deepEqual(facts.events.map((event) => event.uid), expected);
  // Stable under a rebuild: the same accepted set produces the same order.
  const again = calendarDayAgendaFacts(crowdedDay(viewFor("highDensity")));
  assert.deepEqual(again.events.map((event) => event.uid), expected);
  // And nothing is silently omitted between the cell and the panel.
  assert.equal(new Set(expected).size, day.occurrence_count);
});

test("A2: the panel states kind, supplied time, cancellation and rescheduling for each event", () => {
  const facts = calendarDayAgendaFacts(crowdedDay(viewFor("highDensity")));
  const body = renderCalendarDayAgendaBody(facts);
  assert.match(body, new RegExp(`id="${CALENDAR_DAY_AGENDA_TITLE_ID}"`));
  assert.match(body, /<h2 class="calendar-day-agenda-title"[^>]*>Thursday, March 19, 2026<\/h2>/);
  assert.match(body, /<p class="calendar-day-agenda-count">9 events<\/p>/);
  assert.match(body, /calendar-day-agenda-item-flag-cancelled">Cancelled</);
  assert.match(body, /calendar-day-agenda-item-flag-rescheduled">Rescheduled</);
  assert.match(body, /This event is cancelled\./);
  assert.match(body, /This event was rescheduled; the date shown is the currently published one\./);
  // A date-only occurrence acquires no clock time it was never published with.
  assert.match(body, /<span class="calendar-day-agenda-item-time">All day<\/span>/);
  assert.match(body, /<span class="calendar-day-agenda-item-time">9:00\s?AM[^<]*<\/span>/);
  // Cancellation is stated before the event's link, not inferred from styling.
  const cancelledItem = body.slice(body.indexOf("calendar-day-agenda-item-lifecycle-cancelled"));
  assert.ok(cancelledItem.indexOf("This event is cancelled.") < cancelledItem.indexOf("<a class="),
    "cancellation is stated before the action it qualifies");
});

test("A2: every event in the panel keeps its own canonical destination as a real link", () => {
  const view = viewFor("highDensity");
  const day = crowdedDay(view);
  const body = renderCalendarDayAgendaBody(calendarDayAgendaFacts(day));
  for (const entry of [...day.visible_occurrences, ...day.overflow_occurrences]) {
    assert.ok(body.includes(`href="${entry.canonical_url}"`), `${entry.uid} keeps its canonical link`);
    assert.ok(body.includes(`${CALENDAR_DAY_AGENDA_UID_ATTRIBUTE}="${entry.uid}"`), `${entry.uid} is identified`);
    assert.ok(body.includes(`>${entry.title}</a>`), `${entry.uid} shows its unabridged title`);
  }
});

test("A2: a day whose cell shows everything it has offers no agenda trigger at all", () => {
  const view = viewFor("dense");
  for (const day of daysOf(view)) {
    assert.equal(day.hidden_count, 0);
    assert.equal(calendarDayAgendaFacts(day), null);
  }
  assert.ok(!renderCompactMonth(view).includes(CALENDAR_DAY_AGENDA_ATTRIBUTE));
});

test("A2: the unenhanced disclosure stays in the document, complete, as the reading that works without scripting", () => {
  const view = viewFor("highDensity");
  const html = renderCompactMonth(view);
  assert.match(html, /<details class="compact-month-overflow">/);
  assert.match(html, /<summary>\+6 more<\/summary>/);
  for (const entry of crowdedDay(view).overflow_occurrences) {
    assert.ok(html.includes(entry.uid), `${entry.uid} is in the document without any scripting`);
  }
  // The two readings are mutually exclusive, and the swap happens only once a
  // binding has revealed the trigger.
  assert.match(CSS, /\.compact-month-day-more\s*\{\s*display:\s*none;/);
  assert.match(CSS, new RegExp(`\\[${CALENDAR_DAY_AGENDA_READY_ATTRIBUTE}\\] \\.compact-month-overflow\\s*\\{\\s*display: none;`));
  assert.match(CSS, new RegExp(`\\[${CALENDAR_DAY_AGENDA_READY_ATTRIBUTE}\\] \\.compact-month-day-more\\s*\\{`));
});

test("A2: the trigger opens the day beside the month, never by growing the month row", () => {
  const { doc, container } = mountDocument(renderCompactMonth(viewFor("highDensity")));
  const controller = bindCalendarDayAgenda(container);
  assert.ok(controller);
  const rowsBefore = doc.querySelectorAll(".compact-month-grid tr").length;
  const cellsBefore = doc.querySelectorAll(".compact-month-occ").length;

  const trigger = container.querySelectorAll(`[${CALENDAR_DAY_AGENDA_ATTRIBUTE}]`)[0];
  click(trigger);
  const dialog = doc.getElementById(CALENDAR_DAY_AGENDA_DIALOG_ID);
  assert.ok(dialog.hasAttribute("open") || dialog.open, "the panel opened");
  // The month itself is untouched: same rows, same cells, nothing expanded.
  assert.equal(doc.querySelectorAll(".compact-month-grid tr").length, rowsBefore);
  assert.equal(doc.querySelectorAll(".compact-month-occ").length, cellsBefore);
  // The panel is not inside the month it describes.
  assert.equal(container.contains(dialog), false);
  assert.equal(dialog.querySelectorAll(".calendar-day-agenda-item").length, 9);
});

test("A2: the panel is a labelled modal that takes focus and contains Tab", () => {
  const { doc, container } = mountDocument(renderCompactMonth(viewFor("highDensity")));
  bindCalendarDayAgenda(container);
  const trigger = container.querySelectorAll(`[${CALENDAR_DAY_AGENDA_ATTRIBUTE}]`)[0];
  click(trigger);
  const dialog = doc.getElementById(CALENDAR_DAY_AGENDA_DIALOG_ID);
  assert.equal(dialog.getAttribute("aria-labelledby"), CALENDAR_DAY_AGENDA_TITLE_ID);
  assert.ok(dialog.querySelector(`#${CALENDAR_DAY_AGENDA_TITLE_ID}`), "the label points at a heading that exists");
  assert.equal(describeNode(doc.activeElement), describeNode(dialog.querySelector(".calendar-day-agenda-close")));

  const focusable = dialog.querySelectorAll("a[href], button:not([disabled])");
  focusable[focusable.length - 1].focus();
  keydown(dialog, "Tab");
  assert.equal(describeNode(doc.activeElement), describeNode(focusable[0]), "Tab wraps inside the panel");
  keydown(dialog, "Tab", { shiftKey: true });
  assert.equal(describeNode(doc.activeElement), describeNode(focusable[focusable.length - 1]),
    "Shift+Tab wraps inside the panel");

  // Native modal dismissal — Escape, the backdrop, background inertness —
  // belongs to a real engine and is proved by the headless capture. What is
  // pinned here is that closing, however it happens, hands focus back.
  dialog.close();
  assert.equal(dialog.open, false);
  assert.equal(describeNode(doc.activeElement), describeNode(trigger), "closing returns focus to the trigger");
});

test("A2: without native modal support the panel states its own semantics and handles Escape itself", () => {
  const { doc, container } = mountDocument(renderCompactMonth(viewFor("highDensity")));
  bindCalendarDayAgenda(container);
  const trigger = container.querySelectorAll(`[${CALENDAR_DAY_AGENDA_ATTRIBUTE}]`)[0];
  const dialog = doc.getElementById(CALENDAR_DAY_AGENDA_DIALOG_ID);
  dialog.showModal = undefined;
  click(trigger);
  assert.equal(dialog.open, true);
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  keydown(dialog, "Escape");
  assert.equal(dialog.open, false);
  assert.equal(describeNode(doc.activeElement), describeNode(trigger));
});

test("A2: the visible Close control dismisses the panel and hands focus back to the trigger", () => {
  const { doc, container } = mountDocument(renderCompactMonth(viewFor("highDensity")));
  bindCalendarDayAgenda(container);
  const trigger = container.querySelectorAll(`[${CALENDAR_DAY_AGENDA_ATTRIBUTE}]`)[0];
  click(trigger);
  const dialog = doc.getElementById(CALENDAR_DAY_AGENDA_DIALOG_ID);
  const close = dialog.querySelector(".calendar-day-agenda-close");
  assert.equal(close.tagName, "button");
  assert.equal(close.textContent.trim(), "Close");
  click(close);
  assert.equal(dialog.open, false);
  assert.equal(describeNode(doc.activeElement), describeNode(trigger));
});

test("A2: when a rerender replaces the trigger, focus returns to the same day's new one", () => {
  const html = renderCompactMonth(viewFor("highDensity"));
  const { doc, container } = mountDocument(html);
  bindCalendarDayAgenda(container);
  const trigger = container.querySelectorAll(`[${CALENDAR_DAY_AGENDA_ATTRIBUTE}]`)[0];
  const day = trigger.getAttribute(CALENDAR_DAY_AGENDA_DAY_ATTRIBUTE);
  click(trigger);
  const dialog = doc.getElementById(CALENDAR_DAY_AGENDA_DIALOG_ID);
  container.innerHTML = html; // the host repaints while the panel is open
  dialog.close();
  const landed = doc.activeElement;
  assert.equal(landed.getAttribute(CALENDAR_DAY_AGENDA_DAY_ATTRIBUTE), day,
    "focus lands on the same day's replacement trigger");
  // The replacement, not the detached control the reader actually clicked.
  assert.notEqual(landed, trigger);
  assert.equal(landed.isConnected, true);
  assert.equal(trigger.isConnected, false);
});

test("A2: when the day itself is gone, focus lands on the surviving calendar, never the page body", () => {
  const { doc, container } = mountDocument(renderCompactMonth(viewFor("highDensity")));
  bindCalendarDayAgenda(container);
  click(container.querySelectorAll(`[${CALENDAR_DAY_AGENDA_ATTRIBUTE}]`)[0]);
  container.innerHTML = renderCompactMonth(viewFor("dense")); // no crowded day left
  doc.getElementById(CALENDAR_DAY_AGENDA_DIALOG_ID).close();
  assert.equal(doc.activeElement.getAttribute("class"), "compact-month");
  assert.notEqual(describeNode(doc.activeElement), describeNode(doc.body));
});

test("A2: binding the same container twice installs no second listener and mints no second panel", () => {
  const { doc, container } = mountDocument(renderCompactMonth(viewFor("highDensity")));
  assert.ok(bindCalendarDayAgenda(container));
  assert.equal(bindCalendarDayAgenda(container), null, "the second binding is a no-op");
  assert.equal(container.listenerCount("click"), 1);
  click(container.querySelectorAll(`[${CALENDAR_DAY_AGENDA_ATTRIBUTE}]`)[0]);
  assert.equal(doc.querySelectorAll(`#${CALENDAR_DAY_AGENDA_DIALOG_ID}`).length, 1);
});

test("A2: a rerender needs no rebinding, because the behaviour is delegated", () => {
  const html = renderCompactMonth(viewFor("highDensity"));
  const { doc, container } = mountDocument(html);
  bindCalendarDayAgenda(container);
  container.innerHTML = html;
  click(container.querySelectorAll(`[${CALENDAR_DAY_AGENDA_ATTRIBUTE}]`)[0]);
  const dialog = doc.getElementById(CALENDAR_DAY_AGENDA_DIALOG_ID);
  assert.equal(dialog.open, true);
  assert.equal(doc.querySelectorAll(`#${CALENDAR_DAY_AGENDA_DIALOG_ID}`).length, 1);
});

test("A2: two bound calendars on one document share the single panel, and each returns its own focus", () => {
  const { doc, container } = mountDocument(
    `<div id="a">${renderCompactMonth(viewFor("highDensity"))}</div>` +
    `<div id="b">${renderCompactMonth(viewFor("longTitles"))}</div>`);
  const first = doc.getElementById("a");
  const second = doc.getElementById("b");
  bindCalendarDayAgenda(first);
  bindCalendarDayAgenda(second);
  assert.equal(doc.querySelectorAll(`#${CALENDAR_DAY_AGENDA_DIALOG_ID}`).length, 1);
  const secondTrigger = second.querySelectorAll(`[${CALENDAR_DAY_AGENDA_ATTRIBUTE}]`)[0];
  click(secondTrigger);
  doc.getElementById(CALENDAR_DAY_AGENDA_DIALOG_ID).close();
  assert.equal(describeNode(doc.activeElement), describeNode(secondTrigger));
  assert.ok(container);
});

test("A2: a container binding and an enclosing document binding open once and return focus once", () => {
  const { doc, container } = mountDocument(renderCompactMonth(viewFor("highDensity")));
  bindCalendarDayAgenda(container);
  bindCalendarDayAgenda(doc);
  const trigger = container.querySelectorAll(`[${CALENDAR_DAY_AGENDA_ATTRIBUTE}]`)[0];
  click(trigger);
  const dialog = doc.getElementById(CALENDAR_DAY_AGENDA_DIALOG_ID);
  assert.equal(doc.querySelectorAll(`#${CALENDAR_DAY_AGENDA_DIALOG_ID}`).length, 1);
  dialog.close();
  assert.equal(describeNode(doc.activeElement), describeNode(trigger));
});

test("A2: the binder is a no-op without a document, so server-side rendering is unaffected", () => {
  assert.equal(bindCalendarDayAgenda(undefined), null);
  assert.equal(bindCalendarDayAgenda({}), null);
});

test("A2: a malformed or superseded trigger payload opens nothing rather than an empty panel", () => {
  assert.equal(parseCalendarDayAgenda(""), null);
  assert.equal(parseCalendarDayAgenda("not json"), null);
  assert.equal(parseCalendarDayAgenda(JSON.stringify({ v: CALENDAR_DAY_AGENDA_VERSION + 1, day: "2026-03-19", events: [{}] })), null);
  assert.equal(parseCalendarDayAgenda(JSON.stringify({ v: CALENDAR_DAY_AGENDA_VERSION, day: "2026-03-19", events: [] })), null);
  assert.equal(calendarDayAgendaFacts({}), null);
  assert.equal(renderCalendarDayAgendaButton(null), "");
  assert.equal(renderCalendarDayAgendaBody(null), "");
});

test("A2: the existing sparse-calendar fallback is untouched — no month, so no trigger", () => {
  const view = viewFor("sparse");
  assert.equal(view.render, false);
  assert.equal(renderCompactMonth(view), "");
});

/* ================= A3 — narrow, zoomed, touchable, keyboard-reachable ============ */

test("A3: no essential fact is hover-only or tooltip-only anywhere in the component", () => {
  for (const name of ["dense", "crowded", "lifecycle", "longTitles", "highDensity", "localized"]) {
    const html = htmlFor(name);
    assert.ok(!/\stitle="/.test(html), `${name}: nothing is carried in a tooltip attribute`);
  }
  const body = renderCalendarDayAgendaBody(calendarDayAgendaFacts(crowdedDay(viewFor("highDensity"))));
  assert.ok(!/\stitle="/.test(body), "the panel carries nothing in a tooltip attribute either");
  // Hover only ever adds an underline to a title that is already legible.
  const hoverRules = CSS.match(/[^}]*:hover[^{]*\{[^}]*\}/g) || [];
  for (const rule of hoverRules) {
    assert.ok(!/line-clamp|content:|visibility:|display:\s*(block|inline)/.test(rule),
      `hover never reveals content: ${rule.split("{")[0].trim()}`);
  }
});

test("A3: the agenda trigger is text with a real target, never a bare glyph", () => {
  const html = renderCompactMonth(viewFor("highDensity"));
  const trigger = html.match(/<button class="compact-month-day-more"[\s\S]*?<\/button>/)[0];
  assert.match(trigger, /type="button"/);
  assert.match(trigger, />\+6 more<\/button>/, "the label is words and a number, not a symbol");
  assert.match(trigger, /aria-label="Show all 9 events on [^"]+"/);
  assert.match(CSS, /\[data-calendar-day-agenda-ready\] \.compact-month-day-more \{[^}]*min-height: 24px/);
});

test("A3: at narrow widths every control in the day reading gets a 44px target", () => {
  const narrow = CSS.slice(CSS.indexOf("@media (max-width: 640px)"), CSS.indexOf("/* ---------- print"));
  for (const selector of [
    ".compact-month-occ-preview",
    ".compact-month-day-more",
    ".calendar-day-agenda-item-link",
    ".calendar-day-agenda-close",
  ]) {
    const rule = narrow.slice(narrow.indexOf(selector));
    assert.match(rule.slice(0, 400), /min-height:\s*44px/, `${selector} is a real touch target`);
  }
});

test("A3: nothing in the component can push the page sideways", () => {
  // A long unbroken publisher token is the case that does it, and it is in the
  // long-title fixture on purpose.
  assert.ok(fixtureOccurrences("longTitles").some((occurrence) => /[A-Z0-9-]{40,}/.test(occurrence.title)));
  for (const selector of [
    ".compact-month-occ-title",
    ".calendar-day-agenda-title",
    ".calendar-day-agenda-item-link",
    ".calendar-day-agenda-item-where",
  ]) {
    const rule = CSS.slice(CSS.indexOf(`\n${selector} {`));
    assert.match(rule.slice(0, 400), /overflow-wrap:\s*anywhere/, `${selector} wraps rather than overflowing`);
  }
  // The panel is bounded by the viewport at every width, and scrolls inside
  // itself rather than making the document scroll.
  assert.match(CSS, /\.calendar-day-agenda-dialog \{[^}]*width: min\(40rem, calc\(100vw - 24px\)\)/);
  assert.match(CSS, /\.calendar-day-agenda-list \{\s*overflow-y: auto;/);
});

test("A3: every action in the day reading is a native control, so touch and keyboard both reach it", () => {
  const html = renderCompactMonth(viewFor("highDensity"));
  const body = renderCalendarDayAgendaBody(calendarDayAgendaFacts(crowdedDay(viewFor("highDensity"))));
  // No div-with-a-click-handler anywhere: buttons are buttons and links are links.
  assert.match(html, /<button class="compact-month-day-more" type="button"/);
  assert.ok(!/<(div|span)[^>]*onclick/i.test(html + body));
  assert.ok(!/tabindex="0"/.test(html + body), "nothing needs a synthetic tab stop");
  for (const match of body.matchAll(/<a class="calendar-day-agenda-item-link" href="([^"]*)"/g)) {
    assert.ok(match[1].startsWith("https://"), "every agenda title is a real destination");
  }
});

/* ================= A4 — before/after over the same occurrence set ================ */

const EQUIVALENCE_FIXTURES = ["dense", "crowded", "lifecycle", "longTitles", "highDensity", "localized"];

test("A4: the accepted occurrence set is unchanged — counts, dates, identities and order", () => {
  for (const name of EQUIVALENCE_FIXTURES) {
    const accepted = fixtureOccurrences(name);
    const view = viewFor(name);
    const rendered = daysOf(view).flatMap((day) => [...day.visible_occurrences, ...day.overflow_occurrences]);
    assert.deepEqual(
      rendered.map((entry) => entry.uid).sort(),
      accepted.map((occurrence) => occurrence.uid).sort(),
      `${name}: every accepted identity is rendered exactly once`);
    assert.equal(rendered.length, accepted.length, `${name}: no occurrence is added or dropped`);
    const byUid = new Map(accepted.map((occurrence) => [occurrence.uid, occurrence]));
    for (const entry of rendered) {
      const source = byUid.get(entry.uid);
      assert.equal(entry.canonical_url, source.canonical_url, `${name}/${entry.uid}: canonical link is unchanged`);
      assert.equal(entry.starts_at, source.starts_at, `${name}/${entry.uid}: published instant is unchanged`);
      assert.equal(entry.date, source.date, `${name}/${entry.uid}: published date is unchanged`);
      assert.equal(entry.lifecycle, source.lifecycle, `${name}/${entry.uid}: lifecycle is unchanged`);
      assert.equal(entry.title, source.title, `${name}/${entry.uid}: title is unchanged`);
    }
  }
});

test("A4: every reading of a day agrees — cell, narrow agenda, disclosure and panel", () => {
  for (const name of EQUIVALENCE_FIXTURES) {
    const view = viewFor(name);
    const html = renderCompactMonth(view);
    for (const day of daysOf(view).filter((entry) => entry.occurrence_count > 0)) {
      const order = [...day.visible_occurrences, ...day.overflow_occurrences].map((entry) => entry.uid);
      // Every identity for the day is in the document, whichever reading a
      // viewport or a reader's browser ends up using.
      for (const uid of order) assert.ok(html.includes(uid), `${name}/${day.date}: ${uid} is in the document`);
      const facts = calendarDayAgendaFacts(day);
      if (day.hidden_count > 0) {
        assert.deepEqual(facts.events.map((event) => event.uid), order,
          `${name}/${day.date}: the panel reads the day in the cell's own order`);
        assert.equal(facts.total, day.occurrence_count);
        assert.equal(facts.hidden, day.hidden_count);
      } else {
        assert.equal(facts, null, `${name}/${day.date}: a day with nothing hidden offers no panel`);
      }
    }
  }
});

test("A4: a localized bundle renders the same structure, counts and identities as any other", () => {
  const view = viewFor("localized");
  const day = crowdedDay(view);
  assert.equal(day.occurrence_count, 4);
  assert.equal(day.hidden_count, 1);
  const facts = calendarDayAgendaFacts(day);
  assert.equal(facts.events.length, 4);
  const html = renderCompactMonth(view);
  const body = renderCalendarDayAgendaBody(facts);
  for (const occurrence of fixtureOccurrences("localized")) {
    // The published title is carried verbatim into the document; nothing is
    // transliterated, truncated or replaced on the way.
    assert.ok(html.includes(occurrence.title), `${occurrence.uid}: the published title is rendered as published`);
  }
  assert.ok(body.includes("關於社區委員會轄區土地使用申請及相關特別許可的公開聽證會，歡迎居民出席並提供意見"));
  assert.ok(body.includes("কমিউনিটি বোর্ড এলাকার দোকানপাট উন্নয়ন অনুদান কর্মসূচির জন্য আবেদন গ্রহণ শুরু হয়েছে"));
  // The panel's own chrome stays in the interface language; only publisher
  // text is publisher text.
  assert.match(body, /<p class="calendar-day-agenda-count">4 events<\/p>/);
});

test("A4: the in-place event preview is preserved beside the new bound", () => {
  const html = renderCompactMonth(viewFor("longTitles"));
  // Every occurrence still carries its preview trigger, and the trigger still
  // carries the unabridged title as its accessible name.
  const longest = fixtureOccurrences("longTitles")
    .reduce((a, b) => (a.title.length >= b.title.length ? a : b));
  assert.ok(html.includes(`aria-label="Preview: ${longest.title}"`),
    "the preview names the whole title, however much the cell had to clip");
  const { doc, container } = mountDocument(html);
  const controller = bindCompactMonthCalendar(container);
  assert.ok(controller, "the shared mount returns the preview controller its callers have always used");
  assert.ok(container.hasAttribute(CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE));
  assert.ok(container.hasAttribute(CALENDAR_DAY_AGENDA_READY_ATTRIBUTE));
  assert.ok(doc.getElementById("calendar-event-preview"));
});

test("A4: rendered copy carries no schema, join, workstream or control-plane vocabulary", () => {
  const forbidden = forbiddenVocabularyPattern([
    "schema", "workstream", "control.?plane", "join", "adapter", "materializ", "backfill",
    "fixture", "occurrence.?contract", "view.?model",
  ]);
  const text = [
    ...EQUIVALENCE_FIXTURES.map((name) => renderCompactMonth(viewFor(name))),
    renderCalendarDayAgendaBody(calendarDayAgendaFacts(crowdedDay(viewFor("highDensity")))),
  ].join("\n")
    // Attribute payloads and class names are markup, not copy; the assertion
    // is about what a reader is shown, exactly as the shared renderer's own
    // vocabulary gate reads it.
    .replace(/<[^>]*>/g, " ");
  const found = text.match(forbidden);
  assert.equal(found, null, `rendered copy carries forbidden vocabulary: ${found}`);
});

/* ================= A4 — every registered host inherits the bound ================= */

test("A4: all eight registered calendar hosts reach the one shared mount", () => {
  const hosts = [
    // Browser-painted surfaces call the shared mount directly.
    ["site/now_view.mjs", /bindCalendarEventPreview\(/],
    ["site/app/property.mjs", /bindCalendarEventPreview\(/],
    ["site/app/land.mjs", /bindCalendarEventPreview\(/],
    ["site/app/rules.mjs", /bindCalendarEventPreview\(/],
    ["site/exam_document.mjs", /bindCalendarEventPreview\(/],
    // Documents rendered ahead of the reader load the shared boot module.
    ["site/community_board_constellation.mjs", /renderCalendarEventPreviewScript\(/],
    ["site/legislative_matter_document.mjs", /renderCalendarEventPreviewScript\(/],
    ["site/procurement_document.mjs", /renderCalendarEventPreviewScript\(/],
  ];
  assert.equal(hosts.length, 8);
  for (const [path, pattern] of hosts) {
    assert.match(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), pattern, `${path} mounts the calendar`);
  }
  // The name every host reaches for is the complete mount, so a host cannot
  // receive a clipped title without the panel that reads it in full.
  assert.equal(bindCalendarEventPreview, bindCompactMonthCalendar);
  const boot = readFileSync(new URL("../site/calendar_event_preview_boot.mjs", import.meta.url), "utf8");
  assert.match(boot, /from "\.\/compact_calendar\.mjs"/,
    "the rendered-document boot mounts through the shared renderer, not one half of it");
});

/* ================= A5 — the capture contract ================= */

test("A5: the capture tool records this card's proof as a manifest, at both required widths", () => {
  const tool = readFileSync(new URL("../tools/capture_calendar_density_evidence.py", import.meta.url), "utf8");
  assert.match(tool, /VIEWPORTS = \(\(390, 844\), \(1440, 900\)\)/);
  assert.match(tool, /cityscroll-resident-ux\/px-02-keep-calendar-overview-scannable/);
  // The measurements this card owes its reader, recorded rather than asserted
  // as an improvement.
  assert.match(tool, /rendered_row_height_px/);
  assert.match(tool, /title_line_budget/);
  // Image binaries are never committed; the manifest is the tracked proof.
  assert.match(tool, /IMAGES = ROOT \/ "\.artifacts"/);
  assert.match(tool, /capture images must not be committed/);
});
