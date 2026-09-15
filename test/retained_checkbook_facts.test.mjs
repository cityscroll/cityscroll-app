import assert from "node:assert/strict";
import test from "node:test";

import { procurementSourceRecordsFromMaterializations } from "../tools/build_shared_procurement_read_model.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { resolveKeywordQuery, searchKeywordDocuments } from "../site/keyword_matcher.mjs";
import { testClockISOString } from "./helpers/test_clock.mjs";

const TEST_CLOCK = testClockISOString();

const rows = [
  {
    contract_id: "CT110220271400991",
    prime_vendor: "S & P GLOBAL MARKET INTELLIGENCE LLC",
    agency: "City Council",
    pin: "10220272001881",
    award_method: "SUBSCRIPTION ETC PER PPB",
    registration_date: "2026-09-07",
    start_date: "2026-07-01",
    purpose: "& GI SEARCH/ SELECT DATA ONLINE SUBSCRIPTION",
    document_code: "CT1",
    contract_type: "SUBSCRIPTIONS",
    contract_version: "1",
    parent_contract_id: null,
    status: "registered",
    current: 62500,
    original: 62500,
    spent: 0,
    start: "2026-07-01",
    end: "2027-06-30",
    registered: "2026-09-07",
    source_fiscal_years: ["2027"],
    date_ownership: { owner: "prime_vendor_slice" },
    selection_bucket: "new_unique",
  },
  {
    contract_id: "CT105720278802113",
    prime_vendor: "AMERICAN HEART ASSOCIATION INC",
    agency: "Fire Department",
    pin: "05727U0002001",
    registration_date: "2026-09-07",
    purpose: "AHA MATERIALS FOR TRAINING",
    contract_type: "SUBSCRIPTIONS",
    current: 46673.32,
    original: 46673.32,
    start: "2026-08-21",
    end: "2027-06-30",
    registered: "2026-09-07",
    source_fiscal_years: ["2027"],
    selection_bucket: "new_unique",
  },
  {
    contract_id: "CT104020273009333",
    prime_vendor: "QUIZIZZ INC",
    agency: "Department of Education",
    pin: null,
    award_method: "SMALL PURCHASE - WRITTEN",
    registration_date: "2026-09-04",
    start_date: "2026-09-04",
    purpose: "SOLE VENDOR-COMMODITIES",
    contract_type: "SUPPLIES/MATERIALS/EQUIPMENT",
    current: 25000,
    original: 25000,
    start: "2026-09-04",
    end: "2027-06-30",
    registered: "2026-09-04",
    source_fiscal_years: ["2027"],
    selection_bucket: "new_unique",
  },
  {
    contract_id: "CT107120258801626",
    prime_vendor: "BHRAGS HOME CARE CORP",
    agency: "Department of Homeless Services",
    pin: "07124E0044001",
    registration_date: "2024-08-28",
    purpose: "Bhrags Services at FWC Emmons K 2023",
    award_method: "EMERGENCY",
    contract_type: "GENERAL CONTRACT",
    current: 10869881,
    original: 10869881,
    start: "2023-10-11",
    end: "2026-06-30",
    registered: "2024-08-28",
    source_fiscal_years: ["2025"],
    selection_bucket: "new_unique",
  },
];

function readModel() {
  const sourceRecords = procurementSourceRecordsFromMaterializations({
    generated_at: TEST_CLOCK,
    rows: { checkbook_contracts: rows },
  }, {});
  return buildSharedProcurementReadModel({
    sourceRecords,
    generatedAt: TEST_CLOCK,
    now: TEST_CLOCK,
  });
}

function documentFor(model, contractId) {
  const object = model.rows.find((row) => row.identity_keys.contract_ids.includes(contractId));
  const observations = model.observations.filter((entry) => object.source_observation_refs.includes(entry.source_observation_ref));
  return { object, observations, html: renderProcurementDocument(object, observations) };
}

test("A1: the built S&P artifact retains purpose, amount, method, type, and registration date", () => {
  const { object, observations, html } = documentFor(readModel(), "CT110220271400991");
  assert.match(html, /&amp; GI SEARCH\/ SELECT DATA ONLINE SUBSCRIPTION/);
  assert.match(html, /62,500/);
  assert.match(html, /SUBSCRIPTION ETC PER PPB/);
  assert.match(html, /SUBSCRIPTIONS/);
  assert.match(html, /2026-09-07/);
  assert.equal(observations[0].snapshot.registration_date, "2026-09-07");
});

test("A2: the built AHA and QUIZIZZ artifacts retain source wording without inventing QUIZIZZ PIN", () => {
  const model = readModel();
  const aha = documentFor(model, "CT105720278802113").html;
  const quizizz = documentFor(model, "CT104020273009333").html;
  assert.match(aha, /AHA MATERIALS FOR TRAINING/);
  assert.match(quizizz, /SOLE VENDOR-COMMODITIES/);
  assert.match(quizizz, /SMALL PURCHASE - WRITTEN/);
  assert.match(quizizz, /25,000/);
  assert.match(quizizz, /2026-09-04/);
  assert.doesNotMatch(quizizz, /<dt>PIN \/ EPIN<\/dt>/);
});

test("A3: retained identifiers, source metadata, links, and exact-ID search survive the built model", () => {
  const model = readModel();
  const { object, html } = documentFor(model, "CT110220271400991");
  assert.deepEqual(object.identity_keys.contract_ids, ["CT110220271400991"]);
  assert.equal(object.source_observation_refs.length, 1);
  assert.match(html, /href="\/search\/\?q=CT110220271400991"/);
  const documents = buildProcurementSearchDocuments(model).documents;
  const matches = searchKeywordDocuments(documents, resolveKeywordQuery("CT110220271400991"), { limit: 10 });
  assert.deepEqual(matches.map((entry) => entry.object_ref), [object.procurement_id]);
});

test("A4: the built BHRAGS detail reuses the official Checkbook handoff", () => {
  const { html } = documentFor(readModel(), "CT107120258801626");
  assert.match(html, /https:\/\/www\.checkbooknyc\.com\/smart_search\/citywide\?search_term=CT107120258801626/);
});
