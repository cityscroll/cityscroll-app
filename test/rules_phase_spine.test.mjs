import { SITE_SOURCE } from "./helpers/site_source.mjs";
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
  eventFromRelatedNotice,
  isConfidentMultiNoticeRulemaking,
  isConfidentRelatedNotice,
  mapEventToPhase,
  mergeRulemakingEvents,
  normalizeSourceUrl,
  stitchRulemakingRecord,
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
  const index = SITE_SOURCE;
  assert.match(index, /function ruleEventSpineHTML\(/);
  assert.match(index, /buildRulesPhaseView|rules_phase_spine/);
  assert.match(index, /rule-phase-stepper|rule-spine-lead/);
  assert.match(index, /rule_phase_proposal|rule_phase_public_process/);
  // Multi-notice stitch consumption on the public lens.
  assert.match(index, /stitchRulemakingRecord|recordsById/);
  assert.match(index, /ruleSiblingsHTML|rule-siblings/);
  assert.match(index, /rule_siblings_heading/);
});

// ---------------------------------------------------------------------------
// Multi-notice rulemaking stitch (public surface)
// ---------------------------------------------------------------------------

const MULTI_PROPOSAL = {
  request_id: "20260301011",
  title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
  notice_date: "2026-03-01",
  stage: "comment-open",
  join: { matched: false },
  nyc_rules: null,
  events: [],
  rulemaking_subject_ref: "rulemaking:hpd:natural-gas-detectors",
  rulemaking_join: {
    matched: true,
    confidence: "high",
    notice_count: 3,
    method: "title_agency_window",
    role: "proposal",
  },
  related_notices: [
    {
      request_id: "20260415011",
      role: "hearing",
      title: "Public Hearing on Natural Gas Detectors in Dwelling Units",
      notice_date: "2026-04-15",
      event_date: "2026-04-20",
      stage: "hearing",
      join: { matched: true, confidence: "high", method: "title_agency_window" },
    },
    {
      request_id: "20260701011",
      role: "adoption",
      title: "Notice of Adoption — Natural Gas Detectors in Dwelling Units",
      notice_date: "2026-07-01",
      stage: "adopted",
      join: { matched: true, confidence: "high", method: "title_agency_window" },
    },
  ],
};

const MULTI_HEARING = {
  request_id: "20260415011",
  title: "Public Hearing on Natural Gas Detectors in Dwelling Units",
  notice_date: "2026-04-15",
  stage: "hearing",
  join: { matched: false },
  nyc_rules: null,
  events: [
    {
      event_type: "public_hearing",
      valid_at: "2026-04-20T10:00:00",
      source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260415011",
      source_field: "city_record.event_date",
      status: "occurred",
    },
  ],
  rulemaking_subject_ref: "rulemaking:hpd:natural-gas-detectors",
  rulemaking_join: {
    matched: true,
    confidence: "high",
    notice_count: 3,
    method: "title_agency_window",
    role: "hearing",
  },
  related_notices: [
    {
      request_id: "20260301011",
      role: "proposal",
      title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
      notice_date: "2026-03-01",
      stage: "comment-open",
      join: { matched: true, confidence: "high", method: "title_agency_window" },
    },
    {
      request_id: "20260701011",
      role: "adoption",
      title: "Notice of Adoption — Natural Gas Detectors in Dwelling Units",
      notice_date: "2026-07-01",
      stage: "adopted",
      join: { matched: true, confidence: "high", method: "title_agency_window" },
    },
  ],
};

const MULTI_ADOPTION = {
  request_id: "20260701011",
  title: "Notice of Adoption — Natural Gas Detectors in Dwelling Units",
  notice_date: "2026-07-01",
  stage: "adopted",
  join: { matched: true, confidence: "high" },
  nyc_rules: {
    url: "https://rules.cityofnewyork.us/?p=gas",
    adoption_published_at: "2026-07-01T12:00:00.000Z",
    effective_date: "2026-08-01",
  },
  events: [
    {
      event_type: "adoption",
      valid_at: null,
      published_at: "2026-07-01T12:00:00.000Z",
      source_url: "https://rules.cityofnewyork.us/?p=gas",
      status: "occurred",
    },
    {
      event_type: "effective",
      valid_at: "2026-08-01",
      source_url: "https://rules.cityofnewyork.us/?p=gas",
      status: "occurred",
    },
  ],
  rulemaking_subject_ref: "rulemaking:hpd:natural-gas-detectors",
  rulemaking_join: {
    matched: true,
    confidence: "high",
    notice_count: 3,
    method: "title_agency_window",
    role: "adoption",
  },
  related_notices: [
    {
      request_id: "20260301011",
      role: "proposal",
      title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
      notice_date: "2026-03-01",
      stage: "comment-open",
      join: { matched: true, confidence: "high", method: "title_agency_window" },
    },
    {
      request_id: "20260415011",
      role: "hearing",
      title: "Public Hearing on Natural Gas Detectors in Dwelling Units",
      notice_date: "2026-04-15",
      event_date: "2026-04-20",
      stage: "hearing",
      join: { matched: true, confidence: "high", method: "title_agency_window" },
    },
  ],
};

const UNRELATED_SOLO = {
  request_id: "20260320099",
  title: "Proposed Rule — Lead-Based Paint Inspection Fees",
  notice_date: "2026-03-20",
  stage: "proposed",
  join: { matched: false },
  nyc_rules: null,
  events: [],
  rulemaking_subject_ref: "rulemaking:hpd:lead-paint",
  rulemaking_join: {
    matched: false,
    confidence: "singleton",
    notice_count: 1,
    method: "single_notice",
  },
  related_notices: [],
};

test("isConfidentMultiNoticeRulemaking requires high multi join", () => {
  assert.equal(isConfidentMultiNoticeRulemaking(MULTI_PROPOSAL), true);
  assert.equal(isConfidentMultiNoticeRulemaking(UNRELATED_SOLO), false);
  assert.equal(isConfidentMultiNoticeRulemaking({
    rulemaking_join: { matched: true, confidence: "low", notice_count: 2 },
  }), false);
  assert.equal(isConfidentRelatedNotice(MULTI_PROPOSAL.related_notices[0]), true);
  assert.equal(isConfidentRelatedNotice({
    request_id: "X",
    join: { matched: true, confidence: "low" },
  }), false);
});

test("eventFromRelatedNotice synthesizes role-dated spine events", () => {
  const hearing = eventFromRelatedNotice(MULTI_PROPOSAL.related_notices[0], {
    now: "2026-08-01",
  });
  assert.equal(hearing.event_type, "public_hearing");
  assert.equal(hearing.valid_at, "2026-04-20");
  assert.equal(hearing.status, "occurred");
  assert.match(hearing.source_url, /RequestDetail\/20260415011/);

  const adoption = eventFromRelatedNotice(MULTI_PROPOSAL.related_notices[1], {
    now: "2026-08-01",
  });
  assert.equal(adoption.event_type, "adoption");
  assert.equal(adoption.valid_at, "2026-07-01");
});

test("stitchRulemakingRecord merges sibling events into one lifecycle", () => {
  const byId = new Map([
    [MULTI_PROPOSAL.request_id, MULTI_PROPOSAL],
    [MULTI_HEARING.request_id, MULTI_HEARING],
    [MULTI_ADOPTION.request_id, MULTI_ADOPTION],
  ]);
  const stitched = stitchRulemakingRecord(MULTI_PROPOSAL, byId, { now: "2026-08-01" });
  assert.equal(stitched.multi_notice, true);
  assert.equal(stitched.stitched, true);
  assert.equal(stitched.sibling_notices.length, 3);
  assert.equal(stitched.rulemaking_subject_ref, "rulemaking:hpd:natural-gas-detectors");
  // Proposal notice alone had empty events; stitch pulls hearing + adoption/effective.
  const types = stitched.events.map((e) => e.event_type).sort();
  assert.ok(types.includes("public_hearing"));
  assert.ok(types.includes("adoption"));
  assert.ok(types.includes("effective"));
  // Richer NYC Rules from adoption sibling.
  assert.equal(stitched.nyc_rules?.url, "https://rules.cityofnewyork.us/?p=gas");
  assert.equal(stitched.stage, "adopted");
});

test("buildRulesPhaseView multi-notice: one stitched spine with siblings", () => {
  const byId = {
    [MULTI_PROPOSAL.request_id]: MULTI_PROPOSAL,
    [MULTI_HEARING.request_id]: MULTI_HEARING,
    [MULTI_ADOPTION.request_id]: MULTI_ADOPTION,
  };
  const view = buildRulesPhaseView(MULTI_PROPOSAL, {
    recordsById: byId,
    now: "2026-08-01",
  });
  assert.equal(view.multi_notice, true);
  assert.equal(view.stitched, true);
  assert.equal(view.notice_count, 3);
  assert.equal(view.sibling_notices.length, 3);
  assert.ok(view.sibling_notices.some((s) => s.is_self));
  assert.ok(view.event_count >= 3);
  // Later stages from siblings become material phases.
  const adoption = view.phases.find((p) => p.id === "adoption");
  assert.ok(adoption.event_count >= 1);
  const effective = view.phases.find((p) => p.id === "effective");
  assert.ok(effective.event_count >= 1);
  assert.equal(view.current.phase_id, "effective");
});

test("ambiguous / singleton notices do not stitch siblings", () => {
  const ambiguous = {
    ...MULTI_PROPOSAL,
    rulemaking_join: {
      matched: false,
      confidence: "low",
      notice_count: 1,
      method: "single_notice",
    },
    // Even if related_notices leak, low confidence must not surface them.
  };
  const stitched = stitchRulemakingRecord(ambiguous, new Map([
    [MULTI_HEARING.request_id, MULTI_HEARING],
  ]));
  assert.equal(stitched.multi_notice, false);
  assert.equal(stitched.stitched, false);
  assert.deepEqual(stitched.sibling_notices, []);
  // Events stay focal-only (empty).
  assert.equal(stitched.events.length, 0);

  const solo = buildRulesPhaseView(UNRELATED_SOLO);
  assert.equal(solo.multi_notice, false);
  assert.equal(solo.sibling_notices.length, 0);
  assert.equal(solo.notice_count, 1);
});

test("mergeRulemakingEvents dedupes identical type+date+source", () => {
  const a = [
    { event_type: "public_hearing", valid_at: "2026-04-20", source_url: "https://x.example/a", status: "occurred" },
  ];
  const b = [
    { event_type: "public_hearing", valid_at: "2026-04-20", source_url: "https://x.example/a/", status: "occurred" },
    { event_type: "adoption", valid_at: "2026-07-01", source_url: "https://x.example/b", status: "occurred" },
  ];
  const merged = mergeRulemakingEvents(a, b);
  assert.equal(merged.filter((e) => e.event_type === "public_hearing").length, 1);
  assert.equal(merged.filter((e) => e.event_type === "adoption").length, 1);
});
