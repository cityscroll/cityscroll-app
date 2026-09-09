/**
 * The registered-contract aggregate and the procurement detail record are two
 * different populations with two different identifier namespaces. A live run
 * of the deployed gateway followed the identifiers an analysis answer handed
 * back and every one of them dead-ended, because the aggregate published a
 * publisher registration identifier and the detail capability only accepts a
 * canonical procurement id.
 *
 * This is the production reproduction as a test: take the identifiers out of an
 * analysis response and put every one of them through the detail capability.
 * Each must either resolve to a real record or be reported by the analysis
 * response itself as not individually retrievable, with a reason.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSharedProcurementReadModel } from "../../site/shared_procurement_read_model.mjs";
import { executeContractGet } from "../../capabilities/contracts.mjs";
import { executeContractsAnalysis } from "../../capabilities/contracts_analysis.mjs";
import {
  handleContractsAnalysis,
  workerContractsAnalysis,
  workerProcurementContracts,
} from "../src/contracts.mjs";
import { buildSharedProcurementReadModelShardArtifacts } from "../../site/procurement_read_model_shards.mjs";

function sourceRecord(sourceSystem, sourceSystemId, snapshot) {
  return {
    source_system: sourceSystem,
    source_system_id: sourceSystemId,
    content_hash: `${sourceSystemId}-hash`,
    normalized_snapshot: JSON.stringify(snapshot),
    raw_snapshot: JSON.stringify(snapshot),
    ingested_at: "2026-08-18T19:46:32Z",
  };
}

// Two of the three registered contracts below have been observed as procurement
// detail records. The third is registered in the aggregate and has no detail
// record at all, which is the ordinary state for roughly half the published
// registered-contract population.
const readModel = buildSharedProcurementReadModel({
  sourceRecords: [
    sourceRecord("checkbook_contracts", "contract:registered:CT-DETAIL-ONE", {
      id: "CT-DETAIL-ONE", pin: "84126P0001001", vendor: "Vendor One", agency: "Agency A",
      status: "registered", current: 120000, registered: "2026-07-20",
    }),
    sourceRecord("checkbook_contracts", "contract:registered:CT-DETAIL-TWO", {
      id: "CT-DETAIL-TWO", pin: "84126P0002001", vendor: "Vendor Two", agency: "Agency A",
      status: "registered", current: 240000, registered: "2026-07-21",
    }),
  ],
  generatedAt: "2026-08-18T20:00:00Z",
  now: "2026-08-18T20:01:00Z",
});

const projection = {
  schema: "cityscroll.analytical_projection.v1",
  generated_at: "2026-08-18T20:00:00Z",
  snapshot_date: "2026-08-18",
  population_definition: "Normalized Checkbook NYC registered expense contracts; one row per exact prime_contract_id.",
  source_population: { normalized_unique_contracts: 3, source_tag: "checkbook-contracts" },
  rows: [
    { prime_contract_id: "CT-DETAIL-ONE", agency: "Agency A", prime_vendor: "Vendor One", registration_fiscal_year: 2027, contract_amount_band: "$100,000–$999,999", current_registered_amount: 120000, original_registered_amount: 120000, city_record_match: "exact" },
    { prime_contract_id: "CT-DETAIL-TWO", agency: "Agency A", prime_vendor: "Vendor Two", registration_fiscal_year: 2027, contract_amount_band: "$100,000–$999,999", current_registered_amount: 240000, original_registered_amount: 240000, city_record_match: "none" },
    { prime_contract_id: "CT-NO-DETAIL", agency: "Agency A", prime_vendor: "Vendor Three", registration_fiscal_year: 2027, contract_amount_band: "Under $100,000", current_registered_amount: 60000, original_registered_amount: 60000, city_record_match: "cannot_evaluate_missing_pin" },
  ],
};

const env = { ANALYTICAL_PROJECTION: projection, PROCUREMENT_READ_MODEL: readModel };
const input = { groupBy: "agency", measure: "current", agency: "Agency A", limit: 10 };

/**
 * Follow every identifier the analysis answer publishes, exactly as a machine
 * client would: fetch the ones it says are retrievable and check that the ones
 * it declines to publish an id for are reported as not retrievable.
 */
async function followEveryIdentifier(result, contractEnv) {
  const detail = result.contract_detail;
  assert.ok(detail.not_retrievable_reason, "the answer must say why an id is missing");
  const followed = [];
  for (const group of result.groups) {
    for (const { id: primeContractId, procurement_id: procurementId } of group.contract_sample) {
      if (procurementId === null) {
        followed.push({ primeContractId, retrievable: false });
        continue;
      }
      const fetched = await executeContractGet(
        workerProcurementContracts(contractEnv).get,
        { procurementId },
      );
      assert.equal(
        fetched.availability,
        "available",
        `${primeContractId} was published as ${procurementId} but did not resolve`,
      );
      assert.equal(fetched.contract.procurement_id, procurementId);
      followed.push({ primeContractId, retrievable: true, procurementId });
    }
  }
  return followed;
}

test("every identifier the analysis answer publishes resolves or is reported unretrievable", async () => {
  const result = await executeContractsAnalysis(workerContractsAnalysis(env), input);
  assert.equal(result.availability, "complete");
  const followed = await followEveryIdentifier(result, env);
  assert.deepEqual(followed, [
    { primeContractId: "CT-DETAIL-ONE", retrievable: true, procurementId: "procurement:contract:CTDETAILONE" },
    { primeContractId: "CT-DETAIL-TWO", retrievable: true, procurementId: "procurement:contract:CTDETAILTWO" },
    { primeContractId: "CT-NO-DETAIL", retrievable: false },
  ]);
  assert.equal(result.contract_detail.retrievable_contract_count, 2);
  assert.equal(result.contract_detail.not_retrievable_contract_count, 1);
  assert.equal(result.contract_detail.capability, "contract.get@1");
  assert.equal(result.contract_detail.read_model_generated_at, readModel.generated_at);
});

test("a registration identifier is never presented as a canonical procurement id", async () => {
  const result = await executeContractsAnalysis(workerContractsAnalysis(env), input);
  for (const group of result.groups) {
    for (const { id: primeContractId } of group.contract_sample) {
      assert.doesNotMatch(primeContractId, /^procurement:/);
    }
  }
  // The identifier a reader would build by prefixing a registration id is not
  // a canonical id and must stay unresolvable rather than be guessed open.
  const guessed = await executeContractGet(workerProcurementContracts(env).get, {
    procurementId: "procurement:CT-DETAIL-ONE",
  });
  assert.equal(guessed.availability, "not_yet_public");
  assert.equal(guessed.contract, null);
  assert.match(result.contract_detail.identifier_note, /contract_sample/);
});

test("the published identity index resolves the same contracts as the read model rows", async () => {
  const { manifest } = buildSharedProcurementReadModelShardArtifacts(readModel);
  const rowsResult = await executeContractsAnalysis(workerContractsAnalysis(env), input);
  const indexResult = await executeContractsAnalysis(
    workerContractsAnalysis({ ANALYTICAL_PROJECTION: projection, PROCUREMENT_READ_MODEL: manifest }),
    input,
  );
  assert.equal(rowsResult.contract_detail.resolution, "identity_keys");
  assert.equal(indexResult.contract_detail.resolution, "published_identity_index");
  assert.deepEqual(
    indexResult.groups.map((group) => group.contract_sample.map((item) => item.procurement_id)),
    rowsResult.groups.map((group) => group.contract_sample.map((item) => item.procurement_id)),
  );
});

test("an aggregate that cannot see the detail read model claims no retrievable contract", async () => {
  const result = await executeContractsAnalysis(
    workerContractsAnalysis({ ANALYTICAL_PROJECTION: projection }),
    input,
  );
  assert.equal(result.contract_detail.resolution, "not_resolved");
  assert.equal(result.contract_detail.retrievable_contract_count, 0);
  assert.equal(result.contract_detail.not_retrievable_contract_count, 3);
  for (const group of result.groups) assert.ok(group.contract_sample.every((item) => item.procurement_id === null && item.href === null));
});

test("the HTTP analysis answer carries the same resolved identifiers", async () => {
  const response = await handleContractsAnalysis(
    new Request("https://api.cityscroll.org/contracts/analysis?group_by=agency&agency=Agency%20A&limit=10"),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.groups[0].contract_sample.map((item) => item.procurement_id), [
    "procurement:contract:CTDETAILONE",
    "procurement:contract:CTDETAILTWO",
    null,
  ]);
  await followEveryIdentifier(body, env);
});
