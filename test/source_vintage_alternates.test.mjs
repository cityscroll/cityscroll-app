import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { loadSourceContracts } from "../tools/source_contracts.mjs";
import {
  loadSourceVintageAlternates,
  validateSourceVintageAlternates,
} from "../tools/source_vintage_alternates.mjs";
import {
  buildSourceVintageStatusProjection,
  classifySourceVintage,
  loadSourceVintageStatusInputs,
} from "../tools/source_vintage_status.mjs";

test("the committed registry is source-qualified, evidenced, and valid", () => {
  const registry = loadSourceVintageAlternates();
  const contracts = loadSourceContracts();
  assert.deepEqual(validateSourceVintageAlternates(registry, contracts), []);
  assert.deepEqual(registry.alternates.map((row) => row.alternate_id), ["comptroller-acfr"]);
  const acfr = registry.alternates[0];
  assert.equal(acfr.canonical_source_id, "ibo-fiscal-history");
  assert.equal(acfr.observed_coverage.max_fiscal_year, 2025);
  assert.equal(acfr.publisher_vintage, "FY2025");
  assert.equal(acfr.verification_state, "verified");
});

test("duplicate and orphan alternates are rejected", () => {
  const registry = loadSourceVintageAlternates();
  const contracts = loadSourceContracts();
  const duplicate = structuredClone(registry);
  duplicate.alternates.push(structuredClone(duplicate.alternates[0]));
  assert.match(validateSourceVintageAlternates(duplicate, contracts).join("\n"), /duplicate alternate_id/);

  const orphan = structuredClone(registry);
  orphan.alternates[0].canonical_source_id = "missing-source";
  assert.match(validateSourceVintageAlternates(orphan, contracts).join("\n"), /orphan canonical_source_id/);
});

test("ACFR is a verified newer context pointer, never a staffing replacement", () => {
  const contracts = loadSourceContracts();
  const inputs = loadSourceVintageStatusInputs(new URL("../", import.meta.url).pathname);
  const projection = buildSourceVintageStatusProjection({
    registry: contracts,
    vintageObservations: inputs.vintageObservations,
    healthObservations: inputs.healthObservations,
    alternateRegistry: inputs.alternateRegistry,
    asOf: "2026-08-28T00:00:00Z",
  });
  const result = projection.observations.find((row) => row.source_id === "ibo-fiscal-history");
  assert.equal(result.status, "source-vintage-stale");
  assert.deepEqual(result.newer_alternate_source_ids, ["comptroller-acfr"]);
  assert.deepEqual(result.replacement_source_ids, []);
  assert.equal(result.alternates[0].replacement_eligible, false);
});

test("unverified evidence cannot drive a stale diagnosis", () => {
  const source = {
    source_id: "fixture-source",
    alternate_source_ids: ["newer-source"],
    observed_coverage: { max_fiscal_year: 2022, basis: "fixture" },
    cityscroll_retrieval: { status: "succeeded", retrieved_at: "2026-08-20T00:00:00Z" },
  };
  const alternate = {
    ...loadSourceVintageAlternates().alternates[0],
    alternate_id: "newer-source",
    canonical_source_id: "fixture-source",
    verification_state: "suspected",
  };
  const result = classifySourceVintage({
    contract: { id: "fixture-source", alternate_source_ids: ["newer-source"] },
    source,
    alternateRegistry: { alternates: [alternate] },
  });
  assert.equal(result.status, "current");
  assert.deepEqual(result.newer_alternate_source_ids, []);
});

test("the registry remains a backstage artifact and does not become a public source contract", () => {
  const sourceContracts = JSON.parse(readFileSync(new URL("../site/data/source_contracts.json", import.meta.url)));
  assert.equal(sourceContracts.contracts.some((row) => row.id === "comptroller-acfr"), false);
});
