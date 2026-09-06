// Action scent across every mounted calendar family.
//
// The reported defect arrived on one Now procurement card, but the naming rule
// it broke belongs to the shared component every calendar-bearing surface
// paints through — rules, Community Boards, Now, land projects, procurement,
// property opportunities, exams and legislative matters. A correction that
// landed only on Now would leave the same misdirection on the other seven and
// would not reach the eighth surface someone mounts next.
//
// So this suite audits rendered markup, family by family, through the one
// shared classifier in `site/affordance_grammar.mjs`:
//
//   A1 no rendered control promises material positioned in the reader's own
//      document unless that surface actually carries it
//   A3 inspection is a button; internal travel is an ordinary anchor; anything
//      leaving this site is presented as the handoff it is
//   A3 a preview inspects and nothing else — it submits nothing, subscribes to
//      nothing, and contacts no publisher
//   A6 every audited host reaches the correction through the shared mount, so a
//      new host inherits it rather than restating it
//
//   node --test test/now_action_scent.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  AFFORDANCE_ACTION_ROLES,
  affordanceActionRole,
  affordancePositionalPromise,
} from "../site/affordance_grammar.mjs";
import { buildCompactMonthView, renderCompactMonth } from "../site/compact_calendar.mjs";
import {
  calendarEventPreviewFacts,
  renderCalendarEventPreviewBody,
} from "../site/calendar_event_preview.mjs";
import {
  calendarDayAgendaFacts,
  renderCalendarDayAgendaBody,
} from "../site/calendar_day_agenda.mjs";

import { buildRulesPhaseView } from "../site/rules_phase_spine.mjs";
import { buildRuleCompactMonthView, renderRuleParticipationMonth } from "../site/rules_calendar.mjs";
import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import { buildNowCalendarView } from "../site/now_calendar.mjs";
import { projectCalendarRecordsForRecord } from "../site/project_calendar.mjs";
import { landProjectConnectedCalendarHTML } from "../site/land_project_connected_calendar.mjs";
import {
  buildPropertyOpportunityRecord,
  opportunityMonthHTML,
  opportunityOccurrences,
  procurementOpportunityOccurrences,
} from "../site/opportunity_calendar.mjs";
import { extractPropertyTimedEvents } from "../site/property_timed_events.mjs";
import { buildExamCalendarView, renderExamApplicationCalendar } from "../site/exam_calendar.mjs";
import { buildLegislativeMatterDocument } from "../site/legislative_matter_document.mjs";
import {
  buildMatterAppearanceCalendarView,
  renderMatterAppearanceCalendar,
} from "../site/legislative_matter_calendar.mjs";

import {
  COMMUNITY_BOARD_FIXTURES,
  EXAM_FIXTURE_TODAY,
  LAND_FIXTURES,
  LEGISLATIVE_FIXTURES,
  NOW_FIXTURES,
  PROCUREMENT_FIXTURES,
  PROPERTY_FIXTURES,
  RULES_FIXTURES,
  fixtureExam,
} from "./fixtures/calendar_parity_matrix.mjs";

/* ---------- rendered-control audit ---------- */

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
const BUTTON = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;

function attribute(attributes, name) {
  return attributes.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
}

// The visible name a sighted reader reads: the decorative glyph and the
// assistive-technology disclosure are signifiers, not part of the name.
function visibleName(inner) {
  return inner
    .replace(/<span\b[^>]*class="sr-only"[^>]*>[\s\S]*?<\/span>/g, "")
    .replace(/<span\b[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function anchorsIn(html) {
  return [...String(html).matchAll(ANCHOR)].map(([, attributes, inner]) => ({
    attributes,
    inner,
    href: attribute(attributes, "href"),
    ariaLabel: attribute(attributes, "aria-label"),
    name: visibleName(inner),
  }));
}

function buttonsIn(html) {
  return [...String(html).matchAll(BUTTON)].map(([, attributes, inner]) => ({
    attributes,
    inner,
    name: visibleName(inner),
    ariaLabel: attribute(attributes, "aria-label"),
  }));
}

/**
 * The whole naming rule, applied to one family's rendered markup.
 *
 * Every anchor is judged against what its own destination does, so a family
 * that publishes its occurrences under a publisher's URL is held to the handoff
 * contract and a family that keeps them on this site is not.
 */
function assertActionScent(html, family) {
  const anchors = anchorsIn(html);
  assert.ok(anchors.length > 0, `${family}: expected the rendered calendar to offer at least one destination`);

  for (const anchor of anchors) {
    const label = anchor.ariaLabel || anchor.name;
    assert.ok(label, `${family}: a control with no name`);
    assert.equal(affordancePositionalPromise(label), false,
      `${family}: "${label}" promises material positioned in the reader's own document`);

    const role = affordanceActionRole({ href: anchor.href });
    assert.ok(role, `${family}: "${label}" is offered with no usable destination`);

    if (role === AFFORDANCE_ACTION_ROLES.handoff) {
      assert.match(anchor.attributes, /target="_blank"/,
        `${family}: "${label}" leaves this site without opening its own tab`);
      assert.match(anchor.attributes, /rel="noopener noreferrer"/,
        `${family}: "${label}" hands off without isolating the opener`);
      assert.match(anchor.inner, /aria-hidden="true">↗/,
        `${family}: "${label}" leaves this site with no visible signifier`);
      assert.match(anchor.inner, /class="sr-only"/,
        `${family}: "${label}" opens a new tab without announcing one`);
    } else {
      assert.doesNotMatch(anchor.attributes, /target="_blank"/,
        `${family}: "${label}" stays on this site but opens a new tab`);
      assert.doesNotMatch(anchor.inner, /aria-hidden="true">↗/,
        `${family}: "${label}" stays on this site but is dressed as a handoff`);
    }
  }

  // Inspection is a button, and it is only ever a button: nothing in the
  // shared component turns a preview or a day agenda into a navigation, a
  // submission or a subscription.
  for (const button of buttonsIn(html)) {
    assert.match(button.attributes, /type="button"/,
      `${family}: an inspection control that is not an explicit button never submits by default`);
    assert.doesNotMatch(button.attributes, /\bhref=/, `${family}: a button is not a destination`);
    assert.doesNotMatch(button.attributes, /\bformaction=|type="submit"/, `${family}: a preview never submits`);
    assert.ok(button.ariaLabel || button.name, `${family}: an unnamed control`);
  }
}

/* ---------- the eight mounted families ---------- */

function rulesMonth() {
  const fixture = RULES_FIXTURES.denseParticipationCluster;
  const view = buildRulesPhaseView({
    request_id: fixture.requestId,
    join: { matched: true },
    nyc_rules: { url: "https://rules.cityofnewyork.us/?p=9001" },
    events: fixture.events,
  }, { skipStitch: true });
  assert.equal(buildRuleCompactMonthView(view, { today: fixture.today }).render, true);
  return renderRuleParticipationMonth(view, { today: fixture.today });
}

function communityBoardMonth() {
  const fixture = COMMUNITY_BOARD_FIXTURES.denseMonth;
  const view = buildCommunityBoardConstellationView(fixture.bodyId, fixture.sources);
  assert.equal(view.proceedings_calendar.render, true);
  const html = renderCommunityBoardConstellationDocument(view);
  return html.match(/<table class="compact-month-grid"[\s\S]*?<\/table>/)?.[0] || "";
}

function nowMonth() {
  const fixture = NOW_FIXTURES.crowdedDay;
  const view = buildNowCalendarView(fixture.surface, { today: fixture.today });
  assert.equal(view.render, true);
  return renderCompactMonth(view);
}

function landMonth() {
  const fixture = LAND_FIXTURES.acceptedAndRejectedRelations;
  return landProjectConnectedCalendarHTML(fixture.record, { today: fixture.today });
}

function procurementMonth() {
  const fixture = PROCUREMENT_FIXTURES.conferenceQuestionsDeadlineBundle;
  const { occurrences } = procurementOpportunityOccurrences(fixture.object, fixture.observations);
  return opportunityMonthHTML(occurrences, { today: fixture.today });
}

function propertyMonth() {
  const fixture = PROPERTY_FIXTURES.showingsAndDeadlineBundle;
  const record = buildPropertyOpportunityRecord(extractPropertyTimedEvents(fixture.row), {
    requestId: fixture.row.request_id,
    shortTitle: fixture.row.short_title,
    noticeBody: fixture.row.additional_description_1,
    sourceUrl: `https://a856-cityrecord.nyc.gov/RequestDetail/${fixture.row.request_id}`,
    canonicalUrl: `https://cityscroll.org/notices/${fixture.row.request_id}`,
  });
  const { occurrences } = opportunityOccurrences([record]);
  return opportunityMonthHTML(occurrences, { today: fixture.today });
}

function examMonth() {
  const view = buildExamCalendarView(fixtureExam("qualifying-three-date"), { today: EXAM_FIXTURE_TODAY });
  assert.equal(view.render, true);
  return renderExamApplicationCalendar(view);
}

function legislativeMonth() {
  const fixture = LEGISLATIVE_FIXTURES;
  const view = buildLegislativeMatterDocument(fixture.buildPayload(fixture.concentratedMatter), fixture.matterId);
  const calendar = buildMatterAppearanceCalendarView(view, { today: fixture.today });
  assert.equal(calendar.render, true);
  return renderMatterAppearanceCalendar(calendar);
}

const FAMILIES = Object.freeze({
  rulemaking: rulesMonth,
  "community board": communityBoardMonth,
  now: nowMonth,
  "land project": landMonth,
  procurement: procurementMonth,
  "property opportunity": propertyMonth,
  exam: examMonth,
  "legislative matter": legislativeMonth,
});

test("A1/A3: every mounted calendar family names its controls for what they do", () => {
  const families = Object.entries(FAMILIES);
  assert.equal(families.length, 8, "all eight mounted families are audited, not the reported one");
  for (const [family, render] of families) {
    assertActionScent(render(), family);
  }
});

/* ---------- the shared panels every family inherits ---------- */

function occurrence(overrides = {}) {
  return {
    uid: "occ:scent",
    kind: "event",
    title: "Full board meeting",
    date: "2026-03-19",
    starts_at: "2026-03-19",
    timezone: "America/New_York",
    lifecycle: "scheduled",
    status: "scheduled",
    canonical_url: "https://cityscroll.org/meetings/occ:scent",
    source: { system: "city_record", url: "https://a860-gpp.nyc.gov/notice/20260319001" },
    ...overrides,
  };
}

// A crowded day, built the way a host builds one: the agenda exists precisely
// because a cell could not paint every occurrence, so it is taken from a real
// rendered month rather than assembled by hand.
function agendaFacts(overrides = {}) {
  const occurrences = [
    ...Array.from({ length: 4 }, (_, index) => occurrence({
      uid: `occ:agenda-${index}`,
      canonical_url: overrides.canonical_url || `https://cityscroll.org/meetings/occ:agenda-${index}`,
      title: index === 0 ? "Full board meeting" : `Committee session ${index}`,
    })),
    occurrence({ uid: "occ:agenda-other", date: "2026-03-24", starts_at: "2026-03-24" }),
  ];
  const view = buildCompactMonthView(occurrences, { today: "2026-03-15" });
  assert.equal(view.render, true);
  const day = view.weeks.flat().find((cell) => cell.date === "2026-03-19");
  const facts = calendarDayAgendaFacts(day);
  assert.ok(facts, "expected a crowded day with a real remainder to disclose");
  return facts;
}

test("A3: the preview presents this site's page and a publisher's record as two different things", () => {
  const body = renderCalendarEventPreviewBody(calendarEventPreviewFacts(occurrence()));
  const [open, source] = anchorsIn(body);

  assert.equal(open.name, "Open the event page");
  assert.equal(affordanceActionRole({ href: open.href }), AFFORDANCE_ACTION_ROLES.navigate);
  assert.doesNotMatch(open.attributes, /target="_blank"/);

  assert.equal(source.name, "Open the publisher's record");
  assert.equal(affordanceActionRole({ href: source.href }), AFFORDANCE_ACTION_ROLES.handoff);
  assert.match(source.attributes, /target="_blank"/);
  assert.match(source.inner, /↗/);
  // The control names the consequence rather than the publishing system that
  // produced the record.
  assert.doesNotMatch(body, /city_record/);
  assertActionScent(body, "preview");
});

test("A3: a preview of an occurrence published under the publisher's own URL says so", () => {
  // The occurrence contract accepts a publisher's absolute URL as canonical, so
  // "Open the event page" would be a promise about a page this site does not
  // own. The label and the presentation both follow the destination.
  const body = renderCalendarEventPreviewBody(calendarEventPreviewFacts(occurrence({
    canonical_url: "https://rules.cityofnewyork.us/rule/energy-code/",
  })));
  const [open] = anchorsIn(body);
  assert.equal(open.name, "Open the published event page");
  assert.match(open.attributes, /target="_blank"/);
  assert.match(open.inner, /↗/);
  assertActionScent(body, "preview handoff");
});

test("A3: preview and day agenda inspect only — no submission, subscription or publisher request", () => {
  const facts = calendarEventPreviewFacts(occurrence());
  const preview = renderCalendarEventPreviewBody(facts);
  const agenda = renderCalendarDayAgendaBody(agendaFacts());
  for (const [surface, html] of [["preview", preview], ["day agenda", agenda]]) {
    assert.doesNotMatch(html, /<form\b|<input\b|method="post"/i, `${surface} submits nothing`);
    assert.doesNotMatch(html, /webcal:|\.ics\b/i, `${surface} changes no subscription`);
    assertActionScent(html, surface);
  }
});

test("A3: a day agenda item whose canonical destination is a publisher is rendered as a handoff", () => {
  const agenda = renderCalendarDayAgendaBody(agendaFacts({
    canonical_url: "https://rules.cityofnewyork.us/rule/energy-code/",
  }));
  const [item] = anchorsIn(agenda);
  assert.equal(item.name, "Full board meeting");
  assert.match(item.attributes, /target="_blank"/);
  assert.match(item.inner, /↗/);
  assertActionScent(agenda, "day agenda handoff");
});

test("A3: the month cell's publisher link names its consequence instead of a category", () => {
  const view = buildCompactMonthView(
    ["2026-03-17", "2026-03-19", "2026-03-24"].map((date, index) => occurrence({
      uid: `occ:cell-${index}`,
      date,
      starts_at: date,
      canonical_url: `https://cityscroll.org/meetings/occ:cell-${index}`,
    })),
    { today: "2026-03-15" },
  );
  assert.equal(view.render, true);
  const html = renderCompactMonth(view);
  const publisher = anchorsIn(html).find((anchor) => /a860-gpp/.test(anchor.href || ""));
  assert.ok(publisher, "expected the cell to offer the publisher's record");
  // The cell is narrow, so the visible word stays short while the accessible
  // name carries the whole promise. "Source" named neither.
  assert.equal(publisher.name, "Publisher");
  assert.match(publisher.ariaLabel, /^Open the publisher's record: /);
  assertActionScent(html, "month cell");
});

/* ---------- A6: every host inherits the correction ---------- */

test("A6: all eight audited hosts reach the shared component, so a new host inherits this", () => {
  // Re-resolved against the tree rather than assumed: the correction lives in
  // the shared renderer and its two panels, so a host earns it by mounting the
  // component and cannot opt out of it by rendering its own month.
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
    assert.match(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), pattern, `${path} mounts the shared component`);
  }
});

test("A6: the shared renderers decide handoff presentation once, through the one classifier", () => {
  // A surface that restated the rule locally would drift the first time the
  // rule changed. Each shared renderer imports the decision instead.
  for (const path of [
    "site/compact_calendar.mjs",
    "site/calendar_event_preview.mjs",
    "site/calendar_day_agenda.mjs",
    "site/now_view.mjs",
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /affordanceHandoffPresentation/, `${path} uses the shared presentation`);
    assert.doesNotMatch(source, /\/\^https:\\\/\\\/\/i\.test/, `${path} decides by scheme test rather than by destination`);
  }
});
