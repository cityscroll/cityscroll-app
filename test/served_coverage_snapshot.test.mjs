// Served-product coverage snapshot: the census behind the public Stats page.
//
//   node --test test/served_coverage_snapshot.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CENSUS_SCHEMA,
  DISPOSITIONS,
  REVIEWED_REGISTRY_SIZE,
  SNAPSHOT_SCHEMA,
  buildServedCoverage,
  censusProcurementSources,
  resolveVintage,
} from "../tools/build_served_coverage_snapshot.mjs";
import { readProcurementBrowsePopulation } from "../tools/lib/procurement_browse_population_io.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const snapshot = readJson("site/data/served_coverage_snapshot.json");
const census = readJson("docs/evidence/served-coverage/census.json");
const registry = readJson("site/data/source_contracts.json");
const units = snapshot.domains.flatMap((domain) => domain.units);
const unitById = new Map(units.map((unit) => [unit.unit_id, unit]));

test("the committed artifacts are what the builder produces from committed evidence", () => {
  const rebuilt = buildServedCoverage({ root: ROOT, previousSnapshot: snapshot });
  assert.deepEqual(rebuilt.snapshot, snapshot);
  assert.deepEqual(rebuilt.census, census);
  assert.equal(snapshot.schema, SNAPSHOT_SCHEMA);
  assert.equal(census.schema, CENSUS_SCHEMA);
});

// ---- A1: every registered contract is accounted for, and inventory is not coverage ----

test("the census gives every registered source contract a disposition with a reason", () => {
  assert.equal(registry.contracts.length, REVIEWED_REGISTRY_SIZE);
  assert.equal(census.registry.observed_registry_size, registry.contracts.length);
  assert.equal(census.registry.changed, false);

  const censused = census.sources.map((row) => row.source_id).sort();
  assert.deepEqual(censused, registry.contracts.map((contract) => contract.id).sort());
  for (const row of census.sources) {
    assert.ok(DISPOSITIONS.includes(row.disposition), `${row.source_id} has an unknown disposition`);
    assert.ok(row.reason && row.reason.length > 20, `${row.source_id} needs a stated reason`);
    assert.ok(row.evidence && Object.keys(row.evidence).length, `${row.source_id} needs evidence`);
  }
  assert.equal(
    Object.values(census.disposition_counts).reduce((total, count) => total + count, 0),
    registry.contracts.length,
  );
});

test("a registry whose size has moved reports the drift instead of absorbing it", () => {
  const { root, units: fixtureUnits, cleanup } = demoFixture();
  try {
    const report = buildServedCoverage({ root, units: fixtureUnits }).census;
    assert.equal(report.registry.reviewed_registry_size, REVIEWED_REGISTRY_SIZE);
    assert.equal(report.registry.observed_registry_size, 1);
    assert.equal(report.registry.changed, true);
  } finally {
    cleanup();
  }
});

test("a contract with neither a derived nor a reviewed disposition stops the census", () => {
  const { root, cleanup } = demoFixture();
  try {
    assert.throws(
      () => buildServedCoverage({ root, units: [] }),
      /demo-source has no derived or declared disposition/,
    );
  } finally {
    cleanup();
  }
});

test("the published source count is measured coverage, not the size of the registry", () => {
  const sources = snapshot.metrics.find((metric) => metric.metric_id === "served_sources_represented");
  assert.equal(sources.state, "measured");
  assert.equal(sources.value, census.sources_represented.length);
  assert.ok(sources.value > 0 && sources.value < registry.contracts.length);
  const represented = census.sources.filter((row) => row.disposition === "publicly_represented");
  assert.deepEqual(census.sources_represented, represented.map((row) => row.source_id).sort());
});

// ---- A2: the three named sources, independently reproduced ----

test("registered contracts reproduce independently from the shard the Contracts page serves", () => {
  const projection = readJson("site/data/analytics_registered_contracts.json");
  const rows = projection.shards.flatMap((shard) => readJson(`site/data/${shard.path}`).rows);
  const identities = new Set(rows.map((row) => row.prime_contract_id));
  assert.equal(identities.size, rows.length, "one row per exact prime_contract_id");
  assert.equal(projection.source_population.source_tag, "checkbook-contracts");

  const unit = unitById.get("registered-contracts");
  assert.equal(unit.value, identities.size);
  assert.equal(unit.source_id, "checkbook-contracts");
  assert.equal(unit.route, "/browse/contracts/");
  assert.equal(unit.evidence_vintage, "2026-08-18T00:00:00.000Z");
});

test("procurement source counts are recounted from served rows, not from declared inputs", () => {
  const population = readProcurementBrowsePopulation(join(ROOT, "site/data/procurement_browse_rows.json"));
  const recounted = censusProcurementSources(population);
  assert.deepEqual(recounted, census.procurement_source_census);

  const cityRecord = recounted.find((entry) => entry.source_system === "city_record");
  // The declared coverage block counts input rows. The served figure counts the rows a reader
  // can actually retrieve, and the two are not the same number.
  assert.ok(cityRecord.served_observations > 0);
  assert.notEqual(cityRecord.served_observations, cityRecord.declared_input_rows);

  const checkbook = recounted.find((entry) => entry.source_system === "checkbook_contracts");
  assert.equal(checkbook.source_contract_id, "checkbook-contracts");
  assert.ok(checkbook.served_observations > 0);
  assert.match(checkbook.specimen.source_observation_ref, /^checkbook_contracts:/);
  assert.match(checkbook.specimen.canonical_route, /^\/procurements\//);
});

test("a served source system with no registered contract is reported, never dropped", () => {
  const unregistered = census.procurement_source_census.filter((entry) => !entry.registered);
  for (const entry of unregistered) {
    assert.equal(entry.source_contract_id, null);
    assert.ok(entry.served_observations >= 0);
  }
});

test("Legistar reaches the page as two separately labelled record units", () => {
  const legistar = units.filter((unit) => unit.source_id === "nyc-council-legistar");
  assert.equal(legistar.length, 2);
  const byUnit = new Map(legistar.map((unit) => [unit.unit_id, unit]));
  assert.equal(byUnit.get("committee-memberships").record_unit_key, "coverage_record_membership");
  assert.equal(byUnit.get("meeting-outcomes").record_unit_key, "coverage_record_meeting_outcome");
  assert.notEqual(byUnit.get("committee-memberships").record_unit_key, byUnit.get("meeting-outcomes").record_unit_key);
});

// ---- A3: identity and grain ----

test("a repeated record counts once under the consumer's own identity", () => {
  const population = readProcurementBrowsePopulation(join(ROOT, "site/data/procurement_browse_rows.json"));
  const rawReferences = population.rows.flatMap((row) => row.source_observation_refs || [])
    .filter((reference) => String(reference).startsWith("city_record:")).length;
  const rowsCarryingCityRecord = population.rows
    .filter((row) => (row.source_observation_refs || []).some((reference) => String(reference).startsWith("city_record:"))).length;
  assert.ok(rawReferences > rowsCarryingCityRecord, "the specimen needs rows with repeated observations");

  const counted = census.procurement_source_census.find((entry) => entry.source_system === "city_record");
  assert.equal(counted.served_observations, rowsCarryingCityRecord);
});

test("the committee graph counts membership records, not its doubled display edges", () => {
  const graph = readJson("site/data/committee_graph_lookup.json");
  assert.equal(graph.public_graph.edges.length, graph.public_edges.length * 2);
  assert.equal(unitById.get("committee-memberships").value, graph.public_edges.length);
});

test("meeting outcomes count matched evidence, not the notices that had none", () => {
  const outcomes = readJson("site/data/meeting_outcomes_snapshot.json");
  const unit = unitById.get("meeting-outcomes");
  assert.equal(unit.counting_rule_key, "coverage_rule_present_only");
  assert.equal(unit.value, outcomes.present_count);
  assert.equal(unit.records_considered, outcomes.record_count);
  assert.ok(outcomes.absent_count > 0, "the discriminator needs explicit absence records");
  assert.notEqual(unit.value, outcomes.record_count);
});

test("solicitations are not folded into registered contracts because their text resembles them", () => {
  const rfx = census.sources.find((row) => row.source_id === "passport-public-rfx");
  const contracts = census.sources.find((row) => row.source_id === "passport-public-contracts");
  assert.equal(contracts.disposition, "publicly_represented");
  // No RFx row entered the served procurement population at this vintage. An observed zero is
  // published as a zero; it never inherits the neighbouring contracts count.
  assert.equal(rfx.disposition, "not_served");
  assert.equal(rfx.evidence.procurement.served_observations, 0);
  const breakdown = unitById.get("procurement-records").sources;
  const rfxRow = breakdown.find((entry) => entry.source_id === "passport-public-rfx");
  assert.equal(rfxRow.state, "observed_zero");
  assert.equal(rfxRow.served_records, 0);
});

test("a two-workbook context source stays one context-only source, never two searchable ones", () => {
  const contract = registry.contracts.find((entry) => entry.id === "ibo-fiscal-history");
  assert.equal(contract.source_family.component_artifact_ids.length, 2);
  const row = census.sources.find((entry) => entry.source_id === "ibo-fiscal-history");
  assert.equal(row.disposition, "context_only");
  assert.equal(census.sources_represented.includes("ibo-fiscal-history"), false);
  assert.equal(units.some((unit) => unit.source_id === "ibo-fiscal-history"), false);
});

test("the contract forbids summing unlike units and every unit names its record type", () => {
  assert.equal(snapshot.measurement.units_are_not_summed, true);
  for (const unit of units) {
    assert.ok(unit.record_unit_key, `${unit.unit_id} must name its record unit`);
    assert.ok(unit.counting_rule_key, `${unit.unit_id} must name its counting rule`);
    assert.ok(unit.route.startsWith("/"), `${unit.unit_id} must link to a served route`);
  }
});

// ---- A4: vintage is evidence, not a clock ----

test("a vintage comes from the artifact's own field and never from a build clock", () => {
  const declaredVintageFields = new Set(
    registry.first_class_artifacts.flatMap((artifact) => artifact.vintage_fields),
  );
  for (const unit of units) {
    if (unit.state !== "measured" && unit.state !== "observed_zero") continue;
    assert.ok(unit.evidence_vintage, `${unit.unit_id} must carry an evidence vintage`);
    assert.ok(declaredVintageFields.has(unit.vintage_field), `${unit.unit_id} read an undeclared vintage field`);
    assert.ok(unit.vintage_field, `${unit.unit_id} must say which field it read`);
    assert.ok(["single", "composite_oldest"].includes(unit.vintage_basis));
  }
});

test("a composite vintage field is bounded by its oldest input, not its newest", () => {
  const composite = resolveVintage(
    { generated_at: "2026-08-05T20:50:48.662Z|2026-09-05T13:44:00.909Z" },
    ["generated_at"],
  );
  assert.equal(composite.at, "2026-08-05T20:50:48.662Z");
  assert.equal(composite.basis, "composite_oldest");
  assert.equal(resolveVintage({ nothing: "here" }, ["missing"]).basis, "unresolved");
});

test("rebuilding with unchanged evidence leaves every vintage unchanged", () => {
  const first = buildServedCoverage({ root: ROOT, previousSnapshot: snapshot });
  const second = buildServedCoverage({ root: ROOT, previousSnapshot: first.snapshot });
  assert.deepEqual(second.snapshot, first.snapshot);
  assert.deepEqual(second.snapshot.evidence_vintage, snapshot.evidence_vintage);
});

test("a failed refresh keeps the last verified count and its real date", () => {
  const { root, units: fixtureUnits, cleanup } = demoFixture();
  try {
    const verified = buildServedCoverage({ root, units: fixtureUnits }).snapshot;
    const verifiedUnit = verified.domains[0].units[0];
    assert.equal(verifiedUnit.state, "measured");
    assert.equal(verifiedUnit.value, 3);
    assert.equal(verifiedUnit.evidence_vintage, "2026-07-01T00:00:00.000Z");

    rmSync(join(root, "site/data/demo.json"));

    const retained = buildServedCoverage({ root, units: fixtureUnits, previousSnapshot: verified }).snapshot;
    const retainedUnit = retained.domains[0].units[0];
    assert.equal(retainedUnit.state, "retained");
    assert.equal(retainedUnit.value, 3, "a failed refresh must not publish zero");
    assert.equal(retainedUnit.evidence_vintage, "2026-07-01T00:00:00.000Z", "and must not look newer");

    const cold = buildServedCoverage({ root, units: fixtureUnits }).snapshot;
    const coldUnit = cold.domains[0].units[0];
    assert.equal(coldUnit.state, "unavailable");
    assert.equal(coldUnit.value, null, "an unmeasured population is unavailable, never zero");
    assert.equal(coldUnit.reason, "artifact_not_committed");
  } finally {
    cleanup();
  }
});

// ---- A5: the page, the API and the snapshot describe one measurement ----

test("the Stats page reads the materialised snapshot and reaches no publisher", () => {
  const page = readFileSync(join(ROOT, "site/stats.html"), "utf8");
  assert.match(page, /fetch\("data\/served_coverage_snapshot\.json"/);
  assert.match(page, new RegExp(`data-coverage-schema="${SNAPSHOT_SCHEMA}"`));
  for (const gone of ["s-notices", "primary_system_count", "city_record", "data.cityofnewyork.us", "api.cityscroll.org/stats\", { signal"]) {
    assert.equal(page.includes(gone), false, `the page must no longer carry ${gone}`);
  }
  const policy = readJson("architecture/resident-read-policy.json");
  assert.ok(policy.browser_entrypoints.includes("site/stats.html"));
});

test("every label the page renders resolves through the translation catalog", async () => {
  const { STRINGS, SHIPPING_LANGS } = await loadCatalog();
  const keys = new Set([
    ...snapshot.measurement.record_unit_keys,
    ...snapshot.measurement.counting_rule_keys,
    "coverage_rule_source_qualified",
    ...snapshot.measurement.state_keys.map((state) => `coverage_state_${state}`),
    ...snapshot.domains.map((domain) => `stats_domain_${domain.domain_id}`),
    "stats_h_coverage",
    "stats_p_coverage",
    "stats_coverage_caption",
    "stats_coverage_unavailable",
    "stats_coverage_dated",
    "stats_evidence_range",
    "stats_col_record_unit",
    "stats_col_records",
    "stats_col_source",
    "stats_col_counting",
    "stats_col_evidence",
    "stats_sources_label",
    "stats_record_sets_label",
    "stats_evidence_label",
  ]);
  for (const key of keys) {
    assert.ok(STRINGS.en[key], `en is missing ${key}`);
    for (const lang of SHIPPING_LANGS) {
      assert.ok(STRINGS[lang]?.[key], `${lang} is missing ${key}`);
    }
  }
});

test("unresolved counts are named one by one and do not silence the counts beside them", () => {
  const unresolved = census.sources.filter((row) => row.disposition === "unresolved");
  for (const row of unresolved) {
    assert.ok(row.reason.length > 20, `${row.source_id} must say why it is unresolved`);
  }
  assert.ok(units.some((unit) => unit.state === "measured"));
  const evidence = new Map(census.served_units.map((entry) => [entry.unit_id, entry]));
  for (const unit of units) {
    const record = evidence.get(unit.unit_id);
    assert.ok(record, `${unit.unit_id} needs a census entry`);
    assert.equal(record.state, unit.state);
    assert.equal(record.value, unit.value);
  }
});

// ---- helpers ----

/** A one-source, one-artifact repository the census can be driven over hermetically. */
function demoFixture() {
  const root = fixtureRoot({
    contracts: {
      schema_version: 1,
      generated_document: {},
      contracts: [{ id: "demo-source", name: "Demo source", status: "live", scope: "runtime" }],
      first_class_artifacts: [{
        id: "demo",
        public_artifact_path: "site/data/demo.json",
        primary_routes: ["/browse/"],
        source_contract_id: "demo-source",
        population_fields: ["rows"],
        vintage_fields: ["generated_at"],
      }],
    },
    files: { "site/data/demo.json": { generated_at: "2026-07-01T00:00:00.000Z", rows: [1, 2, 3] } },
  });
  return {
    root,
    units: [{
      unit_id: "demo-records",
      artifact_id: "demo",
      record_unit_key: "coverage_record_notice",
      counting_rule_key: "coverage_rule_declared",
      route: "/browse/",
    }],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function fixtureRoot({ contracts, files = {} }) {
  const root = mkdtempSync(join(tmpdir(), "served-coverage-"));
  mkdirSync(join(root, "site/data"), { recursive: true });
  writeFileSync(join(root, "site/data/source_contracts.json"), JSON.stringify(contracts), "utf8");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(body), "utf8");
  }
  return root;
}

async function loadCatalog() {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  globalThis.window = globalThis.window || {};
  require(join(ROOT, "site/i18n.js"));
  return { STRINGS: globalThis.window.STRINGS, SHIPPING_LANGS: globalThis.window.SHIPPING_LANGS };
}
