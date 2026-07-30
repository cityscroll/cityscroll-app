// Characterization: Capital Projects (n7gv-k5yt) recon join is below usefulness.
//   node --test test/capital_projects_join.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCapitalProjectIndex,
  joinTitleToCapitalProject,
  joinTitleToCapitalProjectFuzzy,
} from "../worker/src/lib/capital_projects_join.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const receipt = JSON.parse(
  readFileSync(
    join(ROOT, "site/data/capital_project_sources/verification_receipts/capital_projects_2026-07-30.json"),
    "utf8",
  ),
);
const contracts = JSON.parse(readFileSync(join(ROOT, "site/data/source_contracts.json"), "utf8"));
const registry = JSON.parse(readFileSync(join(ROOT, "site/data/gap_taxonomy.json"), "utf8"));

test("capital-projects source contract is disabled with below-threshold join measurement", () => {
  const c = contracts.contracts.find((x) => x.id === "capital-projects");
  assert.ok(c);
  assert.equal(c.status, "disabled");
  assert.equal(c.dataset_id, "n7gv-k5yt");
  assert.equal(c.join_measurement.pin_or_epin_column, false);
  assert.ok(c.join_measurement.rates.modern_procurement_fuzzy_unique.rate < 0.3);
  assert.ok(c.join_measurement.rates.modern_procurement_substring_unique.rate < 0.3);
  assert.match(c.join_measurement.verdict, /pointer|do not edge-materialize/i);
});

test("verification receipt records kill-criterion failure and curl 200", () => {
  assert.equal(receipt.curl_verified.metadata_http, 200);
  assert.equal(receipt.curl_verified.resource_sample_http, 200);
  assert.equal(receipt.dataset.pin_or_epin_column, false);
  assert.ok(receipt.join_measurement.rates.modern_procurement_fuzzy_unique.rate < 0.3);
  assert.equal(receipt.product_decision.edge_materialization, false);
  assert.equal(receipt.product_decision.gap_id, "procurement-planning-budget");
});

test("procurement-planning-budget pointer names Capital Projects with deep link", () => {
  const gap = registry.gaps.find((g) => g.id === "procurement-planning-budget");
  assert.ok(gap);
  assert.equal(gap.class, "not_published");
  assert.match(gap.would_appear_in, /Capital Projects/i);
  assert.match(gap.would_appear_in, /n7gv-k5yt|data\.cityofnewyork\.us\/d\/n7gv-k5yt/);
  assert.match(gap.evidence, /0%|1%|fuzzy/i);
});

test("unique substring join requires a single clear project_name hit", () => {
  const index = buildCapitalProjectIndex([
    { pid: "1", project_name: "Broadway Bridge over Harlem River Replacement", managing_agency: "DOT" },
    { pid: "2", project_name: "Other Bridge Work", managing_agency: "DOT" },
  ]);
  const hit = joinTitleToCapitalProject(
    "Construction for Broadway Bridge over Harlem River Replacement phase 2",
    index,
  );
  assert.equal(hit?.pid, "1");
  assert.equal(
    joinTitleToCapitalProject("Generic roadway resurfacing solicitation", index),
    null,
  );
});

test("fuzzy jaccard rejects ambiguous multi-match", () => {
  const index = buildCapitalProjectIndex([
    { pid: "1", project_name: "East Side Coastal Resiliency Phase One" },
    { pid: "2", project_name: "East Side Coastal Resiliency Phase Two" },
  ]);
  // Both share many tokens — must not invent a unique join
  assert.equal(
    joinTitleToCapitalProjectFuzzy("East Side Coastal Resiliency construction services", index),
    null,
  );
});
