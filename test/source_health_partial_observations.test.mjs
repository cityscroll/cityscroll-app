import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSourceHealth,
  normalizeClock,
} from "../ontology/source_health.mjs";
import { buildSourceHealthObservations } from "../tools/source_health_observations.mjs";
import {
  buildPublicSourceHealthProjection,
  publicSourceHealthProjectionLeaks,
  validatePublicSourceHealthProjection,
} from "../site/source_health_public_projection.mjs";
import { buildDataSourceGraph } from "../tools/data_source_graph.mjs";

const NOW = "2026-08-18T12:00:00.000Z";
const CLOCKS = [
  "publisher_updated",
  "cityscroll_checked_acquired",
  "cityscroll_serving",
];
const INVALID_CLOCKS = [null, undefined, "", 0, "0", "1970-01-01T00:00:00.000Z", "not-a-date"];

function contract(id, overrides = {}) {
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
    freshness_contract: {
      mode: "continuous",
      max_stale_days: 7,
      clock_basis: "publisher_updated",
      serving_max_age_days: null,
      serve_contract_id: null,
    },
    health_policy: {
      public_visibility: "public",
      backstage_detail: "receipts-and-errors",
      relationship_coverage: "separate",
    },
    ...overrides,
  };
}

function observation(id, overrides = {}) {
  return {
    source_id: id,
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

test("a missing observation is unavailable or UNKNOWN, never a healthy epoch", () => {
  const source = contract("missing-observation");
  const evaluated = evaluateSourceHealth(source, null, { now: NOW });
  assert.equal(evaluated.status, "Source-unavailable");
  assert.deepEqual(evaluated.reason_codes, ["observation-missing"]);
  for (const clockName of CLOCKS) {
    assert.equal(evaluated.clocks[clockName].at, null);
    assert.equal(evaluated.clocks[clockName].state, "UNKNOWN");
  }
  assert.doesNotMatch(JSON.stringify(evaluated), /1970|epoch/i);

  const canonical = buildSourceHealthObservations(
    { contracts: [source] },
    { asOf: NOW },
  );
  const row = canonical.observations[0];
  assert.equal(row.health.status, "Source-unavailable");
  assert.deepEqual(row.health.reason_codes, ["acquisition-status-unknown"]);

  const publicProjection = buildPublicSourceHealthProjection({ contracts: [source] }, canonical);
  assert.equal(publicProjection.sources[0].health.status, "UNKNOWN");
  for (const clockName of CLOCKS) {
    assert.equal(publicProjection.sources[0].health.clocks[clockName].at, null);
    assert.equal(publicProjection.sources[0].health.clocks[clockName].state, "UNKNOWN");
    assert.equal(publicProjection.sources[0].health.clocks[clockName].basis, null);
  }

  const desk = buildDataSourceGraph({
    registry: { contracts: [source] },
    healthObservations: { observations: [] },
  });
  assert.equal(desk.sources[0].health.status, "Unknown");
  assert.equal(desk.sources[0].clocks.publisher_updated.at, null);
  assert.doesNotMatch(JSON.stringify(publicProjection), /1970|epoch/i);
});

test("partial acquisition is limited coverage on evaluator, public, and desk", () => {
  const source = contract("partial-source");
  const evaluated = evaluateSourceHealth(
    source,
    observation("partial-source", { acquisition_status: "partial" }),
    { now: NOW },
  );
  assert.equal(evaluated.status, "Limited-coverage");
  assert.deepEqual(evaluated.reason_codes, ["acquisition-partial"]);

  const canonical = buildSourceHealthObservations(
    { contracts: [source] },
    {
      asOf: NOW,
      scheduleObservations: [{
        source_id: "partial-source",
        observed_at: NOW,
        status: "partial",
        publisher_updated_at: "2026-08-12T12:00:00.000Z",
      }],
    },
  );
  assert.equal(canonical.observations[0].health.status, "Limited-coverage");

  const publicProjection = buildPublicSourceHealthProjection({ contracts: [source] }, canonical);
  const desk = buildDataSourceGraph({
    registry: { contracts: [source] },
    healthObservations: canonical,
  });
  assert.equal(publicProjection.sources[0].health.status, "Limited-coverage");
  assert.equal(desk.sources[0].health.status, "Limited-coverage");
  assert.equal(canonical.observations[0].relationship_coverage.status, "not-declared");
});

test("invalid or missing clocks stay null UNKNOWN on every surface", () => {
  for (const value of INVALID_CLOCKS) {
    assert.deepEqual(normalizeClock(value, "fixture"), {
      at: null,
      state: "UNKNOWN",
      basis: null,
    });
  }
  const source = contract("bad-clocks");
  const evaluated = evaluateSourceHealth(
    source,
    observation("bad-clocks", {
      publisher_updated_at: 0,
      checked_at: "bad",
      acquired_at: null,
      serving: {},
    }),
    { now: NOW },
  );
  for (const clockName of CLOCKS) {
    assert.equal(evaluated.clocks[clockName].at, null);
    assert.equal(evaluated.clocks[clockName].state, "UNKNOWN");
  }
  assert.doesNotMatch(JSON.stringify(evaluated), /1970|epoch/i);

  const publicProjection = buildPublicSourceHealthProjection(
    { contracts: [source, contract("absent-source")] },
    {
      generated_at: NOW,
      observations: [{
        source_id: "bad-clocks",
        health: {
          status: "Source-unavailable",
          reason_codes: ["acquisition-status-unknown"],
          clocks: {
            publisher_updated: { at: "1970-01-01T00:00:00.000Z", state: "KNOWN", basis: "PRIVATE_ENV_NAME" },
            cityscroll_checked_acquired: { at: "not-a-date", state: "KNOWN", basis: "checked_at" },
          },
        },
      }],
    },
  );
  assert.deepEqual(publicProjection.sources.map((row) => row.source_id), ["absent-source", "bad-clocks"]);
  for (const row of publicProjection.sources) {
    assert.equal(row.health.status, "UNKNOWN");
    for (const clockName of CLOCKS) {
      assert.equal(row.health.clocks[clockName].at, null);
      assert.equal(row.health.clocks[clockName].state, "UNKNOWN");
      assert.equal(row.health.clocks[clockName].basis, null);
    }
  }
  assert.deepEqual(validatePublicSourceHealthProjection(publicProjection, {
    contracts: [source, contract("absent-source")],
  }), []);
  assert.doesNotMatch(JSON.stringify(publicProjection), /1970|epoch|PRIVATE_ENV_NAME/);
});

test("an incomplete observation envelope still projects honest UNKNOWN values", () => {
  const source = contract("incomplete");
  const publicProjection = buildPublicSourceHealthProjection(
    { contracts: [source] },
    { generated_at: NOW, observations: [{ source_id: "incomplete" }] },
  );
  const row = publicProjection.sources[0];
  assert.equal(row.health.status, "UNKNOWN");
  assert.equal(row.relationship_coverage.status, "UNKNOWN");
  assert.equal(row.relationship_coverage.measured_at, null);
  assert.deepEqual(publicSourceHealthProjectionLeaks(publicProjection), []);
});

test("partial relationship coverage stays a separate axis from acquisition health", () => {
  const source = contract("coverage-partial");
  const canonical = buildSourceHealthObservations(
    { contracts: [source] },
    {
      asOf: NOW,
      scheduleObservations: [{
        source_id: "coverage-partial",
        observed_at: NOW,
        status: "succeeded",
        publisher_updated_at: "2026-08-12T12:00:00.000Z",
      }],
      coverageCensus: {
        sources: [{
          id: "coverage-partial",
          dual_write: { after: "partial" },
          live_observation: {
            status: "partial",
            row_count: 4,
            measured_at: NOW,
          },
        }],
      },
    },
  );
  const row = canonical.observations[0];
  assert.equal(row.health.status, "Healthy");
  assert.equal(row.relationship_coverage.status, "partial");
  const publicProjection = buildPublicSourceHealthProjection({ contracts: [source] }, canonical);
  const desk = buildDataSourceGraph({
    registry: { contracts: [source] },
    healthObservations: canonical,
  });
  assert.equal(publicProjection.sources[0].health.status, "Healthy");
  assert.equal(publicProjection.sources[0].relationship_coverage.status, "limited_coverage");
  assert.equal("row_count" in publicProjection.sources[0].relationship_coverage, false);
  assert.equal(desk.sources[0].join_gate.status, "partial");
  assert.equal(desk.sources[0].join_gate.row_count, 4);
});

test("committed public rows keep UNKNOWN clocks instead of epoch placeholders", () => {
  const publicProjection = JSON.parse(readFileSync(
    new URL("../site/data/source_health_public.json", import.meta.url),
  ));
  assert.ok(publicProjection.sources.some((row) => row.health.status === "UNKNOWN"));
  for (const row of publicProjection.sources) {
    for (const clockName of CLOCKS) {
      const clock = row.health.clocks[clockName];
      if (clock.state === "UNKNOWN") {
        assert.equal(clock.at, null, `${row.source_id}.${clockName}`);
        assert.equal(clock.basis, null, `${row.source_id}.${clockName}`);
      }
      if (clock.at) assert.doesNotMatch(clock.at, /^1970-/);
    }
  }
  assert.doesNotMatch(JSON.stringify(publicProjection), /1970-01-01|epoch/i);
});
