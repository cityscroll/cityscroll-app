import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("RCP-03 receipt covers private evidence and preserves served artifacts", () => {
  const receipt = JSON.parse(readFileSync("docs/repository-control-plane/evidence-placement.v1.json", "utf8"));
  assert.equal(receipt.card, "cityscroll-repository-control-plane/rcp-03");
  assert.equal(receipt.private_inventory.scrim_review.row_count, 1144);
  assert.equal(receipt.private_inventory.document_count, 51);
  assert.equal(receipt.private_inventory.reference_count, 2644);
  assert.equal(receipt.public_result.raw_inventory_rows_retained, 0);
  assert.equal(receipt.public_result.private_reference_occurrences_retained_in_public_content, 0);
  assert.equal(receipt.served_artifact_baseline.sha256, receipt.served_artifact_baseline.expected_after_sha256);

  const output = execFileSync("node", ["tools/rcp03_evidence_placement.mjs", "--check"], { encoding: "utf8" });
  assert.match(output, /served artifacts unchanged/);
});
