// Make calendar inspection primary while preserving native destinations.
//
// Public alias: c6ca330ec16a0
//
// Shared compact calendars used to lead with a title anchor beside a secondary
// Preview chip. After enhancement the title-sized control inspects in place,
// and a separately named full-record link keeps native destination behaviour.
// Static markup retains the working title link until the binder is ready.
//
//   A1 all eight hosts reach the shared mount; primary enhanced control
//      inspects without leaving the month; canonical links keep destinations
//      and modified-click behaviour
//   A2 no-JavaScript and failed enhancement keep the title link; preview never
//      subscribes, submits, opens a provider, or invents time precision
//   A3 positive and negative fixtures distinguish the prior sibling-Preview
//      hierarchy from the intended primary-inspect outcome
//   A4 modal name, inert background, keyboard, Escape, Close, disappeared
//      trigger fallback, rapid selection, failed detail; day-agenda order and
//      exact overflow counts; journey evidence recorded
//
//   node --test test/calendar_primary_inspection.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createCalendarOccurrence } from "../site/calendar_occurrence.mjs";
import {
  COMPACT_CALENDAR_HOST_IDS,
  BROWSE_INSPECTION_LEGACY_BASELINE,
  BROWSE_INSPECTION_SURFACES,
} from "../site/browse_inspection_contract.mjs";
import {
  MAX_VISIBLE_OCCURRENCES_PER_DAY,
  bindCompactMonthCalendar,
  buildCompactMonthView,
  renderCompactMonth,
} from "../site/compact_calendar.mjs";
import {
  CALENDAR_EVENT_FULL_RECORD_CLASS,
  CALENDAR_EVENT_PREVIEW_DIALOG_ID,
  CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE,
  CALENDAR_EVENT_PREVIEW_TITLE_ID,
  bindCalendarEventPreview,
  calendarEventFullRecordLabel,
  calendarEventPreviewFacts,
  renderCalendarEventFullRecordLink,
  renderCalendarEventPreviewButton,
} from "../site/calendar_event_preview.mjs";
import { click, describeNode, keydown, mountDocument } from "./helpers/preview_dom.mjs";

const TODAY = "2026-03-15";
const ROOT = process.cwd();
const EVIDENCE_PATH = join("docs", "evidence", "calendar-primary-inspection", "acceptance-manifest.json");
const CSS = readFileSync(new URL("../site/compact_calendar.css", import.meta.url), "utf8");

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

function mountMonth(extra = [], bindOptions = {}) {
  const { doc, container } = mountDocument(monthHTML(extra));
  const controller = bindCompactMonthCalendar(container, bindOptions);
  const dialog = doc.getElementById(CALENDAR_EVENT_PREVIEW_DIALOG_ID);
  return { doc, container, controller, dialog };
}

function previewButton(container, uid) {
  return [...container.querySelectorAll("[data-calendar-event-preview-uid]")]
    .find((node) => node.getAttribute("data-calendar-event-preview-uid") === uid);
}

function fullRecordLink(container, uid) {
  return [...container.querySelectorAll(`.${CALENDAR_EVENT_FULL_RECORD_CLASS}`)]
    .find((node) => node.getAttribute("data-browse-return-uid") === uid
      || node.closest("[data-compact-month-occ-uid]")?.getAttribute("data-compact-month-occ-uid") === uid);
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function assertFocused(doc, expected, message) {
  assert.ok(doc.activeElement === expected,
    `${message} — focus is on ${describeNode(doc.activeElement)}, expected ${describeNode(expected)}`);
}

function firstItemHTML(html = monthHTML()) {
  return html.match(/<li class="compact-month-occ[\s\S]*?<\/li>/)[0];
}

/* ---------- A3: positive vs prior negative hierarchy ---------- */

test("A3 negative fixture: a sibling Preview chip beside a leading title link is no longer the enhanced hierarchy", () => {
  const item = firstItemHTML();
  // Prior defect: title link was the dominant control and Preview was a small
  // secondary chip with visible text "Preview".
  assert.doesNotMatch(item, />Preview<\/button>/,
    "enhanced markup must not keep a visible Preview chip as the secondary control");
  assert.match(item, /compact-month-occ-inspect/,
    "the inspect control is title-sized, not a subordinate chip");
  assert.match(item, new RegExp(`class="${CALENDAR_EVENT_FULL_RECORD_CLASS}"`),
    "a separately named full-record link must exist beside the inspect control");
});

test("A3 positive fixture: static title link plus title-sized inspect button plus named full-record link", () => {
  const item = firstItemHTML();
  assert.match(item, /<a class="compact-month-occ-link" href="https:\/\/cityscroll\.org\/meetings\/occ:a"/);
  assert.match(item, /<button class="compact-month-occ-preview compact-month-occ-inspect" type="button"/);
  assert.match(item, /<a class="compact-month-occ-full-record" href="https:\/\/cityscroll\.org\/meetings\/occ:a"/);
  assert.match(item, />Open the event page</);
  const titleLink = item.match(/<a class="compact-month-occ-link"[\s\S]*?<\/a>/)[0];
  const fullRecord = item.match(/<a class="compact-month-occ-full-record"[\s\S]*?<\/a>/)[0];
  assert.doesNotMatch(titleLink, /<button/);
  assert.doesNotMatch(fullRecord, /<button/);
  assert.doesNotMatch(item, /onclick=/);
});

/* ---------- A2: progressive enhancement boundaries ---------- */

test("A2: without the ready marker CSS keeps the title link and hides inspect plus full-record", () => {
  assert.match(CSS, /\.compact-month-occ-preview,\s*\n\.compact-month-occ-full-record\s*{\s*display:\s*none;/);
  assert.match(CSS, new RegExp(`\\[${CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE}\\] \\.compact-month-occ-link\\s*{[^}]*display:\\s*none`));
  assert.match(CSS, new RegExp(`\\[${CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE}\\] \\.compact-month-occ-preview\\s*{[^}]*display:\\s*flex`));
  assert.match(CSS, new RegExp(`\\[${CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE}\\] \\.compact-month-occ-full-record\\s*{[^}]*display:\\s*inline-block`));

  const { container } = mountDocument(monthHTML());
  assert.equal(container.hasAttribute(CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE), false,
    "failed enhancement never marks the container ready");
  assert.ok(container.querySelector(".compact-month-occ-link"), "static title link remains in the document");
});

test("A2: preview never invents time precision for a date-only occurrence", () => {
  const view = buildCompactMonthView(bundle([
    occ({ uid: "occ:date-only", date: "2026-03-20", kind: "deadline", title: "Filing deadline" }),
  ]), { today: TODAY });
  const entry = view.weeks.flat()
    .flatMap((day) => [...day.visible_occurrences, ...day.overflow_occurrences])
    .find((row) => row.uid === "occ:date-only");
  const facts = calendarEventPreviewFacts(entry);
  assert.equal(facts.precision, "date");
  assert.equal(Object.hasOwn(facts, "time"), false);
});

test("A2: opening a preview never navigates, subscribes, submits, or fetches a publisher", () => {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    requests.push(args);
    return Promise.reject(new Error("no request expected"));
  };
  try {
    const { container, dialog } = mountMonth();
    const before = container.querySelector(".compact-month").getAttribute("data-compact-month");
    const hrefBefore = container.querySelector(".compact-month-occ-link").getAttribute("href");
    click(previewButton(container, "occ:a"));
    assert.equal(dialog.open, true);
    assert.equal(container.querySelector(".compact-month").getAttribute("data-compact-month"), before);
    assert.equal(container.querySelector(".compact-month-occ-link").getAttribute("href"), hrefBefore);
    assert.equal(requests.length, 0);
    assert.equal(container.querySelectorAll("form").length, 0);
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

/* ---------- A1: primary enhanced control inspects; hosts share the mount ---------- */

test("A1: the enhanced primary control inspects in place without leaving the month", () => {
  const { container, dialog } = mountMonth();
  assert.ok(container.hasAttribute(CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE));
  const invoker = previewButton(container, "occ:a");
  assert.ok((invoker.getAttribute("class") || "").split(/\s+/).includes("compact-month-occ-inspect"));
  const cellsBefore = container.querySelectorAll(".compact-month-occ").length;
  const monthBefore = container.querySelector(".compact-month").getAttribute("data-compact-month");
  click(invoker);
  assert.equal(dialog.open, true);
  assert.match(dialog.textContent, /Full board meeting/);
  assert.equal(container.querySelector(".compact-month").getAttribute("data-compact-month"), monthBefore);
  assert.equal(container.querySelectorAll(".compact-month-occ").length, cellsBefore);
});

test("A1: the named full-record link keeps the canonical destination and is not nested", () => {
  const { container } = mountMonth();
  const link = fullRecordLink(container, "occ:a");
  assert.equal(link.getAttribute("href"), "https://cityscroll.org/meetings/occ:a");
  assert.equal(link.textContent.includes("Open the event page"), true);
  assert.equal(link.querySelector("button"), null);
  assert.equal(link.closest("button"), null);
});

test("A1: modified-click activation is left to the real link — the inspect button never starts navigation", () => {
  const { container, dialog } = mountMonth();
  const button = previewButton(container, "occ:a");
  const link = fullRecordLink(container, "occ:a");
  click(button, { metaKey: true });
  assert.equal(dialog.open, true, "modified click on the inspect button still inspects; it is not a link");
  assert.equal(link.getAttribute("href"), "https://cityscroll.org/meetings/occ:a");
  assert.equal(button.tagName, "button");
  assert.equal(link.tagName, "a");
});

test("A1: all eight compact-calendar hosts are conforming and share the primary-inspection journey owner", () => {
  assert.equal(COMPACT_CALENDAR_HOST_IDS.length, 8);
  const byId = new Map(BROWSE_INSPECTION_SURFACES.map((row) => [row.surface_id, row]));
  for (const hostId of COMPACT_CALENDAR_HOST_IDS) {
    const host = byId.get(hostId);
    assert.ok(host, hostId);
    assert.equal(host.classification, "conforming", hostId);
    assert.equal(host.baseline_id, null, hostId);
    assert.equal(host.detail_host, "modal_preview", hostId);
    assert.equal(host.journey_owner, "test/calendar_primary_inspection.test.mjs", hostId);
  }
  assert.equal(
    BROWSE_INSPECTION_LEGACY_BASELINE.some((row) => row.id === "compact-calendar-title-navigates"),
    false,
    "the compact-calendar title-navigates baseline entry must be removed once hosts conform",
  );
});

test("A1: every audited host mounts the one shared binder", () => {
  const hosts = [
    ["site/now_view.mjs", /bindCompactMonthCalendar\(/],
    ["site/app/property.mjs", /bindCompactMonthCalendar\(/],
    ["site/app/land.mjs", /bindCompactMonthCalendar\(/],
    ["site/app/rules.mjs", /bindCompactMonthCalendar\(/],
    ["site/exam_document.mjs", /bindCompactMonthCalendar\(/],
    ["site/community_board_constellation.mjs", /renderCalendarEventPreviewScript\(/],
    ["site/legislative_matter_document.mjs", /renderCalendarEventPreviewScript\(/],
    ["site/procurement_document.mjs", /renderCalendarEventPreviewScript\(/],
  ];
  assert.equal(hosts.length, 8);
  for (const [path, pattern] of hosts) {
    assert.match(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), pattern, path);
  }
});

/* ---------- A4: modal contract, overflow, journey evidence ---------- */

test("A4: modal is labelled by the event title and opened through the native modal path", () => {
  const { container, dialog } = mountMonth();
  click(previewButton(container, "occ:b"));
  assert.equal(dialog.showModalCount, 1);
  assert.equal(dialog.getAttribute("aria-labelledby"), CALENDAR_EVENT_PREVIEW_TITLE_ID);
  assert.equal(dialog.querySelector(`#${CALENDAR_EVENT_PREVIEW_TITLE_ID}`).textContent, "Comments due");
});

test("A4: Escape, Close, Tab containment, and disappeared-trigger fallback", () => {
  const { doc, container, dialog } = mountMonth();
  const button = previewButton(container, "occ:a");
  click(button);
  const close = dialog.querySelector("[data-calendar-event-preview-close]");
  assertFocused(doc, close, "opening moves focus inside the dialog");

  const focusable = [...dialog.querySelectorAll("a[href], button:not([disabled])")];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  last.focus();
  keydown(dialog, "Tab");
  assertFocused(doc, first, "Tab wraps inside the dialog");
  first.focus();
  keydown(dialog, "Tab", { shiftKey: true });
  assertFocused(doc, last, "Shift+Tab wraps inside the dialog");

  click(close);
  assert.equal(dialog.open, false);
  assertFocused(doc, button, "Close returns focus to the invoker");

  dialog.showModal = undefined;
  click(button);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  keydown(dialog, "Escape");
  assert.equal(dialog.open, false);
  assertFocused(doc, button, "Escape closes the fallback dialog");

  click(button);
  container.innerHTML = monthHTML();
  const survivor = previewButton(container, "occ:a");
  dialog.close();
  assertFocused(doc, survivor, "focus follows a replaced trigger for the same event");
});

test("A4: rapid selection and failed detail keep the coherent summary and record link", async () => {
  const resolvers = new Map();
  const { container, dialog } = mountMonth([], {
    loadDetail: (facts) => new Promise((resolve, reject) => {
      resolvers.set(facts.uid, { resolve, reject });
    }),
  });
  click(previewButton(container, "occ:a"));
  click(previewButton(container, "occ:b"));
  await tick();
  resolvers.get("occ:a").resolve("Stale detail for the event the reader left");
  await tick();
  assert.match(dialog.textContent, /Comments due/);
  assert.doesNotMatch(dialog.textContent, /Stale detail/);

  resolvers.get("occ:b").reject(new Error("detail unavailable"));
  await tick();
  assert.match(dialog.textContent, /Comments due/);
  assert.match(dialog.textContent, /Further detail did not load/);
  assert.equal(
    dialog.querySelector("[data-calendar-event-preview-open]").getAttribute("href"),
    "https://cityscroll.org/meetings/occ:b",
  );
});

test("A4: day-agenda order and exact overflow counts are preserved", () => {
  const crowded = ["p", "q", "r", "s", "t"].map((suffix, index) => occ({
    uid: `occ:crowd-${suffix}`,
    date: "2026-03-26",
    title: `Crowded item ${index + 1}`,
  }));
  const view = buildCompactMonthView(bundle(crowded), { today: TODAY });
  const day = view.weeks.flat().find((row) => row.date === "2026-03-26");
  assert.ok(day);
  assert.equal(day.visible_occurrences.length, MAX_VISIBLE_OCCURRENCES_PER_DAY);
  assert.equal(day.hidden_count, day.occurrence_count - MAX_VISIBLE_OCCURRENCES_PER_DAY);
  assert.equal(day.overflow_occurrences.length, day.hidden_count);
  const html = renderCompactMonth(view);
  assert.match(html, new RegExp(`data-compact-month-day-hidden="${day.hidden_count}"`));
  assert.match(html, new RegExp(`\\+${day.hidden_count} more`));
  const order = [...day.visible_occurrences, ...day.overflow_occurrences].map((entry) => entry.uid);
  for (const uid of order) assert.ok(html.includes(uid));
});

test("A4: full-record label helpers stay kind-honest and refuse empty facts", () => {
  assert.equal(calendarEventFullRecordLabel(null), null);
  assert.equal(renderCalendarEventFullRecordLink(null), "");
  assert.equal(renderCalendarEventPreviewButton(null), "");
  const deadline = calendarEventPreviewFacts({
    uid: "occ:due",
    title: "Bids due",
    kind: "deadline",
    canonical_url: "https://cityscroll.org/meetings/occ:due",
    day: "2026-03-20",
  });
  assert.equal(calendarEventFullRecordLabel(deadline), "Open the page for this deadline");
  assert.match(renderCalendarEventFullRecordLink(deadline), /Open the page for this deadline/);
});

test("A4: acceptance manifest records the journey with revision, route, viewport, and fixture vintage", () => {
  assert.equal(existsSync(join(ROOT, EVIDENCE_PATH)), true);
  const manifest = JSON.parse(readFileSync(join(ROOT, EVIDENCE_PATH), "utf8"));
  assert.equal(manifest.schema, "cityscroll.calendar_primary_inspection_acceptance.v1");
  assert.equal(manifest.record, "cityscroll-engineering/c6ca330ec16a0");
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.ok(manifest.route);
  assert.ok(Array.isArray(manifest.viewport) && manifest.viewport.length === 2);
  assert.ok(manifest.fixture_vintage);
  assert.ok(Array.isArray(manifest.assertions) && manifest.assertions.length >= 4);
  assert.ok(manifest.assertions.some((row) => row.id === "primary-inspect-no-navigation" && row.result === "accepted"));
  assert.ok(manifest.assertions.some((row) => row.id === "no-js-title-link" && row.result === "accepted"));
  assert.ok(manifest.assertions.some((row) => row.id === "reject-sibling-preview-chip" && row.result === "rejected"));
  assert.ok(manifest.journey?.sequence?.includes("inspect"));
  assert.ok(manifest.journey?.sequence?.includes("open_full_record"));
  for (const banned of ["needs_james", "card_standard", "richness_profile", "autodispatch", "realization_gate"]) {
    assert.equal(JSON.stringify(manifest).includes(banned), false, banned);
  }
  const digest = createHash("sha256").update(JSON.stringify(manifest.assertions) + "\n").digest("hex");
  assert.equal(manifest.assertions_sha256, digest);
});
