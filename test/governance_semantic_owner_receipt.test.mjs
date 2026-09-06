import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("the semantic-owner receipt covers every migrated candidate without duplicates", () => {
  const result = spawnSync(process.execPath, ["tools/governance_semantic_owner_receipt.mjs", "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const receipt = JSON.parse(readFileSync("docs/repository-governance/semantic-owner-mapping.v1.json", "utf8"));
  assert.equal(receipt.coverage.frontier_entries, 33);
  assert.equal(receipt.coverage.lens_candidates, 5);
  assert.equal(receipt.frontier_reconciliation.declared_count_before, 31);
  assert.equal(receipt.frontier_reconciliation.source_of_truth_count, 33);
  assert.equal(new Set(receipt.items.map((item) => item.manifest_id)).size, receipt.items.length);
  assert.deepEqual(receipt.clean_checkout_proof.deliberately_public_roadmap_phrase_hits, []);
  assert.equal(receipt.clean_checkout_proof.retained_frontier_records_with_source_and_measurement_fields, 33);
});
