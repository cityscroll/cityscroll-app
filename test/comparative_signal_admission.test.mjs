import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SIGNAL_ADMISSION_METHOD,
  SIGNAL_STATES,
  admitComparativeFact,
  buildPublishedStorySignalReadModel,
  projectPublishedStorySignal,
} from "../site/comparative_signal_admission.mjs";
import { buildComparativeStorySignalArtifact } from "../tools/build_comparative_story_signals.mjs";

const positiveArtifact = JSON.parse(readFileSync(
  new URL("../site/data/comparative_award_rank_receipts.json", import.meta.url),
  "utf8",
));

function positiveFact() {
  return structuredClone(positiveArtifact.facts[0]);
}

function setCounts(fact, eligible, observed = eligible) {
  fact.comparison.eligible_count = eligible;
  fact.comparison.observed_count = observed;
  fact.observation.eligible_count = eligible;
  fact.observation.observed_count = observed;
  fact.peer_class.eligible_count = eligible;
  fact.peer_class.observed_count = observed;
}

test("the complete positive award-rank receipt publishes one deterministic basis sentence", () => {
  const first = admitComparativeFact(positiveFact());
  const second = admitComparativeFact(positiveFact());

  assert.equal(first.schema, "cityscroll.comparative_signal_admission.v1");
  assert.equal(first.method, SIGNAL_ADMISSION_METHOD);
  assert.equal(first.state, "published");
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(projectPublishedStorySignal(first), first.public_signal);
  // The closed template and every measured term are fixed; only the peer count
  // and the observed window's end move with the award snapshot behind them.
  const { observed_count: observedCount } = positiveFact().comparison;
  assert.match(
    first.public_signal.basis_sentence,
    new RegExp(
      `^This \\$53\\.0M award is 4th-largest among ${observedCount} `
      + "Housing Preservation and Development award rows observed in the OCP snapshot "
      + "from Jan\\. 1, 2024 through [A-Z][a-z]+\\.? \\d{1,2}, 2026\\.$",
    ),
  );
  assert.equal(first.public_signal.schema, "cityscroll.story_signal.v1");
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.public_signal), true);
});

test("eligible is a backstage pre-materialization state with no public projection", () => {
  const admission = admitComparativeFact(positiveFact(), { materialize: false });
  assert.equal(admission.state, "eligible");
  assert.equal(admission.public_signal, null);
  assert.equal(projectPublishedStorySignal(admission), null);
});

test("every held state is explicit and projects to no public signal", () => {
  const cases = [
    ["held_coverage", (fact) => {
      fact.observation.basis = "partial";
      fact.peer_class.observability_equivalence.basis = "partial";
    }],
    ["held_small_n", (fact) => {
      setCounts(fact, 9);
    }],
    ["held_freshness", (fact) => {
      fact.observation.source_vintages[0].materialized_at = "2026-07-01T00:00:00.000Z";
      fact.peer_class.observability_equivalence.source_vintages[0].materialized_at = "2026-07-01T00:00:00.000Z";
    }],
    ["held_join", (fact) => {
      fact.peer_class.observability_equivalence.identity_gate = "unresolved";
    }],
    ["held_semantics", (fact) => {
      fact.comparison.rank = 6;
    }],
  ];

  for (const [expected, mutate] of cases) {
    const fact = positiveFact();
    mutate(fact);
    const admission = admitComparativeFact(fact);
    assert.equal(admission.state, expected);
    assert.equal(admission.public_signal, null);
    assert.equal(projectPublishedStorySignal(admission), null);
  }
  assert.deepEqual(SIGNAL_STATES, [
    "eligible",
    "published",
    "held_coverage",
    "held_small_n",
    "held_mnar",
    "held_freshness",
    "held_join",
    "held_semantics",
  ]);
});

test("gate precedence is coverage, freshness, join, MNAR, small-N, then semantics", () => {
  const allFailures = positiveFact();
  allFailures.observation.basis = "partial";
  allFailures.peer_class.observability_equivalence.basis = "partial";
  allFailures.observation.source_vintages[0].materialized_at = "2026-07-01T00:00:00.000Z";
  allFailures.peer_class.observability_equivalence.identity_gate = "unresolved";
  setCounts(allFailures, 2, 1);
  allFailures.comparison.rank = 6;
  assert.equal(admitComparativeFact(allFailures).state, "held_coverage");

  const staleBeforeJoin = positiveFact();
  staleBeforeJoin.observation.source_vintages[0].materialized_at = "2026-07-01T00:00:00.000Z";
  staleBeforeJoin.peer_class.observability_equivalence.source_vintages[0].materialized_at = "2026-07-01T00:00:00.000Z";
  staleBeforeJoin.peer_class.observability_equivalence.identity_gate = "unresolved";
  setCounts(staleBeforeJoin, 2);
  assert.equal(admitComparativeFact(staleBeforeJoin).state, "held_freshness");

  const joinBeforeSmallN = positiveFact();
  joinBeforeSmallN.peer_class.observability_equivalence.identity_gate = "unresolved";
  setCounts(joinBeforeSmallN, 2);
  assert.equal(admitComparativeFact(joinBeforeSmallN).state, "held_join");

  const smallNBeforeMeaningfulness = positiveFact();
  setCounts(smallNBeforeMeaningfulness, 2);
  smallNBeforeMeaningfulness.comparison.rank = 6;
  assert.equal(admitComparativeFact(smallNBeforeMeaningfulness).state, "held_small_n");
});

test("published read models contain public signals only and remain byte-stable", () => {
  const facts = [positiveFact()];
  const first = buildPublishedStorySignalReadModel(facts);
  const second = buildPublishedStorySignalReadModel(structuredClone(facts));

  assert.equal(first.schema, "cityscroll.story_signal_read_model.v1");
  assert.equal(first.signals.length, 1);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const publicJson = JSON.stringify(first);
  assert.doesNotMatch(publicJson, /held_|join_rate|snapshot_sha|source_errors|reason_codes|gate_id/i);
});

test("the committed story-signal artifact is current with the CI-01 receipt", () => {
  const committed = JSON.parse(readFileSync(
    new URL("../site/data/comparative_story_signals.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(buildComparativeStorySignalArtifact(positiveArtifact), committed);
  assert.equal(committed.signals.length, 1);
});

test("admission remains pure and contains no store, network, or model-service path", () => {
  const source = readFileSync(
    new URL("../site/comparative_signal_admission.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /(?:fetch\s*\(|D1Database|\.prepare\s*\(|openai|anthropic|language model|LLM)/i);
  assert.doesNotMatch(source, /site\/app\/|worker\/src/);
});
