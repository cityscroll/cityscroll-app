// Pure subsidy phase spine: stage-as-phase group, current/next, future collapse.
//
//   node --test test/subsidy_phase_spine.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUBSIDY_PHASES,
  mapStageToPhase,
  publicStatus,
  currentStageKey,
  buildSubsidyPhaseView,
} from "../site/subsidy_phase_spine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const HEARING_CURRENT = {
  ok: true,
  stage: "hearing",
  join: { matched: true, method: "city-record-hearing" },
  project: { id: "city-record:1", name: "IDA Hearing", company: "Young Co" },
  company: { status: "matched", value: "Young Co" },
  timeline: [
    {
      stage: "application",
      status: "matched",
      date: "2026-07-02",
      official_action: "application_review",
      outcome: "filed",
      source: { status: "matched", url: "https://example.test/a" },
    },
    {
      stage: "hearing",
      status: "matched",
      date: "2026-07-16",
      official_action: "public_hearing",
      outcome: "held",
      source: { status: "matched", url: "https://example.test/h" },
    },
    {
      stage: "board_decision",
      status: "unknown",
      date: null,
      gap_kind: "too_soon",
    },
    {
      stage: "closing",
      status: "unknown",
      date: null,
      gap_kind: "too_soon",
    },
    {
      stage: "compliance",
      status: "unknown",
      date: null,
      gap_kind: "too_soon",
    },
  ],
};

test("mapStageToPhase: ontology stages map 1:1", () => {
  for (const id of SUBSIDY_PHASES) {
    assert.equal(mapStageToPhase(id), id);
  }
  assert.equal(mapStageToPhase("nope"), "application");
});

test("publicStatus: later matched marks earlier unmatched as passed", () => {
  const tl = [
    { stage: "application", status: "unknown" },
    { stage: "hearing", status: "matched", date: "2026-01-01" },
  ];
  assert.equal(publicStatus(tl[0], tl), "passed");
  assert.equal(publicStatus(tl[1], tl), "matched");
});

test("currentStageKey: last matched wins", () => {
  assert.equal(currentStageKey(HEARING_CURRENT.timeline), "hearing");
  assert.equal(currentStageKey([], "closing"), "closing");
});

test("buildSubsidyPhaseView: five phases, current hearing, three future empty", () => {
  const view = buildSubsidyPhaseView(HEARING_CURRENT);
  assert.equal(view.schema_version, 1);
  assert.equal(view.phases.length, 5);
  assert.deepEqual(
    view.phases.map((p) => p.id),
    SUBSIDY_PHASES,
  );
  assert.equal(view.current.phase_id, "hearing");
  assert.equal(view.current.stage, "hearing");
  assert.equal(view.current.action_key, "subsidy_phase_action_hearing");
  assert.equal(view.next?.phase_id, "board_decision");

  const byId = Object.fromEntries(view.phases.map((p) => [p.id, p]));
  assert.equal(byId.application.state, "passed");
  assert.equal(byId.hearing.state, "current");
  assert.equal(byId.board_decision.state, "future");
  assert.equal(byId.closing.state, "future");
  assert.equal(byId.compliance.state, "future");

  // Future empty stages carry no detail milestones (collapse into stepper).
  assert.equal(byId.board_decision.event_count, 0);
  assert.equal(byId.closing.event_count, 0);
  assert.equal(byId.compliance.event_count, 0);
  assert.equal(view.future_empty_count, 3);
  assert.deepEqual(view.future_empty_phase_ids, [
    "board_decision",
    "closing",
    "compliance",
  ]);

  // Material stages retain events for panels.
  assert.equal(byId.application.event_count, 1);
  assert.equal(byId.hearing.event_count, 1);
});

test("buildSubsidyPhaseView: ontology-complete when timeline only has hearing", () => {
  const view = buildSubsidyPhaseView({
    stage: "hearing",
    join: { matched: true },
    timeline: [
      {
        stage: "hearing",
        status: "matched",
        date: "2025-06-01",
        official_action: "public_hearing",
        outcome: "held",
      },
    ],
  });
  assert.equal(view.phases.length, 5);
  assert.equal(view.current.phase_id, "hearing");
  assert.ok(view.future_empty_count >= 3);
});

test("public Land/Money surface files exist for subsidy phase module", () => {
  const index = readFileSync(join(ROOT, "site/index.html"), "utf8");
  assert.match(index, /subsidy_phase_spine|buildSubsidyPhaseView|subsidyPhaseTimelineHTML/);
  assert.match(index, /subsidy_phase_not_yet_reached|future_empty/);
});
