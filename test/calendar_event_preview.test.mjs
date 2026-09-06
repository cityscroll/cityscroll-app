// PX-01: inspecting a calendar event without leaving the calendar.
//
// One shared behaviour, mounted through the one shared month renderer, so the
// eight calendar-bearing surfaces get the same contract. This suite pins:
//
//   A1 activation opens a bounded preview with no navigation, no subscription
//      change, no save, and no request of any kind
//   A2 progressive enhancement — the canonical anchor survives untouched and
//      un-nested, and the preview trigger is an explicit native button
//   A3 the accepted display-occurrence facts only: date-only stays date-only,
//      cancellation and rescheduling are stated before action, a real venue is
//      kept, and an absent optional field produces no line at all
//   A4 the modal contract — label, focus inside, contained Tab and Shift+Tab,
//      visible Close, Escape, and focus returned to the invoker or a logical
//      surviving target
//   A5 bounded content, and optional detail that can fail or arrive late
//      without disturbing the initial facts or the working full-page link
//   A6 every audited host mounts it, and a rerender adds no second listener
//      and no second dialog id
//
//   node --test test/calendar_event_preview.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { createCalendarOccurrence } from "../site/calendar_occurrence.mjs";
import { buildCompactMonthView, renderCompactMonth } from "../site/compact_calendar.mjs";
import {
  CALENDAR_EVENT_PREVIEW_ATTRIBUTE,
  CALENDAR_EVENT_PREVIEW_DIALOG_ID,
  CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE,
  CALENDAR_EVENT_PREVIEW_TITLE_ID,
  CALENDAR_EVENT_PREVIEW_VERSION,
  bindCalendarEventPreview,
  calendarEventPreviewFacts,
  parseCalendarEventPreview,
  renderCalendarEventPreviewBody,
  renderCalendarEventPreviewButton,
} from "../site/calendar_event_preview.mjs";
import { click, describeNode, keydown, mountDocument } from "./helpers/preview_dom.mjs";
import { forbiddenVocabularyPattern } from "./helpers/internal_vocabulary.mjs";

const TODAY = "2026-03-15";

function occ(overrides = {}) {
  const { date, starts_at: startsAt } = overrides;
  return createCalendarOccurrence({
    uid: overrides.uid || "occ:a",
    object_ref: `object:${overrides.uid || "occ:a"}`,
    kind: overrides.kind || "event",
    title: overrides.title || "Full board meeting",
    ...(startsAt ? { starts_at: startsAt } : { date: date || "2026-03-18" }),
    timezone: overrides.timezone,
    status: overrides.status,
    lifecycle: overrides.lifecycle,
    location: overrides.location,
    canonical_url: overrides.canonical_url === undefined
      ? `https://cityscroll.org/meetings/${overrides.uid || "occ:a"}`
      : overrides.canonical_url,
    source: overrides.source === undefined ? { system: "city_record", record_id: "20260318001" } : overrides.source,
    provenance: { basis: "publisher_record" },
  });
}

// A bundle that clears the shared density rule, so the month actually renders.
function bundle(extra = []) {
  return [
    occ({ uid: "occ:a", date: "2026-03-18", title: "Full board meeting" }),
    occ({ uid: "occ:b", date: "2026-03-24", kind: "deadline", title: "Comments due" }),
    occ({ uid: "occ:c", date: "2026-03-30", kind: "milestone", title: "Board vote" }),
    ...extra,
  ];
}

function monthHTML(extra = [], options = {}) {
  return renderCompactMonth(buildCompactMonthView(bundle(extra), { today: TODAY }), options);
}

function entryFor(view, uid) {
  return view.weeks.flat()
    .flatMap((day) => [...day.visible_occurrences, ...day.overflow_occurrences])
    .find((entry) => entry.uid === uid);
}

function factsFor(occurrence) {
  const view = buildCompactMonthView(bundle([occurrence]), { today: TODAY });
  return calendarEventPreviewFacts(entryFor(view, occurrence.uid));
}

function mountMonth(extra = [], bindOptions = {}) {
  const { doc, container } = mountDocument(monthHTML(extra));
  const controller = bindCalendarEventPreview(container, bindOptions);
  const dialog = doc.getElementById(CALENDAR_EVENT_PREVIEW_DIALOG_ID);
  return { doc, container, controller, dialog };
}

// The detail hook is deliberately invoked off a microtask, so a test has to
// let the queue drain before the hook has even been called.
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function previewButton(container, uid) {
  return container.querySelector(`[data-calendar-event-preview-uid="${uid}"]`);
}

function assertFocused(doc, expected, message) {
  assert.ok(doc.activeElement === expected,
    `${message} — focus is on ${describeNode(doc.activeElement)}, expected ${describeNode(expected)}`);
}

/* ---------- A2: progressive enhancement ---------- */

test("A2: the canonical anchor is untouched — a real href, outside the button, with no dialog role bolted onto it", () => {
  const html = monthHTML();
  const item = html.match(/<li class="compact-month-occ[\s\S]*?<\/li>/)[0];
  assert.match(item, /<a class="compact-month-occ-link" href="https:\/\/cityscroll\.org\/meetings\/occ:a">/);
  // Nothing turns the link into a control: no role, no dialog wiring, no
  // handler attribute. It stays a destination for a context menu or a
  // modified click, and it is the only affordance without scripting.
  assert.doesNotMatch(item, /<a[^>]*\srole=/);
  assert.doesNotMatch(item, /<a[^>]*\sdata-calendar-event-preview/);
  assert.doesNotMatch(item, /<a[^>]*\sonclick/);
});

test("A2: the preview trigger is an explicit native button, a sibling of the anchor rather than nested inside it", () => {
  const item = monthHTML().match(/<li class="compact-month-occ[\s\S]*?<\/li>/)[0];
  const anchor = item.match(/<a class="compact-month-occ-link"[\s\S]*?<\/a>/)[0];
  assert.doesNotMatch(anchor, /<button/, "the button must not be nested inside the link");
  assert.match(item, /<button class="compact-month-occ-preview" type="button"/);
  // The accessible name starts with the visible label, so speaking the visible
  // word still activates the control.
  assert.match(item, /aria-label="Preview: Full board meeting"/);
  assert.match(item, />Preview<\/button>/);
});

test("A2: the trigger stays invisible until a container is bound, so an unenhanced document offers only what works", () => {
  const css = readFileSync(new URL("../site/compact_calendar.css", import.meta.url), "utf8");
  assert.match(css, /\.compact-month-occ-preview\s*{\s*display:\s*none;/);
  assert.match(css, new RegExp(`\\[${CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE}\\] \\.compact-month-occ-preview`));

  const { container } = mountMonth();
  assert.equal(container.hasAttribute(CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE), true,
    "binding marks the container ready, which is what reveals the trigger");
});

test("A2: an unbound container is never marked ready, so its buttons stay hidden", () => {
  const { container } = mountDocument(monthHTML());
  assert.equal(container.hasAttribute(CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE), false);
});

/* ---------- A3: the accepted display-occurrence facts, and nothing else ---------- */

test("A3: a date-only occurrence keeps date-only precision and never acquires a clock time", () => {
  const facts = factsFor(occ({ uid: "occ:date-only", date: "2026-03-20", title: "Filing deadline", kind: "deadline" }));
  assert.equal(facts.precision, "date");
  assert.equal(facts.day, "2026-03-20");
  assert.equal(Object.hasOwn(facts, "time"), false);
  const body = renderCalendarEventPreviewBody(facts);
  assert.match(body, /<dd>Friday, March 20, 2026<\/dd>/);
  assert.doesNotMatch(body, /\d{1,2}:\d{2}/);
});

test("A3: a timed occurrence keeps the published clock time, in its own timezone", () => {
  const facts = factsFor(occ({
    uid: "occ:timed",
    starts_at: "2026-03-19T18:30:00-04:00",
    timezone: "America/New_York",
    title: "Evening hearing",
  }));
  assert.equal(facts.precision, "time");
  assert.match(facts.time, /6:30 ?\s?PM/);
  assert.match(renderCalendarEventPreviewBody(facts), /March 19, 2026, 6:30/);
});

test("A3: cancellation is stated before any action is offered", () => {
  const facts = factsFor(occ({
    uid: "occ:cancelled",
    date: "2026-03-21",
    status: "cancelled",
    lifecycle: "cancelled",
    title: "Cancelled committee meeting",
  }));
  const body = renderCalendarEventPreviewBody(facts);
  assert.equal(facts.lifecycle, "cancelled");
  assert.match(body, /This event is cancelled\./);
  assert.ok(body.indexOf("This event is cancelled.") < body.indexOf("calendar-event-preview-actions"),
    "the cancellation reaches the reader before the action does");
});

test("A3: a rescheduled occurrence says the date shown is the currently published one", () => {
  const facts = factsFor(occ({ uid: "occ:moved", date: "2026-03-22", lifecycle: "rescheduled", title: "Rescheduled hearing" }));
  assert.match(renderCalendarEventPreviewBody(facts), /rescheduled; the date below is the currently published one/);
});

test("A3: a past occurrence says so rather than reading as something still ahead", () => {
  const facts = factsFor(occ({ uid: "occ:past", date: "2026-03-02", title: "Already-held session" }));
  assert.equal(facts.state, "past");
  assert.match(renderCalendarEventPreviewBody(facts), /This date has passed\./);
});

test("A3: a meaningful venue is retained, from a plain string or a structured one", () => {
  const plain = factsFor(occ({ uid: "occ:venue", date: "2026-03-19", location: "250 Broadway, 16th Floor" }));
  assert.equal(plain.location, "250 Broadway, 16th Floor");
  assert.match(renderCalendarEventPreviewBody(plain), /<dt>Where<\/dt><dd>250 Broadway, 16th Floor<\/dd>/);

  const structured = factsFor(occ({
    uid: "occ:venue2",
    date: "2026-03-19",
    location: { name: "Borough Hall", address: "209 Joralemon St" },
  }));
  assert.equal(structured.location, "Borough Hall — 209 Joralemon St");
});

test("A3: an absent optional field produces no line at all — never an invented value or a missing-data apology", () => {
  const facts = factsFor(occ({ uid: "occ:bare", date: "2026-03-19", title: "Plain event" }));
  assert.equal(Object.hasOwn(facts, "location"), false);
  const body = renderCalendarEventPreviewBody(facts);
  assert.doesNotMatch(body, /Where/);
  assert.doesNotMatch(body, /Unavailable|Not available|Unknown|no information|Sorry/i);
  // No description, join, or clock time is manufactured for a record that
  // published none of them.
  assert.doesNotMatch(body, /calendar-event-preview-detail/);
  assert.doesNotMatch(body, /\d{1,2}:\d{2}/);
});

test("A3: an occurrence with no canonical destination produces no preview facts, so no trigger is offered", () => {
  assert.equal(calendarEventPreviewFacts({ uid: "occ:x" }), null);
  assert.equal(calendarEventPreviewFacts({ canonical_url: "https://cityscroll.org/x" }), null);
  assert.equal(renderCalendarEventPreviewButton(null), "");
});

test("A3: rendered preview copy carries no schema or control-plane vocabulary", () => {
  const facts = factsFor(occ({ uid: "occ:vocab", date: "2026-03-19", location: "City Hall" }));
  const forbidden = forbiddenVocabularyPattern([
    "schema", "object_ref", "scope_ref", "join_status", "lifecycle", "canonical_url", "workstream",
  ]);
  assert.doesNotMatch(renderCalendarEventPreviewBody(facts), forbidden);
  assert.doesNotMatch(renderCalendarEventPreviewButton(facts), forbidden);
});

/* ---------- A5: bounded content ---------- */

test("A5: the preview is one event summary and its links — never an embedded copy of the full document", () => {
  const facts = factsFor(occ({
    uid: "occ:bounded",
    date: "2026-03-19",
    source: { system: "city_record", url: "https://a860-gpp.nyc.gov/notice/20260319001" },
  }));
  const body = renderCalendarEventPreviewBody(facts);
  assert.doesNotMatch(body, /<iframe|<embed|<object/);
  // Exactly one titled event, its own page, and the publisher's record.
  assert.equal((body.match(/<h2/g) || []).length, 1);
  assert.match(body, /href="https:\/\/cityscroll\.org\/meetings\/occ:bounded"/);
  assert.match(body, /Source: city_record/);
});

test("A5: a source link identical to the canonical destination is not repeated as a second link", () => {
  const facts = factsFor(occ({
    uid: "occ:samesource",
    date: "2026-03-19",
    source: { system: "city_record", url: "https://cityscroll.org/meetings/occ:samesource" },
  }));
  assert.equal(Object.hasOwn(facts, "source"), false);
  assert.doesNotMatch(renderCalendarEventPreviewBody(facts), /calendar-event-preview-source/);
});

test("A5: the next action names the destination for the occurrence's kind, without inventing an instruction", () => {
  const deadline = factsFor(occ({ uid: "occ:due", date: "2026-03-20", kind: "deadline", title: "Bids due" }));
  assert.match(renderCalendarEventPreviewBody(deadline), />Open the page for this deadline</);
  const event = factsFor(occ({ uid: "occ:ev", date: "2026-03-20", kind: "event" }));
  assert.match(renderCalendarEventPreviewBody(event), />Open the event page</);
});

/* ---------- serialization ---------- */

test("facts survive the markup round trip, and anything else is rejected rather than trusted", () => {
  const facts = factsFor(occ({ uid: "occ:round", date: "2026-03-19", location: 'Room "A" & B' }));
  const html = renderCalendarEventPreviewButton(facts);
  const { container } = mountDocument(`<div>${html}</div>`);
  const parsed = parseCalendarEventPreview(
    container.querySelector(`[${CALENDAR_EVENT_PREVIEW_ATTRIBUTE}]`).getAttribute(CALENDAR_EVENT_PREVIEW_ATTRIBUTE));
  assert.deepEqual(parsed, facts);
  assert.equal(parsed.v, CALENDAR_EVENT_PREVIEW_VERSION);

  assert.equal(parseCalendarEventPreview(""), null);
  assert.equal(parseCalendarEventPreview("not json"), null);
  assert.equal(parseCalendarEventPreview(JSON.stringify({ uid: "x", href: "y" })), null, "an unversioned payload is refused");
  assert.equal(parseCalendarEventPreview(JSON.stringify({ v: 1, uid: "x" })), null, "a payload with no destination is refused");
});

/* ---------- A1: activation opens in place ---------- */

test("A1: pointer activation opens the preview without navigating, saving, subscribing, or requesting anything", () => {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { requests.push(args); return Promise.reject(new Error("no request expected")); };
  try {
    const { container, dialog } = mountMonth();
    const before = container.querySelector(".compact-month-occ-link").getAttribute("href");
    click(previewButton(container, "occ:a"));
    assert.equal(dialog.open, true);
    assert.equal(dialog.showModalCount, 1);
    assert.match(dialog.textContent, /Full board meeting/);
    // Nothing about the calendar underneath moved.
    assert.equal(container.querySelector(".compact-month-occ-link").getAttribute("href"), before);
    assert.equal(requests.length, 0, "no request of any kind is made to open a preview");
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test("A1: opening and closing leaves the month, its cells and an expanded day exactly as they were", () => {
  // A crowded day so the month carries a real open/closed disclosure.
  const crowded = ["p", "q", "r", "s"].map((suffix, index) => occ({
    uid: `occ:crowd-${suffix}`,
    date: "2026-03-26",
    title: `Crowded item ${index + 1}`,
  }));
  const { container, dialog } = mountMonth(crowded);
  const disclosure = container.querySelector(".compact-month-overflow");
  assert.ok(disclosure, "the fixture produces a crowded-day disclosure");
  disclosure.setAttribute("open", "");
  const monthBefore = container.querySelector(".compact-month").getAttribute("data-compact-month");
  const cellsBefore = container.querySelectorAll(".compact-month-occ").length;

  click(previewButton(container, "occ:a"));
  click(dialog.querySelector("[data-calendar-event-preview-close]"));

  assert.equal(container.querySelector(".compact-month").getAttribute("data-compact-month"), monthBefore);
  assert.equal(container.querySelectorAll(".compact-month-occ").length, cellsBefore);
  assert.equal(disclosure.hasAttribute("open"), true, "the day the reader expanded is still expanded");
});

/* ---------- A4: the modal contract ---------- */

test("A4: the dialog is labelled by its own event title and opened as a modal", () => {
  const { container, dialog } = mountMonth();
  assert.equal(dialog.tagName, "dialog");
  assert.equal(dialog.getAttribute("aria-labelledby"), null,
    "no label is claimed before there is a heading to point at");
  click(previewButton(container, "occ:b"));
  assert.equal(dialog.showModalCount, 1, "the native modal path is taken, which is what makes the background inert");
  assert.equal(dialog.getAttribute("aria-labelledby"), CALENDAR_EVENT_PREVIEW_TITLE_ID);
  assert.equal(dialog.querySelector(`#${CALENDAR_EVENT_PREVIEW_TITLE_ID}`).textContent, "Comments due");
});

test("A4: focus moves inside the dialog on open, onto the visible Close control", () => {
  const { doc, container, dialog } = mountMonth();
  click(previewButton(container, "occ:a"));
  const close = dialog.querySelector("[data-calendar-event-preview-close]");
  assert.equal(close.textContent, "Close");
  assertFocused(doc, close, "opening moves focus inside the dialog");
});

test("A4: the visible Close control closes the preview and returns focus to the invoking button", () => {
  const { doc, container, dialog } = mountMonth();
  const button = previewButton(container, "occ:a");
  click(button);
  click(dialog.querySelector("[data-calendar-event-preview-close]"));
  assert.equal(dialog.open, false);
  assertFocused(doc, button, "Close returns focus to the invoker");
});

test("A4: Tab and Shift+Tab stay inside the dialog", () => {
  const { doc, container, dialog } = mountMonth([occ({
    uid: "occ:tab",
    date: "2026-03-19",
    source: { system: "city_record", url: "https://a860-gpp.nyc.gov/notice/1" },
  })]);
  click(previewButton(container, "occ:tab"));
  const focusable = dialog.querySelectorAll("a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])");
  assert.ok(focusable.length >= 3, "close, the event page, and the publisher's record");
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  last.focus();
  keydown(dialog, "Tab");
  assertFocused(doc, first, "Tab from the last control wraps to the first");

  first.focus();
  keydown(dialog, "Tab", { shiftKey: true });
  assertFocused(doc, last, "Shift+Tab from the first control wraps to the last");
});

test("A4: without native modal support the dialog states its own semantics and handles Escape itself", () => {
  const { doc, container, dialog } = mountMonth();
  const button = previewButton(container, "occ:a");
  dialog.showModal = undefined;
  click(button);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.hasAttribute("open"), true);

  keydown(dialog, "Escape");
  assert.equal(dialog.open, false);
  assertFocused(doc, button, "Escape closes the fallback dialog and returns focus");
});

test("A4: when a rerender replaces the invoking button, focus returns to the same event's new trigger", () => {
  const { doc, container, dialog } = mountMonth();
  click(previewButton(container, "occ:a"));
  const replacedInvoker = previewButton(container, "occ:a");
  container.innerHTML = monthHTML();
  const survivor = previewButton(container, "occ:a");
  assert.ok(survivor !== replacedInvoker, "the rerender produced a new trigger for the same event");
  assert.equal(replacedInvoker.isConnected, false, "the invoking control is genuinely gone");
  dialog.close();
  assertFocused(doc, survivor, "focus follows the event to its new trigger");
});

test("A4: when the event itself is gone, focus lands on the surviving calendar rather than the page body", () => {
  const { doc, container, dialog } = mountMonth();
  click(previewButton(container, "occ:a"));
  // A repaint that no longer carries the invoking event at all.
  container.innerHTML = renderCompactMonth(buildCompactMonthView([
    occ({ uid: "occ:x", date: "2026-04-06", title: "Later hearing" }),
    occ({ uid: "occ:y", date: "2026-04-13", kind: "deadline", title: "Later deadline" }),
    occ({ uid: "occ:z", date: "2026-04-20", kind: "milestone", title: "Later vote" }),
  ], { today: TODAY }));
  dialog.close();
  const month = container.querySelector(".compact-month");
  assertFocused(doc, month, "focus lands on the surviving calendar");
  assert.equal(month.getAttribute("tabindex"), "-1", "the surviving target is made focusable rather than skipped");
});

/* ---------- A5: optional detail, failure and staleness ---------- */

test("A5: with no detail hook configured, a preview makes no call at all", async () => {
  const { container, dialog } = mountMonth();
  click(previewButton(container, "occ:a"));
  await Promise.resolve();
  assert.doesNotMatch(dialog.textContent, /did not load/);
  assert.match(dialog.textContent, /Full board meeting/);
});

test("A5: supplied optional detail is added beside the facts that were already correct", async () => {
  const { container, dialog } = mountMonth([], {
    loadDetail: (facts) => Promise.resolve(`Agenda published for ${facts.uid}.`),
  });
  click(previewButton(container, "occ:a"));
  await tick();
  assert.match(dialog.textContent, /Agenda published for occ:a\./);
  assert.match(dialog.textContent, /Full board meeting/);
  assert.ok(dialog.querySelector("[data-calendar-event-preview-open]"));
});

test("A5: failed optional detail leaves the initial facts and a working full-page link in place", async () => {
  const { container, dialog } = mountMonth([], {
    loadDetail: () => Promise.reject(new Error("detail unavailable")),
  });
  click(previewButton(container, "occ:a"));
  await tick();
  assert.match(dialog.textContent, /Full board meeting/);
  assert.match(dialog.textContent, /March 18, 2026/);
  assert.match(dialog.textContent, /Further detail did not load/);
  assert.equal(
    dialog.querySelector("[data-calendar-event-preview-open]").getAttribute("href"),
    "https://cityscroll.org/meetings/occ:a");
});

test("A5: a stale detail response never replaces a newer selection", async () => {
  const resolvers = new Map();
  const { container, dialog } = mountMonth([], {
    loadDetail: (facts) => new Promise((resolve) => resolvers.set(facts.uid, resolve)),
  });
  click(previewButton(container, "occ:a"));
  click(previewButton(container, "occ:b"));
  await tick();
  // The first selection's answer arrives after the reader moved to the second.
  resolvers.get("occ:a")("Detail for the event the reader left");
  await tick();
  assert.match(dialog.textContent, /Comments due/);
  assert.doesNotMatch(dialog.textContent, /the reader left/);

  resolvers.get("occ:b")("Detail for the current selection");
  await tick();
  assert.match(dialog.textContent, /Detail for the current selection/);
});

test("A5: a detail response that arrives after the reader closed the preview is discarded", async () => {
  let resolveDetail;
  const { container, dialog } = mountMonth([], {
    loadDetail: () => new Promise((resolve) => { resolveDetail = resolve; }),
  });
  click(previewButton(container, "occ:a"));
  await tick();
  dialog.close();
  resolveDetail("Detail nobody is looking at");
  await tick();
  assert.doesNotMatch(dialog.textContent, /Detail nobody is looking at/);
});

/* ---------- A6: mounting, rerenders, and identity ---------- */

test("A6: binding the same container twice installs no second listener", () => {
  const { container } = mountMonth();
  assert.equal(container.listenerCount("click"), 1);
  assert.equal(bindCalendarEventPreview(container), null, "a second bind is a no-op");
  assert.equal(container.listenerCount("click"), 1);
});

test("A6: a rerender needs no rebinding and produces no second dialog id", () => {
  const { doc, container, dialog } = mountMonth();
  container.innerHTML = monthHTML();
  click(previewButton(container, "occ:c"));
  assert.equal(dialog.open, true, "the delegated binding still reaches occurrences painted after it");
  assert.match(dialog.textContent, /Board vote/);
  assert.equal(doc.querySelectorAll(`#${CALENDAR_EVENT_PREVIEW_DIALOG_ID}`).length, 1);
});

test("A6: two bound calendars on one document share the single dialog rather than each minting one", () => {
  const { doc, container } = mountMonth();
  const second = doc.createElement("div");
  doc.body.appendChild(second);
  second.innerHTML = monthHTML();
  bindCalendarEventPreview(second);
  assert.equal(doc.querySelectorAll(`#${CALENDAR_EVENT_PREVIEW_DIALOG_ID}`).length, 1);
  click(previewButton(second, "occ:b"));
  assert.equal(doc.getElementById(CALENDAR_EVENT_PREVIEW_DIALOG_ID).open, true);
  assert.ok(container);
});

test("A6: binding at the document marks the root element ready, which is how a rendered document is enhanced", () => {
  const { doc, container } = mountDocument(monthHTML());
  assert.equal(bindCalendarEventPreview(doc) !== null, true);
  assert.equal(doc.documentElement.hasAttribute(CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE), true,
    "a document has no attributes of its own, so the root element carries the marker");
  click(previewButton(container, "occ:a"));
  assert.equal(doc.getElementById(CALENDAR_EVENT_PREVIEW_DIALOG_ID).open, true);
});

test("A6: a uid carrying selector punctuation still resolves to its own trigger", () => {
  // Fixture identities are real occurrence uids: `notice:20260722002:deadline`
  // shapes, not tidy slugs.
  const awkward = occ({ uid: 'notice:"quoted":deadline', date: "2026-03-19", kind: "deadline", title: "Odd identity" });
  const { doc, container, dialog } = mountMonth([awkward]);
  const button = [...container.querySelectorAll("[data-calendar-event-preview-uid]")]
    .find((node) => node.getAttribute("data-calendar-event-preview-uid") === 'notice:"quoted":deadline');
  assert.ok(button, "the trigger is addressable by its own identity");
  click(button);
  container.innerHTML = monthHTML([awkward]);
  dialog.close();
  assert.ok(doc.activeElement !== doc.body, "focus found a surviving target rather than falling to the body");
});

test("A6: a container binding and an enclosing document binding open once and return focus once", () => {
  const { doc, container } = mountDocument(monthHTML());
  bindCalendarEventPreview(container);
  bindCalendarEventPreview(doc);
  const dialog = doc.getElementById(CALENDAR_EVENT_PREVIEW_DIALOG_ID);
  const button = previewButton(container, "occ:a");
  click(button);
  assert.equal(dialog.showModalCount, 1, "one activation opens one preview, not two");
  assert.equal(dialog.querySelector(`#${CALENDAR_EVENT_PREVIEW_TITLE_ID}`).textContent, "Full board meeting");

  // Only the binding that opened it returns focus; the other must not take
  // focus away afterwards by falling back to its own surviving calendar.
  click(dialog.querySelector("[data-calendar-event-preview-close]"));
  assertFocused(doc, button, "the invoking control keeps the returned focus");
});

test("A6: the binder is a no-op without a document, so server-side rendering is unaffected", () => {
  assert.equal(bindCalendarEventPreview(undefined), null);
  assert.equal(bindCalendarEventPreview({}), null);
});

test("A6: every audited host reaches the one shared behaviour", async () => {
  // Hosts mount the shared month component's single binder, which is what
  // gives every one of them this behaviour rather than each wiring its own.
  const hosts = [
    // Browser-painted surfaces call the binder directly.
    ["site/now_view.mjs", /bindCompactMonthCalendar\(/],
    ["site/app/property.mjs", /bindCompactMonthCalendar\(/],
    ["site/app/land.mjs", /bindCompactMonthCalendar\(/],
    ["site/app/rules.mjs", /bindCompactMonthCalendar\(/],
    ["site/exam_document.mjs", /bindCompactMonthCalendar\(/],
    // Documents rendered ahead of the reader load the shared boot module.
    ["site/community_board_constellation.mjs", /renderCalendarEventPreviewScript\(/],
    ["site/legislative_matter_document.mjs", /renderCalendarEventPreviewScript\(/],
    ["site/procurement_document.mjs", /renderCalendarEventPreviewScript\(/],
  ];
  assert.equal(hosts.length, 8);
  for (const [path, pattern] of hosts) {
    assert.match(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), pattern, `${path} mounts the preview`);
  }
  const boot = await import("../site/calendar_event_preview_boot.mjs");
  assert.ok(boot);
});

test("A6: a sparse surface renders no month, so it offers no preview trigger either", () => {
  const view = buildCompactMonthView([occ({ uid: "occ:only", date: "2026-03-19" })], { today: TODAY });
  assert.equal(view.render, false);
  assert.equal(renderCompactMonth(view), "");
});
