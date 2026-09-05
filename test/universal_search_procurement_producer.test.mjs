import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { readSharedProcurementReadModel } from "../tools/lib/procurement_read_model_io.mjs";
import { searchContractAwardDocuments } from "../site/contract_award_search_producer.mjs";
import { contractSearchDocumentToMoneyRow } from "../site/contract_search_bridge.mjs";
import {
  mergeUniversalSearchCandidates,
  mergeUniversalSearchResults,
} from "../worker/src/search.mjs";

const cohort = JSON.parse(readFileSync(
  new URL("./fixtures/procurement_search/golden_cohort.json", import.meta.url),
  "utf8",
));
const productionShared = readSharedProcurementReadModel(
  new URL("../site/data/shared_procurement_read_model.json", import.meta.url),
);
const FIREMATIC_FIXTURE = JSON.parse(readFileSync(
  new URL("./fixtures/procurement_search/firematic_vendor.json", import.meta.url),
  "utf8",
));

function model(sourceStatus = {}) {
  return buildSharedProcurementReadModel({
    sourceRecords: cohort.source_records,
    sourceStatus,
    generatedAt: cohort.generated_at,
  });
}

test("CROL-negative canonical procurement is indexed once without request_id", () => {
  const corpus = buildProcurementSearchDocuments(model());
  const negative = corpus.documents.filter((document) => (
    document.object_ref === "procurement:contract:CT101520271400806"
  ));
  assert.equal(negative.length, 1);
  assert.equal(negative[0].canonical_href, "/procurements/procurement%3Acontract%3ACT101520271400806");
  assert.equal(negative[0].process_role, "registered");
  assert.equal(Object.hasOwn(negative[0].provenance.browse_record, "request_id"), false);
  assert.deepEqual(negative[0].source_observation_refs, [
    "checkbook_contracts:contract:registered:CT101520271400806:BILLIG LAW PC:prime-vendor:2026-08-15",
  ]);
});

test("CROL-positive canonical result retains notice evidence additively", () => {
  const corpus = buildProcurementSearchDocuments(model());
  const positive = corpus.documents.find((document) => (
    document.object_ref === "procurement:contract:CT1841260001"
  ));
  assert.ok(positive);
  assert.ok(positive.source_observation_refs.includes("city_record:20260623008"));
  assert.deepEqual(positive.provenance.notice_evidence.map((entry) => entry.request_id), ["20260623008"]);
  assert.match(positive.provenance.notice_evidence[0].additional_description_1, /retained/);
  assert.equal(positive.provenance.browse_record.request_id, "20260623008");
});

test("one unavailable source changes only that source coverage", () => {
  const available = buildProcurementSearchDocuments(model());
  for (const source of ["checkbook_contracts", "passport_public_contracts", "city_record"]) {
    const unavailable = buildProcurementSearchDocuments(model({
      [source]: { status: "unavailable", reason: "golden_failure" },
    }));
    assert.deepEqual(unavailable.documents, available.documents);
    assert.equal(unavailable.coverage[source].status, "unavailable");
    assert.equal(unavailable.coverage[source].reason, "golden_failure");
    for (const other of Object.keys(available.coverage).filter((key) => key !== source)) {
      assert.deepEqual(unavailable.coverage[other], available.coverage[other]);
    }
  }
});

test("production corpus adds material CROL-negative recall without reducing CROL awards", () => {
  const shared = readSharedProcurementReadModel(
    new URL("../site/data/shared_procurement_read_model.json", import.meta.url),
  );
  const browse = JSON.parse(readFileSync(
    new URL("../site/data/procurement_browse_rows.json", import.meta.url),
    "utf8",
  ));
  const awards = JSON.parse(readFileSync(
    new URL("../site/data/ocp_awards_warehouse_lookup.json", import.meta.url),
    "utf8",
  ));
  const canonical = buildProcurementSearchDocuments(shared).documents;
  const crol = searchContractAwardDocuments(awards, "contract award", { limit: 40 }).documents;
  // CROL-negative rows are served contracts with no matching City Record award.
  // A larger award snapshot matches more of them, so the count falls as coverage
  // improves; the floor guards the share of the corpus that only the production
  // read model can reach, not one snapshot's absolute count.
  const crolNegative = browse.rows.filter((row) => !row.request_id).length;
  assert.ok(
    crolNegative >= browse.rows.length * 0.05,
    `expected material CROL-negative recall, got ${crolNegative} of ${browse.rows.length}`,
  );
  assert.ok(canonical.length >= 2_000);
  assert.ok(canonical.some((document) => document.provenance.notice_evidence.length));
  assert.ok(mergeUniversalSearchResults([], [...crol, ...canonical], 100).length >= crol.length);
});

test("FIREMATIC merges all 21 retained awards with the served PASSPort-only contract", () => {
  assert.equal(FIREMATIC_FIXTURE.ocp_rows.length, 21);
  const awards = searchContractAwardDocuments({
    schema_version: 1,
    source: "ocp-recent-contract-awards",
    rows: FIREMATIC_FIXTURE.ocp_rows,
  }, FIREMATIC_FIXTURE.query, { limit: 100 }).documents;
  const canonical = buildProcurementSearchDocuments(productionShared).documents
    .filter((document) => document.object_ref === FIREMATIC_FIXTURE.passport_only.object_ref);
  assert.equal(awards.length, 21);
  assert.equal(canonical.length, 1);

  const merged = mergeUniversalSearchCandidates({
    cityRecordDocuments: [],
    contractAwardDocuments: awards,
    procurementDocuments: canonical,
    limit: 100,
  });
  assert.deepEqual(merged.candidate_counts, {
    city_record: 0,
    contract_award: 21,
    shared_procurement: 1,
    pre_merge: 22,
    post_merge: 22,
  });
  const passport = merged.documents.find((document) => (
    document.object_ref === FIREMATIC_FIXTURE.passport_only.object_ref
  ));
  assert.ok(passport);
  assert.equal(passport.canonical_href, FIREMATIC_FIXTURE.passport_only.canonical_href);
  assert.equal(passport.provenance.browse_record.vendor_name, FIREMATIC_FIXTURE.passport_only.vendor_name);
  assert.equal(passport.provenance.browse_record.contract_amount, FIREMATIC_FIXTURE.passport_only.contract_amount);
  const bridged = contractSearchDocumentToMoneyRow(passport);
  assert.equal(bridged.procurement_id, FIREMATIC_FIXTURE.passport_only.object_ref);
  assert.equal(bridged.canonical_href, passport.canonical_href);
  assert.equal(bridged.contract_id, "CT185720228800365");
});
