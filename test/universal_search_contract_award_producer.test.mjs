import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildContractAwardSearchDocuments,
  projectContractAwardSearchDocument,
  searchContractAwardDocuments,
} from "../site/contract_award_search_producer.mjs";

const LOOKUP = {
  schema_version: 1,
  source: "ocp-recent-contract-awards",
  materialized_at: "2026-08-05T10:40:50.286Z",
  rows: [
    {
      request_id: "20030520019",
      start_date: "2003-05-27",
      agency_name: "Health and Mental Hygiene",
      type_of_notice_description: "Award",
      short_title: "Aerial Mosquito Control",
      pin: "02ea43001r0x00",
      contract_amount: "4294050",
      vendor_name: "Agrotors, Inc.",
    },
    {
      request_id: "missing-pin",
      type_of_notice_description: "Award",
      short_title: "Valid source row without a stable contract identity",
      pin: "see below",
    },
  ],
};

test("OCP awards become canonical procurement SearchDocuments without requiring enrichment", () => {
  const result = projectContractAwardSearchDocument(LOOKUP.rows[0], { lookup: LOOKUP });
  assert.equal(result.outcome, "indexed");
  assert.deepEqual({
    object_ref: result.document.object_ref,
    object_type: result.document.object_type,
    domain: result.document.domain,
    canonical_href: result.document.canonical_href,
    process_role: result.document.process_role,
    source_observation_refs: result.document.source_observation_refs,
  }, {
    object_ref: "procurement:02EA43001R0X00",
    object_type: "procurement",
    domain: "contracts",
    canonical_href: "/browse/contracts/?mode=award&q=02EA43001R0X00",
    process_role: "award",
    source_observation_refs: ["ocp_award:20030520019"],
  });
  assert.equal(result.document.provenance.evidence_metadata, null);

  const enriched = projectContractAwardSearchDocument(LOOKUP.rows[0], {
    lookup: LOOKUP,
    evidenceByRequestId: new Map([["20030520019", { place: { scope: "citywide" } }]]),
  });
  assert.deepEqual(enriched.document.provenance.evidence_metadata, {
    place: { scope: "citywide" },
  });
  assert.equal(enriched.outcome, "indexed", "evidence metadata is additive, never an admission filter");
});

test("contract award coverage exposes rows that fail the stable-identity gate", () => {
  const corpus = buildContractAwardSearchDocuments(LOOKUP);
  assert.equal(corpus.coverage.state, "partial");
  assert.equal(corpus.coverage.total_count, 2);
  assert.equal(corpus.coverage.indexed_count, 1);
  assert.equal(corpus.coverage.not_indexed_count, 1);
  assert.equal(corpus.outcomes[1].reason, "missing_stable_procurement_identifier");
  assert.equal(corpus.outcomes[1].document, null);

  assert.equal(buildContractAwardSearchDocuments({}).coverage.state, "not_indexed");
});

test("the committed complete award materialization makes mosquito findable", () => {
  const lookup = JSON.parse(readFileSync(
    new URL("../site/data/ocp_awards_warehouse_lookup.json", import.meta.url),
    "utf8",
  ));
  const result = searchContractAwardDocuments(lookup, "mosquito");
  assert.ok(result.documents.length >= 20, `expected broad mosquito recall, got ${result.documents.length}`);
  assert.ok(result.documents.every((document) => (
    document.object_type === "procurement"
    && document.domain === "contracts"
    && document.process_role === "award"
  )));
  assert.ok(result.documents.some((document) => /mosquito/i.test(document.title)));

  const generic = searchContractAwardDocuments(lookup, "contract award");
  assert.equal(generic.documents.length, 40);
  assert.ok(generic.documents.every((document) => document.domain === "contracts"));
});
