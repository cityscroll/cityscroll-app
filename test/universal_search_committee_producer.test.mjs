import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildCommitteeSearchDocuments,
  projectCommitteeSearchDocument,
} from "../site/committee_search_producer.mjs";

function lookup(overrides = {}) {
  return {
    schema: "cityscroll.committee_graph.v1",
    generated_at: "2026-08-12T14:37:51Z",
    publication: "published",
    gate: { gate: { publication_allowed: true } },
    identity: {
      committee_key: "committee:{OfficeRecordBodyId}",
      name_identity_forbidden: true,
    },
    nodes: [{
      id: "committee:17",
      type: "committee",
      name: "Committee on Land Use",
      properties: { body_id: "17", body_name: "Committee on Land Use" },
      provenance: {
        source: { system: "nyc_legistar_office_records", id: "17" },
        source_fields: ["OfficeRecordBodyId", "OfficeRecordBodyName"],
        observed_at: "2026-08-12T14:37:51Z",
      },
    }],
    observations: [{
      committee_id: "committee:17",
      body_id: "17",
      body_name: "Committee on Land Use",
      valid_from: "2024-01-01",
      valid_to: null,
      source_row_hash: "abc123",
    }],
    ...overrides,
  };
}

test("committee documents retain publisher body identity and a canonical committee route", () => {
  const source = lookup();
  const result = projectCommitteeSearchDocument(source.nodes[0], { lookup: source });
  assert.equal(result.outcome, "indexed");
  assert.equal(result.document.object_ref, "committee:17");
  assert.equal(result.document.object_type, "committee");
  assert.equal(result.document.domain, "meetings");
  assert.equal(result.document.canonical_href, "/committees/17/");
  assert.deepEqual(result.document.source_observation_refs, [
    "nyc_legistar_office_records:abc123",
  ]);
  assert.ok(result.document.search_text.includes("New York City Council"));
  assert.equal(result.document.provenance.lifecycle.open_ended_membership_observation, true);
});

test("held, malformed, and partial committee inputs fail closed", () => {
  const source = lookup();
  const malformed = projectCommitteeSearchDocument({
    id: "committee:possible-land-use",
    type: "committee",
    name: "Committee on Land Use",
  }, { lookup: source });
  assert.equal(malformed.outcome, "unclassified");
  assert.equal(malformed.document, null);

  const held = buildCommitteeSearchDocuments(lookup({ publication: "held" }));
  assert.equal(held.coverage.state, "not_indexed");

  const partial = buildCommitteeSearchDocuments(lookup({
    nodes: [...source.nodes, { id: "committee:possible", type: "committee", name: "Possible" }],
  }));
  assert.equal(partial.coverage.state, "partial");
  assert.equal(partial.documents.length, 1);
  assert.equal(buildCommitteeSearchDocuments(lookup({ nodes: [] })).coverage.state, "empty");
});

test("the committed published graph produces one document per canonical committee node", () => {
  const source = JSON.parse(readFileSync(new URL("../site/data/committee_graph_lookup.json", import.meta.url)));
  const corpus = buildCommitteeSearchDocuments(source);
  assert.equal(corpus.coverage.state, "matched");
  assert.equal(corpus.documents.length, source.nodes.filter((row) => row.type === "committee").length);
});
