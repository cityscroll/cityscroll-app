import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildPublicSourceHealthProjection,
  publicSourceHealthProjectionLeaks,
  validatePublicSourceHealthProjection,
} from "../site/source_health_public_projection.mjs";
import {
  SOURCE_VINTAGE_FINDING_SCHEMA,
  backstageSourceVintage,
  collectSourceVintageFindings,
  findingsFromVintageClassifications,
  publicSourceVintage,
  sourceVintageFindingIntent,
  sourceVintageFindingKey,
  unknownPublicSourceVintage,
} from "../site/source_vintage_public_projection.mjs";
import {
  classifySourceVintage,
  loadSourceVintageStatusInputs,
} from "../tools/source_vintage_status.mjs";
import { generateSourceVintageObservations } from "../tools/build_source_vintage_observations.mjs";
import { loadSourceVintageAlternates } from "../tools/source_vintage_alternates.mjs";
import { loadSourceContracts } from "../tools/source_contracts.mjs";
import { buildDataHealthView, renderDataHealthDocument } from "../site/data_health_page.mjs";
import { buildDataSourceGraph } from "../tools/data_source_graph.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/source_vintage/ibo-acfr-pair.json", import.meta.url)));
const GENERATED_AT = "2026-08-28T00:00:00.000Z";

function contract(id, overrides = {}) {
  return {
    id,
    name: `Source ${id}`,
    owner: "Public publisher",
    landing_page: `https://example.gov/${id}`,
    publisher_cadence: "Daily",
    used_for: "Public records",
    freshness_contract: { mode: "continuous", max_stale_days: 7 },
    health_policy: { public_visibility: "public" },
    ...overrides,
  };
}

function observation(id) {
  return {
    source_id: id,
    health: {
      status: "Healthy",
      reason_codes: [],
      clocks: {
        publisher_updated: { at: "2026-08-18T09:00:00.000Z", state: "KNOWN", basis: "warehouse_source_summary" },
        cityscroll_checked_acquired: { at: "2026-08-18T10:00:00.000Z", state: "KNOWN", basis: "acquired_at" },
        cityscroll_serving: { at: "2026-08-18T11:00:00.000Z", state: "KNOWN", basis: "cityscroll_materialization" },
      },
    },
    relationship_coverage: {
      status: "complete",
      join_status: "accepted",
      measured_at: "2026-08-18T08:00:00.000Z",
      reason_codes: [],
    },
  };
}

function iboClassification() {
  const contracts = loadSourceContracts();
  const inputs = loadSourceVintageStatusInputs(ROOT, { asOf: GENERATED_AT });
  const ibo = generateSourceVintageObservations().observations.find((row) => row.source_id === "ibo-fiscal-history");
  const alternate = loadSourceVintageAlternates().alternates[0];
  const classification = classifySourceVintage({
    contract: contracts.contracts.find((row) => row.id === "ibo-fiscal-history"),
    source: ibo,
    healthObservation: { health: { status: "Healthy", reason_codes: [] } },
    alternateRegistry: loadSourceVintageAlternates(),
    asOf: GENERATED_AT,
  });
  return { ibo, alternate, classification };
}

test("IBO public vintage keeps FY2022 coverage beside a FY2025 ACFR pointer", () => {
  const { ibo, alternate, classification } = iboClassification();
  assert.equal(classification.status, "source-vintage-stale");
  assert.equal(classification.ingestion_stale, false);
  const vintage = publicSourceVintage({ observation: ibo, classification, alternate });
  assert.equal(vintage.status, "source-vintage-stale");
  assert.equal(vintage.observed_coverage.max_fiscal_year, FIXTURE.observed_coverage.max_fiscal_year);
  assert.equal(vintage.publisher_vintage, "FY2022");
  assert.equal(vintage.retrieved_at, "2026-08-27T17:59:48.000Z");
  assert.equal(vintage.expected_lag_tolerance_days, 550);
  assert.deepEqual(vintage.current_lag, { value: 3, unit: "fiscal_years" });
  assert.equal(vintage.newer_source.url, "https://comptroller.nyc.gov/reports/annual-comprehensive-financial-reports/");
  assert.equal(vintage.newer_source.artifact_url, "https://comptroller.nyc.gov/wp-content/uploads/documents/ACFR-2025-7-28-2026.pdf");
  assert.equal(vintage.newer_source.observed_coverage.max_fiscal_year, 2025);
  assert.equal(vintage.newer_source.relation, "newer-official-context");
  assert.equal(vintage.newer_source.replacement_eligible, false);
  assert.equal("row_count" in vintage.observed_coverage, false);
  assert.equal("receipt_ref" in vintage, false);
  assert.equal("downstream_consumer_ids" in vintage, false);
});

test("missing vintage evidence stays explicit UNKNOWN rather than current", () => {
  const unknown = unknownPublicSourceVintage();
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.observed_coverage.max_fiscal_year, null);
  assert.equal(unknown.publisher_vintage, null);
  assert.equal(unknown.retrieved_at, null);
  assert.equal(unknown.expected_lag_tolerance_days, null);
  assert.equal(unknown.current_lag.value, null);
  assert.equal(unknown.newer_source, null);

  const unclassified = publicSourceVintage({
    observation: { observed_coverage: { max_fiscal_year: null }, cityscroll_retrieval: { status: "unknown" } },
    classification: { status: "unknown", observed_frontier: { kind: null, value: null } },
  });
  assert.equal(unclassified.status, "unknown");
  assert.equal(unclassified.newer_source, null);
});

test("repeated identical stale observations emit one durable finding key", () => {
  const { ibo, alternate, classification } = iboClassification();
  const intent = sourceVintageFindingIntent({
    source_id: classification.source_id,
    alternate_id: classification.alternate_source_id,
    frontier: classification.alternates[0].frontier,
    evidence: {
      observed_coverage: ibo.observed_coverage,
      publisher_vintage: ibo.publisher_vintage,
      retrieved_at: ibo.cityscroll_retrieval.retrieved_at,
      alternate_url: alternate.url,
      evidence_at: alternate.evidence_at,
    },
  });
  assert.equal(intent.schema, SOURCE_VINTAGE_FINDING_SCHEMA);
  assert.equal(intent.diagnosis, "source-vintage-stale");
  assert.equal(
    intent.finding_key,
    sourceVintageFindingKey({
      source_id: "ibo-fiscal-history",
      alternate_id: "comptroller-acfr",
      frontier: { kind: "fiscal_year", value: 2025 },
    }),
  );
  const once = collectSourceVintageFindings([intent, structuredClone(intent), intent]);
  assert.equal(once.length, 1);
  assert.equal(once[0].card_intent.kind, "source-vintage-stale");
  const fromRows = findingsFromVintageClassifications(
    [classification, classification],
    {
      observationsById: new Map([[ibo.source_id, ibo]]),
      alternatesById: new Map([[alternate.alternate_id, alternate]]),
    },
  );
  assert.equal(fromRows.length, 1);
  assert.equal(fromRows[0].finding_key, intent.finding_key);
});

test("public health projection allowlists vintage beside ingestion clocks", () => {
  const { ibo, alternate, classification } = iboClassification();
  const vintage = publicSourceVintage({ observation: ibo, classification, alternate });
  const projection = buildPublicSourceHealthProjection(
    { contracts: [contract("ibo-fiscal-history", { name: "NYC Independent Budget Office fiscal history" })] },
    { generated_at: GENERATED_AT, observations: [observation("ibo-fiscal-history")] },
    { vintageById: { "ibo-fiscal-history": vintage } },
  );
  assert.deepEqual(Object.keys(projection.sources[0]), [
    "source_id",
    "name",
    "publisher",
    "official_url",
    "expected_cadence",
    "mode",
    "health",
    "relationship_coverage",
    "source_vintage",
  ]);
  assert.equal(projection.sources[0].health.status, "Healthy");
  assert.equal(projection.sources[0].source_vintage.status, "source-vintage-stale");
  assert.notEqual(projection.sources[0].health.status, projection.sources[0].source_vintage.status);
  assert.deepEqual(validatePublicSourceHealthProjection(projection, {
    contracts: [contract("ibo-fiscal-history")],
  }), []);
  assert.deepEqual(publicSourceHealthProjectionLeaks(projection), []);
  const text = JSON.stringify(projection);
  assert.doesNotMatch(text, /receipt_ref|warehouse\/sources|agency-fiscal-context|row_count|26101/);
  assert.doesNotMatch(text, /CURRENT|MISSING|facts generated/);
});

test("backstage vintage retains receipts and consumers without replacing IBO series scope", () => {
  const { ibo, alternate, classification } = iboClassification();
  const findings = findingsFromVintageClassifications(
    [classification, classification],
    {
      observationsById: new Map([[ibo.source_id, ibo]]),
      alternatesById: new Map([[alternate.alternate_id, alternate]]),
    },
  );
  const backstage = backstageSourceVintage({
    observation: ibo,
    classification,
    alternate,
    findings,
  });
  assert.equal(backstage.status, "source-vintage-stale");
  assert.equal(backstage.ingestion_stale, false);
  assert.equal(backstage.observed_coverage.row_count, 26101);
  assert.match(backstage.retrieval.receipt_ref, /warehouse\/sources\/ibo-fiscal-history/);
  assert.deepEqual(backstage.downstream_consumer_ids, ["agency-fiscal-context"]);
  assert.equal(backstage.newer_alternates[0].replacement_eligible, false);
  assert.match(backstage.newer_alternates[0].replacement_warning, /not a drop-in replacement/i);
  assert.equal(backstage.findings.length, 1);

  const desk = buildDataSourceGraph({
    registry: {
      contracts: [contract("ibo-fiscal-history", {
        name: "NYC Independent Budget Office fiscal history",
        status: "build-time",
        delivery_tier: "inline-at-build",
        code_references: [{ path: "site/agency_fiscal_context.mjs", contains: "ibo-fiscal-history" }],
      })],
    },
    healthObservations: { generated_at: GENERATED_AT, observations: [observation("ibo-fiscal-history")] },
    vintageObservations: { observations: [ibo] },
    alternateRegistry: { alternates: [alternate] },
  });
  const deskRow = desk.sources.find((row) => row.id === "ibo-fiscal-history");
  assert.equal(deskRow.source_vintage.status, "source-vintage-stale");
  assert.ok(deskRow.source_vintage.retrieval.receipt_ref);
  assert.equal(deskRow.source_vintage.findings.length, 1);
});

test("Data health HTML keeps vintage labels off the ingestion clocks", () => {
  const { ibo, alternate, classification } = iboClassification();
  const vintage = publicSourceVintage({ observation: ibo, classification, alternate });
  const projection = buildPublicSourceHealthProjection(
    { contracts: [contract("ibo-fiscal-history", {
      name: "NYC Independent Budget Office fiscal history",
      owner: "New York City Independent Budget Office",
    })] },
    { generated_at: GENERATED_AT, observations: [observation("ibo-fiscal-history")] },
    { vintageById: { "ibo-fiscal-history": vintage } },
  );
  const html = renderDataHealthDocument(buildDataHealthView(projection));
  assert.match(html, /NYC Independent Budget Office fiscal history/);
  assert.match(html, /Observed through FY2022/);
  assert.match(html, /Publisher vintage/);
  assert.match(html, /FY2022/);
  assert.match(html, /August 27, 2026/);
  assert.match(html, /source-vintage-stale/);
  assert.match(html, /https:\/\/comptroller\.nyc\.gov\/reports\/annual-comprehensive-financial-reports\//);
  assert.match(html, /FY2025/);
  assert.match(html, /Publisher updated/);
  assert.match(html, /CityScroll last checked/);
  assert.ok(html.indexOf("data-health-condition") < html.indexOf("data-health-vintage"));
  assert.doesNotMatch(html, /26101|receipt_ref|agency-fiscal-context|CURRENT|MISSING/);
});
