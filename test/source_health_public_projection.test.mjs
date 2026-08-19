import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPublicSourceHealthProjection,
  publicSourceHealthProjectionLeaks,
  validatePublicSourceHealthProjection,
} from "../site/source_health_public_projection.mjs";
import { buildDataSourceGraph } from "../tools/data_source_graph.mjs";

const GENERATED_AT = "2026-08-18T12:00:00.000Z";

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

function observation(id, overrides = {}) {
  return {
    source_id: id,
    contract_fingerprint: "a".repeat(64),
    health: {
      status: "Healthy",
      reason_codes: [],
      clocks: {
        publisher_updated: {
          at: "2026-08-18T09:00:00.000Z",
          state: "KNOWN",
          basis: "warehouse_source_summary",
        },
        cityscroll_checked_acquired: {
          at: "2026-08-18T10:00:00.000Z",
          state: "KNOWN",
          basis: "acquired_at",
        },
        cityscroll_serving: {
          at: "2026-08-18T11:00:00.000Z",
          state: "KNOWN",
          basis: "serve_contract:private-gate-id",
        },
      },
    },
    relationship_coverage: {
      status: "complete",
      join_status: "accepted",
      row_count: 1234,
      measured_at: "2026-08-18T08:00:00.000Z",
      reason_codes: [],
    },
    evidence: [{ path: "/operator/runbook.json", status: "succeeded" }],
    raw_error_body: "upstream dumped credentials",
    ...overrides,
  };
}

test("public source health is rebuilt from an explicit field allowlist", () => {
  const projection = buildPublicSourceHealthProjection(
    { contracts: [
      contract("public-source", {
        auth_token_env: "PRIVATE_SOURCE_TOKEN",
        operator_runbook: "/ops/source.md",
      }),
      contract("backstage-source", {
        health_policy: { public_visibility: "backstage-only" },
      }),
    ] },
    { generated_at: GENERATED_AT, observations: [observation("public-source")] },
  );

  assert.deepEqual(Object.keys(projection), [
    "schema",
    "generated_at",
    "available",
    "source_count",
    "sources",
  ]);
  assert.equal(projection.schema, "cityscroll.public_source_health.v1");
  assert.equal(projection.available, true);
  assert.equal(projection.source_count, 1);
  assert.deepEqual(projection.sources.map((row) => row.source_id), ["public-source"]);
  assert.deepEqual(Object.keys(projection.sources[0]), [
    "source_id",
    "name",
    "publisher",
    "official_url",
    "expected_cadence",
    "mode",
    "health",
    "relationship_coverage",
  ]);
  assert.equal(projection.sources[0].health.clocks.cityscroll_serving.basis, "cityscroll_materialization");
  assert.equal("row_count" in projection.sources[0].relationship_coverage, false);
  assert.equal(publicSourceHealthProjectionLeaks(projection).length, 0);
  assert.deepEqual(validatePublicSourceHealthProjection(projection, { contracts: [contract("public-source")] }), []);
  assert.doesNotMatch(JSON.stringify(projection), /PRIVATE_SOURCE_TOKEN|runbook|fingerprint|raw_error|1234/i);
});

test("partial and missing observations remain valid UNKNOWN values", () => {
  const projection = buildPublicSourceHealthProjection(
    { contracts: [contract("a-source"), contract("b-source")] },
    {
      generated_at: GENERATED_AT,
      observations: [{
        source_id: "a-source",
        health: {
          status: "Source-unavailable",
          reason_codes: ["acquisition-status-unknown"],
          clocks: { publisher_updated: { at: "not-a-date", basis: "PRIVATE_ENV_NAME" } },
        },
      }],
    },
  );

  assert.deepEqual(projection.sources.map((row) => row.source_id), ["a-source", "b-source"]);
  for (const row of projection.sources) {
    assert.equal(row.health.status, "UNKNOWN");
    assert.equal(row.health.clocks.publisher_updated.state, "UNKNOWN");
    assert.equal(row.health.clocks.publisher_updated.at, null);
    assert.equal(row.health.clocks.publisher_updated.basis, null);
  }
  assert.equal(projection.sources[1].relationship_coverage.status, "UNKNOWN");
  assert.equal(projection.sources[1].relationship_coverage.measured_at, null);
  assert.deepEqual(validatePublicSourceHealthProjection(projection, {
    contracts: [contract("a-source"), contract("b-source")],
  }), []);
  assert.doesNotMatch(JSON.stringify(projection), /1970|epoch|PRIVATE_ENV_NAME/);
});

test("projection rejects orphan or duplicate observation identities", () => {
  const registry = { contracts: [contract("canonical")] };
  assert.throws(
    () => buildPublicSourceHealthProjection(registry, {
      generated_at: GENERATED_AT,
      observations: [observation("orphan")],
    }),
    /no canonical contract/,
  );
  assert.throws(
    () => buildPublicSourceHealthProjection(registry, {
      generated_at: GENERATED_AT,
      observations: [observation("canonical"), observation("canonical")],
    }),
    /duplicate observation/,
  );
});

test("serializer deny-list catches secret-like and operator-only fixture fields", () => {
  const unsafe = {
    schema: "cityscroll.public_source_health.v1",
    generated_at: GENERATED_AT,
    available: true,
    source_count: 1,
    sources: [{
      source_id: "unsafe",
      operator_runbook: "/ops/recover.md",
      auth_token_env: "SOURCE_API_KEY",
      contract_fingerprint: "f".repeat(64),
      raw_error_body: "403 body",
      exact_gate_threshold: 95,
    }],
  };
  const findings = publicSourceHealthProjectionLeaks(unsafe);
  assert.ok(findings.some((finding) => finding.includes("operator_runbook")));
  assert.ok(findings.some((finding) => finding.includes("auth_token_env")));
  assert.ok(findings.some((finding) => finding.includes("contract_fingerprint")));
  assert.ok(findings.some((finding) => finding.includes("raw_error_body")));
  assert.ok(findings.some((finding) => finding.includes("exact_gate_threshold")));
});

test("frontstage and backstage derive from one canonical observation model", () => {
  const registry = {
    contracts: [
      contract("public-source", {
        auth_token_env: "SOURCE_API_TOKEN",
        operator_runbook: "/ops/recover.md",
      }),
      contract("backstage-source", {
        health_policy: { public_visibility: "backstage-only" },
      }),
    ],
  };
  const observations = {
    generated_at: GENERATED_AT,
    observations: [
      observation("public-source", {
        health: {
          status: "Degraded",
          reason_codes: ["acquisition-failed", "serving-valid-fallback"],
          clocks: observation("public-source").health.clocks,
        },
        relationship_coverage: {
          status: "held",
          join_status: "held",
          row_count: 12,
          measured_at: "2026-08-18T08:00:00.000Z",
          reason_codes: ["relationship-join-held"],
        },
        operator: {
          runs: [{
            adapter: "source-contracts-live",
            run_id: "fixture-run",
            at: GENERATED_AT,
            status: "failed",
            receipt_ref: "/operator/runbook.json",
            exact_error: "HTTP 503 from publisher",
          }],
        },
      }),
      observation("backstage-source"),
    ],
  };
  const publicProjection = buildPublicSourceHealthProjection(registry, observations);
  const desk = buildDataSourceGraph({
    registry: {
      contracts: registry.contracts.map((row) => ({
        ...row,
        status: "live",
        delivery_tier: "live-only",
        code_references: [{ path: "worker/src/fixture.mjs", contains: "fixtureAdapter" }],
      })),
    },
    healthObservations: observations,
  });

  assert.deepEqual(publicProjection.sources.map((row) => row.source_id), ["public-source"]);
  const publicRow = publicProjection.sources[0];
  const deskPublic = desk.sources.find((row) => row.id === "public-source");
  const deskBackstage = desk.sources.find((row) => row.id === "backstage-source");
  assert.equal(publicRow.health.status, "Degraded");
  assert.equal(deskPublic.health.status, "Degraded");
  assert.equal(deskPublic.serving_fallback.active, true);
  assert.equal(deskPublic.join_gate.row_count, 12);
  assert.equal(deskPublic.runs[0].exact_error, "HTTP 503 from publisher");
  assert.equal(deskBackstage.health.status, "Healthy");
  assert.equal("row_count" in publicRow.relationship_coverage, false);
  assert.deepEqual(publicSourceHealthProjectionLeaks(publicProjection), []);
  assert.doesNotMatch(
    JSON.stringify(publicProjection),
    /SOURCE_API_TOKEN|runbook|fingerprint|HTTP 503|exact_error|backstage-source/i,
  );
});

test("committed public artifact is canonical, generated, and contains no backstage leaks", () => {
  const registry = JSON.parse(readFileSync(new URL("../site/data/source_contracts.json", import.meta.url)));
  const observations = JSON.parse(readFileSync(new URL("../site/data/source_health_observations.json", import.meta.url)));
  const committed = JSON.parse(readFileSync(new URL("../site/data/source_health_public.json", import.meta.url)));
  assert.deepEqual(committed, buildPublicSourceHealthProjection(registry, observations));
  assert.deepEqual(validatePublicSourceHealthProjection(committed, registry), []);
  assert.deepEqual(publicSourceHealthProjectionLeaks(committed), []);
  assert.ok(committed.sources.length > 0);
  assert.ok(committed.sources.every((row) => registry.contracts.some((contractRow) => contractRow.id === row.source_id)));

  const pagesConfig = readFileSync(new URL("../site/_config.yml", import.meta.url), "utf8");
  assert.match(pagesConfig, /^\s+- data\/source_health_observations\.json$/m);
  assert.doesNotMatch(pagesConfig, /^\s+- data\/source_health_public\.json$/m);
});
