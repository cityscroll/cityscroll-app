/**
 * node --test test/land_project_geometry_source.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LAND_PARCEL_GEOMETRY_SOURCE_SCHEMA_VERSION,
  assertLandParcelGeometrySource,
  landParcelGeometrySourceFindings,
} from "../site/land_project_geometry.mjs";

const FIXTURE_NOW = "2026-09-02T00:00:00.000Z";

function validDoc(overrides = {}) {
  return {
    schema_version: LAND_PARCEL_GEOMETRY_SOURCE_SCHEMA_VERSION,
    source: { publisher: "NYC Department of City Planning MapPLUTO/PLUTO" },
    mode: "mappluto_arcgis_batch",
    materialized_at: FIXTURE_NOW,
    max_age_days: 120,
    by_bbl: {
      "5007087501": {
        rings: [[
          [-74.1198, 40.6128],
          [-74.1195, 40.6128],
          [-74.1195, 40.6131],
          [-74.1198, 40.6131],
          [-74.1198, 40.6128],
        ]],
      },
    },
    ...overrides,
  };
}

test("a fresh, valid, complete doc passes the serve gate", () => {
  const doc = validDoc();
  assert.deepEqual(landParcelGeometrySourceFindings(doc, { candidateBbls: ["5007087501"] }), []);
  assert.equal(assertLandParcelGeometrySource(doc, { candidateBbls: ["5007087501"] }), true);
});

test("a missing candidate BBL fails closed", () => {
  const doc = validDoc();
  const findings = landParcelGeometrySourceFindings(doc, { candidateBbls: ["5007087501", "1000000001"] });
  assert.ok(findings.some((f) => f.includes("missing candidate BBL 1000000001")));
});

test("an invalid ring on a candidate BBL fails closed", () => {
  const doc = validDoc({ by_bbl: { "5007087501": { rings: [[[-74.1, 40.6]]] } } });
  const findings = landParcelGeometrySourceFindings(doc, { candidateBbls: ["5007087501"] });
  assert.ok(findings.some((f) => f.includes("invalid")));
});

test("stale materialized_at fails closed", () => {
  const doc = validDoc({ materialized_at: "2020-01-01T00:00:00.000Z" });
  const findings = landParcelGeometrySourceFindings(doc, {
    candidateBbls: ["5007087501"],
    now: "2026-09-02T00:00:00.000Z",
  });
  assert.ok(findings.some((f) => f.includes("exceeds max")));
});

test("wrong mode and schema version fail closed", () => {
  const doc = validDoc({ mode: "live_resident_fetch", schema_version: 99 });
  const findings = landParcelGeometrySourceFindings(doc, { candidateBbls: ["5007087501"] });
  assert.ok(findings.some((f) => f.includes("schema_version")));
  assert.ok(findings.some((f) => f.includes("mode")));
});
