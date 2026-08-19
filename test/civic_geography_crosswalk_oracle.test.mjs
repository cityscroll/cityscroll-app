import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { resolveCivicGeographies } from "../site/civic_geography.mjs";
import { evaluateModaGeographyOracle } from "../tools/lib/civic_geography_oracles.mjs";

const ROOT = new URL("../", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, ROOT), "utf8"));
const registry = readJson("site/data/geography/layer_registry.json");

function simplified(type) {
  const row = registry.layers.find((candidate) => candidate.type === type);
  return readJson(row.artifacts.simplified.site_path);
}

test("pinned MODA oracle is skipped, not passed, when 25C and 26B inputs differ", () => {
  const oracle = readJson("data/geography/oracles/moda-v2025.09.29.json");
  const evaluation = evaluateModaGeographyOracle(registry, oracle);
  assert.deepEqual(evaluation, {
    status: "skipped",
    reason: "vintage_mismatch",
    mismatches: [
      { type: "nta2020", oracle: "25C", current: "26B" },
      { type: "police_precinct", oracle: "25C", current: "26B" },
    ],
  });
  assert.equal(oracle.evaluation.status, "skipped");
  assert.equal(oracle.runtime_dependency, false);
  assert.ok(Object.values(oracle.artifacts).every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
});

test("MapPLUTO cross-checks agree for applicable native keys and never override geometry", () => {
  const qa = readJson("data/geography/qa/first_four_pluto_cross_checks.json");
  const types = ["police_precinct", "sanitation_district"];
  const layers = types.map(simplified);
  assert.equal(qa.applicability.nta2020.status, "not_applicable");
  assert.equal(qa.applicability.business_improvement_district.status, "not_applicable");
  for (const row of qa.rows) {
    assert.equal(String(row.published.PolicePrct), row.expected.police_precinct);
    assert.equal(`${row.published.Sanitboro}${row.published.SanitDistrict}`, row.expected.sanitation_district);
    const result = resolveCivicGeographies(row.lat, row.lon, { types, layerData: layers });
    assert.equal(result.matches.find((match) => match.type === "police_precinct")?.id, row.expected.police_precinct);
    assert.equal(result.matches.find((match) => match.type === "sanitation_district")?.id, row.expected.sanitation_district);
  }
  assert.deepEqual(qa.result, { status: "matched", checked_rows: 5, disagreements: 0 });
  assert.match(qa.policy, /never overrides authoritative layer geometry/);
});

test("each acquisition receipt binds the same PIP, PLUTO, and oracle QA surfaces", () => {
  for (const type of ["nta2020", "police_precinct", "sanitation_district", "business_improvement_district"]) {
    const row = registry.layers.find((candidate) => candidate.type === type);
    const receipt = readJson(row.receipt.path);
    assert.equal(receipt.qa.point_canaries, "data/geography/qa/first_four_point_canaries.json");
    assert.equal(receipt.qa.pluto_cross_checks, "data/geography/qa/first_four_pluto_cross_checks.json");
    assert.equal(receipt.qa.moda_oracle, "data/geography/oracles/moda-v2025.09.29.json");
  }
});
