//   node --test test/ulurp_recommendation_panel.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isUlurpRecommendationEligible,
  recommendationsForProject,
  renderUlurpRecommendationPanel,
} from "../site/ulurp_recommendation_panel.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const lookup = JSON.parse(readFileSync(
  join(ROOT, "site/data/ulurp_recommendations_lookup.json"),
  "utf8",
));

test("Property Disposition is never eligible for the ULURP recommendation panel", () => {
  assert.equal(isUlurpRecommendationEligible({
    project_id: "x",
    lens: "Property Disposition",
    ulurp_numbers: "210033ZMK",
  }), false);
  assert.equal(isUlurpRecommendationEligible({
    wrong_universe: "property_disposition",
    ulurp_numbers: "210033ZMK",
  }), false);
});

test("lookup hit renders a sparse panel; miss omits HTML", () => {
  // Pick any key present in the live lookup.
  const key = Object.keys(lookup.by_ulurp_key)[0];
  assert.ok(key);
  const hit = recommendationsForProject(lookup, {
    project_id: "demo",
    ulurp_numbers: key,
  });
  assert.ok(hit);
  const html = renderUlurpRecommendationPanel(hit, {
    esc: (v) => String(v ?? ""),
  });
  assert.match(html, /ulurp-recommendation-panel/);
  assert.equal(
    renderUlurpRecommendationPanel(null),
    "",
  );
  assert.equal(
    recommendationsForProject(lookup, {
      project_id: "nope",
      ulurp_numbers: "999999ZZZ",
    }),
    null,
  );
});

test("source contracts are live after recommendation-row re-gate", async () => {
  const { loadSourceContracts } = await import("../tools/source_contracts.mjs");
  const registry = loadSourceContracts();
  for (const id of ["ulurp-recommendations", "ulurp-recommendation-pdfs"]) {
    const contract = registry.contracts.find((c) => c.id === id);
    assert.ok(contract, id);
    assert.equal(contract.status, "live");
    assert.match(contract.join_measurement.verdict, /recommendation-row|Above usefulness/i);
  }
});
