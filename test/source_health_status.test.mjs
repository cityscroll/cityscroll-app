import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSourceHealth,
  normalizeRelationshipCoverage,
} from "../ontology/source_health.mjs";
import {
  buildSourceHealthObservations,
  validateSourceHealthProjection,
} from "../tools/source_health_observations.mjs";
import {
  buildPublicSourceHealthProjection,
  publicSourceHealthProjectionLeaks,
} from "../site/source_health_public_projection.mjs";
import { buildDataSourceGraph } from "../tools/data_source_graph.mjs";
import { loadSourceContracts } from "../tools/source_contracts.mjs";

const NOW = "2026-08-18T12:00:00.000Z";
const CLOCKS = [
  "publisher_updated",
  "cityscroll_checked_acquired",
  "cityscroll_serving",
];
const OPERATOR_MARKERS = [
  "SOURCE_API_TOKEN",
  "contract_fingerprint",
  "exact_error",
  "operator-runbook",
  "publisher-diagnostic-fixture",
  "row_count",
];

function contract(overrides = {}) {
  const id = overrides.id || "daily-source";
  return {
    id,
    name: `Source ${id}`,
    owner: "Public publisher",
    status: "live",
    landing_page: `https://example.gov/${id}`,
    publisher_cadence: "Daily",
    used_for: "Public records",
    delivery_tier: "live-only",
    code_references: [{ path: "worker/src/fixture.mjs", contains: "fixtureAdapter" }],
    auth_token_env: "SOURCE_API_TOKEN",
    operator_runbook: "/ops/operator-runbook.md",
    ...overrides,
    freshness_contract: {
      mode: "continuous",
      max_stale_days: 7,
      clock_basis: "publisher_updated",
      serving_max_age_days: null,
      serve_contract_id: null,
      ...(overrides.freshness_contract || {}),
    },
    health_policy: {
      public_visibility: "public",
      backstage_detail: "receipts-and-errors",
      relationship_coverage: "separate",
      ...(overrides.health_policy || {}),
    },
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

function scheduleFrom(id, obs) {
  if (!obs || obs.skip_schedule) return [];
  return [{
    source_id: id,
    observed_at: obs.checked_at || NOW,
    status: obs.acquisition_status || "succeeded",
    publisher_updated_at: obs.publisher_updated_at || null,
    path: ".external-schedule-state/results/source-contracts-live/fixture.json",
    adapter: "source-contracts-live",
    run_id: `${id}-run`,
    exact_error: obs.exact_error || null,
  }];
}

function serveFrom(id, obs) {
  if (!obs?.serving?.at) return [];
  return [{
    source_id: id,
    at: obs.serving.at,
    status: obs.serving.status || "current",
    fallback_valid: Boolean(obs.serving.fallback_valid),
    path: "site/data/fixture_lookup.json",
    basis: "warehouse_serve_receipt",
  }];
}

function projectSurfaces(registry, inputs = {}) {
  const canonical = buildSourceHealthObservations(registry, { asOf: NOW, ...inputs });
  const publicProjection = buildPublicSourceHealthProjection(registry, canonical);
  const desk = buildDataSourceGraph({
    registry,
    healthObservations: canonical,
    inputs: [],
  });
  return { canonical, publicProjection, desk };
}

function expectedPublicStatus(health) {
  const reasons = health?.reason_codes || [];
  if (
    reasons.includes("acquisition-status-unknown")
    || reasons.includes("observation-missing")
  ) {
    return "UNKNOWN";
  }
  return health.status;
}

const ARCHETYPES = [
  {
    name: "continuous-daily",
    contract: contract(),
    observation: observation(),
    status: "Healthy",
    reasons: [],
  },
  {
    name: "continuous-daily-own-breach",
    contract: contract(),
    observation: observation({ publisher_updated_at: "2026-08-11T11:59:59.999Z" }),
    status: "Delayed",
    reasons: ["publisher-clock-stale"],
  },
  {
    name: "continuous-daily-acquisition-clock",
    contract: contract({
      freshness_contract: { mode: "continuous", max_stale_days: 1, clock_basis: "checked_acquired" },
    }),
    observation: observation({
      publisher_updated_at: NOW,
      checked_at: "2026-08-16T12:00:00.000Z",
      acquired_at: "2026-08-16T12:00:00.000Z",
    }),
    status: "Delayed",
    reasons: ["acquisition-clock-stale"],
  },
  {
    name: "slow-periodic",
    contract: contract({
      id: "slow-periodic",
      freshness_contract: { mode: "periodic", max_stale_days: 30, clock_basis: "publisher_updated" },
    }),
    observation: observation({
      source_id: "slow-periodic",
      publisher_updated_at: "2026-07-20T00:00:00.000Z",
    }),
    status: "Healthy",
    reasons: [],
  },
  {
    name: "historical",
    contract: contract({
      id: "historical-source",
      freshness_contract: { mode: "historical", max_stale_days: null, clock_basis: "publisher_updated" },
    }),
    observation: observation({
      source_id: "historical-source",
      publisher_updated_at: "2001-01-01T00:00:00.000Z",
    }),
    status: "Historical",
    reasons: ["historical-source"],
  },
  {
    name: "manual-conditional",
    contract: contract({
      id: "manual-source",
      freshness_contract: {
        mode: "manual-conditional",
        max_stale_days: null,
        clock_basis: "manual_condition",
        manual_refresh_condition: "re-check after the next release",
      },
    }),
    observation: observation({
      source_id: "manual-source",
      publisher_updated_at: "2025-01-01T00:00:00.000Z",
      manual_refresh: { due: false, evaluated_at: NOW },
    }),
    status: "Healthy",
    reasons: [],
    skip_builder: true,
  },
  {
    name: "pointer-only",
    contract: contract({
      id: "pointer-source",
      freshness_contract: { mode: "pointer", max_stale_days: null, clock_basis: "publisher_updated" },
    }),
    observation: observation({
      source_id: "pointer-source",
      publisher_updated_at: "2001-01-01T00:00:00.000Z",
    }),
    status: "Healthy",
    reasons: [],
  },
  {
    name: "current-failure-with-LKG",
    contract: contract({ id: "lkg-source" }),
    observation: observation({
      source_id: "lkg-source",
      acquisition_status: "failed",
      exact_error: "HTTP 503 from publisher; publisher-diagnostic-fixture",
      serving: { status: "fallback", at: "2026-08-18T09:00:00.000Z", fallback_valid: true },
    }),
    status: "Degraded",
    reasons: ["acquisition-failed", "serving-valid-fallback"],
  },
  {
    name: "no-fallback",
    contract: contract({ id: "no-fallback-source" }),
    observation: observation({
      source_id: "no-fallback-source",
      acquisition_status: "failed",
      serving: { status: "unavailable", at: null, fallback_valid: false },
    }),
    status: "Source-unavailable",
    reasons: ["acquisition-failed", "serving-fallback-unavailable"],
  },
  {
    name: "held-join",
    contract: contract({ id: "held-join" }),
    observation: observation({ source_id: "held-join" }),
    coverage: {
      status: "complete",
      row_count: 12,
      measured_at: NOW,
      join_status: "held",
    },
    status: "Healthy",
    reasons: [],
    coverageStatus: "held",
  },
  {
    name: "complete-with-zero",
    contract: contract({ id: "empty-complete" }),
    observation: observation({ source_id: "empty-complete" }),
    coverage: {
      status: "complete",
      row_count: 0,
      measured_at: NOW,
      join_status: "accepted",
    },
    status: "Healthy",
    reasons: [],
    coverageStatus: "empty-declared-live",
  },
];

test("table-driven archetypes keep evaluator, public, and desk health honest", async (t) => {
  for (const fixture of ARCHETYPES) {
    await t.test(fixture.name, () => {
      const evaluated = evaluateSourceHealth(
        fixture.contract,
        fixture.observation,
        { now: NOW },
      );
      assert.equal(evaluated.status, fixture.status, fixture.name);
      assert.deepEqual(evaluated.reason_codes, fixture.reasons, fixture.name);
      if (fixture.name === "historical" || fixture.name === "pointer-only") {
        assert.notEqual(evaluated.status, "Delayed");
        assert.equal(evaluated.reason_codes.some((code) => /stale|delayed/.test(code)), false);
      }
      if (fixture.coverage) {
        assert.equal(normalizeRelationshipCoverage(fixture.coverage).status, fixture.coverageStatus);
        assert.equal("relationship_coverage" in evaluated, false);
      }

      const id = fixture.contract.id;
      let canonical;
      let publicProjection;
      let desk;
      if (fixture.skip_builder) {
        canonical = {
          schema: "cityscroll.source_health_observations.v1",
          generated_at: NOW,
          observations: [{
            source_id: id,
            health: evaluated,
            relationship_coverage: normalizeRelationshipCoverage(fixture.coverage),
            evidence: [],
          }],
        };
        publicProjection = buildPublicSourceHealthProjection({ contracts: [fixture.contract] }, canonical);
        desk = buildDataSourceGraph({
          registry: { contracts: [fixture.contract] },
          healthObservations: canonical,
          inputs: [],
        });
      } else {
        ({ canonical, publicProjection, desk } = projectSurfaces(
          { contracts: [fixture.contract] },
          {
            scheduleObservations: scheduleFrom(id, fixture.observation),
            serveObservations: serveFrom(id, fixture.observation),
            coverageCensus: fixture.coverage
              ? {
                sources: [{
                  id,
                  dual_write: { after: fixture.coverage.join_status === "held" ? "held" : fixture.coverage.status },
                  live_observation: {
                    status: fixture.coverage.join_status === "held" ? "held" : fixture.coverage.status,
                    row_count: fixture.coverage.row_count,
                    measured_at: fixture.coverage.measured_at,
                  },
                }],
              }
              : undefined,
          },
        ));
      }
      const row = canonical.observations.find((item) => item.source_id === id);
      const publicRow = publicProjection.sources.find((item) => item.source_id === id);
      const deskRow = desk.sources.find((item) => item.id === id);
      assert.equal(row.health.status, fixture.status, `${fixture.name} canonical`);
      assert.deepEqual(row.health.reason_codes, fixture.reasons, `${fixture.name} canonical reasons`);
      assert.equal(publicRow.health.status, expectedPublicStatus(row.health), `${fixture.name} public`);
      assert.equal(deskRow.health.status, fixture.status, `${fixture.name} desk`);
      for (const clockName of CLOCKS) {
        assert.equal(publicRow.health.clocks[clockName].at, row.health.clocks[clockName].at, clockName);
        assert.equal(publicRow.health.clocks[clockName].state, row.health.clocks[clockName].state, clockName);
        assert.equal(deskRow.clocks[clockName].at, row.health.clocks[clockName].at, clockName);
        if (publicRow.health.clocks[clockName].state === "UNKNOWN") {
          assert.equal(publicRow.health.clocks[clockName].at, null);
          assert.equal(publicRow.health.clocks[clockName].basis, null);
        }
      }
      assert.equal("row_count" in publicRow.relationship_coverage, false);
      assert.deepEqual(publicSourceHealthProjectionLeaks(publicProjection), []);
      const publicText = JSON.stringify(publicProjection);
      for (const marker of OPERATOR_MARKERS) {
        assert.doesNotMatch(publicText, new RegExp(marker));
      }
      if (fixture.coverageStatus) {
        assert.equal(row.relationship_coverage.status, fixture.coverageStatus);
        assert.equal(deskRow.join_gate.status, fixture.coverageStatus);
      }
      if (fixture.status === "Degraded") {
        assert.notEqual(row.health.status, "Healthy");
        assert.equal(deskRow.serving_fallback.active, true);
      }
    });
  }
});

test("a daily source is delayed only after its own freshness breach", () => {
  const staleForDaily = "2026-07-20T00:00:00.000Z";
  const withinDaily = "2026-08-12T12:00:00.000Z";
  const daily = contract({ id: "daily-source" });
  const periodic = contract({
    id: "slow-periodic",
    freshness_contract: { mode: "periodic", max_stale_days: 30, clock_basis: "publisher_updated" },
  });
  const { canonical, publicProjection, desk } = projectSurfaces(
    { contracts: [daily, periodic] },
    {
      scheduleObservations: [
        {
          source_id: "daily-source",
          observed_at: NOW,
          status: "succeeded",
          publisher_updated_at: withinDaily,
        },
        {
          source_id: "slow-periodic",
          observed_at: NOW,
          status: "succeeded",
          publisher_updated_at: staleForDaily,
        },
      ],
    },
  );
  const dailyRow = canonical.observations.find((row) => row.source_id === "daily-source");
  const periodicRow = canonical.observations.find((row) => row.source_id === "slow-periodic");
  assert.equal(dailyRow.health.status, "Healthy");
  assert.equal(periodicRow.health.status, "Healthy");
  assert.equal(
    evaluateSourceHealth(daily, observation({ publisher_updated_at: staleForDaily }), { now: NOW }).status,
    "Delayed",
  );
  assert.equal(
    publicProjection.sources.find((row) => row.source_id === "daily-source").health.status,
    "Healthy",
  );
  assert.equal(desk.sources.find((row) => row.id === "slow-periodic").health.status, "Healthy");
});

test("failed acquisition with a valid last-known-good is degraded on every surface", () => {
  const source = contract({ id: "lkg-source" });
  const { canonical, publicProjection, desk } = projectSurfaces(
    { contracts: [source] },
    {
      scheduleObservations: [{
        source_id: "lkg-source",
        observed_at: NOW,
        status: "failed",
        publisher_updated_at: "2026-08-12T12:00:00.000Z",
        exact_error: "HTTP 503 from publisher; publisher-diagnostic-fixture",
        path: ".external-schedule-state/results/source-contracts-live/fixture.json",
        adapter: "source-contracts-live",
        run_id: "lkg-run",
      }],
      serveObservations: [{
        source_id: "lkg-source",
        at: "2026-08-18T09:00:00.000Z",
        status: "current",
        fallback_valid: true,
        path: "site/data/fixture_lookup.json",
      }],
    },
  );
  const row = canonical.observations[0];
  assert.equal(row.health.status, "Degraded");
  assert.deepEqual(row.health.reason_codes, ["acquisition-failed", "serving-valid-fallback"]);
  assert.equal(publicProjection.sources[0].health.status, "Degraded");
  assert.equal(desk.sources[0].health.status, "Degraded");
  assert.equal(desk.sources[0].serving_fallback.active, true);
  assert.match(JSON.stringify(desk.sources[0].runs), /HTTP 503 from publisher/);
  assert.doesNotMatch(JSON.stringify(publicProjection), /publisher-diagnostic-fixture|SOURCE_API_TOKEN|HTTP 503/);
});

test("orphan and duplicate identities fail on canonical, public, and desk surfaces", () => {
  const registry = { contracts: [contract()] };
  assert.deepEqual(validateSourceHealthProjection(registry, {
    observations: [{ source_id: "daily-source" }, { source_id: "daily-source" }],
  }), ["daily-source: duplicate source health observation"]);
  assert.deepEqual(validateSourceHealthProjection(registry, {
    observations: [{ source_id: "orphan" }],
  }), ["orphan: source health observation has no canonical contract"]);
  assert.deepEqual(validateSourceHealthProjection({
    contracts: [contract(), contract()],
  }, { observations: [] }), ["daily-source: duplicate source contract id"]);

  const healthy = {
    generated_at: NOW,
    observations: [observation({
      health: { status: "Healthy", reason_codes: [], clocks: {} },
    })],
  };
  assert.throws(
    () => buildPublicSourceHealthProjection(registry, {
      generated_at: NOW,
      observations: [observation({ source_id: "orphan" })],
    }),
    /no canonical contract/,
  );
  assert.throws(
    () => buildPublicSourceHealthProjection(registry, {
      generated_at: NOW,
      observations: [healthy.observations[0], healthy.observations[0]],
    }),
    /duplicate observation/,
  );
  assert.throws(
    () => buildDataSourceGraph({
      registry,
      healthObservations: { observations: [{ source_id: "orphan" }] },
    }),
    /no canonical contract/,
  );
  assert.throws(
    () => buildDataSourceGraph({
      registry,
      healthObservations: { observations: [{ source_id: "daily-source" }, { source_id: "daily-source" }] },
    }),
    /duplicate desk health observation/,
  );
});

test("schema-drift health statuses fail closed instead of shipping a public alias", () => {
  const registry = { contracts: [contract()] };
  assert.deepEqual(validateSourceHealthProjection(registry, {
    observations: [{ source_id: "daily-source", health: { status: "OK" } }],
  }), ["daily-source: invalid health status OK"]);
  const publicProjection = buildPublicSourceHealthProjection(registry, {
    generated_at: NOW,
    observations: [{
      source_id: "daily-source",
      health: {
        status: "Stale",
        reason_codes: [],
        clocks: {
          publisher_updated: { at: NOW, state: "KNOWN", basis: "publisher_record" },
          cityscroll_checked_acquired: { at: NOW, state: "KNOWN", basis: "cityscroll_acquisition" },
          cityscroll_serving: { at: NOW, state: "KNOWN", basis: "cityscroll_materialization" },
        },
      },
    }],
  });
  assert.equal(publicProjection.sources[0].health.status, "UNKNOWN");
  assert.notEqual(publicProjection.sources[0].health.status, "Stale");
});

test("committed historical and pointer sources never inherit another source's age alarm", () => {
  const registry = loadSourceContracts();
  const observations = JSON.parse(readFileSync(new URL("../site/data/source_health_observations.json", import.meta.url)));
  const publicProjection = JSON.parse(readFileSync(new URL("../site/data/source_health_public.json", import.meta.url)));
  const byId = new Map(observations.observations.map((row) => [row.source_id, row]));
  for (const source of registry.contracts) {
    const row = byId.get(source.id);
    assert.ok(row, source.id);
    if (source.freshness_contract.mode === "historical") {
      assert.equal(row.health.status, "Historical", source.id);
      assert.equal(row.health.reason_codes.includes("historical-source"), true, source.id);
      assert.equal(row.health.reason_codes.some((code) => /stale/.test(code)), false, source.id);
    }
    if (source.freshness_contract.mode === "pointer") {
      assert.notEqual(row.health.status, "Delayed", source.id);
      assert.equal(row.health.reason_codes.some((code) => /stale/.test(code)), false, source.id);
    }
  }
  const publicIds = new Set(publicProjection.sources.map((row) => row.source_id));
  for (const source of registry.contracts) {
    if (source.health_policy.public_visibility === "backstage-only") {
      assert.equal(publicIds.has(source.id), false, source.id);
    }
  }
  assert.deepEqual(publicSourceHealthProjectionLeaks(publicProjection), []);
});
