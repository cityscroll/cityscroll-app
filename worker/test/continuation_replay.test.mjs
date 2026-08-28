import assert from "node:assert/strict";
import test from "node:test";

import fixtures from "../../test/fixtures/action_path_v0.json" with { type: "json" };
import { scopeFromWatch } from "../../site/scope_v0.mjs";
import { buildNoticesQuery } from "../src/lib/notices.mjs";
import {
  CONTINUATION_REPLAY_SCHEMA,
  continuationReplayForSubject,
  continuationScopeForSubject,
} from "../src/lib/continuation_replay.mjs";

const DOT_SUBJECT = "rulemaking:dot:bicycle-owned-racks";
const DOT_NOTICE_IDS = ["20260317026", "20260706041"];

function dotCandidate(originRef, deliverySubject = DOT_SUBJECT, extra = {}) {
  return {
    kind: "subject",
    subject_ref: DOT_SUBJECT,
    replayable: true,
    subject_exists: true,
    relation: {
      status: "accepted",
      method: "exact_notice_membership",
      from: originRef,
      to: DOT_SUBJECT,
      member_refs: DOT_NOTICE_IDS.map((id) => `notice:${id}`),
    },
    scope: {
      schema: "cityscroll.scope",
      version: 0,
      facets: {
        domains: ["rules"],
        agencies: ["Transportation"],
        values: { request_ids: DOT_NOTICE_IDS },
      },
    },
    replay_proof: {
      following: { subject_ref: deliverySubject },
      delivery: {
        soda_subject_refs: [deliverySubject],
        d1_subject_refs: [deliverySubject],
      },
    },
    ...extra,
  };
}

test("exact rulemaking continuation round-trips through Following and both compilers", () => {
  const capability = continuationReplayForSubject("notice:20260317026", dotCandidate("notice:20260317026"));

  assert.equal(capability.schema, CONTINUATION_REPLAY_SCHEMA);
  assert.equal(capability.subject_ref, DOT_SUBJECT);
  assert.deepEqual(capability.watch.filter.request_ids, DOT_NOTICE_IDS);
  assert.deepEqual(capability.compilers.d1.opts.requestIds, DOT_NOTICE_IDS);
  assert.match(capability.compilers.soda.params.$where, /request_id IN \('20260317026','20260706041'\)/);
  const d1Query = buildNoticesQuery(capability.compilers.d1.opts);
  assert.match(d1Query.sql, /request_id IN \(\?,\?\)/);
  assert.deepEqual(d1Query.params.slice(-2), DOT_NOTICE_IDS);
  assert.equal(new URLSearchParams(capability.following.params).get("lens"), "rules");
  assert.deepEqual(
    scopeFromWatch(capability.watch),
    capability.scope,
    "Following reopen must preserve every canonical scope axis",
  );
  assert.deepEqual(continuationScopeForSubject("notice:20260317026", dotCandidate("notice:20260317026")), capability.scope);
  assert.doesNotMatch(JSON.stringify(capability), /all DOT rules|all DOT hearings/i);
});

test("the DOT canary keeps one subject from T1 through T2 adoption and T3 effectiveness", () => {
  const snapshots = Object.values(fixtures.dot_bicycle_racks);
  const capabilities = snapshots.map((snapshot) => {
    const origin = `notice:${snapshot.subject_ref.replace(/^notice:/, "")}`;
    return continuationReplayForSubject(origin, dotCandidate(origin));
  });

  assert.deepEqual(capabilities.map((capability) => capability?.subject_ref), [DOT_SUBJECT, DOT_SUBJECT, DOT_SUBJECT]);
  assert.deepEqual(capabilities.map((capability) => capability?.scope.facets.values.request_ids), [DOT_NOTICE_IDS, DOT_NOTICE_IDS, DOT_NOTICE_IDS]);
  assert.deepEqual(snapshots.map((snapshot) => [snapshot.snapshot.rulemaking_state, snapshot.snapshot.next_event]), [
    ["hearing", "public_hearing"],
    ["adopted", "adoption"],
    ["effective", "effective"],
  ]);
  for (const capability of capabilities) {
    assert.doesNotMatch(capability.compilers.soda.params.$where, /all DOT rules|all DOT hearings/i);
    assert.doesNotMatch(JSON.stringify(capability.compilers.d1.opts), /all DOT rules|all DOT hearings/i);
  }
});

test("matter continuation remains absent until an exact relation compiler exists", () => {
  const matter = dotCandidate("meeting:city_record:20260707022", "matter:79200", {
    subject_ref: "matter:79200",
    relation: {
      status: "accepted",
      method: "strict",
      from: "meeting:city_record:20260707022",
      to: "matter:79200",
    },
    scope: {
      schema: "cityscroll.scope",
      version: 0,
      facets: { domains: ["meetings"] },
    },
  });
  assert.equal(continuationReplayForSubject("meeting:city_record:20260707022", matter), null);
  assert.equal(continuationScopeForSubject("meeting:city_record:20260707022", matter), null);
});

test("lossy relation and broad rule fallback both fail closed", () => {
  const origin = "notice:20260317026";
  const broad = dotCandidate(origin, DOT_SUBJECT, {
    scope: {
      schema: "cityscroll.scope",
      version: 0,
      facets: { domains: ["rules"], agencies: ["Transportation"] },
    },
  });
  assert.equal(continuationReplayForSubject(origin, broad), null);

  const lossy = dotCandidate(origin, DOT_SUBJECT, {
    relation: {
      status: "accepted",
      method: "body_level_fallback",
      from: origin,
      to: DOT_SUBJECT,
      member_refs: DOT_NOTICE_IDS.map((id) => `notice:${id}`),
    },
  });
  assert.equal(continuationReplayForSubject(origin, lossy), null);

  const wrongDelivery = dotCandidate(origin, "rulemaking:dot:other-rules");
  assert.equal(continuationReplayForSubject(origin, wrongDelivery), null);
});
