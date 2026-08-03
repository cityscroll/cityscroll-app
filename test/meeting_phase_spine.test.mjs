import { SITE_SOURCE } from "./helpers/site_source.mjs";
// Pure Council matter phase spine: phase-group, aggregate, voice-vote honesty.
//
//   node --test test/meeting_phase_spine.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  MEETING_MATTER_PHASES,
  MEETING_STAGE_KINDS,
  aggregateActionLabels,
  buildMeetingMatterPhaseView,
  buildPhaseViewForMatter,
  dedupeDocuments,
  indexSpinesByMatter,
  mapStageToPhase,
  mergeMatterSpines,
  spineFromCollapsedEntry,
} from "../site/meeting_phase_spine.mjs";
import {
  buildMeetingOutcomes,
  buildMeetingVoteSpine,
} from "../worker/src/lib/meeting_outcomes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(join(ROOT, "test/contract/fixtures/meeting_outcomes.json"), "utf8"),
);

test("MEETING_MATTER_PHASES is agenda → matter → decision → record", () => {
  assert.deepEqual([...MEETING_MATTER_PHASES], [
    "agenda",
    "matter",
    "decision",
    "record",
  ]);
});

test("mapStageToPhase groups action+vote under decision", () => {
  assert.equal(mapStageToPhase("agenda"), "agenda");
  assert.equal(mapStageToPhase("matter"), "matter");
  assert.equal(mapStageToPhase("action"), "decision");
  assert.equal(mapStageToPhase("vote"), "decision");
  assert.equal(mapStageToPhase("attachment"), "record");
  assert.equal(mapStageToPhase("nope"), "agenda");
});

test("fixture spine: full path lands on record with decision filled", () => {
  const model = buildMeetingOutcomes(
    fixture.notices,
    fixture.events,
    fixture.event_items,
    fixture.votes,
    fixture.attachments,
  );
  const spine = model.records[0].spines[0];
  const view = buildMeetingMatterPhaseView(spine);
  assert.equal(view.schema_version, 1);
  assert.equal(view.empty, false);
  assert.equal(view.phases.length, 4);
  assert.deepEqual(
    view.phases.map((p) => p.id),
    [...MEETING_MATTER_PHASES],
  );
  // Full spine → current is last material phase (record).
  assert.equal(view.current.phase_id, "record");
  assert.equal(view.next, null);
  assert.equal(view.phases.find((p) => p.id === "agenda")?.state, "passed");
  assert.equal(view.phases.find((p) => p.id === "matter")?.state, "passed");
  assert.equal(view.phases.find((p) => p.id === "decision")?.state, "passed");
  assert.equal(view.phases.find((p) => p.id === "record")?.state, "current");
  // Decision holds both action and vote stages.
  const decision = view.phases.find((p) => p.id === "decision");
  assert.ok(decision.stages.some((s) => s.kind === "action"));
  assert.ok(decision.stages.some((s) => s.kind === "vote"));
  assert.equal(decision.voice_vote, false);
  assert.equal(decision.matched, true);
  // Documents deduped on record phase.
  const record = view.phases.find((p) => p.id === "record");
  assert.ok(record.documents.length >= 1);
  assert.ok(record.documents.some((d) => /Staff report|Agenda|Minutes/i.test(d.name || "")));
});

test("empty vote with action is voice/committee, not a gap", () => {
  const spine = buildMeetingVoteSpine({
    item: { agenda_item_id: "a1", title: "Item", agenda_number: "3" },
    matter: {
      matter_id: "79062",
      matter_file: "LU 0091-2026",
      title: "Public School 15 Annex",
      outcome: "Approved by Subcommittee",
      passed: "Pass",
      votes: [],
      documents: [],
    },
    event: { event_id: "22526" },
  });
  const view = buildMeetingMatterPhaseView(spine, {
    actionHistory: ["Hearing Held by Committee", "Approved by Subcommittee"],
  });
  assert.equal(view.current.phase_id, "decision");
  const decision = view.phases.find((p) => p.id === "decision");
  assert.equal(decision.matched, true);
  assert.equal(decision.voice_vote, true);
  assert.equal(decision.gap_class, null);
  // Multi-action labels aggregated.
  assert.ok(view.action_history.length >= 2);
  const multi = decision.aggregates.filter((a) => a.count >= 1);
  assert.ok(multi.length >= 1);
  // Record future / empty with class-a gap (no invent).
  const record = view.phases.find((p) => p.id === "record");
  assert.equal(record.state, "future");
  assert.equal(record.gap_class, "not_yet_ingested");
  // Lead opens legislation for numeric MatterId.
  assert.equal(view.current.lead_action, "open_legislation");
  assert.match(view.official_url || "", /Gateway\.aspx\?M=L&ID=79062/);
});

test("dedupeDocuments collapses identical URLs", () => {
  const out = dedupeDocuments([
    { url: "https://example.test/a.pdf", name: "A" },
    { url: "https://example.test/a.pdf/", name: "A dup" },
    { url: "https://example.test/b.pdf", name: "B" },
  ]);
  assert.equal(out.candidates, 3);
  assert.equal(out.count, 2);
  assert.equal(out.documents.length, 2);
});

test("aggregateActionLabels collapses verbatim repeats", () => {
  const aggs = aggregateActionLabels([
    "Hearing Held by Committee",
    "Hearing Held by Committee",
    "Approved by Subcommittee",
  ]);
  assert.equal(aggs.length, 2);
  const held = aggs.find((a) => a.label.startsWith("Hearing"));
  assert.equal(held.count, 2);
});

test("mergeMatterSpines prefers last action and unions docs", () => {
  const a = buildMeetingVoteSpine({
    item: { agenda_item_id: "1", title: "T" },
    matter: {
      matter_id: "m1",
      matter_file: "LU 1",
      outcome: "Hearing Held",
      votes: [],
      documents: [{ url: "https://example.test/1.pdf", name: "One" }],
    },
  });
  const b = buildMeetingVoteSpine({
    item: { agenda_item_id: "2", title: "T" },
    matter: {
      matter_id: "m1",
      matter_file: "LU 1",
      outcome: "Approved",
      votes: [{ result: "Pass", counts: { aye: 5, nay: 0 } }],
      documents: [{ url: "https://example.test/2.pdf", name: "Two" }],
    },
  });
  const merged = mergeMatterSpines([a, b]);
  const action = merged.stages.find((s) => s.kind === "action");
  const vote = merged.stages.find((s) => s.kind === "vote");
  const att = merged.stages.find((s) => s.kind === "attachment");
  assert.equal(action.action_name, "Approved");
  assert.equal(vote.matched, true);
  assert.equal(att.documents.length, 2);
});

test("buildPhaseViewForMatter joins spines[] by matter_id", () => {
  const model = buildMeetingOutcomes(
    fixture.notices,
    fixture.events,
    fixture.event_items,
    fixture.votes,
    fixture.attachments,
  );
  const record = model.records[0];
  const entry = {
    matter_id: "mat-001",
    matter_file: "LU 0001-2026",
    title: "Transit Improvement Funding",
    actions: ["Approved by Subcommittee"],
    finalOutcome: "Approved by Subcommittee",
    finalVotes: [],
    documents: [],
  };
  const view = buildPhaseViewForMatter(entry, record);
  assert.equal(view.matter_id, "mat-001");
  assert.equal(view.empty, false);
  assert.ok(view.phases.every((p) => MEETING_MATTER_PHASES.includes(p.id)));
});

test("spineFromCollapsedEntry is a fallback when spines[] absent", () => {
  const spine = spineFromCollapsedEntry({
    matter_id: "79062",
    matter_file: "LU 0091-2026",
    matter_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=79062",
    title: "Annex",
    agendaTitle: "Application",
    agendaNumber: "1",
    actions: ["Held", "Approved"],
    finalOutcome: "Approved",
    finalVotes: [{ result: "Pass", counts: { aye: 4, nay: 0 } }],
    documents: [{ url: "https://example.test/d.pdf", name: "Doc" }],
  });
  assert.equal(spine.matter_id, "79062");
  assert.equal(spine.stages.length, MEETING_STAGE_KINDS.length);
  assert.ok(spine.stages.every((s) => s.matched));
  const view = buildMeetingMatterPhaseView(spine);
  assert.equal(view.current.phase_id, "record");
});

test("indexSpinesByMatter keys by id and file", () => {
  const spine = buildMeetingVoteSpine({
    item: { agenda_item_id: "a", title: "T" },
    matter: { matter_id: "m9", matter_file: "LU 9", title: "X" },
  });
  const map = indexSpinesByMatter([spine]);
  assert.ok(map.has("m9"));
  assert.ok(map.has("LU 9"));
  assert.equal(map.get("m9")[0], spine);
});

test("public Council meeting template uses phase spine surface", () => {
  const index = SITE_SOURCE;
  assert.match(index, /function meetingOutcomesHTML\(/);
  assert.match(index, /buildPhaseViewForMatter|meeting_phase_spine/);
  assert.match(index, /meeting-phase-stepper|meeting-spine-lead/);
  assert.match(index, /meeting_phase_agenda|meeting_phase_decision/);
  assert.match(index, /function meetingMatterPhaseHTML\(/);
});
