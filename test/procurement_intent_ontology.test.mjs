import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildProspectiveProcess,
  buildSourceRecord,
  buildStatedIntent,
  conservativePredictionWindow,
  PROSPECTIVE_EVENT_KIND,
  validateProspectiveProcess,
} from "../ontology/procurement_intent.mjs";
import { resolvePredictions } from "../worker/src/lib/prediction_contract.mjs";

const candidateArtifact = JSON.parse(readFileSync(new URL("../warehouse/fixtures/procurement-intent-radar/candidate_review.v0.json", import.meta.url), "utf8"));
const ontologyArtifact = JSON.parse(readFileSync(new URL("../warehouse/fixtures/procurement-intent-radar/prospective_ontology.v0.json", import.meta.url), "utf8"));
const positives = candidateArtifact.rows.filter((row) => row.status === "candidate");

test("all three PIR-1 positive candidates materialize as open prospective processes", () => {
  assert.equal(ontologyArtifact.process_count, 3);
  assert.equal(ontologyArtifact.processes.length, positives.length);
  for (const process of ontologyArtifact.processes) {
    validateProspectiveProcess(process);
    assert.equal(process.status, "open");
    assert.match(process.process_ref, /^procurement-intent:/u);
    assert.equal(process.predictions.occurrence.predicted_event_kind, PROSPECTIVE_EVENT_KIND);
    assert.equal(process.predictions.timing.predicted_event_kind, PROSPECTIVE_EVENT_KIND);
    assert.equal(process.predictions.occurrence.status, "open");
    assert.equal(process.predictions.timing.status, "open");
  }
});
test("source, stated intent, and later procurement identity remain separate", () => {
  for (const [index, process] of ontologyArtifact.processes.entries()) {
    const source = positives[index].source;
    const assertion = positives[index].assertion;
    assert.notEqual(process.source_record, process.stated_intent);
    assert.notEqual(process.stated_intent, process.procurement_identity);
    assert.equal(process.source_record.source_record_id, source.source_record_id);
    assert.equal(process.source_record.source_span_text, source.source_span_text);
    assert.equal(process.stated_intent.assertion_id, assertion.assertion_id);
    assert.equal(process.stated_intent.source_span, source.source_span_text);
    assert.equal(process.stated_intent.observed_at, source.observed_at);
    assert.equal(process.procurement_identity.epin, null);
    assert.equal(process.procurement_identity.pin, null);
    assert.equal(process.procurement_identity.procurement_id, null);
    assert.deepEqual(process.procurement_identity.realized_by, []);
    assert.deepEqual(process.procurement_identity.superseded_by, []);
    assert.ok(process.edges.some((edge) => edge.relation === "asserted_in" && edge.status === "accepted"));
    assert.ok(process.edges.some((edge) => edge.relation === "expects_event" && edge.to === PROSPECTIVE_EVENT_KIND));
  }
});

test("prospective artifact contains no realization identity or later procurement facts", () => {
  const serialized = JSON.stringify(ontologyArtifact);
  for (const value of ["26026P0003", "26026P0004", "06925P0010", "06823P0002", "2025-10-01", "2025-03-07", "2022-10-14"]) {
    assert.equal(serialized.includes(value), false, `unexpected downstream value ${value}`);
  }
  for (const process of ontologyArtifact.processes) {
    assert.equal(Object.hasOwn(process.stated_intent, "epin"), false);
    assert.equal(Object.hasOwn(process.stated_intent, "vendor"), false);
    assert.equal(Object.hasOwn(process.stated_intent, "realized_by"), false);
  }
});

test("occurrence and timing use the exact prediction contract with source windows", () => {
  for (const process of ontologyArtifact.processes) {
    const { occurrence, timing } = process.predictions;
    assert.equal(occurrence.subject_ref, process.process_ref);
    assert.equal(timing.subject_ref, process.process_ref);
    assert.equal(occurrence.claim, "occurrence");
    assert.equal(timing.claim, "timing");
    assert.deepEqual(occurrence.predicted_window, timing.predicted_window);
    assert.equal(occurrence.basis.evidence_event_ids[0], process.stated_intent.source_event_id);
    assert.equal(timing.basis.evidence_event_ids[0], process.stated_intent.source_event_id);
    assert.equal(occurrence.predicted_window.p10 >= process.stated_intent.observed_at, true);
    assert.equal(occurrence.predicted_window.p90, process.stated_intent.expected_window.latest);
    assert.equal(process.stated_intent.modality.length > 0, true);
  }
});

test("the existing resolver can resolve both claims only on the exact provisional subject/event pair", () => {
  const process = ontologyArtifact.processes[0];
  const resolved = resolvePredictions(
    [process.predictions.occurrence, process.predictions.timing],
    [{ event_id: "synthetic:notice-published", subject_ref: process.process_ref, event_kind: PROSPECTIVE_EVENT_KIND, published_at: "2025-10-01" }],
    { now: "2025-10-02T00:00:00.000Z" },
  );
  assert.deepEqual(resolved.map((prediction) => prediction.status), ["resolved_hit", "resolved_hit"]);
  assert.deepEqual(resolved.map((prediction) => prediction.resolved_by_event_id), ["synthetic:notice-published", "synthetic:notice-published"]);
});

test("unbounded source timing stays explicit instead of becoming an invented prediction", () => {
  assert.equal(conservativePredictionWindow({ earliest: null, latest: null, precision: "unknown", raw_text: "" }, "2026-01-01"), null);
  const row = positives[0];
  const source = buildSourceRecord(row.source);
  const assertion = buildStatedIntent({ ...row.assertion, expected_window: { earliest: null, latest: null, precision: "unknown", raw_text: "" } }, source);
  const process = buildProspectiveProcess({ sourceRecord: source, statedIntent: assertion });
  assert.equal(process.predictions.occurrence, null);
  assert.equal(process.predictions.timing, null);
  assert.ok(process.unknowns.includes("timing_prediction_window"));
});

test("future-only fields cannot be smuggled into the stated-intent register", () => {
  const row = positives[0];
  const source = buildSourceRecord(row.source);
  assert.throws(() => buildStatedIntent({ ...row.assertion, epin: "26026P0003" }, source), /future-only field/u);
  assert.throws(() => buildStatedIntent({ ...row.assertion, vendor: "Future Vendor" }, source), /future-only field/u);
});
