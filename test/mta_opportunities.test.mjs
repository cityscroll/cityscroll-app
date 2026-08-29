import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { recordsFromMtaOpportunityFixtures, validateMtaOpportunityFixtures } from "../warehouse/lib/mta_opportunities.mjs";
import { contractSearchDocumentToMoneyRow } from "../site/contract_search_bridge.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";

const fixtures = JSON.parse(readFileSync(
  new URL("../warehouse/fixtures/authority-native-procurement/mta-opportunities.v1.json", import.meta.url),
  "utf8",
));

test("MTA and Contract Reporter fixtures retain source rows and receipts", () => {
  assert.deepEqual(validateMtaOpportunityFixtures(fixtures), []);
  const records = recordsFromMtaOpportunityFixtures(fixtures);
  assert.equal(records.length, 3);
  const contractReporter = JSON.parse(records[0].normalized_snapshot);
  assert.equal(contractReporter.contract_reporter_number, "2138505");
  assert.equal(contractReporter.source_values.title, fixtures.fixtures[0].source_row.title);
  assert.equal(contractReporter.source_receipt.url, fixtures.fixtures[0].receipt.url);
  assert.match(records[0].content_hash, /^[a-f0-9]{64}$/);
});

test("S48020 and event 0000541781 are searchable current-opportunity identifiers", () => {
  const model = buildSharedProcurementReadModel({
    sourceRecords: recordsFromMtaOpportunityFixtures(fixtures),
    generatedAt: fixtures.retrieved_at,
  });
  const corpus = buildProcurementSearchDocuments(model);
  const document = corpus.documents.find((entry) => entry.search_text.includes("0000541781"));
  assert.ok(document);
  assert.match(document.title, /CBTC for 6th Ave Line/);
  assert.match(document.search_text, /S48020/);
  const row = contractSearchDocumentToMoneyRow(document);
  assert.equal(row.primary_stage, "solicitation");
  assert.equal(row.event_id, "0000541781");
  assert.equal(row.end_date, "10/16/2026");
  assert.equal(row.source_systems.includes("mta_current_opportunities"), true);
});

test("bid results remain bid-opening evidence and never become awards or winning vendors", () => {
  const model = buildSharedProcurementReadModel({
    sourceRecords: recordsFromMtaOpportunityFixtures(fixtures),
    generatedAt: fixtures.retrieved_at,
  });
  const bid = model.rows.find((row) => row.identity_keys.solicitation_ids.includes("AW9Y"));
  assert.ok(bid);
  assert.deepEqual(bid.stages.map((stage) => stage.stage), ["bid_opening_result"]);
  assert.equal(bid.identity_keys.solicitation_ids[0], "AW9Y");
  const html = renderProcurementDocument(bid, model.observations);
  assert.match(html, /Observed stages/);
  assert.match(html, /bid opening result/);
  assert.doesNotMatch(html, /<strong>award<\/strong>/);
  assert.doesNotMatch(html, /winning vendor|<dt>Vendor<\/dt>/i);
});

test("native records with different exact identifiers do not join by descriptive similarity", () => {
  const records = recordsFromMtaOpportunityFixtures({
    fixtures: fixtures.fixtures.slice(1).map((fixture) => ({
      ...fixture,
      source_row: { ...fixture.source_row, title: "Shared descriptive title" },
    })),
  });
  const model = buildSharedProcurementReadModel({ sourceRecords: records, generatedAt: fixtures.retrieved_at });
  assert.equal(model.rows.length, 2);
  assert.deepEqual(model.cross_source_identity_joins, []);
});

