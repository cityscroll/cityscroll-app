import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCommitteeGateReceipt,
  buildCommitteeGraph,
  normalizeOfficeRecord,
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
  assert.equal(doc.edge_observations[0].is_chair, true);
  assert.equal(doc.edge_observations[1].valid_to, null);
  assert.notEqual(doc.edge_observations[0].source_row_hash, doc.edge_observations[1].source_row_hash);
  assert.equal(doc.rejected.excluded_governance_body, 1);
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
