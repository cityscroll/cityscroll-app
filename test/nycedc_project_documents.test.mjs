import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";


const runner = readFileSync(new URL("../warehouse/scripts/nycedc_project_documents_run.py", import.meta.url), "utf8");
const schema = JSON.parse(readFileSync(new URL("../warehouse/schemas/nycedc_project_feed.v1.schema.json", import.meta.url), "utf8"));
const fixtureReceipt = JSON.parse(readFileSync(new URL("../warehouse/receipts/proof/rc2_nycedc_project_documents_latest.json", import.meta.url), "utf8"));
const liveReceipt = JSON.parse(readFileSync(new URL("../site/data/nycedc_sources/verification_receipts/nycedc_project_documents_2026-08-04.json", import.meta.url), "utf8"));

test("NYCEDC pure parser and measurement detector suite", () => {
  const result = spawnSync("python3", ["test/test_nycedc_projects.py"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("host collector is checkpointed, bounded, polite, and warehouse-backed", () => {
  assert.match(runner, /IngestLock/);
  assert.match(runner, /check_headroom/);
  assert.match(runner, /checkpoint/);
  assert.match(runner, /time\.sleep\(self\.delay_s\)/);
  assert.match(runner, /HTTP 403, no retry/);
  assert.match(runner, /1 <= args\.limit <= 50/);
  assert.match(runner, /nycedc_documents/);
  assert.match(runner, /nycedc_projects/);
  assert.match(runner, /nycedc_project_notice_edges/);
});

test("payload contract preserves nullable facts and document provenance", () => {
  const required = new Set(schema.required);
  for (const field of ["authority", "project_id", "project_name", "address", "request_id", "requested_benefit", "estimated_public_cost", "project_cost", "milestones", "provenance"]) {
    assert.ok(required.has(field), `missing required contract field ${field}`);
  }
  assert.equal(schema.properties.address.type[1], "null");
  assert.deepEqual(schema.properties.provenance.required, ["source_url", "document_type", "content_sha256", "observed_at", "source_locator"]);
});

test("published receipts enforce the evidence gate", () => {
  assert.equal(fixtureReceipt.bridge_status, "accepted");
  assert.equal(fixtureReceipt.false_positive_review.false_positives, 0);
  assert.ok(fixtureReceipt.sample.join_rate >= fixtureReceipt.threshold);

  assert.equal(liveReceipt.mode, "live");
  assert.equal(liveReceipt.sample.numerator, 5);
  assert.equal(liveReceipt.sample.denominator, 12);
  assert.equal(liveReceipt.false_positive_review.false_positives, 0);
  assert.equal(liveReceipt.false_positive_review.unreviewed_candidates, 0);
  assert.equal(liveReceipt.false_positive_review.decisions.length, 5);
  assert.equal(liveReceipt.honest_absent, 7);
  assert.equal(liveReceipt.bridge_status, "accepted");
  assert.ok(liveReceipt.documents.some((row) => row.document_type === "annual_project_spreadsheet"));
  assert.ok(liveReceipt.counts.indexed_project_documents >= 400);
});
