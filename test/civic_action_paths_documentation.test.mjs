import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildActionPath } from "../site/action_path_v0.mjs";
import { buildCouncilHearingActionPath } from "../site/council_hearing_action_path.mjs";
import { projectCivicOutcomeTransition, projectRulemakingOutcomeSnapshot } from "../site/civic_outcome_transition.mjs";
import {
  AFTER_MANIFEST,
  DOCUMENTATION_DOC,
  DOCUMENTATION_JSON,
  REQUIRED_AFTER_FIXTURES,
  REQUIRED_BEFORE_FIXTURES,
  VIEWPORTS,
  assembleCivicActionPathsDocumentationReceipt,
  assertCivicActionPathsDocumentationReceipt,
  documentationFindings,
} from "../tools/lib/civic_action_paths_documentation.mjs";
import { buildCivicActionPathsDocumentationFromRepo } from "../tools/build_civic_action_paths_documentation.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/action_path_v0.json", import.meta.url), "utf8"));
const snapshot = JSON.parse(readFileSync(new URL("../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
const committed = JSON.parse(readFileSync(new URL(`../${DOCUMENTATION_JSON}`, import.meta.url), "utf8"));
const after = JSON.parse(readFileSync(new URL(`../${AFTER_MANIFEST}`, import.meta.url), "utf8"));
const docs = readFileSync(new URL(`../${DOCUMENTATION_DOC}`, import.meta.url), "utf8");

function meeting(requestId, outcome) {
  return {
    source_system: "city_record",
    meeting_id: `meeting:city_record:${requestId}`,
    request_id: requestId,
    event_date: "2026-07-22T11:00:00-04:00",
    meeting_outcome: outcome,
  };
}

test("committed documentation receipt matches retained docs and capture manifests", () => {
  const rebuilt = buildCivicActionPathsDocumentationFromRepo();
  assert.deepEqual(rebuilt, committed);
  assertCivicActionPathsDocumentationReceipt(rebuilt);
  assert.equal(documentationFindings().length, 0);
});

test("Action Path remains a derived projection with no semantic graph noun", () => {
  assert.equal(committed.derived_projection, true);
  assert.equal(committed.semantic_graph_noun, false);
  assert.match(docs, /derived product projection/);
  assert.match(docs, /not a universal graph noun/);
});

test("DOT T1/T2/T3 stay on one rulemaking and never claim a comment caused the change", () => {
  const snapshots = Object.values(fixtures.dot_bicycle_racks).map(buildActionPath);
  assert.deepEqual(snapshots.map((path) => path.continuation.subject_ref), [
    "rulemaking:dot:bicycle-owned-racks",
    "rulemaking:dot:bicycle-owned-racks",
    "rulemaking:dot:bicycle-owned-racks",
  ]);
  assert.equal(committed.canaries.dot_bicycle_racks.t3_effective, "2026-08-13");
  assert.doesNotMatch(docs, /because you commented|your comment caused|follow all DOT rules|follow all DOT hearings/i);
  const t1 = projectRulemakingOutcomeSnapshot({
    rulemaking_subject_ref: "rulemaking:dot:bicycle-owned-racks",
    request_id: "20260317026",
    events: [{ event_type: "public_hearing", valid_at: "2026-04-24", status: "occurred" }],
  }, { asOf: "2026-04-01" });
  const t2 = projectRulemakingOutcomeSnapshot({
    rulemaking_subject_ref: "rulemaking:dot:bicycle-owned-racks",
    request_id: "20260706041",
    events: [
      { event_type: "public_hearing", valid_at: "2026-04-24", status: "occurred" },
      { event_type: "adoption", valid_at: "2026-07-14", status: "occurred" },
    ],
  }, { asOf: "2026-07-20" });
  const adopted = projectCivicOutcomeTransition({
    subject_ref: "rulemaking:dot:bicycle-owned-racks",
    previous: t1,
    current: t2,
  });
  assert.equal(adopted.subject_ref, "rulemaking:dot:bicycle-owned-racks");
  assert.doesNotMatch(JSON.stringify(adopted), /caused|resident|user commented/i);
});

test("Council hearing continuation, no-action unmatched, and later laid-over state remain source-backed", () => {
  const single = buildCouncilHearingActionPath(meeting("20260707022", snapshot.by_notice["20260707022"]));
  assert.equal(single.continuation.subject_ref, "matter:79200");
  assert.equal(snapshot.by_notice["20260707022"].matters[0].outcome, "Laid Over by Subcommittee");
  const unmatched = buildCouncilHearingActionPath(meeting("20260728026", snapshot.by_notice["20260728026"]));
  assert.equal(unmatched.continuation, null);
});

test("before and after captures cover both viewports without causal or cross-board claims", () => {
  assert.deepEqual(VIEWPORTS.map((row) => row.width).sort((a, b) => a - b), [390, 1440]);
  for (const fixture of REQUIRED_BEFORE_FIXTURES) {
    assert.ok(fixture);
  }
  const afterKeys = new Set(after.captures.map((row) => `${row.fixture}:${row.viewport}`));
  for (const fixture of REQUIRED_AFTER_FIXTURES) {
    for (const viewport of VIEWPORTS) {
      assert.equal(afterKeys.has(`${fixture}:${viewport.name}`), true, `${fixture} ${viewport.name}`);
    }
  }
  const strict = after.captures.find((row) => row.fixture === "strict_matter_join" && row.viewport === "desktop");
  assert.equal(strict.observations.follow_cta, true);
  assert.equal(strict.observations.calendar_creates_watch, false);
  const negative = after.captures.find((row) => row.fixture === "cb_unknown");
  assert.equal(negative.observations.apply_now, false);
  assert.doesNotMatch(JSON.stringify(after), /follow all DOT rules|comment caused|citywide board default/i);
});
