import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildSourceVintageObservations,
  loadSourceVintageInputs,
  validateSourceVintageProjection,
} from "../tools/source_vintage_observations.mjs";
import {
  checkSourceVintageObservations,
  generateSourceVintageObservations,
} from "../tools/build_source_vintage_observations.mjs";
import { loadSourceContracts, validateSourceContracts } from "../tools/source_contracts.mjs";

const ROOT = new URL("../", import.meta.url).pathname;

test("source-vintage projection is versioned, canonical, and preserves unknowns", () => {
  const registry = loadSourceContracts();
  assert.deepEqual(validateSourceContracts(registry), []);
  const pagesConfig = readFileSync(new URL("../site/_config.yml", import.meta.url), "utf8");
  assert.match(pagesConfig, /data\/source_vintage_observations\.json/);
  const projection = buildSourceVintageObservations(registry, {
    asOf: "2026-08-20T00:00:00Z",
    healthObservations: {
      generated_at: "2026-08-20T00:00:00Z",
      observations: [],
    },
    root: ROOT,
  });
  assert.equal(projection.schema, "cityscroll.source_vintage_observations.v1");
  assert.equal(projection.contract_count, registry.contracts.length);
  assert.equal(projection.observations.length, registry.contracts.length);
  const unknown = projection.observations.find((row) => row.source_id === "city-record");
  assert.deepEqual(unknown.observed_coverage, {
    max_fiscal_year: null,
    max_date: null,
    fiscal_year_count: null,
    row_count: null,
    basis: null,
  });
  assert.equal(unknown.publisher_vintage, null);
  assert.equal(unknown.cityscroll_retrieval.status, "unknown");
  assert.equal(unknown.current_lag.value, null);
  assert.deepEqual(validateSourceVintageProjection(registry, projection), []);
});

test("IBO source family records measured FY2022 coverage and both component artifact IDs", () => {
  const projection = generateSourceVintageObservations();
  const row = projection.observations.find((entry) => entry.source_id === "ibo-fiscal-history");
  assert.ok(row);
  assert.deepEqual(row.source_family, {
    id: "ibo-fiscal-history",
    component_artifact_ids: ["ibo_agency_expenditures", "ibo_full_time_positions"],
  });
  assert.deepEqual(row.observed_coverage, {
    max_fiscal_year: 2022,
    max_date: null,
    fiscal_year_count: 43,
    row_count: 26101,
    basis: "ibo_fiscal_history_receipt.coverage.fiscal_years",
  });
  assert.equal(row.publisher_vintage, "FY2022");
  assert.equal(row.cityscroll_retrieval.status, "succeeded");
  assert.equal(row.cityscroll_retrieval.retrieved_at, "2026-08-27T17:59:48.000Z");
  assert.equal(row.cityscroll_retrieval.receipt_schema, "cityscroll.ibo_fiscal_history_receipt.v1");
  assert.deepEqual(row.downstream_consumer_ids, ["agency-fiscal-context"]);
  assert.deepEqual(row.alternate_source_ids, ["comptroller-acfr"]);
  assert.equal(row.current_lag.value, null, "SV-0 records lag without classifying it");
});

test("the proving fixture pairs IBO FY2022 with official-context FY2025 without an alternate registry", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/source_vintage/ibo-acfr-pair.json", import.meta.url)));
  const registry = loadSourceContracts();
  const row = generateSourceVintageObservations().observations.find((entry) => entry.source_id === fixture.source_id);
  assert.equal(row.observed_coverage.max_fiscal_year, fixture.observed_coverage.max_fiscal_year);
  assert.equal(row.observed_coverage.fiscal_year_count, fixture.observed_coverage.fiscal_year_count);
  assert.equal(row.observed_coverage.row_count, fixture.observed_coverage.row_count);
  assert.equal(row.publisher_vintage, fixture.publisher_vintage);
  assert.deepEqual(row.alternate_source_ids, [fixture.alternate_source_id]);
  assert.equal(fixture.alternate_observed_coverage.max_fiscal_year, 2025);
  assert.equal(registry.contracts.some((contract) => contract.id === fixture.alternate_source_id), false);
});

test("source-health retrieval is copied by canonical source_id and remains separate", () => {
  const registry = { contracts: [{
    id: "fixture-source",
    publisher_cadence: "Daily",
    freshness_contract: { max_stale_days: 7 },
    downstream_consumer_ids: ["fixture-consumer"],
    alternate_source_ids: [],
  }] };
  const projection = buildSourceVintageObservations(registry, {
    asOf: "2026-08-20T00:00:00Z",
    healthObservations: {
      observations: [{
        source_id: "fixture-source",
        operator: {
          acquisition_receipts: [{
            schema: "cityscroll.source_acquisition_receipt.v1",
            source_contract_id: "fixture-source",
            observed_at: "2026-08-19T12:00:00Z",
            status: "succeeded",
            run_id: "fixture-run",
            publisher_clock_basis: "publisher_record",
            publisher_updated_at: "2026-08-18T00:00:00Z",
          }],
        },
      }],
    },
  });
  const row = projection.observations[0];
  assert.equal(row.cityscroll_retrieval.retrieved_at, "2026-08-19T12:00:00.000Z");
  assert.equal(row.cityscroll_retrieval.status, "succeeded");
  assert.equal(row.publisher_last_updated_at, "2026-08-18T00:00:00.000Z");
  assert.equal(row.observed_coverage.max_fiscal_year, null);
});

test("the IBO retrieval receipt also remains visible on the source-health clock", () => {
  const health = JSON.parse(readFileSync(new URL("../site/data/source_health_observations.json", import.meta.url)));
  const row = health.observations.find((entry) => entry.source_id === "ibo-fiscal-history");
  assert.equal(row.operator.acquisition_receipts[0].status, "succeeded");
  assert.equal(row.operator.acquisition_receipts[0].source_contract_id, "ibo-fiscal-history");
  assert.equal(row.operator.clocks.acquired.at, "2026-08-27T17:59:48.000Z");
});

test("committed source-vintage artifact is reproducible", () => {
  assert.deepEqual(checkSourceVintageObservations(), []);
});
