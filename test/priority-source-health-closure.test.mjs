/**
 * Priority-source observation closure: census, fixtures, input vs serving
 * vintage, warehouse rail, and repair upsert.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  DATA_SOURCE_GRAPH_SCHEMA_VERSION,
  DESK_CONSUMER_CONTRACT_PATH,
  JSON_OUTPUT,
  ROOT,
  buildDataSourceGraph,
  generatedGraphFiles,
  renderGraphHtml,
} from "../tools/data_source_graph.mjs";
import {
  FIXTURE_CASES,
  OBSERVATION_CLASSES,
  PRIORITY_SOURCE_FAMILIES,
  PRIORITY_SOURCE_HEALTH_CLOSURE_EXTENSION_VERSION,
  PRIORITY_SOURCE_IDS,
  acquisitionObservationDate,
  buildPrioritySourceHealthClosure,
  cardSynthesisOwner,
  classifyRegistryCensus,
  classifySourceObservation,
  fixtureObservation,
  inspectWarehouseRefreshRail,
  isActiveObservabilitySource,
  materializationDoesNotClearAcquisition,
  noChangeCheckReceipt,
  servingObservationDate,
  unchangedOldCatalogIsNotFreshnessProof,
} from "../tools/priority_source_health_closure.mjs";
import {
  buildSourceHealthObservations,
  loadSourceHealthInputs,
} from "../tools/source_health_observations.mjs";
import { loadSourceContracts } from "../tools/source_contracts.mjs";
import {
  REPAIR_SCOPE_KINDS,
  buildHealthRepairObservations,
  buildRepairObservation,
  groupRepairObservations,
  mergeRepairObservations,
} from "../tools/repair_observations.mjs";
import { passportReceiptsFromMeta } from "../worker/src/lib/source_acquisition_receipt.mjs";

const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const NOW = "2026-09-06T12:00:00.000Z";

function contract(overrides = {}) {
  return {
    id: "daily-source",
    status: "live",
    freshness_contract: {
      mode: "continuous",
      max_stale_days: 7,
      clock_basis: "checked_acquired",
    },
    ...overrides,
  };
}

function observation(sourceId, overrides = {}) {
  return {
    source_id: sourceId,
    health: {
      status: "Healthy",
      clocks: {
        publisher_updated: { at: null, state: "UNKNOWN", basis: null },
        cityscroll_checked_acquired: { at: "2026-09-06T10:00:00.000Z", state: "KNOWN", basis: "acquired_at" },
        cityscroll_serving: { at: "2026-09-06T10:05:00.000Z", state: "KNOWN", basis: "serving" },
      },
    },
    operator: {
      runs: [{
        adapter: "warehouse-acquisition-receipt",
        run_id: "run-1",
        at: "2026-09-06T10:00:00.000Z",
        status: "succeeded",
      }],
      clocks: {
        acquired: { at: "2026-09-06T10:00:00.000Z", state: "KNOWN", basis: "acquired_at" },
      },
    },
    ...overrides,
  };
}

test("full registry census classifies every source without dropping difficult ones", () => {
  const registry = loadSourceContracts();
  const projection = readJson("site/data/source_health_observations.json");
  const census = classifyRegistryCensus(registry, projection);
  assert.equal(census.contract_count, registry.contracts.length);
  assert.equal(census.rows.length, registry.contracts.length);
  assert.deepEqual(new Set(census.rows.map((row) => row.observation_class)), new Set(
    census.rows.map((row) => row.observation_class).filter((id) => OBSERVATION_CLASSES.includes(id)),
  ));
  for (const id of OBSERVATION_CLASSES) assert.ok(id in census.counts);
  assert.equal(
    Object.values(census.counts).reduce((sum, value) => sum + value, 0),
    registry.contracts.length,
  );
  assert.ok(census.active_source_observability.denominator >= census.active_source_observability.numerator);
  assert.ok(census.active_source_observability.denominator > 0);
  const difficult = PRIORITY_SOURCE_IDS.filter((id) => registry.contracts.some((row) => row.id === id));
  assert.equal(difficult.length, PRIORITY_SOURCE_IDS.length);
  for (const id of difficult) {
    assert.ok(census.rows.some((row) => row.source_id === id));
  }
});

test("active-source observability does not count historical, manual, disabled, or candidate rows", () => {
  const registry = {
    contracts: [
      contract({ id: "live-observed" }),
      contract({ id: "historical-source", freshness_contract: { mode: "historical", max_stale_days: null, clock_basis: "publisher_updated" } }),
      contract({ id: "manual-source", status: "manual", freshness_contract: { mode: "manual-conditional", max_stale_days: null, clock_basis: "manual_condition" } }),
      contract({ id: "disabled-source", status: "disabled" }),
      contract({ id: "unobserved-live" }),
    ],
  };
  const projection = {
    observations: [
      observation("live-observed"),
      observation("historical-source"),
    ],
  };
  const census = classifyRegistryCensus(registry, projection, { candidates: new Set() });
  assert.equal(census.active_source_observability.numerator, 1);
  assert.equal(census.active_source_observability.denominator, 2);
  assert.equal(census.rows.find((row) => row.source_id === "historical-source").observation_class, "legitimately-historical-or-manual");
  assert.equal(census.rows.find((row) => row.source_id === "manual-source").observation_class, "legitimately-historical-or-manual");
  assert.equal(census.rows.find((row) => row.source_id === "disabled-source").observation_class, "disabled-or-candidate");
  assert.equal(census.rows.find((row) => row.source_id === "unobserved-live").observation_class, "requires-observation-producer");
  assert.equal(isActiveObservabilitySource(registry.contracts[1]), false);
});

test("seven priority families are the required implementation population", () => {
  assert.equal(PRIORITY_SOURCE_FAMILIES.length, 7);
  assert.deepEqual(PRIORITY_SOURCE_FAMILIES.map((row) => row.id), [
    "city-record",
    "passport",
    "checkbook",
    "legistar",
    "rules-rss",
    "zap-projects",
    "community-board-minutes",
  ]);
  const registry = loadSourceContracts();
  const ids = new Set(registry.contracts.map((row) => row.id));
  for (const sourceId of PRIORITY_SOURCE_IDS) {
    assert.ok(ids.has(sourceId), `${sourceId} must remain in the canonical registry`);
  }
});

test("fixtures cover partial, failed, unsearched, fresh-empty, no-change, serving, and fallback cases", () => {
  assert.deepEqual([...FIXTURE_CASES].sort(), [
    "expired-fallback",
    "failed-check",
    "fresh-empty",
    "old-input-rematerialization",
    "partial-acquisition",
    "successful-no-change-check",
    "unavailable-serving",
    "unsearched-scope",
    "valid-fallback",
  ]);
  assert.equal(fixtureObservation("partial-acquisition").acquisition_status, "partial");
  assert.equal(fixtureObservation("failed-check").check_status, "failed");
  assert.equal(fixtureObservation("unsearched-scope").checked_at, null);
  assert.equal(fixtureObservation("fresh-empty").population, 0);
  assert.equal(fixtureObservation("successful-no-change-check").event_kind, "successful-no-change-check");
  assert.equal(fixtureObservation("unavailable-serving").serving.status, "unavailable");
  assert.equal(fixtureObservation("valid-fallback").serving.fallback_valid, true);
  assert.equal(fixtureObservation("expired-fallback").serving.fallback_valid, false);
  const rebuilt = fixtureObservation("old-input-rematerialization");
  const verdict = materializationDoesNotClearAcquisition({
    inputVintage: rebuilt.input_vintage,
    servedAt: rebuilt.serving.at,
    now: NOW,
    maxStaleDays: 7,
  });
  assert.equal(verdict.acquisition_stale, true);
  assert.equal(verdict.serving_rebuilt, true);
  assert.equal(verdict.cleared_by_rebuild, false);
});

test("a fresh materialization from old input never clears acquisition staleness", () => {
  const input = "2026-06-01T00:00:00.000Z";
  const served = "2026-09-06T12:00:00.000Z";
  assert.equal(acquisitionObservationDate({
    pulled_at: input,
    generated_at: served,
    materialized_at: served,
  }), input);
  assert.equal(servingObservationDate({
    pulled_at: input,
    generated_at: served,
    materialized_at: served,
  }), served);
  const verdict = materializationDoesNotClearAcquisition({
    inputVintage: input,
    servedAt: served,
    now: NOW,
    maxStaleDays: 45,
  });
  assert.equal(verdict.acquisition_stale, true);
  assert.equal(verdict.cleared_by_rebuild, false);
  assert.deepEqual(unchangedOldCatalogIsNotFreshnessProof({
    previousChecksum: "abc",
    nextChecksum: "abc",
    previousInputVintage: input,
    nextInputVintage: input,
  }), {
    freshness_proved: false,
    unchanged_catalog: true,
    reason: "unchanged-old-catalog-is-not-freshness-proof",
  });
});

test("PASSPort observations are D1 ingest-meta receipts, never a blocked publisher request", () => {
  const receipts = passportReceiptsFromMeta({
    ingested_at: "2026-09-06T08:00:00.000Z",
    last_attempt_at: "2026-09-06T08:00:00.000Z",
    last_ok: "true",
    contract_rows: "12",
    rfx_rows: "4",
    last_modified: { contracts: "Wed, 01 Jan 2026 00:00:00 GMT", rfx: null },
  }, { run_id: "worker:cron:1" });
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts.map((row) => row.source_contract_id), [
    "passport-public-contracts",
    "passport-public-rfx",
  ]);
  assert.ok(receipts.every((row) => row.adapter === "worker-d1-passport-ingest-meta"));
  assert.ok(receipts.every((row) => row.run_id === "worker:cron:1"));
  const worker = readFileSync(join(ROOT, "worker/src/admin.mjs"), "utf8");
  assert.match(worker, /\/admin\/passport-ingest-meta/);
  assert.match(worker, /req\.method !== "GET"/);
  assert.doesNotMatch(
    worker.slice(worker.indexOf("handleAdminPassportIngestMeta"), worker.indexOf("handleAdminPassportIngestMeta") + 800),
    /ingestPassportPublic/,
  );
});

test("successful no-change checks keep the retained input vintage", () => {
  const receipt = noChangeCheckReceipt({
    source_contract_id: "nyc-rules-rss",
    observed_at: NOW,
    run_id: "worker:cron:2",
    input_vintage: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.clock_kind, "check");
  assert.equal(receipt.event_kind, "successful-no-change-check");
  assert.equal(receipt.input_vintage, "2026-09-01T00:00:00.000Z");
});

test("warehouse rail inspection names blockers instead of inventing a live receipt", () => {
  assert.equal(inspectWarehouseRefreshRail({}).blocker, "uninstalled-schedule");
  assert.equal(inspectWarehouseRefreshRail({ installed: true }).blocker, "absent-live-receipt");
  const live = inspectWarehouseRefreshRail({
    installed: true,
    last_execution: { at: "2026-09-05T19:57:00.000Z", exit_code: 0, identity: "com.cityscroll.first-class-refresh" },
    identity: "com.cityscroll.first-class-refresh",
    schedule: "10 7 * * *",
  });
  assert.equal(live.blocker, null);
  assert.equal(live.installed, true);
  assert.equal(live.evidence_class, "live-host-inspection");
});

test("missing monitoring never resolves a repair group; unchanged repeats do not duplicate", () => {
  assert.ok(REPAIR_SCOPE_KINDS.includes("canonical_source"));
  const first = buildRepairObservation({
    condition: "source-retrieval-failed",
    source_contract_id: "nyc-council-legistar",
    source_id: "nyc-council-legistar",
    adapter: "worker-scheduled-refresh",
    scope_kind: "canonical_source",
    scope_id: "nyc-council-legistar",
    observed_at: "2026-09-04T12:00:00.000Z",
    evidence_locator: "site/data/source_health_observations.json#/observations/0",
  });
  const repeat = buildRepairObservation({
    condition: "source-retrieval-failed",
    source_contract_id: "nyc-council-legistar",
    source_id: "nyc-council-legistar",
    adapter: "worker-scheduled-refresh",
    scope_kind: "canonical_source",
    scope_id: "nyc-council-legistar",
    observed_at: "2026-09-05T12:00:00.000Z",
    evidence_locator: "site/data/source_health_observations.json#/observations/0",
  });
  const merged = mergeRepairObservations([first], [repeat], { observedAt: "2026-09-05T12:00:00.000Z" });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].fingerprint, first.fingerprint);
  assert.equal(merged[0].first_observed_at, first.first_observed_at);
  assert.equal(merged[0].observation_count, 2);
  assert.equal(merged[0].resolved, false);
  const groups = groupRepairObservations(merged);
  assert.equal(groups.length, 1);
  const missingMonitor = mergeRepairObservations(merged, [], {
    observedAt: NOW,
    monitoringAvailable: false,
  });
  assert.equal(missingMonitor[0].resolved, false);
  const recovered = mergeRepairObservations(merged, [], { observedAt: NOW, monitoringAvailable: true });
  assert.equal(recovered[0].resolved, true);
});

test("health findings project into the existing repair identity", () => {
  const rows = buildHealthRepairObservations({
    observations: [{
      source_id: "nyc-rules-rss",
      health: { status: "Source-unavailable", reason_codes: ["observation-missing"] },
      freshness_watchdog: { status: "STALE", reason_codes: ["monitor-missing"] },
      acquisition_status: "unknown",
    }],
    contracts: [{ id: "nyc-rules-rss", code_references: [{ path: "worker/src/rules.mjs" }] }],
    observedAt: NOW,
  });
  assert.ok(rows.some((row) => row.condition.id === "scope-not-searched"));
  const synthesis = cardSynthesisOwner();
  assert.equal(typeof synthesis.available, "boolean");
  if (synthesis.available) assert.equal(synthesis.owner, "diagnostic-card-producer");
});

test("Desk graph publishes the additive priority-source closure without leaving version 4", () => {
  const graph = JSON.parse(generatedGraphFiles()[JSON_OUTPUT]);
  const html = renderGraphHtml(graph);
  const deskContract = readJson(DESK_CONSUMER_CONTRACT_PATH);
  assert.equal(DATA_SOURCE_GRAPH_SCHEMA_VERSION, 4);
  assert.equal(graph.schema_version, 4);
  assert.equal(graph.extensions.priority_source_closure, PRIORITY_SOURCE_HEALTH_CLOSURE_EXTENSION_VERSION);
  assert.equal(deskContract.extensions.priority_source_closure.version, 1);
  assert.ok(graph.priority_source_closure);
  assert.equal(graph.priority_source_closure.census.contract_count, graph.counts.source_contracts);
  assert.match(html, /id="prioritySourceClosure"/);
  assert.match(html, /Active-source observability/);
  for (const family of PRIORITY_SOURCE_FAMILIES) {
    assert.match(html, new RegExp(family.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("worker acquisition receipts and D1 PASSPort meta load through the existing health model", () => {
  const registry = {
    contracts: [
      contract({ id: "passport-public-contracts" }),
      contract({ id: "passport-public-rfx" }),
      contract({ id: "nyc-council-legistar" }),
    ],
  };
  const projection = buildSourceHealthObservations(registry, {
    asOf: NOW,
    warehouseReceipts: [],
    serveObservations: [],
    workerAcquisitionReceipts: [
      {
        source_id: "nyc-council-legistar",
        observed_at: NOW,
        status: "succeeded",
        run_id: "worker:cron:legistar",
        adapter: "worker-scheduled-refresh",
        clock_kind: "acquisition",
      },
    ],
    passportIngestMeta: {
      ingested_at: "2026-09-06T08:00:00.000Z",
      last_attempt_at: "2026-09-06T08:00:00.000Z",
      last_ok: "true",
      contract_rows: "3",
      rfx_rows: "1",
    },
  });
  const byId = Object.fromEntries(projection.observations.map((row) => [row.source_id, row]));
  assert.equal(classifySourceObservation(registry.contracts[0], byId["passport-public-contracts"]), "observed");
  assert.equal(classifySourceObservation(registry.contracts[1], byId["passport-public-rfx"]), "observed");
  assert.equal(classifySourceObservation(registry.contracts[2], byId["nyc-council-legistar"]), "observed");
});

test("closure matrix retains remaining non-priority gaps instead of deleting them", () => {
  const registry = loadSourceContracts();
  const projection = readJson("site/data/source_health_observations.json");
  const closure = buildPrioritySourceHealthClosure({
    registry,
    projection,
    evidenceRevision: "test-rev",
  });
  assert.equal(closure.schema, "cityscroll.priority_source_health_closure.v1");
  assert.equal(closure.families.length, 7);
  assert.ok(Array.isArray(closure.remaining_non_priority_observation_gaps));
  const census = classifyRegistryCensus(registry, projection);
  const expectedGaps = census.rows
    .filter((row) => row.observation_class === "requires-observation-producer" && !row.priority_family)
    .map((row) => row.source_id);
  assert.deepEqual(closure.remaining_non_priority_observation_gaps, expectedGaps);
});

test("committed load path still builds one observation per contract", () => {
  const registry = loadSourceContracts();
  const inputs = loadSourceHealthInputs(ROOT, registry);
  const projection = buildSourceHealthObservations(registry, { ...inputs, asOf: inputs.asOf || NOW });
  assert.equal(projection.observations.length, registry.contracts.length);
});
