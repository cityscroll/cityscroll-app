import assert from "node:assert/strict";
import test from "node:test";

import {
  attachPassportPublicFields,
  cleanPassportPublicTitle,
  densifyPassportPublicFields,
  passportPublicFieldsFromRow,
} from "../site/passport_public_fields.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { renderProcurementObjectCoverageHtml } from "../site/procurement_coverage_labels.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import {
  resolveKeywordQuery,
  searchKeywordDocuments,
} from "../site/keyword_matcher.mjs";
import { procurementSourceRecordsFromMaterializations } from "../tools/build_shared_procurement_read_model.mjs";

const identity = {
  ctr_id: "9000001",
  epin: "85024M0001001",
  contract_id: "CT1-850-20248800001",
};

function sourceRecord(snapshot) {
  return {
    source_system: "passport_public_contracts",
    source_system_id: `contract:${snapshot.epin_norm || snapshot.epin}:${snapshot.ctr_id}`,
    content_hash: `${snapshot.ctr_id}-hash`,
    normalized_snapshot: JSON.stringify(snapshot),
    raw_snapshot: JSON.stringify(snapshot),
    ingested_at: "2026-08-18T19:46:32Z",
  };
}

test("quality gate keeps real titles and drops identity or PIN-only garbage", () => {
  assert.equal(
    cleanPassportPublicTitle("Annual subscription of license maintenance", identity),
    "Annual subscription of license maintenance",
  );
  assert.equal(
    cleanPassportPublicTitle("85721B0111-Bid 2100089 Nozzles (Brand Specific) Amendment #1", identity),
    "Bid 2100089 Nozzles (Brand Specific) Amendment #1",
  );
  assert.equal(cleanPassportPublicTitle("85021B0087-LBC10CDHC-CO#8", identity), null);
  assert.equal(cleanPassportPublicTitle("CT1-850-20248800001", identity), null);
  assert.equal(cleanPassportPublicTitle("N/A", identity), null);
  assert.equal(cleanPassportPublicTitle("61415", identity), null);
  assert.equal(cleanPassportPublicTitle("", identity), null);
});

test("honest absence stays absent and does not invent scope or location", () => {
  const fields = passportPublicFieldsFromRow({
    ...identity,
    title: "85021B0087-LBC10CDHC-CO#8",
    procurement_method: "",
    program: null,
  });
  assert.equal(fields.title, null);
  assert.equal(fields.procurement_method, null);
  assert.equal(fields.program, null);
  assert.equal(Object.hasOwn(fields, "scope"), false);
  assert.equal(Object.hasOwn(fields, "deliverables"), false);
  assert.equal(Object.hasOwn(fields, "place_of_performance"), false);
});

test("densify matches exact ctr_id and attaches only clean publisher fields", () => {
  const spine = [{
    ...identity,
    agency: "DEPARTMENT OF PARKS AND RECREATION",
    vendor: "GLO STUDIO INC",
    status: "Registered",
    award_amount: 8000,
    registration_date: "01/15/2024",
  }];
  const dump = [{
    ...identity,
    title: "Furnish and install pre-cut vinyl Sign",
    procurement_method: "Micropurchase",
    program: "Citywide Sign Shop",
    industry: "Goods",
    award_amount: 8000,
    scope: "should-not-copy",
  }];
  const result = densifyPassportPublicFields(spine, dump);
  assert.equal(result.matched, 1);
  assert.equal(result.titled, 1);
  assert.equal(result.rows[0].title, "Furnish and install pre-cut vinyl Sign");
  assert.equal(result.rows[0].procurement_method, "Micropurchase");
  assert.equal(result.rows[0].program, "Citywide Sign Shop");
  assert.equal(result.rows[0].industry, "Goods");
  assert.equal(Object.hasOwn(result.rows[0], "scope"), false);
});

test("PASSPort-only object, coverage label, and keyword search use restored fields", () => {
  const snapshot = attachPassportPublicFields({
    ...identity,
    epin_norm: "85024M0001001",
    agency: "Department of Parks and Recreation",
    vendor: "GLO STUDIO INC",
    status: "Registered",
    award_amount: 8000,
    registration_date: "01/15/2024",
    title: "Furnish and install pre-cut vinyl Sign",
    procurement_method: "Micropurchase",
    program: "Citywide Sign Shop",
    industry: "Goods",
  });
  const model = buildSharedProcurementReadModel({
    sourceRecords: [sourceRecord(snapshot)],
    generatedAt: "2026-08-18T19:46:32Z",
  });
  assert.equal(model.rows.length, 1);
  const [object] = model.rows;
  const observation = model.observations[0];
  assert.equal(observation.snapshot.title, "Furnish and install pre-cut vinyl Sign");
  assert.equal(observation.snapshot.procurement_method, "Micropurchase");
  assert.equal(Object.hasOwn(object, "title"), false);

  const html = renderProcurementDocument(object, model.observations);
  assert.match(html, /Furnish and install pre-cut vinyl Sign/);
  assert.doesNotMatch(html, /Contract CT1-850-20248800001/);
  assert.match(
    renderProcurementObjectCoverageHtml(object, model.observations),
    /Targeted small-purchase — no public solicitation required/,
  );

  const corpus = buildProcurementSearchDocuments(model);
  assert.equal(corpus.documents[0].title, "Furnish and install pre-cut vinyl Sign");
  const hits = searchKeywordDocuments(
    corpus.documents,
    resolveKeywordQuery("vinyl sign"),
    { limit: 8 },
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].object_ref, object.procurement_id);
});

test("shared-read-model builder keeps restored fields on PASSPort snapshots", () => {
  const spine = {
    generated_at: "2026-08-18T19:46:32Z",
    rows: {
      checkbook_contracts: [],
      passport_contracts: [{
        ...identity,
        agency: "Department of Parks and Recreation",
        vendor: "GLO STUDIO INC",
        status: "Registered",
        award_amount: 8000,
        registration_date: "08/01/2026",
        title: "Furnish and install pre-cut vinyl Sign",
        procurement_method: "Micropurchase",
        program: "Citywide Sign Shop",
        industry: "Goods",
      }],
    },
  };
  const records = procurementSourceRecordsFromMaterializations(spine, { rows: [] });
  const passport = records.find((row) => row.source_system === "passport_public_contracts");
  const snapshot = JSON.parse(passport.normalized_snapshot);
  assert.equal(snapshot.title, "Furnish and install pre-cut vinyl Sign");
  assert.equal(snapshot.procurement_method, "Micropurchase");
});
