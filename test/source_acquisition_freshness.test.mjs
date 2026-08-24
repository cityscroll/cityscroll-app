import assert from "node:assert/strict";
import test from "node:test";

import {
  ACQUISITION_RECEIPT_SCHEMA,
  buildSourceHealthObservations,
  externalScheduleReceiptRows,
  validateAcquisitionReceipt,
} from "../tools/source_health_observations.mjs";
import { buildDataSourceGraph } from "../tools/data_source_graph.mjs";
import { sourceAcquisitionReceipt } from "../worker/src/lib/source_acquisition_receipt.mjs";

const NOW = "2026-08-24T12:00:00.000Z";

function contract(overrides = {}) {
  return {
    id: "freshness-fixture",
    name: "Freshness fixture",
    owner: "Fixture publisher",
    status: "live",
    landing_page: "https://example.test/source",
    publisher_cadence: "Weekly",
    acquisition_cadence_days: 7,
    delivery_tier: "edge-materialized",
    freshness_contract: {
      mode: "periodic",
      max_stale_days: 30,
      clock_basis: "publisher_updated",
      serving_max_age_days: null,
    },
    health_policy: { public_visibility: "backstage-only" },
    ...overrides,
  };
}

test("canonical validator rejects a benchmark-only timestamp and accepts an acquisition receipt", () => {
  const benchmark = { measured_at: NOW, phase: "WH-05" };
  assert.ok(validateAcquisitionReceipt(benchmark).some((error) => /observed_at/.test(error)));
  const receipt = {
    schema: ACQUISITION_RECEIPT_SCHEMA,
    source_contract_id: "freshness-fixture",
    observed_at: NOW,
    status: "succeeded",
    run_id: "fixture-run-1",
    publisher_clock_basis: "publisher_response",
    publisher_updated_at: null,
  };
  assert.deepEqual(validateAcquisitionReceipt(receipt, { sourceIds: new Set(["freshness-fixture"]) }), []);
});

test("fresh acquisition and a missing scheduler slot remain distinct visible graph events", () => {
  const source = contract();
  const canonical = buildSourceHealthObservations(
    { contracts: [source] },
    {
      asOf: NOW,
      warehouseReceipts: [{
        source_id: source.id,
        source_contract_id: source.id,
        observed_at: NOW,
        status: "succeeded",
        run_id: "worker-run-1",
        publisher_clock_basis: "publisher_response",
        publisher_updated_at: null,
        clock_kind: "acquisition",
      }],
      schedulerHeartbeats: [{
        source_contract_id: "source-contracts-live",
        observed_at: "2026-08-20T10:23:00.000Z",
        status: "succeeded",
        run_id: "monitor-run-20",
        publisher_clock_basis: null,
        publisher_updated_at: null,
      }],
    },
  );
  const row = canonical.observations[0];
  assert.equal(row.freshness_watchdog.status, "STALE");
  assert.deepEqual(row.freshness_watchdog.reason_codes, ["monitor-missing"]);
  assert.equal(row.operator.acquisition_receipts[0].source_contract_id, source.id);
  assert.equal(row.operator.acquisition_receipts[0].observed_at, NOW);
  assert.equal(row.operator.acquisition_receipts[0].status, "succeeded");
  assert.equal(row.operator.acquisition_receipts[0].run_id, "worker-run-1");

  const graph = buildDataSourceGraph({ registry: { contracts: [source] }, healthObservations: canonical, inputs: [] });
  const graphSource = graph.sources[0];
  assert.equal(graphSource.freshness_watchdog.status, "STALE");
  assert.equal(graphSource.freshness_watchdog.reason_codes[0], "monitor-missing");
  assert.ok(graphSource.freshness_events.some((event) => (
    event.source_contract_id === source.id
    && event.observed_at === NOW
    && event.status === "succeeded"
    && event.run_id === "worker-run-1"
  )));
  assert.ok(graphSource.freshness_events.some((event) => (
    event.source_contract_id === source.id
    && event.status === "failed"
    && event.run_id.startsWith("missing:")
  )));
});

test("external monitor results carry canonical check receipts and a heartbeat", () => {
  const rows = externalScheduleReceiptRows([{
    path: ".external-schedule-state/results/source-contracts-live/run.json",
    run_key: "2026-08-24T10-23",
    result: {
      observed_at: "2026-08-24T10:23:00.000Z",
      healthy: ["freshness-fixture"],
      failures: [],
    },
  }]);
  assert.deepEqual(rows[0], {
    schema: ACQUISITION_RECEIPT_SCHEMA,
    source_contract_id: "freshness-fixture",
    observed_at: "2026-08-24T10:23:00.000Z",
    status: "succeeded",
    run_id: "2026-08-24T10-23:freshness-fixture",
    publisher_clock_basis: null,
    publisher_updated_at: null,
    clock_kind: "check",
  });
});

test("Worker runtime adapter emits the same canonical fields", () => {
  const receipt = sourceAcquisitionReceipt({
    source_contract_id: "abo-local-authorities",
    observed_at: NOW,
    status: "succeeded",
    run_id: "worker-run-abo",
    publisher_clock_basis: "publisher_metadata",
    publisher_updated_at: "2026-08-20",
  });
  assert.deepEqual(Object.keys(receipt).slice(0, 7), [
    "schema",
    "source_contract_id",
    "observed_at",
    "status",
    "run_id",
    "publisher_clock_basis",
    "publisher_updated_at",
  ]);
  assert.equal(receipt.schema, ACQUISITION_RECEIPT_SCHEMA);
});
