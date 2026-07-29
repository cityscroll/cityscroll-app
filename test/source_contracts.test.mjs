import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AWARD_SOURCE_REGISTRY } from "../external_awards.js";
import { checkGeneratedSourceFiles } from "../tools/generate_source_docs.mjs";
import {
  awardCoverage,
  classifyMocsFieldCase,
  loadSourceContractFixtures,
  loadSourceContracts,
  validateSourceContractFixtures,
  validateSourceContracts,
  verifyCodeReferences,
} from "../tools/source_contracts.mjs";
import { verifySocrata } from "../tools/verify_source_contracts.mjs";

test("source-contract registry is valid and its generated public docs are current", () => {
  const registry = loadSourceContracts();
  assert.deepEqual(validateSourceContracts(registry), []);
  assert.deepEqual(validateSourceContractFixtures(registry, loadSourceContractFixtures()), []);
  assert.deepEqual(verifyCodeReferences(registry), []);
  assert.deepEqual(checkGeneratedSourceFiles(), []);
});

test("recorded fixtures reject missing fields and non-tabular source shapes", () => {
  const registry = loadSourceContracts();
  const missingField = structuredClone(loadSourceContractFixtures());
  missingField.sources.find((source) => source.id === "city-record").fields = [];
  assert.match(
    validateSourceContractFixtures(registry, missingField).join("\n"),
    /city-record: fixture is missing fields/,
  );

  const nonTabular = structuredClone(loadSourceContractFixtures());
  nonTabular.sources.find((source) => source.id === "city-record").asset_type = "href";
  assert.match(
    validateSourceContractFixtures(registry, nonTabular).join("\n"),
    /city-record: fixture is not tabular Socrata metadata/,
  );
});

test("pull-request CI requires fixtures while live drift runs on a daily alerting lane", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const live = readFileSync(
    new URL("../.github/workflows/source-contracts-live.yml", import.meta.url),
    "utf8",
  );
  assert.match(ci, /name: Recorded civic-data source contracts[\s\S]*node tools\/verify_source_contracts\.mjs/);
  assert.doesNotMatch(ci, /verify_source_contracts\.mjs --live/);
  assert.match(live, /schedule:[\s\S]*cron:/);
  assert.match(live, /node tools\/verify_source_contracts\.mjs --live/);
  assert.match(live, /issues: write/);
  assert.match(live, /Report upstream drift[\s\S]*issues\.create/);
});

test("ABO source contracts match the runtime registry and derive coverage prose", () => {
  const registry = loadSourceContracts();
  const coverage = awardCoverage(AWARD_SOURCE_REGISTRY);
  const contractDatasets = registry.contracts
    .filter((contract) => contract.id.startsWith("abo-"))
    .map((contract) => contract.dataset_id)
    .sort();
  assert.deepEqual(contractDatasets, coverage.datasets);
  assert.deepEqual(coverage, {
    aliases: 13,
    authorities: 12,
    sourcePairs: 12,
    nycha: 1,
    absent: 16,
    datasets: ["8w5p-k45m", "d84c-dk28", "ehig-g5x3"],
  });
});

test("MOCS field-case fixture classifies both retired IDs as unusable", () => {
  const fixture = JSON.parse(readFileSync(
    new URL("./fixtures/source_contracts/mocs-field-case.json", import.meta.url),
  ));
  assert.deepEqual(classifyMocsFieldCase(
    fixture.configured.metadata,
    fixture.configured.resource,
    fixture.documented.resource,
  ), {
    configuredNonTabular: true,
    documentedMissing: true,
  });
});

test("live Socrata verification rejects non-tabular and stale sources", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const contract = {
    id: "field-case",
    domain: "https://data.example.gov",
    dataset_id: "aaaa-bbbb",
    required_fields: ["record_id"],
    max_stale_days: 7,
  };

  globalThis.fetch = async () => new Response(JSON.stringify({
    assetType: "href",
    columns: [],
    rowsUpdatedAt: Math.floor(Date.now() / 1000),
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  await assert.rejects(verifySocrata(contract), /expected a tabular dataset/);

  globalThis.fetch = async () => new Response(JSON.stringify({
    assetType: "dataset",
    columns: [{ fieldName: "record_id" }],
    rowsUpdatedAt: 1,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  await assert.rejects(verifySocrata(contract), /source is stale/);
});
