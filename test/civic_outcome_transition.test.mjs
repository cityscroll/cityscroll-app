import assert from "node:assert/strict";
import test from "node:test";

import {
  projectCouncilMatterOutcomeSnapshot,
  projectCivicOutcomeTransition,
  projectRulemakingOutcomeSnapshot,
  reconcileRulemakingOutcomeRows,
  renderCivicOutcomeTransition,
} from "../site/civic_outcome_transition.mjs";
import { reconcileTemporalCandidates } from "../worker/src/lib/alert_temporal.mjs";

const SUBJECT = "rulemaking:dot:bicycle-owned-racks";
const RULE_URL = "https://rules.cityofnewyork.us/rule/city-owned-bicycle-racks/";

function dotSnapshot(asOf) {
  const events = [
    { event_type: "proposal_published", valid_at: "2026-03-25", status: "occurred", source_url: RULE_URL },
    { event_type: "public_hearing", valid_at: "2026-04-24", status: "occurred", source_url: RULE_URL },
    { event_type: "adoption", valid_at: "2026-07-14", status: "occurred", source_url: RULE_URL },
    { event_type: "effective", valid_at: "2026-08-13", status: "occurred", source_url: RULE_URL },
  ];
  return {
    rulemaking_subject_ref: SUBJECT,
    request_id: asOf < "2026-07-14" ? "20260317026" : "20260706041",
    stage: asOf < "2026-07-14" ? "hearing" : asOf < "2026-08-13" ? "adopted" : "effective",
    nyc_rules: { url: RULE_URL },
    events: events.filter((event) => event.valid_at <= asOf),
  };
}

test("DOT rulemaking emits adoption and effectiveness as real, stable-subject transitions", () => {
  const t1 = projectRulemakingOutcomeSnapshot(dotSnapshot("2026-04-01"), { asOf: "2026-04-01" });
  const t2 = projectRulemakingOutcomeSnapshot(dotSnapshot("2026-07-20"), { asOf: "2026-07-20" });
  const t3 = projectRulemakingOutcomeSnapshot(dotSnapshot("2026-08-20"), { asOf: "2026-08-20" });
  assert.equal(t1.state, "hearing");
  assert.equal(t1.outcome_state, "not_yet_known");
  const adopted = projectCivicOutcomeTransition({ subject_ref: SUBJECT, previous: t1, current: t2 });
  const effective = projectCivicOutcomeTransition({ subject_ref: SUBJECT, previous: t2, current: t3 });
  assert.equal(adopted.transition.to.state, "adopted");
  assert.equal(adopted.transition.event.type, "adoption");
  assert.equal(effective.transition.to.state, "effective");
  assert.equal(effective.transition.event.type, "effective");
  assert.equal(adopted.subject_ref, effective.subject_ref);
  assert.match(renderCivicOutcomeTransition(adopted), /Rulemaking adopted/);
  assert.match(renderCivicOutcomeTransition(effective), /Rulemaking effective/);
  assert.doesNotMatch(renderCivicOutcomeTransition(adopted), /comment caused|resident|user/i);
});

test("same DOT outcome refresh has no transition and preserves exact follow identity", () => {
  const t2 = projectRulemakingOutcomeSnapshot(dotSnapshot("2026-07-20"), { asOf: "2026-07-20" });
  const same = projectCivicOutcomeTransition({ subject_ref: SUBJECT, previous: t2, current: t2 });
  assert.equal(same.transition, null);
  assert.equal(t2.subject_ref, SUBJECT);
  assert.deepEqual(t2.evidence.map((entry) => entry.source_url), [RULE_URL]);
});

test("Council matter action is a recorded outcome, while an agenda-only snapshot is not yet known", () => {
  const before = {
    request_id: "20260707022",
    snapshot_state: "present",
    event: { url: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=22509" },
    matters: [{ matter_id: "79200", title: "Land-use matter", actions: [], votes: [] }],
  };
  const after = {
    ...before,
    matters: [{
      matter_id: "79200",
      title: "Land-use matter",
      actions: ["Hearing Held by Committee", "Laid Over by Subcommittee"],
      outcome: "Laid Over by Subcommittee",
      votes: [],
    }],
  };
  const prior = projectCouncilMatterOutcomeSnapshot(before, { subjectRef: "matter:79200" });
  const current = projectCouncilMatterOutcomeSnapshot(after, { subjectRef: "matter:79200" });
  assert.equal(prior.outcome_state, "not_yet_known");
  assert.equal(current.outcome_state, "recorded");
  const transition = projectCivicOutcomeTransition({
    subject_ref: "matter:79200",
    previous: prior,
    current,
    kind: "matter",
  });
  assert.equal(transition.transition.event.type, "action");
  assert.match(renderCivicOutcomeTransition(transition), /Laid Over by Subcommittee/);
  assert.doesNotMatch(JSON.stringify(transition), /synthetic source|resident|caused/i);
});

test("rules reconciliation decorates one exact subject once, then emits nothing on rerun", () => {
  const record = {
    request_id: "20260706041",
    rulemaking_subject_ref: SUBJECT,
    stage: "adopted",
    nyc_rules: { url: RULE_URL },
    events: [{ event_type: "adoption", valid_at: "2026-07-14", status: "occurred", source_url: RULE_URL }],
  };
  const input = { rows: [{ request_id: record.request_id, short_title: "Notice of Adoption: City-Owned Bicycle Racks" }], rulesView: { rules: [record] }, asOf: "2026-07-20" };
  const first = reconcileRulemakingOutcomeRows({ ...input, seen: new Set() });
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].post_event_outcome.transition.to.state, "adopted");
  const second = reconcileRulemakingOutcomeRows({ ...input, seen: new Set(first.markSeenIds) });
  assert.deepEqual(second.rows, []);
});

test("the exact DOT notice-membership follow carries adoption, then effectiveness, once each", () => {
  const rows = [
    { request_id: "20260317026", short_title: "DOT Proposed Rules Relating to City-Owned Bicycle Racks" },
    { request_id: "20260706041", short_title: "Notice of Adoption: City-Owned Bicycle Racks" },
  ];
  const t2Records = rows.map((row) => ({
    ...row,
    rulemaking_subject_ref: SUBJECT,
    nyc_rules: { url: RULE_URL },
    events: row.request_id === "20260706041"
      ? [{ event_type: "adoption", valid_at: "2026-07-14", status: "occurred", source_url: RULE_URL }]
      : [],
  }));
  const t2View = { generated_at: "2026-07-20T00:00:00.000Z", rules: t2Records };
  const adoption = reconcileTemporalCandidates({
    lens: "rules",
    rows,
    seen: new Set(rows.slice(0, 1).map((row) => row.request_id)),
    rulesView: t2View,
  });
  assert.equal(adoption.fresh.length, 1);
  assert.equal(adoption.fresh[0].request_id, "20260706041");
  assert.equal(adoption.fresh[0].post_event_outcome.transition.to.state, "adopted");
  assert.match(adoption.markSeenIds.join("|"), /civic-outcome:rulemaking:dot:bicycle-owned-racks:adoption/);

  const t3View = {
    generated_at: "2026-08-20T00:00:00.000Z",
    rules: t2Records.map((record) => ({
      ...record,
      events: record.request_id === "20260706041"
        ? [...record.events, { event_type: "effective", valid_at: "2026-08-13", status: "occurred", source_url: RULE_URL }]
        : record.events,
    })),
  };
  const effective = reconcileTemporalCandidates({
    lens: "rules",
    rows,
    seen: new Set([...rows.map((row) => row.request_id), ...adoption.markSeenIds]),
    rulesView: t3View,
  });
  assert.equal(effective.fresh.length, 1);
  assert.equal(effective.fresh[0].post_event_outcome.transition.to.state, "effective");
  const unchanged = reconcileTemporalCandidates({
    lens: "rules",
    rows,
    seen: new Set([...rows.map((row) => row.request_id), ...adoption.markSeenIds, ...effective.markSeenIds]),
    rulesView: t3View,
  });
  assert.equal(unchanged.fresh.length, 0);
  assert.doesNotMatch(JSON.stringify(effective), /all DOT rules|all DOT hearings|resident.*caus/i);
});
