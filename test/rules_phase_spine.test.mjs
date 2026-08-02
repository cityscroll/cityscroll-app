// Pure rules phase spine: phase-group, aggregate, dedupe, current/next.
//
//   node --test test/rules_phase_spine.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  RULES_PHASES,
  RULE_EVENT_TYPES,
  aggregatePhaseEvents,
  buildRulesPhaseView,
  dedupePhaseSourceLinks,
  eventDate,
  mapEventToPhase,
  normalizeSourceUrl,
} from "../site/rules_phase_spine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Open-comment commercial-meter style notice (proposal + hearing + comment). */
const OPEN_COMMENT = {
  request_id: "20260714029",
  stage: "comment-open",
  join: { matched: true },
  nyc_rules: {
    url: "https://rules.cityofnewyork.us/?p=9001",
    comment_url: "https://rules.cityofnewyork.us/?p=9001#comment",
    comment_by_date: "2026-09-15",
    hearing_date: "2026-09-10",
  },
  events: [
    {
      event_type: "proposal_published",
      valid_at: "2026-07-14",
      source_url: "https://rules.cityofnewyork.us/?p=9001",
      status: "occurred",
    },
    {
      event_type: "public_hearing",
      valid_at: "2026-09-10",
      source_url: "https://rules.cityofnewyork.us/?p=9001",
      status: "scheduled",
    },
    {
      event_type: "comment_close",
      valid_at: "2026-09-15",
      source_url: "https://rules.cityofnewyork.us/?p=9001",
      status: "scheduled",
    },
  ],
};

/** Fully adopted rule with effective date. */
const ADOPTED = {
  request_id: "20250101001",
  stage: "effective",
  join: { matched: true },
  nyc_rules: {
    url: "https://rules.cityofnewyork.us/?p=100",
    effective_date: "2025-06-01",
  },
  events: [
    {
      event_type: "adoption",
      valid_at: null,
      published_at: "2025-03-01T12:00:00.000Z",
      source_url: "https://rules.cityofnewyork.us/?p=100",
      status: "occurred",
    },
    {
      event_type: "effective",
      valid_at: "2025-06-01",
      source_url: "https://rules.cityofnewyork.us/?p=100",
      status: "occurred",
    },
  ],
};

test("RULES_PHASES is proposal → public process → adoption → effective", () => {
  assert.deepEqual([...RULES_PHASES], [
    "proposal",
    "public_process",
    "adoption",
    "effective",
  ]);
});

test("mapEventToPhase keeps comment_close distinct under public_process", () => {
  assert.equal(mapEventToPhase("proposal_published"), "proposal");
  assert.equal(mapEventToPhase("public_hearing"), "public_process");
  assert.equal(mapEventToPhase("comment_close"), "public_process");
  assert.equal(mapEventToPhase("adoption"), "adoption");
  assert.equal(mapEventToPhase("effective"), "effective");
  assert.equal(mapEventToPhase("nope"), "proposal");
});

test("eventDate prefers valid_at and falls back to published_at", () => {
  assert.equal(eventDate({ valid_at: "2026-09-15" }), "2026-09-15");
  assert.equal(eventDate({ published_at: "2025-03-01T12:00:00.000Z" }), "2025-03-01");
  assert.equal(eventDate(null), null);
});

test("aggregatePhaseEvents collapses verbatim titles and keeps members", () => {
  const events = [
    {
      event_type: "public_hearing",
      title: "Public hearing",
      valid_at: "2026-09-10",
      status: "scheduled",
    },
    {
      event_type: "public_hearing",
      title: "Public hearing",
      valid_at: "2026-09-17",
      status: "scheduled",
    },
    {
      event_type: "comment_close",
      title: "Comment deadline",
      valid_at: "2026-09-15",
      status: "scheduled",
    },
  ];
  const agg = aggregatePhaseEvents(events);
  const hearing = agg.find((a) => a.event_type === "public_hearing");
  assert.equal(hearing.count, 2);
  assert.equal(hearing.first, "2026-09-10");
  assert.equal(hearing.last, "2026-09-17");
  assert.equal(hearing.members.length, 2);
  // comment_close stays its own aggregate (never collapsed into hearing).
  const close = agg.find((a) => a.event_type === "comment_close");
  assert.equal(close.count, 1);
  assert.equal(close.first, "2026-09-15");
});

test("dedupePhaseSourceLinks collapses identical URLs to one", () => {
  const events = [
    { source_url: "https://rules.cityofnewyork.us/?p=9001" },
    { source_url: "https://rules.cityofnewyork.us/?p=9001/" },
    { source_url: "https://rules.cityofnewyork.us/?p=9001" },
  ];
  const d = dedupePhaseSourceLinks(events);
  assert.equal(d.candidates, 3);
  assert.equal(d.count, 1);
  assert.ok(normalizeSourceUrl(d.url).includes("rules.cityofnewyork.us"));
});

test("open-comment: current is public_process; hearing+comment under one phase", () => {
  const view = buildRulesPhaseView(OPEN_COMMENT);
  assert.equal(view.schema_version, 1);
  assert.equal(view.phases.length, 4);
  assert.deepEqual(
    view.phases.map((p) => p.id),
    [...RULES_PHASES],
  );
  assert.equal(view.current.phase_id, "public_process");
  assert.equal(view.current.lead_action, "comment");
  assert.equal(view.current.milestone_event_type, "comment_close");

  const proposal = view.phases.find((p) => p.id === "proposal");
  assert.equal(proposal.state, "passed");
  assert.equal(proposal.event_count, 1);

  const pub = view.phases.find((p) => p.id === "public_process");
  assert.equal(pub.state, "current");
  assert.equal(pub.event_count, 2);
  assert.ok(pub.events.some((e) => e.event_type === "public_hearing"));
  assert.ok(pub.events.some((e) => e.event_type === "comment_close"));
  // Distinct comment_close date preserved.
  const close = pub.events.find((e) => e.event_type === "comment_close");
  assert.equal(close.valid_at, "2026-09-15");
  // Three identical portal links → one unique source on the phase.
  assert.equal(pub.source_link_candidates, 2);
  assert.equal(pub.source_link_count, 1);

  const adoption = view.phases.find((p) => p.id === "adoption");
  assert.equal(adoption.state, "future");
  assert.equal(adoption.event_count, 0);
  assert.ok(adoption.missing_types.includes("adoption"));

  assert.equal(view.next?.phase_id, "adoption");
  assert.equal(view.event_count, 3);
  assert.equal(view.source_link_candidates, 3);
  assert.equal(view.source_link_unique, 1);
});

test("adopted+effective: current is effective; no invented intermediate stages", () => {
  const view = buildRulesPhaseView(ADOPTED);
  assert.equal(view.current.phase_id, "effective");
  assert.equal(view.next, null);
  assert.equal(view.phases.find((p) => p.id === "adoption")?.state, "passed");
  assert.equal(view.phases.find((p) => p.id === "effective")?.state, "current");
  // Only the five known event types exist in the model.
  for (const e of view.chronological) {
    assert.ok(RULE_EVENT_TYPES.includes(e.event_type));
  }
  // No CAPA / intermediate stages invented when data is sparse.
  assert.equal(view.phases.length, 4);
  assert.equal(view.event_count, 2);
});

test("unmatched notice: empty spine stays on proposal with gap slots", () => {
  const view = buildRulesPhaseView({
    request_id: "20260101001",
    stage: "unknown",
    join: { matched: false },
    nyc_rules: null,
    events: [],
  });
  assert.equal(view.joined, false);
  assert.equal(view.current.phase_id, "proposal");
  assert.equal(view.event_count, 0);
  for (const p of view.phases) {
    if (p.id === "proposal") assert.equal(p.state, "current");
    else assert.equal(p.state, "future");
    assert.equal(p.event_count, 0);
  }
});

test("public Rules detail template uses phase spine surface", () => {
  const index = readFileSync(join(ROOT, "site/index.html"), "utf8");
  assert.match(index, /function ruleEventSpineHTML\(/);
  assert.match(index, /buildRulesPhaseView|rules_phase_spine/);
  assert.match(index, /rule-phase-stepper|rule-spine-lead/);
  assert.match(index, /rule_phase_proposal|rule_phase_public_process/);
});
