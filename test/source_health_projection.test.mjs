import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HEALTH_STATUSES,
  evaluateSourceHealth,
  normalizeClock,
  normalizeRelationshipCoverage,
} from "../ontology/source_health.mjs";
import {
  aboExternalAwardContractIds,
  aboExternalAwardObservations,
  buildSourceHealthObservations,
  externalScheduleObservations,
  loadSourceHealthInputs,
  receiptSourceIds,
  redactCredentialValues,
  runtimeServedSourceIds,
  validateSourceHealthProjection,
  workerExternalAwardServeIsLive,
} from "../tools/source_health_observations.mjs";
import { loadSourceContracts, validateSourceContracts } from "../tools/source_contracts.mjs";
import { fileURLToPath } from "node:url";

const NOW = "2026-08-18T12:00:00.000Z";

test("backstage errors preserve diagnostics while redacting credential values", () => {
  const diagnostic = [
    "HTTP 503 from publisher",
    "token=start-secret",
    "Authorization: Basic encoded-secret",
    "{\"password\":\"json-secret\"}",
    "https://user:password@example.test/path",
  ].join("; ");
  const redacted = redactCredentialValues(diagnostic);
  assert.match(redacted, /HTTP 503 from publisher/);
  assert.equal((redacted.match(/\[REDACTED\]/g) || []).length, 4);
  assert.doesNotMatch(redacted, /start-secret|encoded-secret|json-secret|user:password/);
});

function contract(overrides = {}) {
  return {
    id: "daily-source",
    status: "live",
    freshness_contract: {
      mode: "continuous",
      max_stale_days: 7,
      clock_basis: "publisher_updated",
    },
    health_policy: {
      public_visibility: "public",
      backstage_detail: "receipts-and-errors",
      relationship_coverage: "separate",
    },
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    source_id: "daily-source",
    publisher_updated_at: "2026-08-12T12:00:00.000Z",
    checked_at: "2026-08-18T10:00:00.000Z",
    acquired_at: "2026-08-18T10:00:00.000Z",
    acquisition_status: "succeeded",
    serving: {
      status: "current",
      at: "2026-08-18T10:30:00.000Z",
      fallback_valid: false,
    },
    ...overrides,
  };
}

test("canonical contracts declare structured freshness and public/backstage health policy", () => {
  const registry = loadSourceContracts();
  assert.equal(registry.contracts.length, 63);
  assert.deepEqual(validateSourceContracts(registry), []);
  for (const source of registry.contracts) {
    assert.ok(source.freshness_contract, source.id);
    assert.match(source.freshness_contract.mode, /^(continuous|periodic|historical|manual-conditional|pointer)$/);
    if (["continuous", "periodic"].includes(source.freshness_contract.mode)) {
      assert.ok(Number(source.freshness_contract.max_stale_days) > 0, source.id);
    } else {
      assert.equal(source.freshness_contract.max_stale_days, null, source.id);
    }
    if (source.freshness_contract.mode === "manual-conditional") {
      assert.ok(source.freshness_contract.manual_refresh_condition, source.id);
    }
    assert.equal(source.health_policy.backstage_detail, "receipts-and-errors", source.id);
    assert.equal(source.health_policy.relationship_coverage, "separate", source.id);
    assert.match(source.health_policy.public_visibility, /^(public|backstage-only)$/, source.id);
    assert.equal("last_checked" in source, false, `${source.id} has transient last_checked in its contract`);
  }
});

test("geography acquisition receipts feed backstage source health", () => {
  const projection = JSON.parse(readFileSync(
    new URL("../site/data/source_health_observations.json", import.meta.url),
    "utf8",
  ));
  const expected = new Map([
    ["dcp-nta2020-boundaries", "Healthy"],
    ["dcp-police-precinct-boundaries", "Healthy"],
    ["dsny-district-boundaries", "Delayed"],
    ["business-improvement-district-boundaries", "Healthy"],
  ]);
  for (const [sourceId, status] of expected) {
    const observation = projection.observations.find((row) => row.source_id === sourceId);
    assert.equal(observation.health.status, status, sourceId);
    assert.ok(observation.evidence.some((item) => item.path.startsWith("data/geography/receipts/")));
    assert.equal(observation.operator.runs[0].adapter, "civic-geography-acquisition-receipt");
  }
});

test("health evaluation uses the source's own freshness contract", () => {
  const within = evaluateSourceHealth(
    contract(),
    observation({ publisher_updated_at: "2026-08-11T12:00:00.000Z" }),
    { now: NOW },
  );
  assert.equal(within.status, "Healthy");

  const breached = evaluateSourceHealth(
    contract(),
    observation({ publisher_updated_at: "2026-08-11T11:59:59.999Z" }),
    { now: NOW },
  );
  assert.equal(breached.status, "Delayed");
  assert.deepEqual(breached.reason_codes, ["publisher-clock-stale"]);

  const slower = evaluateSourceHealth(
    contract({ freshness_contract: { mode: "periodic", max_stale_days: 30, clock_basis: "publisher_updated" } }),
    observation({ publisher_updated_at: "2026-08-01T00:00:00.000Z" }),
    { now: NOW },
  );
  assert.equal(slower.status, "Healthy");
});

test("historical and manual-conditional sources do not inherit generic age alarms", () => {
  const historical = evaluateSourceHealth(
    contract({ freshness_contract: { mode: "historical", max_stale_days: null, clock_basis: "publisher_updated" } }),
    observation({ publisher_updated_at: "2001-01-01T00:00:00.000Z" }),
    { now: NOW },
  );
  assert.equal(historical.status, "Historical");
  assert.doesNotMatch(historical.reason_codes.join(" "), /stale|delayed/);

  const manual = evaluateSourceHealth(
    contract({ freshness_contract: { mode: "manual-conditional", max_stale_days: null, clock_basis: "manual_condition" } }),
    observation({
      publisher_updated_at: "2025-01-01T00:00:00.000Z",
      manual_refresh: { due: false, evaluated_at: NOW },
    }),
    { now: NOW },
  );
  assert.equal(manual.status, "Healthy");

  const due = evaluateSourceHealth(
    contract({ freshness_contract: { mode: "manual-conditional", max_stale_days: null, clock_basis: "manual_condition" } }),
    observation({ manual_refresh: { due: true, evaluated_at: NOW } }),
    { now: NOW },
  );
  assert.equal(due.status, "Manual-refresh");
});

test("a failed acquisition with a valid serving fallback is degraded, never healthy", () => {
  const withFallback = evaluateSourceHealth(
    contract(),
    observation({
      acquisition_status: "failed",
      serving: { status: "fallback", at: "2026-08-18T09:00:00.000Z", fallback_valid: true },
    }),
    { now: NOW },
  );
  assert.equal(withFallback.status, "Degraded");
  assert.deepEqual(withFallback.reason_codes, ["acquisition-failed", "serving-valid-fallback"]);

  const withoutFallback = evaluateSourceHealth(
    contract(),
    observation({
      acquisition_status: "failed",
      serving: { status: "unavailable", at: null, fallback_valid: false },
    }),
    { now: NOW },
  );
  assert.equal(withoutFallback.status, "Source-unavailable");

  const partial = evaluateSourceHealth(
    contract(),
    observation({ acquisition_status: "partial" }),
    { now: NOW },
  );
  assert.equal(partial.status, "Limited-coverage");
});

test("invalid or missing clocks stay explicit UNKNOWN values", () => {
  for (const value of [null, undefined, "", 0, "0", "1970-01-01T00:00:00.000Z", "not-a-date"]) {
    assert.deepEqual(normalizeClock(value, "fixture"), {
      at: null,
      state: "UNKNOWN",
      basis: null,
    });
  }
  const result = evaluateSourceHealth(
    contract(),
    observation({ publisher_updated_at: 0, checked_at: "bad", acquired_at: null, serving: {} }),
    { now: NOW },
  );
  assert.equal(result.clocks.publisher_updated.at, null);
  assert.equal(result.clocks.publisher_updated.state, "UNKNOWN");
  assert.equal(result.clocks.cityscroll_checked_acquired.at, null);
  assert.equal(result.clocks.cityscroll_serving.at, null);
  assert.doesNotMatch(JSON.stringify(result), /1970|epoch/i);
});

test("relationship coverage is a separate axis and failed or held joins cannot be complete", () => {
  const held = normalizeRelationshipCoverage({
    status: "complete",
    row_count: 12,
    measured_at: NOW,
    join_status: "held",
  });
  assert.equal(held.status, "held");
  assert.deepEqual(held.reason_codes, ["relationship-join-held"]);

  const failed = normalizeRelationshipCoverage({
    status: "complete",
    row_count: 12,
    measured_at: NOW,
    join_status: "failed",
  });
  assert.equal(failed.status, "failed");

  const completeWithZero = normalizeRelationshipCoverage({
    status: "complete",
    row_count: 0,
    measured_at: NOW,
    join_status: "accepted",
  });
  assert.equal(completeWithZero.status, "empty-declared-live");

  const health = evaluateSourceHealth(contract(), observation(), { now: NOW });
  assert.equal(health.status, "Healthy");
  assert.equal("relationship_coverage" in health, false);
});

test("projection rejects orphan and duplicate canonical source ids", () => {
  const registry = { contracts: [contract()] };
  assert.deepEqual(validateSourceHealthProjection(registry, {
    observations: [{ source_id: "daily-source" }, { source_id: "daily-source" }],
  }), ["daily-source: duplicate source health observation"]);
  assert.deepEqual(validateSourceHealthProjection(registry, {
    observations: [{ source_id: "orphan" }],
  }), ["orphan: source health observation has no canonical contract"]);

  const duplicateContracts = { contracts: [contract(), contract()] };
  assert.deepEqual(validateSourceHealthProjection(duplicateContracts, { observations: [] }), [
    "daily-source: duplicate source contract id",
  ]);
});

test("projection ordering and reason codes are deterministic", () => {
  const registry = {
    contracts: [contract({ id: "z-source" }), contract({ id: "a-source" })],
  };
  const inputs = {
    asOf: NOW,
    scheduleObservations: [
      { source_id: "z-source", observed_at: NOW, status: "failed" },
      { source_id: "a-source", observed_at: NOW, status: "partial" },
    ],
  };
  const first = buildSourceHealthObservations(registry, inputs);
  const second = buildSourceHealthObservations(registry, {
    ...inputs,
    scheduleObservations: [...inputs.scheduleObservations].reverse(),
  });
  assert.deepEqual(first, second);
  assert.deepEqual(first.observations.map((row) => row.source_id), ["a-source", "z-source"]);
  assert.ok(first.observations.every((row) => HEALTH_STATUSES.includes(row.health.status)));
  assert.ok(first.observations.every((row) => (
    [...row.health.reason_codes].sort().join("|") === row.health.reason_codes.join("|")
  )));
});

test("external-schedule outbox results normalize to canonical acquisition observations", () => {
  const path = ".external-schedule-state/results/source-contracts-live/fixture.json";
  const rows = externalScheduleObservations([{
    path,
    run_key: "2026-08-18-source-0",
    result: {
      observed_at: NOW,
      healthy: ["a-source"],
      failures: [{
        id: "z-source",
        detail: "operator-only detail; Authorization: Bearer credential-value; token=credential-value",
      }],
    },
  }]);
  assert.deepEqual(rows, [
    {
      source_id: "a-source",
      observed_at: NOW,
      status: "succeeded",
      path,
      adapter: "source-contracts-live",
      run_id: "2026-08-18-source-0",
      exact_error: null,
    },
    {
      source_id: "z-source",
      observed_at: NOW,
      status: "failed",
      path,
      adapter: "source-contracts-live",
      run_id: "2026-08-18-source-0",
      exact_error: "operator-only detail; Authorization: Bearer [REDACTED]; token=[REDACTED]",
    },
  ]);
  assert.match(JSON.stringify(rows), /operator-only detail/);
  assert.doesNotMatch(JSON.stringify(rows), /credential-value/);
});

test("shared observations retain credential-safe backstage run detail", () => {
  const projection = buildSourceHealthObservations(
    { contracts: [contract()] },
    {
      asOf: NOW,
      scheduleObservations: [{
        source_id: "daily-source",
        observed_at: NOW,
        status: "failed",
        path: ".external-schedule-state/results/source-contracts-live/fixture.json",
        adapter: "source-contracts-live",
        run_id: "fixture-run",
        exact_error: "HTTP 503 from publisher",
      }],
    },
  );
  assert.deepEqual(projection.observations[0].operator.runs, [{
    adapter: "source-contracts-live",
    run_id: "fixture-run",
    at: NOW,
    status: "failed",
    receipt_ref: ".external-schedule-state/results/source-contracts-live/fixture.json",
    exact_error: "HTTP 503 from publisher",
  }]);
});

test("committed observations are canonical, complete, and generated from receipts", () => {
  const registry = loadSourceContracts();
  const projection = JSON.parse(readFileSync(
    new URL("../site/data/source_health_observations.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(validateSourceHealthProjection(registry, projection), []);
  assert.equal(projection.observations.length, registry.contracts.length);
  assert.deepEqual(
    projection.observations.map((row) => row.source_id),
    [...registry.contracts.map((source) => source.id)].sort(),
  );
  assert.ok(projection.observations.some((row) => row.evidence.length > 0));
});

test("receipt join reads source_contracts arrays and schema-named Checkbook receipts", () => {
  assert.deepEqual(receiptSourceIds({
    source_contracts: [
      "abo-local-authorities",
      "abo-local-development-corporations",
      "abo-state-authorities",
    ],
  }), [
    "abo-local-authorities",
    "abo-local-development-corporations",
    "abo-state-authorities",
  ]);
  assert.deepEqual(receiptSourceIds({
    schema: "cityscroll.checkbook_contracts_population_receipt.v1",
    source: { pulled_at: "2026-08-18T04:05:51.552Z" },
  }), ["checkbook-contracts"]);
  assert.deepEqual(receiptSourceIds({
    source_contract_id: "city-record",
    source_contracts: ["city-record"],
  }), ["city-record"]);
});

test("committed ABO and checkbook-contracts observations carry real receipt clocks", () => {
  const registry = loadSourceContracts();
  const root = fileURLToPath(new URL("../", import.meta.url));
  const inputs = loadSourceHealthInputs(root, registry);
  const projection = JSON.parse(readFileSync(
    new URL("../site/data/source_health_observations.json", import.meta.url),
    "utf8",
  ));
  const required = [
    "abo-local-authorities",
    "abo-local-development-corporations",
    "abo-state-authorities",
    "checkbook-contracts",
  ];
  for (const id of required) {
    assert.ok(
      inputs.warehouseReceipts.some((row) => row.source_id === id && row.observed_at),
      `${id} must have a dated warehouse receipt`,
    );
    const row = projection.observations.find((item) => item.source_id === id);
    assert.ok(row, id);
    const clocks = row.health.clocks;
    assert.equal(clocks.cityscroll_checked_acquired.state, "KNOWN", id);
    assert.ok(clocks.cityscroll_checked_acquired.at, id);
    assert.doesNotMatch(clocks.cityscroll_checked_acquired.at, /^1970-/);
    assert.equal(clocks.cityscroll_serving.state, "KNOWN", id);
    assert.ok(clocks.cityscroll_serving.at, id);
    assert.notEqual(row.health.status, "Source-unavailable", id);
    assert.ok(!row.health.reason_codes.includes("acquisition-status-unknown"), id);
    assert.ok(row.evidence.some((item) => item.at), id);
  }
  const local = projection.observations.find((row) => row.source_id === "abo-local-authorities");
  assert.equal(local.health.clocks.publisher_updated.state, "KNOWN");
  assert.match(local.health.clocks.publisher_updated.at, /^2024-05-06/);
  const ldc = projection.observations.find((row) => row.source_id === "abo-local-development-corporations");
  assert.equal(ldc.health.clocks.publisher_updated.state, "KNOWN");
  assert.match(ldc.health.clocks.publisher_updated.at, /^2024-06-26/);
  const state = projection.observations.find((row) => row.source_id === "abo-state-authorities");
  assert.equal(state.health.clocks.publisher_updated.state, "UNKNOWN");
  assert.equal(state.health.clocks.publisher_updated.at, null);
  const checkbook = projection.observations.find((row) => row.source_id === "checkbook-contracts");
  assert.equal(checkbook.health.clocks.cityscroll_checked_acquired.at, "2026-08-18T04:05:51.552Z");
});

test("ABO Worker KV weekly refresh and GET /externalaward are observed as the serve path", () => {
  const registry = loadSourceContracts();
  const root = fileURLToPath(new URL("../", import.meta.url));
  assert.equal(workerExternalAwardServeIsLive(root), true);
  assert.deepEqual(aboExternalAwardContractIds(registry).sort(), [
    "abo-local-authorities",
    "abo-local-development-corporations",
    "abo-state-authorities",
  ]);
  const served = runtimeServedSourceIds(root, registry);
  for (const id of ["abo-local-authorities", "abo-local-development-corporations", "abo-state-authorities", "checkbook-contracts"]) {
    assert.equal(served.has(id), true, id);
  }
  assert.equal(served.has("checkbook-nycha-contracts"), true);

  const withReceipt = aboExternalAwardObservations(root, registry);
  // Production KV last_refresh is not in git; do not invent it. A dated receipt fills clocks.
  const projection = buildSourceHealthObservations(
    { contracts: [contract({ id: "abo-local-authorities", dataset_id: "8w5p-k45m" })] },
    {
      asOf: NOW,
      warehouseReceipts: [{
        source_id: "abo-local-authorities",
        observed_at: "2026-07-16T00:00:00.000Z",
        publisher_updated_at: "2025-12-01T00:00:00.000Z",
        publisher_clock_basis: "publisher_receipt",
        status: "succeeded",
        path: "worker/src/external_award.mjs",
        adapter: "worker-externalaward-refresh",
      }],
      serveObservations: [{
        source_id: "abo-local-authorities",
        at: "2026-07-16T00:00:00.000Z",
        status: "current",
        path: "worker/src/external_award.mjs",
        basis: "worker_kv_externalaward",
      }],
    },
  );
  const row = projection.observations[0];
  assert.equal(row.health.clocks.publisher_updated.at, "2025-12-01T00:00:00.000Z");
  assert.equal(row.health.clocks.cityscroll_checked_acquired.at, "2026-07-16T00:00:00.000Z");
  assert.equal(row.health.clocks.cityscroll_serving.at, "2026-07-16T00:00:00.000Z");
  assert.equal(withReceipt.acquisitions.length, 0);
  assert.equal(withReceipt.serving.length, 0);
});

test("raw receipt observations remain backstage until a strict public projection exists", () => {
  const publicBuildConfig = readFileSync(new URL("../site/_config.yml", import.meta.url), "utf8");
  assert.match(publicBuildConfig, /^\s+- data\/source_health_observations\.json$/m);
});
