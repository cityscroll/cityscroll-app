import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCommitteeGateReceipt,
  buildCommitteeGraph,
  buildCommitteeReciprocalEdges,
  committeeGateAllowsPublication,
  normalizeOfficeRecord,
  reciprocalCommitteeEdge,
  sourceRowHash,
} from "../site/committee_graph.mjs";

const people = { by_person_id: {
  "7801": { person_id: "7801", person_name: "Christopher Marte" },
  "7802": { person_id: "7802", person_name: "Erik Bottcher" },
} };

test("committee identity uses BodyId and retains repeated appointment observations", () => {
  const rows = [
    {
      OfficeRecordPersonId: 7801,
      OfficeRecordBodyId: 5261,
      OfficeRecordBodyName: "Subcommittee on Landmarks",
      OfficeRecordTitle: "Chair",
      OfficeRecordStartDate: "2024-01-01",
      OfficeRecordEndDate: "2025-01-01",
    },
    {
      OfficeRecordPersonId: 7801,
      OfficeRecordBodyId: 5261,
      OfficeRecordBodyName: "Subcommittee on Landmarks",
      OfficeRecordTitle: "Member",
      OfficeRecordStartDate: "2026-01-01",
      OfficeRecordEndDate: null,
    },
    {
      OfficeRecordPersonId: 7801,
      OfficeRecordBodyId: 1,
      OfficeRecordBodyName: "City Council",
      OfficeRecordTitle: "Member",
    },
  ];
  const doc = buildCommitteeGraph(rows, people, {
    retrievedAt: "2026-08-12T00:00:00.000Z",
    gate: { publication_allowed: true },
  });
  assert.equal(doc.nodes.length, 1);
  assert.equal(doc.edge_observations.length, 2);
  assert.equal(doc.public_edges.length, 2);
  assert.equal(doc.history.duplicate_person_body_rows_retained, 1);
  assert.equal(doc.edge_observations[0].from, "official:7801");
  assert.equal(doc.edge_observations[0].to, "committee:5261");
  assert.equal(doc.public_reverse_edges.length, 2);
  assert.equal(doc.public_reverse_edges[0].type, "has_member");
  assert.equal(doc.public_reverse_edges[0].from, "committee:5261");
  assert.equal(doc.public_reverse_edges[0].to, "official:7801");
  assert.equal(doc.public_reverse_edges[0].relation_label, "has member");
  assert.equal(doc.public_reverse_edges[0].inverse_of, doc.public_edges[0].id);
  assert.deepEqual(doc.public_reverse_edges[0].provenance, doc.public_edges[0].provenance);
  assert.equal(doc.public_graph.edges.length, 4);
  assert.equal(doc.edge_observations[0].is_chair, true);
  assert.equal(doc.edge_observations[1].valid_to, null);
  assert.notEqual(doc.edge_observations[0].source_row_hash, doc.edge_observations[1].source_row_hash);
  assert.equal(doc.rejected.excluded_governance_body, 1);
});

test("reciprocal edges use exact source ids, preserve null provenance, and never mint a route", () => {
  const edge = {
    id: "edge:member_of:official:7801:committee:5261:row",
    type: "member_of",
    from: "official:7801",
    to: "committee:5261",
    provenance: null,
  };
  const inverse = reciprocalCommitteeEdge(edge, people);
  assert.equal(inverse.to, "official:7801");
  assert.equal(inverse.target_href, "/officials/7801/");
  assert.equal(inverse.provenance, null);
  assert.deepEqual(buildCommitteeReciprocalEdges([edge], people), [inverse]);
  assert.equal(reciprocalCommitteeEdge({ ...edge, from: "official:unknown" }, people), null);
  assert.equal(reciprocalCommitteeEdge({ ...edge, from: "official:9999" }, people), null);
});

test("committee graph never falls back to a name-only official join", () => {
  const doc = buildCommitteeGraph([{
    OfficeRecordPersonId: 9999,
    OfficeRecordBodyId: 5261,
    OfficeRecordBodyName: "Subcommittee on Landmarks",
  }], people, { gate: { publication_allowed: true } });
  assert.equal(doc.edge_observations.length, 0);
  assert.equal(doc.rejected.unknown_person, 1);
});

test("committee gate records an honest authenticated-sample miss", () => {
  const receipt = buildCommitteeGateReceipt({
    observedAt: "2026-08-12T00:00:00.000Z",
    samplePersonIds: Array.from({ length: 30 }, (_, index) => String(index + 1)),
    currentPersonIds: ["1"],
    formerPersonIds: ["2"],
    socrataPersonIds: ["3"],
    rows: null,
    peopleDoc: people,
    error: "LEGISTAR_API_TOKEN is not configured",
  });
  assert.equal(receipt.review.denominator, null);
  assert.equal(receipt.review.exact_key_precision, null);
  assert.equal(receipt.gate.publication_allowed, false);
  assert.equal(receipt.gate.publication_status, "held");
  assert.equal(receipt.source.name_only_edges, 0);
  assert.equal(receipt.sample_plan.requested, 30);
});

function sampleIds() {
  return Array.from({ length: 30 }, (_, index) => String(index + 1));
}

function officeRow(person = "7801") {
  return {
    OfficeRecordPersonId: person,
    OfficeRecordBodyId: "5261",
    OfficeRecordBodyName: "Subcommittee on Landmarks",
    OfficeRecordTitle: "Member",
    OfficeRecordStartDate: "2024-01-01",
    OfficeRecordEndDate: null,
  };
}

test("committee gate publishes at the 95% exact-key threshold", () => {
  const rows = [...Array.from({ length: 19 }, () => officeRow()), officeRow("not-in-person-hub")];
  const receipt = buildCommitteeGateReceipt({
    observedAt: "2026-08-12T00:00:00.000Z",
    samplePersonIds: sampleIds(),
    currentPersonIds: sampleIds().slice(0, 20),
    formerPersonIds: sampleIds().slice(20, 25),
    socrataPersonIds: sampleIds().slice(25),
    rows,
    peopleDoc: people,
  });
  assert.equal(receipt.review.denominator, 20);
  assert.equal(receipt.review.exact_key_precision, 0.95);
  assert.deepEqual(receipt.review.field_review, {
    exact_person_id_rows: 19,
    exact_body_id_rows: 20,
    body_name_rows: 20,
    title_rows: 20,
    date_order_reviewed_rows: 19,
    date_order_valid_rows: 19,
  });
  assert.equal(receipt.review.current_vs_historical_overlap.current_and_historical_person_count, 0);
  assert.equal(committeeGateAllowsPublication(receipt), true);
  assert.equal(receipt.gate.publication_allowed, true);
});

test("committee gate holds below 95% precision", () => {
  const rows = [...Array.from({ length: 18 }, () => officeRow()), officeRow("not-in-person-hub"), officeRow("also-not-in-person-hub")];
  const receipt = buildCommitteeGateReceipt({
    observedAt: "2026-08-12T00:00:00.000Z",
    samplePersonIds: sampleIds(),
    rows,
    peopleDoc: people,
  });
  assert.equal(receipt.review.exact_key_precision, 0.9);
  assert.equal(committeeGateAllowsPublication(receipt), false);
  assert.equal(receipt.gate.publication_status, "held");
});

test("committee gate holds whenever a name-only edge is reported", () => {
  const receipt = buildCommitteeGateReceipt({
    observedAt: "2026-08-12T00:00:00.000Z",
    samplePersonIds: sampleIds(),
    rows: [officeRow()],
    peopleDoc: people,
    nameOnlyEdges: 1,
  });
  assert.equal(receipt.review.exact_key_precision, 1);
  assert.equal(receipt.review.body_name_mismatches, 0);
  assert.equal(receipt.source.name_only_edges, 1);
  assert.equal(receipt.gate.publication_allowed, false);
  assert.equal(committeeGateAllowsPublication(receipt), false);
});

test("committee gate holds when an accepted row has no publisher title", () => {
  const row = officeRow();
  delete row.OfficeRecordTitle;
  const receipt = buildCommitteeGateReceipt({
    observedAt: "2026-08-12T00:00:00.000Z",
    samplePersonIds: sampleIds(),
    rows: [row],
    peopleDoc: people,
  });
  assert.equal(receipt.review.field_review.title_rows, 0);
  assert.equal(receipt.review.exact_key_precision, 0);
  assert.equal(receipt.gate.publication_allowed, false);
});

test("committee gate holds when one BodyId has conflicting publisher names", () => {
  const first = officeRow();
  const second = { ...officeRow(), OfficeRecordBodyName: "Renamed committee" };
  const receipt = buildCommitteeGateReceipt({
    observedAt: "2026-08-12T00:00:00.000Z",
    samplePersonIds: sampleIds(),
    rows: [first, second],
    peopleDoc: people,
  });
  assert.equal(receipt.review.body_name_mismatches, 1);
  assert.equal(receipt.gate.publication_allowed, false);
  assert.equal(committeeGateAllowsPublication(receipt), false);
});

test("source-row hashes are stable and normalized office records preserve null dates", () => {
  const raw = {
    OfficeRecordPersonId: "7801",
    OfficeRecordBodyId: "5261",
    OfficeRecordBodyName: "Subcommittee on Landmarks",
    OfficeRecordTitle: "Member",
    OfficeRecordStartDate: "",
    OfficeRecordEndDate: null,
  };
  const row = normalizeOfficeRecord(raw, { retrievedAt: "2026-08-12T00:00:00.000Z" });
  assert.equal(row.valid_from, null);
  assert.equal(row.valid_to, null);
  assert.equal(row.source_row_hash, sourceRowHash(raw));
});
