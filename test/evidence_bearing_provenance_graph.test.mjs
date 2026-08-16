import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PROVENANCE_GRAPH_SCHEMA_VERSION,
  PROVENANCE_PUBLIC_SCHEMA_VERSION,
  buildProvenanceGraph,
  provenanceForAssertion,
  publicProvenanceProjection,
  versionedAssertionId,
  walkProvenance,
} from "../entity_resolution/provenance_graph.mjs";
import {
  CURATION_REVIEW_POLICY_VERSION,
  buildCurationVerdictReceipt,
} from "../entity_resolution/review/curation_verdicts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_ACTIONS = JSON.parse(readFileSync(
  join(ROOT, "entity_resolution/eval/fixtures/review_actions_v0.json"),
  "utf8",
));
const HNTB = REVIEW_ACTIONS.rows.find((row) => row.pair_id === "pair-hntb-truncation");
const ASSERTION_KEY = "vendor_identity:pair-hntb-truncation";
const ASSERTION_ID = "assertion:vendor_identity:pair-hntb-truncation:v1";
const RUN_ID = "resolution-run:hntb:conventional-v2";
const ACTOR_ID = "desk:fixture-1";

function receiptInput(overrides = {}) {
  return {
    id: "verdict-accept-001",
    actor: ACTOR_ID,
    decision: "ACCEPT",
    target: {
      kind: "entity_pair",
      id: HNTB.pair_id,
      edge_family: "vendor_identity",
      gold_candidate: {
        entity_type: "vendor",
        left: HNTB.evidence.left,
        right: HNTB.evidence.right,
      },
    },
    evidence_refs: [HNTB.evidence.left, HNTB.evidence.right].map((record) => ({
      kind: "source_record",
      id: record.source_record_id,
    })),
    model_version: "conventional_v2",
    rule_version: CURATION_REVIEW_POLICY_VERSION,
    review_policy: {
      version: CURATION_REVIEW_POLICY_VERSION,
      status: "satisfied",
      reasons: ["authenticated_review_complete"],
    },
    timestamp: "2026-08-15T12:00:00.000Z",
    ...overrides,
  };
}

function sourceEvidence(record) {
  return {
    kind: "source_record",
    id: record.source_record_id,
    source_system: record.source_system,
    source_system_id: record.source_system_id,
    source_record_id: record.source_record_id,
    observed_at: HNTB.created_at,
    raw_snapshot: {
      display_name: record.display_name,
      observed_fields: record.observed_fields,
    },
  };
}

function graphInput({ includeReversal = true, omitEvidenceId = null } = {}) {
  const accepted = buildCurationVerdictReceipt(receiptInput());
  accepted.note = "private adjudication note";
  const reversed = buildCurationVerdictReceipt(receiptInput({
    id: "verdict-reverse-001",
    decision: "REJECT",
    target: { kind: "entity_pair", id: HNTB.pair_id },
    review_policy: {
      version: CURATION_REVIEW_POLICY_VERSION,
      status: "not_applicable",
      reasons: ["later evidence changed the judgment"],
    },
    reverses_receipt_id: accepted.id,
    timestamp: "2026-08-15T12:06:00.000Z",
  }));

  const evidence = [
    sourceEvidence(HNTB.evidence.left),
    sourceEvidence(HNTB.evidence.right),
    {
      kind: "resolution_run",
      id: RUN_ID,
      method: "conventional_v2",
      model_version: "conventional_v2",
      policy_version: CURATION_REVIEW_POLICY_VERSION,
      observed_at: "2026-08-15T11:59:00.000Z",
    },
  ].filter((node) => node.id !== omitEvidenceId);

  return {
    assertions: [{
      assertion_key: ASSERTION_KEY,
      assertion_id: ASSERTION_ID,
      version: 1,
      claim_class: "cityscroll_interpretation",
      assertion_kind: "vendor_identity",
      subject_ref: `source_record:${HNTB.evidence.left.source_record_id}`,
      predicate: "same_entity_as",
      object_ref: `source_record:${HNTB.evidence.right.source_record_id}`,
      status: "reviewed",
      warrant_class: "reviewed",
      evidence_refs: [HNTB.evidence.left, HNTB.evidence.right].map((record) => ({
        kind: "source_record",
        id: record.source_record_id,
      })),
      produced_by_refs: [{ kind: "resolution_run", id: RUN_ID }],
      decision_target: { kind: "entity_pair", id: HNTB.pair_id },
    }],
    evidence,
    decisions: includeReversal ? [accepted, reversed] : [accepted],
    entity_links: [{
      id: "link-curated-001",
      materialized_by_decision_id: accepted.id,
      canonical_entity_id: "vendor:hntb",
      method: "curation_accept",
      matcher_version: "conventional_v2",
      resolution_run_id: RUN_ID,
    }],
    actors: [{
      id: ACTOR_ID,
      actor_kind: "curator",
      attestation: "authenticated",
      label: "Fixture Curator",
    }],
  };
}

test("versioned assertion identity is deterministic and separate from the review-pair target", () => {
  assert.equal(versionedAssertionId(ASSERTION_KEY, 1), ASSERTION_ID);
  const graph = buildProvenanceGraph(graphInput());
  assert.equal(graph.schema_version, PROVENANCE_GRAPH_SCHEMA_VERSION);

  const assertion = graph.nodes.find((node) => node.node_type === "assertion");
  assert.equal(assertion.id, ASSERTION_ID);
  assert.equal(assertion.assertion_key, ASSERTION_KEY);
  assert.equal(assertion.version, "1");
  assert.deepEqual(assertion.decision_target, {
    kind: "entity_pair",
    id: HNTB.pair_id,
  });
  assert.notEqual(assertion.id, assertion.decision_target.id);
});

test("assertion provenance walks to exact observations, run evidence, ordered decisions, and actor", () => {
  const graph = buildProvenanceGraph(graphInput());
  const provenance = provenanceForAssertion(graph, ASSERTION_ID);

  assert.deepEqual(
    provenance.evidence
      .filter((node) => node.kind === "source_record")
      .map((node) => node.source_record_id)
      .sort(),
    [
      HNTB.evidence.left.source_record_id,
      HNTB.evidence.right.source_record_id,
    ].sort(),
  );
  assert.equal(
    provenance.evidence.find((node) => node.kind === "resolution_run")?.id,
    RUN_ID,
  );
  assert.deepEqual(
    provenance.decisions.map((node) => [node.id, node.decision]),
    [
      ["verdict-accept-001", "ACCEPT"],
      ["verdict-reverse-001", "REJECT"],
    ],
  );
  assert.deepEqual(
    provenance.actors.map((node) => [node.id, node.attestation]),
    [[ACTOR_ID, "authenticated"]],
  );
  const fullWalk = walkProvenance(
    graph,
    { node_type: "assertion", id: ASSERTION_ID },
  );
  assert.equal(
    fullWalk.nodes.some((node) => node.node_type === "actor" && node.id === ACTOR_ID),
    true,
  );

  for (const sourceRecordId of [
    HNTB.evidence.left.source_record_id,
    HNTB.evidence.right.source_record_id,
  ]) {
    const reverse = walkProvenance(
      graph,
      { node_type: "evidence", id: sourceRecordId },
      { direction: "incoming", max_depth: 1 },
    );
    assert.equal(
      reverse.nodes.some((node) => node.node_type === "assertion" && node.id === ASSERTION_ID),
      true,
    );
  }
});

test("reversing REJECT removes the accepted link only from current state and preserves history", () => {
  const acceptedGraph = buildProvenanceGraph(graphInput({ includeReversal: false }));
  const accepted = provenanceForAssertion(acceptedGraph, ASSERTION_ID);
  assert.equal(accepted.current.state, "gold_candidate");
  assert.equal(accepted.current.active, true);
  assert.equal(accepted.current.active_decision_id, "verdict-accept-001");
  assert.equal(accepted.current.materialized_entity_link_id, "link-curated-001");

  const reversedGraph = buildProvenanceGraph(graphInput());
  const reversed = provenanceForAssertion(reversedGraph, ASSERTION_ID);
  assert.equal(reversed.current.state, "reject_withheld");
  assert.equal(reversed.current.active, false);
  assert.equal(reversed.current.materialized_entity_link_id, null);
  assert.deepEqual(reversed.decisions.map((node) => node.id), [
    "verdict-accept-001",
    "verdict-reverse-001",
  ]);
  assert.deepEqual(reversed.materializations.map((node) => node.id), ["link-curated-001"]);
});

test("dangling evidence and mismatched assertion identities fail contract validation", () => {
  assert.throws(
    () => buildProvenanceGraph(graphInput({
      omitEvidenceId: HNTB.evidence.right.source_record_id,
    })),
    /dangling node reference.*checkbook:CT184120268807929:hash-r/,
  );

  const mismatched = graphInput();
  mismatched.assertions[0].assertion_id = "assertion:wrong:v1";
  assert.throws(
    () => buildProvenanceGraph(mismatched),
    /assertion_id must equal assertion:vendor_identity:pair-hntb-truncation:v1/,
  );
});

test("superseding versions share the compatibility decision_target and route decisions to the current version", () => {
  const input = graphInput();
  const v2Id = versionedAssertionId(ASSERTION_KEY, 2);
  input.assertions.push({
    ...input.assertions[0],
    assertion_id: v2Id,
    version: 2,
    supersedes_assertion_id: ASSERTION_ID,
  });
  const graph = buildProvenanceGraph(input);

  const current = provenanceForAssertion(graph, v2Id);
  assert.deepEqual(current.decisions.map((node) => node.id), [
    "verdict-accept-001",
    "verdict-reverse-001",
  ]);
  assert.deepEqual(current.materializations.map((node) => node.id), ["link-curated-001"]);
  const superseded = provenanceForAssertion(graph, ASSERTION_ID);
  assert.deepEqual(superseded.decisions, []);
  assert.equal(superseded.current.active, false);
  assert.equal(
    graph.edges.some((edge) => edge.edge_type === "supersedes"
      && edge.from.id === v2Id
      && edge.to.id === ASSERTION_ID),
    true,
  );

  const conflicting = graphInput();
  conflicting.assertions.push({
    ...conflicting.assertions[0],
    assertion_key: "other_claim:pair-hntb-truncation",
    assertion_id: "",
  });
  assert.throws(
    () => buildProvenanceGraph(conflicting),
    /maps to multiple assertion keys/,
  );
});

test("public projection is allowlisted to warrant and source evidence without review-process detail", () => {
  const graph = buildProvenanceGraph(graphInput());
  const projection = publicProvenanceProjection(graph, ASSERTION_ID);

  assert.equal(projection.schema_version, PROVENANCE_PUBLIC_SCHEMA_VERSION);
  assert.equal(projection.assertion.assertion_id, ASSERTION_ID);
  assert.equal(projection.assertion.warrant_class, "reviewed");
  assert.equal(projection.publication.active, false);
  assert.deepEqual(
    projection.evidence_sources.map((source) => source.source_system).sort(),
    ["checkbook", "city_record"],
  );

  const encoded = JSON.stringify(projection);
  for (const privateValue of [
    ACTOR_ID,
    "Fixture Curator",
    "private adjudication note",
    "authenticated_review_complete",
    "later evidence changed the judgment",
    HNTB.evidence.left.display_name,
    "verdict-accept-001",
    HNTB.evidence.left.source_record_id,
    HNTB.evidence.right.source_record_id,
    "link-curated-001",
    RUN_ID,
    "reject_withheld",
    "gold_candidate",
  ]) {
    assert.equal(encoded.includes(privateValue), false, `public projection leaked ${privateValue}`);
  }
  assert.equal(Object.hasOwn(projection, "decisions"), false);
  assert.equal(Object.hasOwn(projection, "actors"), false);
  assert.equal(Object.hasOwn(projection, "current"), false);
  assert.equal(encoded.includes("raw_snapshot"), false);
  assert.equal(encoded.includes("review_policy"), false);
  assert.equal(encoded.includes("receipt"), false);
});
