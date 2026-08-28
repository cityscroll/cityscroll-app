import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildSourceVintageStatusProjection,
  classifySourceVintage,
  validateSourceVintageStatusProjection,
} from "../tools/source_vintage_status.mjs";
import { generateSourceVintageObservations } from "../tools/build_source_vintage_observations.mjs";
import { loadSourceContracts } from "../tools/source_contracts.mjs";

const ALTERNATE = {
  alternate_id: "comptroller-acfr",
  publisher: "New York City Comptroller",
  url: "https://comptroller.nyc.gov/reports/annual-comprehensive-financial-reports/",
  artifact_url: "https://comptroller.nyc.gov/wp-content/uploads/2025/11/ACFR-2025.pdf",
  relation: "newer-official-context",
  semantic_scope: "official citywide financial statements; contextual to IBO staffing and expenditure history",
  replacement_warning: "not a drop-in replacement for IBO staffing semantics",
  observed_coverage: { max_fiscal_year: 2025, basis: "official ACFR FY2025 publication" },
  evidence_at: "2026-08-20T00:00:00Z",
  verification_status: "verified",
};

function source(overrides = {}) {
  return {
    source_id: "fixture-source",
    alternate_source_ids: ["newer-source"],
    observed_coverage: { max_fiscal_year: 2022, basis: "fixture" },
    cityscroll_retrieval: {
      status: "succeeded",
      retrieved_at: "2026-08-20T00:00:00Z",
    },
    expected_lag_tolerance_days: 30,
    ...overrides,
  };
}

const contract = {
  id: "fixture-source",
  alternate_source_ids: ["newer-source"],
  freshness_contract: { max_stale_days: 30 },
};

test("IBO FY2022 is semantically stale while ingestion remains healthy", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/source_vintage/ibo-acfr-pair.json", import.meta.url)));
  const ibo = generateSourceVintageObservations().observations.find((row) => row.source_id === fixture.source_id);
  const result = classifySourceVintage({
    contract: { id: fixture.source_id, alternate_source_ids: [fixture.alternate_source_id] },
    source: {
      ...ibo,
      alternate_source_ids: [fixture.alternate_source_id],
    },
    healthObservation: {
      health: { status: "Healthy", reason_codes: [] },
    },
    alternateRegistry: [ALTERNATE],
    asOf: "2026-08-28T00:00:00Z",
  });
  assert.equal(result.status, "source-vintage-stale");
  assert.equal(result.ingestion_stale, false);
  assert.equal(result.ingestion_status, "Healthy");
  assert.deepEqual(result.newer_alternate_source_ids, ["comptroller-acfr"]);
  assert.deepEqual(result.replacement_source_ids, []);
  assert.equal(result.observed_frontier.value, fixture.observed_coverage.max_fiscal_year);
});

test("table-driven precedence and unknown-frontier cases are fail-closed", () => {
  const cases = [
    ["current", source({ alternate_source_ids: [] }), []],
    ["ingestion-stale", source({ cityscroll_retrieval: { status: "failed", retrieved_at: null } }), [ALTERNATE]],
    ["source-vintage-stale", source(), [{ ...ALTERNATE, alternate_id: "newer-source" }]],
    ["unknown", source({ observed_coverage: { max_fiscal_year: null }, alternate_source_ids: [] }), []],
    ["unknown", source({ observed_coverage: { max_fiscal_year: null } }), [{ ...ALTERNATE, alternate_id: "newer-source" }]],
  ];
  for (const [expected, observed, alternates] of cases) {
    const result = classifySourceVintage({
      contract,
      source: observed,
      alternateRegistry: alternates,
      asOf: "2026-08-28T00:00:00Z",
    });
    assert.equal(result.status, expected);
  }
});

test("cadence breach wins before a newer alternate and serving degradation does not rewrite ingestion", () => {
  const result = classifySourceVintage({
    contract,
    source: source({ cityscroll_retrieval: { status: "succeeded", retrieved_at: "2026-01-01T00:00:00Z" } }),
    healthObservation: {
      health: { status: "Degraded", reason_codes: ["serving-clock-stale"] },
    },
    alternateRegistry: [{ ...ALTERNATE, alternate_id: "newer-source" }],
    asOf: "2026-08-28T00:00:00Z",
  });
  assert.equal(result.status, "ingestion-stale");
  assert.equal(result.ingestion_stale, true);

  const servingOnly = classifySourceVintage({
    contract,
    source: source(),
    healthObservation: { health: { status: "Degraded", reason_codes: ["serving-clock-stale"] } },
    alternateRegistry: [{ ...ALTERNATE, alternate_id: "newer-source" }],
  });
  assert.equal(servingOnly.status, "source-vintage-stale");
  assert.equal(servingOnly.ingestion_stale, false);
});

test("incomparable, unverified, and unowned alternates cannot produce a stale diagnosis", () => {
  const result = classifySourceVintage({
    contract,
    source: source(),
    alternateRegistry: [
      { ...ALTERNATE, alternate_id: "newer-source", relation: "unrelated", verification_status: "verified" },
      { ...ALTERNATE, alternate_id: "newer-source", verification_status: "unverified" },
      { ...ALTERNATE, alternate_id: "orphan", verification_status: "verified" },
    ],
  });
  assert.equal(result.status, "current");
  assert.deepEqual(result.newer_alternate_source_ids, []);
});

test("projection keeps one status for each canonical source", () => {
  const registry = { contracts: [contract] };
  const projection = buildSourceVintageStatusProjection({
    registry,
    vintageObservations: { generated_at: "2026-08-28T00:00:00Z", observations: [source()] },
    alternateRegistry: [{ ...ALTERNATE, alternate_id: "newer-source" }],
    asOf: "2026-08-28T00:00:00Z",
  });
  assert.deepEqual(validateSourceVintageStatusProjection(registry, projection), []);
  assert.equal(projection.observations[0].status, "source-vintage-stale");
});
