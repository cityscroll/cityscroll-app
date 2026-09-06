import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

import {
  CHECKBOOK_NYCHA_DATASET,
  CHECKBOOK_NYCHA_ENDPOINT,
  CHECKBOOK_NYCHA_MIN_DELAY_MS,
  CHECKBOOK_NYCHA_SOURCE_SYSTEM,
  checkDelay,
  contractsNychaRequestXml,
  normalizeNychaObservation,
  parseNychaTransactions,
  sha256,
} from "../warehouse/lib/checkbook_nycha_contracts.mjs";
import { collectNychaPages } from "../warehouse/scripts/checkbook_nycha_contracts.mjs";
import { buildProcurementObjects } from "../site/procurement_object_contract.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { readKeywordSearchIndexFromShards } from "../site/keyword_search_index_shards.mjs";
import { readProcurementBrowsePopulation } from "../tools/lib/procurement_browse_population_io.mjs";

const xml = `<response><status><result>success</result></status><record_count>1</record_count><transaction><contract_id>BA2335819</contract_id><record_type>Agreement</record_type><vendor>VITAL PLUMBING INC</vendor><pin>19056829</pin><purpose>Steam control valve work</purpose><contract_start_date>2025-01-14</contract_start_date><contract_end_date>2028-01-13</contract_end_date><contract_current_amount>4348681.74</contract_current_amount></transaction></response>`;

test("Contracts_NYCHA request is isolated and deterministic", () => {
  const request = contractsNychaRequestXml({ from: 21, maxRecords: 20, contractId: "BA2335819" });
  assert.match(request, /<type_of_data>Contracts_NYCHA<\/type_of_data>/);
  assert.match(request, /<records_from>21<\/records_from>/);
  assert.match(request, /<max_records>20<\/max_records>/);
  assert.match(request, /<name>contract_id<\/name>/);
  assert.equal(request, contractsNychaRequestXml({ from: 21, maxRecords: 20, contractId: "BA2335819" }));
  assert.notEqual(CHECKBOOK_NYCHA_ENDPOINT, "https://www.checkbooknyc.com/api?type_of_data=Contracts");
});

test("native observation retains source values and raw-response provenance", () => {
  const row = parseNychaTransactions(xml)[0];
  const observation = normalizeNychaObservation(row, { rawResponse: xml, retrievedAt: "2026-08-28T15:00:00Z" });
  assert.equal(observation.source_system, CHECKBOOK_NYCHA_SOURCE_SYSTEM);
  assert.equal(observation.source_dataset, CHECKBOOK_NYCHA_DATASET);
  assert.equal(observation.source_record_id, "BA2335819:Agreement");
  assert.equal(observation.observation_type, "contract");
  assert.equal(observation.procuring_institution_id, "agency:id:housing-authority");
  assert.equal(observation.source_agency_label, "NYCHA");
  assert.equal(observation.source_vendor_name, "VITAL PLUMBING INC");
  assert.equal(observation.amount.currency, "USD");
  assert.equal(observation.raw_observation.raw_response_hash, observation.raw_response_hash);
  assert.equal(observation.source_values.current_amount, "4348681.74");
  assert.equal(observation.current, 4348681.74);
  assert.match(observation.official_url, /nycha_contract_details\/agency\/162\/datasource\/checkbook_nycha\/contract\/BA2335819$/);
});

test("request pacing is fail-closed below the declared floor", () => {
  assert.equal(CHECKBOOK_NYCHA_MIN_DELAY_MS, 1100);
  assert.equal(checkDelay(1000, 2100), true);
  assert.equal(checkDelay(1000, 2099), false);
});

test("live page collection spaces request starts and retains raw page receipts", async () => {
  const page = (id) => `<response><status><result>success</result></status><record_count>2</record_count><transaction><contract_id>BA2335819</contract_id><record_type>${id}</record_type><vendor>VITAL PLUMBING INC</vendor><pin>19056829</pin><purpose>Steam control valve work</purpose></transaction></response>`;
  let clock = 1_000;
  const requestStarts = [];
  const sleeps = [];
  const rawDir = mkdtempSync(resolve(process.cwd(), "warehouse/raw/checkbook-nycha-test-"));
  const result = await collectNychaPages({
    pageSize: 1,
    contractId: "BA2335819",
    rawDir,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    fetchImpl: async (_url, init) => {
      requestStarts.push({ at: clock, body: init.body });
      clock += 10;
      const id = requestStarts.length === 1 ? "Agreement" : "Release";
      return { ok: true, status: 200, text: async () => page(id) };
    },
  });
  assert.equal(result.pages.length, 2);
  assert.equal(requestStarts[0].at, 1_000);
  assert.ok(requestStarts[1].at - requestStarts[0].at >= CHECKBOOK_NYCHA_MIN_DELAY_MS);
  assert.ok(sleeps[0] >= 1_090);
  assert.match(requestStarts[1].body, /<records_from>2<\/records_from>/);
  assert.equal(result.pages[0].raw_response_hash, sha256(page("Agreement")));
  rmSync(rawDir, { recursive: true, force: true });
});

test("re-ingestion preserves one source identity and one canonical contract identity", () => {
  const row = parseNychaTransactions(xml)[0];
  const one = normalizeNychaObservation(row, { rawResponse: xml, retrievedAt: "2026-08-28T15:00:00Z" });
  const two = normalizeNychaObservation(row, { rawResponse: xml, retrievedAt: "2026-08-28T16:00:00Z" });
  const records = [one, two].map((observation) => ({
    source_system: observation.source_system,
    source_system_id: `contract:${observation.contract_id}:Agreement`,
    normalized_snapshot: JSON.stringify(observation),
    raw_snapshot: JSON.stringify(observation),
    ingested_at: observation.retrieval_timestamp,
  }));
  const model = buildProcurementObjects({ sourceRecords: records });
  assert.equal(model.objects.length, 1);
  assert.equal(model.objects[0].procurement_id, "procurement:contract:BA2335819");
  assert.deepEqual(model.objects[0].stages.map((stage) => stage.stage), ["contract"]);
});

test("frozen native row reaches shared search, agency, vendor, and detail artifacts", () => {
  const browse = readProcurementBrowsePopulation("site/data/procurement_browse_rows.json");
  const nativeRows = browse.rows.filter((row) => row.contract_id === "BA2335819");
  assert.equal(nativeRows.length, 1);
  assert.equal(nativeRows[0].vendor_name, "VITAL PLUMBING INC");
  assert.equal(nativeRows[0].canonical_href, "/procurements/procurement%3Acontract%3ABA2335819");
  assert.deepEqual(nativeRows[0].source_observation_refs, ["checkbook_nycha_contracts:contract:BA2335819:Agreement"]);

  const shard = JSON.parse(readFileSync("site/data/shared_procurement_read_model/shard-000.json", "utf8"));
  const object = shard.rows.find((row) => row.procurement_id === "procurement:contract:BA2335819");
  assert.ok(object);
  assert.deepEqual(object.stages.map((stage) => stage.stage), ["contract"]);
  assert.deepEqual(object.compatibility.city_record_notice_hrefs, []);
  const observations = shard.observations.filter((row) => row.source_system === "checkbook_nycha_contracts");
  const detail = renderProcurementDocument(object, observations);
  assert.match(detail, /NYCHA/);
  assert.match(detail, /VITAL PLUMBING INC/);
  assert.match(detail, /Citywide with Borough of Brooklyn Focus/);
  assert.match(detail, /4,348,681\.74|4348681\.74/);
  assert.match(detail, /2025-01-14/);
  assert.match(detail, /2028-01-13/);
  assert.match(detail, /Checkbook NYC/);
  assert.match(detail, /nycha_contract_details\/agency\/162/);
  assert.doesNotMatch(detail, /City Record/);

  const agency = JSON.parse(readFileSync("site/agencies/housing-authority/relationships-data.json", "utf8")).view;
  const contracts = agency.categories.find((category) => category.id === "contracts");
  assert.ok(contracts.items.some((item) => item.subject_ref === "procurement:contract:BA2335819"));
  assert.match(JSON.stringify(agency.categories.find((category) => category.id === "vendors")), /VITAL PLUMBING INC/);

  const entityIntelligence = JSON.parse(readFileSync("site/data/entity_intelligence_lookup.json", "utf8"));
  const vital = entityIntelligence.by_ref["vendor:stem:VITAL%20PLUMBING"];
  assert.ok(vital);
  assert.match(JSON.stringify(vital), /BA2335819/);
  assert.match(JSON.stringify(vital), /checkbook_nycha_contracts/);

  const keyword = readKeywordSearchIndexFromShards("worker/src/data/keyword_search_index_shards/manifest.json");
  const indexed = JSON.stringify(keyword);
  assert.equal((indexed.match(/procurement:contract:BA2335819/g) || []).length > 0, true);
  assert.match(indexed, /BA2335819/);
  assert.match(indexed, /VITAL PLUMBING INC/);
});
