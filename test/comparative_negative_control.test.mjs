import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  admitComparativeFact,
  buildPublishedStorySignalReadModel,
  projectPublishedStorySignal,
} from "../site/comparative_signal_admission.mjs";

const negativeControl = JSON.parse(readFileSync(
  new URL("./fixtures/comparative_signal_admission/successor_absence.json", import.meta.url),
  "utf8",
));

test("successor-solicitation absence is materially evaluated and held as MNAR", () => {
  const admission = admitComparativeFact(negativeControl);

  assert.equal(negativeControl.claim, "No successor solicitation exists");
  assert.equal(admission.fact_id, negativeControl.fact_id);
  assert.equal(admission.state, "held_mnar");
  assert.equal(admission.backstage.gate_id, "negative_inference");
  assert.ok(admission.backstage.failed_predicates.length >= 1);
  assert.ok(admission.backstage.failed_predicates.includes("historical_window_exhaustive"));
  assert.ok(admission.backstage.failed_predicates.includes("detector_recall_clears_gate"));
  assert.ok(admission.backstage.failed_predicates.includes("not_right_censored"));
  assert.equal(admission.public_signal, null);
});

test("the held MNAR control emits no resident copy or public artifact entry", () => {
  const admission = admitComparativeFact(negativeControl);
  const publicSignal = projectPublishedStorySignal(admission);
  const artifact = buildPublishedStorySignalReadModel([negativeControl]);

  assert.equal(publicSignal, null);
  assert.deepEqual(artifact.signals, []);
  const residentCopy = JSON.stringify({ publicSignal, artifact });
  assert.doesNotMatch(residentCopy, /No successor solicitation exists|held_mnar|join_rate|snapshot_sha|source_errors/i);
});

test("each missing negative-inference predicate independently forces held_mnar", () => {
  const required = Object.keys(negativeControl.observation.negative_inference_contract);
  for (const predicate of required) {
    const fact = structuredClone(negativeControl);
    for (const key of required) {
      fact.observation.negative_inference_contract[key] = key === "not_right_censored";
    }
    fact.observation.negative_inference_contract[predicate] = predicate === "not_right_censored" ? false : null;
    const admission = admitComparativeFact(fact);
    assert.equal(admission.state, "held_mnar", predicate);
    assert.ok(admission.backstage.failed_predicates.includes(predicate), predicate);
  }
});

test("freshness and join gates precede MNAR, while MNAR precedes small-N", () => {
  const stale = structuredClone(negativeControl);
  stale.observation.source_vintages[0].materialized_at = "2026-07-01T00:00:00.000Z";
  stale.peer_class.observability_equivalence.source_vintages[0].materialized_at = "2026-07-01T00:00:00.000Z";
  assert.equal(admitComparativeFact(stale).state, "held_freshness");

  const ungrounded = structuredClone(negativeControl);
  ungrounded.subject.ref = "";
  assert.equal(admitComparativeFact(ungrounded).state, "held_join");

  const mnarAndSmallN = structuredClone(negativeControl);
  mnarAndSmallN.comparison.eligible_count = 0;
  mnarAndSmallN.peer_class.eligible_count = 0;
  mnarAndSmallN.observation.eligible_count = 0;
  assert.equal(admitComparativeFact(mnarAndSmallN).state, "held_mnar");
});
