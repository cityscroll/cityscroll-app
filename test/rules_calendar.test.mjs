// Rulemaking participation month (CBICS-03). This suite pins: a dense
// proposal/hearing/comment-close bundle rendering the shared compact month
// (A1), semantic labels/stable identity/canonical destinations carried over
// from the RD-S4 history timeline (A2), the derived "awaiting agency action"
// state never becoming a dated cell (A3), partial historical coverage
// staying visible and untouched by the calendar projection (A4), sparse and
// unavailable rules keeping their existing lifecycle with no placeholder
// (A5), canonical link/list parity with the traceable history, reschedule
// identity collapsing onto one stable occurrence, and no-JS-safe markup with
// the required mount order relative to related notices and the full history
// (A6).
//
//   node --test test/rules_calendar.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRulesPhaseView } from "../site/rules_phase_spine.mjs";
import {
  RULE_EVENT_CALENDAR_KIND,
  buildRuleCalendarOccurrences,
  buildRuleCalendarRecord,
  buildRuleCompactMonthView,
  renderRuleParticipationMonth,
} from "../site/rules_calendar.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const REQUEST_ID = "20260501001";
const TODAY = "2026-04-01";

function rec(events, overrides = {}) {
  return {
    request_id: REQUEST_ID,
    stage: "comment-open",
    join: { matched: true },
    nyc_rules: { url: "https://rules.cityofnewyork.us/?p=1" },
    ...overrides,
    events,
  };
}

function viewFor(events, overrides) {
  return buildRulesPhaseView(rec(events, overrides), { skipStitch: true });
}

// Proposal → hearing → comment-close inside a 35-day span: three eligible
// occurrences on three distinct dates, well within the 42-day window.
const DENSE_EVENTS = [
  { event_type: "proposal_published", valid_at: "2026-05-01", source_url: "https://rules.cityofnewyork.us/?p=1", request_id: REQUEST_ID, status: "occurred" },
  { event_type: "public_hearing", valid_at: "2026-05-20", source_url: "https://rules.cityofnewyork.us/?p=1", request_id: REQUEST_ID, status: "scheduled" },
  { event_type: "comment_close", valid_at: "2026-06-05", source_url: "https://rules.cityofnewyork.us/?p=1", request_id: REQUEST_ID, status: "scheduled" },
];

test("RULE_EVENT_CALENDAR_KIND covers exactly the five rule history event types", () => {
  assert.deepEqual(Object.keys(RULE_EVENT_CALENDAR_KIND).sort(), [
    "adoption", "comment_close", "effective", "proposal_published", "public_hearing",
  ]);
});

test("A1: a rule with proposal, hearing, and comment-close inside the eligibility window displays the shared compact month", () => {
  const view = viewFor(DENSE_EVENTS);
  const monthView = buildRuleCompactMonthView(view, { today: TODAY });
  assert.equal(monthView.render, true);
  assert.equal(monthView.month, "2026-05");
  const html = renderRuleParticipationMonth(view, { today: TODAY });
  assert.match(html, /Participation month/);
  assert.match(html, /<table[^>]*class="compact-month-grid"/);
});

test("A2: proposal, hearing, comment-close events retain semantic labels, stable identity, provenance, and canonical destinations", () => {
  const view = viewFor(DENSE_EVENTS);
  const occurrences = buildRuleCalendarOccurrences(view);
  assert.equal(occurrences.length, 3);
  const byType = new Map(occurrences.map((o) => [o.provenance.rule_event_type, o]));
  assert.equal(byType.get("proposal_published").title, "Proposal published");
  assert.equal(byType.get("public_hearing").title, "Public hearing");
  assert.equal(byType.get("comment_close").title, "Comment period closes");
  assert.equal(byType.get("proposal_published").uid, `rule:${REQUEST_ID}:proposal_published`);
  assert.equal(byType.get("public_hearing").uid, `rule:${REQUEST_ID}:public_hearing`);
  assert.equal(byType.get("comment_close").uid, `rule:${REQUEST_ID}:comment_close`);
  for (const occ of occurrences) {
    assert.equal(occ.canonical_url, "https://rules.cityofnewyork.us/?p=1");
    assert.ok(occ.source);
    assert.equal(occ.provenance.basis, "publisher_record");
  }
});

test("A2/A6: calendar canonical links match the traceable history timeline's own links (link/list parity)", () => {
  const view = viewFor(DENSE_EVENTS);
  const occurrences = buildRuleCalendarOccurrences(view);
  const byType = new Map(occurrences.map((o) => [o.provenance.rule_event_type, o]));
  for (const event of view.history_timeline.events) {
    assert.equal(byType.get(event.event_type).canonical_url, event.trace_href);
  }
});

test("canonical destination falls back to an absolute CityScroll record link when no official source URL is retained", () => {
  const events = [
    { event_type: "proposal_published", valid_at: "2026-05-01", request_id: REQUEST_ID, status: "occurred" },
    { event_type: "public_hearing", valid_at: "2026-05-10", request_id: REQUEST_ID, status: "scheduled" },
    { event_type: "comment_close", valid_at: "2026-05-20", request_id: REQUEST_ID, status: "scheduled" },
  ];
  const view = viewFor(events, { nyc_rules: null });
  const occurrences = buildRuleCalendarOccurrences(view);
  assert.equal(occurrences.length, 3);
  for (const occ of occurrences) {
    assert.equal(occ.canonical_url, `https://cityscroll.org/notices/${REQUEST_ID}`);
  }
});

test("A3: the derived 'awaiting agency action' state never becomes a dated cell", () => {
  const view = viewFor(DENSE_EVENTS);
  assert.ok(view.history_timeline.derived, "fixture must actually produce a derived entry");
  const occurrences = buildRuleCalendarOccurrences(view);
  assert.ok(occurrences.every((o) => o.provenance.rule_event_type !== "derived"));
  const html = renderRuleParticipationMonth(view, { today: TODAY });
  assert.doesNotMatch(html, /Awaiting agency action/i);
  assert.doesNotMatch(html, /Derived/);
});

test("publication-only / unsupported event types never become dated cells", () => {
  const events = [
    ...DENSE_EVENTS,
    { event_type: "notice_published", valid_at: "2026-05-15", request_id: REQUEST_ID, status: "occurred" },
  ];
  const view = viewFor(events);
  const occurrences = buildRuleCalendarOccurrences(view);
  assert.equal(occurrences.length, 3);
  assert.ok(occurrences.every((o) => o.provenance.rule_event_type !== "notice_published"));
});

test("A4: partial historical coverage stays visible and is untouched by the calendar projection", () => {
  const view = viewFor(DENSE_EVENTS);
  assert.equal(view.history_timeline.coverage.state, "partial");
  assert.deepEqual(view.history_timeline.coverage.missing_event_types, ["adoption", "effective"]);
  const monthView = buildRuleCompactMonthView(view, { today: TODAY });
  assert.equal(monthView.render, true);
  assert.equal(view.history_timeline.coverage.state, "partial");
  assert.deepEqual(view.history_timeline.coverage.missing_event_types, ["adoption", "effective"]);
});

test("A5: fewer than three eligible occurrences preserves the existing lifecycle with no calendar placeholder", () => {
  const view = viewFor(DENSE_EVENTS.slice(0, 2));
  const monthView = buildRuleCompactMonthView(view, { today: TODAY });
  assert.equal(monthView.render, false);
  assert.equal(monthView.reason, "sparse-too-few-occurrences");
  assert.equal(renderRuleParticipationMonth(view, { today: TODAY }), "");
});

test("A5: three occurrences on a single date is sparse, never renders", () => {
  const sameDay = DENSE_EVENTS.map((event) => ({ ...event, valid_at: "2026-05-01" }));
  const view = viewFor(sameDay);
  const monthView = buildRuleCompactMonthView(view, { today: TODAY });
  assert.equal(monthView.render, false);
  assert.equal(monthView.reason, "sparse-single-date");
});

test("A5: a rule with no history-observed known date produces no calendar record, no placeholder", () => {
  const view = viewFor([{ event_type: "proposal_published", valid_at: null, request_id: REQUEST_ID, status: "occurred" }]);
  assert.equal(buildRuleCalendarRecord(view), null);
  assert.deepEqual(buildRuleCalendarOccurrences(view), []);
  const monthView = buildRuleCompactMonthView(view, { today: TODAY });
  assert.equal(monthView.render, false);
  assert.equal(monthView.reason, "unavailable-no-occurrences");
});

test("A5: a rule with no material events at all produces no calendar record", () => {
  const view = viewFor([]);
  assert.equal(buildRuleCalendarRecord(view), null);
  assert.equal(renderRuleParticipationMonth(view, { today: TODAY }), "");
});

const RESCHEDULE_EVENTS = [
  { event_type: "proposal_published", valid_at: "2026-05-01", source_url: "https://rules.cityofnewyork.us/?p=1", request_id: REQUEST_ID, status: "occurred" },
  { event_type: "public_hearing", valid_at: "2026-05-10", source_url: "https://rules.cityofnewyork.us/?p=1", request_id: REQUEST_ID, status: "occurred" },
  { event_type: "public_hearing", valid_at: "2026-05-20", source_url: "https://rules.cityofnewyork.us/?p=1", request_id: REQUEST_ID, status: "scheduled" },
  { event_type: "comment_close", valid_at: "2026-06-01", source_url: "https://rules.cityofnewyork.us/?p=1", request_id: REQUEST_ID, status: "scheduled" },
];

test("reschedule identity: two observed hearing notices collapse onto one stable occurrence, newest observation wins", () => {
  const view = viewFor(RESCHEDULE_EVENTS);
  const occurrences = buildRuleCalendarOccurrences(view);
  const hearings = occurrences.filter((o) => o.provenance.rule_event_type === "public_hearing");
  assert.equal(hearings.length, 1);
  assert.equal(hearings[0].uid, `rule:${REQUEST_ID}:public_hearing`);
  assert.equal(hearings[0].date, "2026-05-20");
  assert.equal(occurrences.length, 3);
  assert.equal(buildRuleCompactMonthView(view, { today: TODAY }).render, true);
});

test("no-JS behavior: rendered markup is real anchors and a real table, not script-dependent", () => {
  const view = viewFor(DENSE_EVENTS);
  const html = renderRuleParticipationMonth(view, { today: TODAY });
  assert.match(html, /<table[^>]*class="compact-month-grid"/);
  assert.match(html, /<a class="compact-month-occ-link" href="https:\/\/rules\.cityofnewyork\.us\/\?p=1"/);
  assert.doesNotMatch(html, /onclick=/);
});

test("action hierarchy: the compact month mounts after related notices and before the full process history", () => {
  assert.match(SITE_SOURCE, /\$\{siblings\}\s*\$\{calendar\}\s*\$\{history\}/);
  assert.match(SITE_SOURCE, /rules_calendar\.mjs/);
  assert.match(SITE_SOURCE, /renderRuleParticipationMonth/);
});

test("app wiring passes a date-only `today` — todayISO() returns a full timestamp buildCompactMonthView rejects", () => {
  assert.match(SITE_SOURCE, /renderRuleParticipationMonth\(view,\s*\{\s*today:\s*todayISO\(\)\.slice\(0,\s*10\)\s*\}\)/);
});

test("A6: existing rule actions and timeline remain wired", () => {
  assert.match(SITE_SOURCE, /function ruleCommentAction\(/);
  assert.match(SITE_SOURCE, /function ruleSiblingsHTML\(/);
  assert.match(SITE_SOURCE, /function ruleHistoryTimelineHTML\(/);
  assert.match(SITE_SOURCE, /function downloadRuleEventICS\(/);
});
