import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildActionPath } from "../site/action_path_v0.mjs";
import { continuationReplayForSubject } from "../worker/src/lib/continuation_replay.mjs";
import {
  ACTION_PATH_GENERALIZATION_COLUMNS,
  ACTION_PATH_GENERALIZATION_DOMAINS,
  ACTION_PATH_GENERALIZATION_SCHEMA,
  ESTABLISHED,
  EXACT_REPLAY_FAMILY,
  NOT_ESTABLISHED,
  actionPathGeneralizationFindings,
  assembleActionPathGeneralizationAudit,
  assertActionPathGeneralizationContract,
  measureDotBicycleRacksCanary,
} from "../tools/lib/action_path_generalization_audit.mjs";
import {
  AUDIT_JSON,
  buildActionPathGeneralizationAuditFromRepo,
} from "../tools/build_action_path_generalization_audit.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/action_path_v0.json", import.meta.url), "utf8"));
const committed = JSON.parse(readFileSync(new URL(`../${AUDIT_JSON}`, import.meta.url), "utf8"));
const feedActions = readFileSync(new URL("../site/app/feed-actions.mjs", import.meta.url), "utf8");

function domain(audit, name) {
  return audit.domains.find((row) => row.domain === name);
}

test("committed generalization audit matches a fresh measurement of retained fixtures", () => {
  const rebuilt = buildActionPathGeneralizationAuditFromRepo();
  assert.deepEqual(rebuilt, committed);
  assertActionPathGeneralizationContract(rebuilt);
});

test("the matrix covers seven domains and five columns with cited cells", () => {
  assert.equal(committed.schema, ACTION_PATH_GENERALIZATION_SCHEMA);
  assert.equal(committed.stopping_rule, true);
  assert.equal(committed.rebuild_every_domain, false);
  assert.equal(committed.exact_replay_family, EXACT_REPLAY_FAMILY);
  assert.deepEqual(committed.domains.map((row) => row.domain), [...ACTION_PATH_GENERALIZATION_DOMAINS]);
  for (const row of committed.domains) {
    for (const column of ACTION_PATH_GENERALIZATION_COLUMNS) {
      const cell = row[column];
      assert.ok(cell, `${row.domain}.${column}`);
      assert.ok(cell.evidence.length > 0, `${row.domain}.${column} needs evidence`);
      assert.equal(cell.evidence.some((entry) => ["fixture", "source", "receipt", "test"].includes(entry.kind)), true);
      if (column !== "card_decision") {
        assert.equal([ESTABLISHED, NOT_ESTABLISHED].includes(cell.status), true, `${row.domain}.${column}`);
      }
      assert.doesNotMatch(`${cell.claim} ${cell.notes || ""}`, /button density|citywide policy|all DOT rules/i);
    }
    assert.equal(row.card_decision.rebuild_domain, false);
  }
});

test("Meetings publish a grounded matter continuation without claiming exact matter replay", () => {
  const meetings = domain(committed, "meetings");
  assert.equal(meetings.action.status, ESTABLISHED);
  assert.equal(meetings.continuation.status, ESTABLISHED);
  assert.match(meetings.continuation.claim, /matter:79200/);
  assert.equal(meetings.grounding.status, ESTABLISHED);
  assert.match(meetings.grounding.claim, /exact_date_body_tokens/);
  assert.equal(meetings.replay.status, NOT_ESTABLISHED);
  assert.equal(meetings.card_decision.additional, "follow-on");
  assert.equal(meetings.card_decision.cost, "substantial-ingestion-or-compiler");
});

test("Rules are measured from the DOT T1/T2/T3 canary, including snapshot-specific CTAs", () => {
  const rules = domain(committed, "rules");
  const canary = committed.dot_bicycle_racks;
  assert.equal(canary.same_rulemaking, true);
  assert.equal(canary.rulemaking_subject, "rulemaking:dot:bicycle-owned-racks");
  assert.deepEqual(canary.snapshots.map((row) => row.snapshot), [
    "t1_before_hearing",
    "t2_after_adoption",
    "t3_after_effective_date",
  ]);
  assert.equal(canary.snapshots[0].comment_cta, true);
  assert.equal(canary.snapshots[0].continuation_cta, true);
  assert.equal(canary.snapshots[1].comment_cta, false);
  assert.equal(canary.snapshots[2].comment_cta, false);
  assert.equal(canary.snapshots.every((row) => row.continuation_ref === "rulemaking:dot:bicycle-owned-racks"), true);
  assert.equal(canary.snapshots.every((row) => row.exact_replay === true), true);
  assert.equal(rules.replay.status, ESTABLISHED);
  assert.equal(rules.card_decision.additional, "none");
  assert.equal(rules.card_decision.rebuild_domain, false);
  assert.doesNotMatch(JSON.stringify(canary), /all DOT rules|all DOT hearings/i);
});

test("live DOT fixtures still build one rulemaking path and exact replay at each snapshot", () => {
  const paths = Object.values(fixtures.dot_bicycle_racks).map(buildActionPath);
  assert.deepEqual(paths.map((path) => path.process_ref), [
    "rulemaking:dot:bicycle-owned-racks",
    "rulemaking:dot:bicycle-owned-racks",
    "rulemaking:dot:bicycle-owned-racks",
  ]);
  const measured = measureDotBicycleRacksCanary(
    Object.fromEntries(Object.entries(fixtures.dot_bicycle_racks).map(([key, input]) => [key, { ...input, path: buildActionPath(input) }])),
    Object.fromEntries(Object.entries(fixtures.dot_bicycle_racks).map(([key, input]) => {
      const origin = `notice:${String(input.subject_ref).replace(/^notice:/, "")}`;
      return [key, continuationReplayForSubject(origin, {
        kind: "subject",
        subject_ref: "rulemaking:dot:bicycle-owned-racks",
        replayable: true,
        subject_exists: true,
        relation: {
          status: "accepted",
          method: "exact_notice_membership",
          from: origin,
          to: "rulemaking:dot:bicycle-owned-racks",
          member_refs: ["notice:20260317026", "notice:20260706041"],
        },
        scope: {
          schema: "cityscroll.scope",
          version: 0,
          facets: {
            domains: ["rules"],
            agencies: ["Transportation"],
            values: { request_ids: ["20260317026", "20260706041"] },
          },
        },
        replay_proof: {
          following: { subject_ref: "rulemaking:dot:bicycle-owned-racks" },
          delivery: {
            soda_subject_refs: ["rulemaking:dot:bicycle-owned-racks"],
            d1_subject_refs: ["rulemaking:dot:bicycle-owned-racks"],
          },
        },
      })];
    })),
  );
  assert.equal(measured.same_rulemaking, true);
  assert.equal(measured.snapshots[0].comment_cta, true);
  assert.equal(measured.snapshots[2].continuation_present, true);
});

test("Land, Money, Staffing, and Property stay not-established for exact replay and rank follow-on work", () => {
  for (const name of ["land", "money", "staffing", "property"]) {
    const row = domain(committed, name);
    assert.equal(row.replay.status, NOT_ESTABLISHED, name);
    assert.equal(row.card_decision.additional, "follow-on", name);
    assert.equal(row.card_decision.cost, "substantial-ingestion-or-compiler", name);
    assert.equal(row.card_decision.rebuild_domain, false, name);
  }
  assert.match(feedActions, /href:`#land\/\$\{encodeURIComponent\(projectId\)\}`/);
  assert.doesNotMatch(domain(committed, "land").replay.claim, /#land\//);
  assert.equal(domain(committed, "land").continuation.notes.includes("not exact replay"), true);
  assert.equal(domain(committed, "money").continuation.status, NOT_ESTABLISHED);
  assert.equal(domain(committed, "staffing").continuation.status, NOT_ESTABLISHED);
  assert.equal(domain(committed, "property").continuation.status, NOT_ESTABLISHED);
});

test("Community Boards keep board-local actions and leave committee replay not-established", () => {
  const boards = domain(committed, "community_boards");
  assert.equal(boards.action.status, ESTABLISHED);
  assert.equal(boards.continuation.status, ESTABLISHED);
  assert.equal(boards.grounding.status, ESTABLISHED);
  assert.match(boards.grounding.claim, /cross-board inference is false/i);
  assert.equal(boards.replay.status, NOT_ESTABLISHED);
  assert.match(boards.replay.claim, /committee identity replay is not-established/);
  assert.equal(boards.card_decision.shipped_cards.includes("cap-6"), true);
});

test("button density and missing citations cannot establish a cell", () => {
  const audit = assembleActionPathGeneralizationAudit({});
  const broken = structuredClone(audit);
  broken.domains[0].action.claim = "Meetings are complete because of button density";
  broken.domains[0].action.evidence = [{ kind: "source", ref: "ui affordance count" }];
  broken.rebuild_every_domain = true;
  const findings = actionPathGeneralizationFindings(broken).map((row) => row.message);
  assert.equal(findings.some((message) => /button density|forbidden proxy|rebuild/i.test(message)), true);
  assert.throws(() => assertActionPathGeneralizationContract(broken));
});
