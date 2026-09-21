import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const EVIDENCE = join(ROOT, "docs/evidence/public-user-guide/guide-review");
const pointer = JSON.parse(readFileSync(join(EVIDENCE, "consumer-handoff-pointer.json"), "utf8"));
const report = JSON.parse(readFileSync(join(EVIDENCE, pointer.producer.report), "utf8"));
const section = readFileSync(join(EVIDENCE, pointer.producer.section), "utf8");

test("retained producer packet names one guide-review section and its source report", () => {
  assert.equal(pointer.schema, "cityscroll.guide_review_handoff_pointer.v1");
  assert.equal(report.schema, pointer.producer.report_schema);
  assert.equal(report.job_id, "guide-review");
  assert.equal(report.checked_at, pointer.producer.checked_at);
  assert.equal(report.run_key, pointer.producer.run_key);
  assert.equal(report.observed_commit, pointer.producer.observed_commit);
  assert.equal(report.content_hash, pointer.producer.content_hash);
  assert.equal((section.match(/^## Guide review$/gm) || []).length, 1);
});

test("retained packet keeps the consumer receipt boundary honest", () => {
  assert.deepEqual(pointer.consumer_handoff.deduplication_keys, ["job_id", "run_key", "finding_id"]);
  assert.match(pointer.consumer_handoff.required_receipt_assertions[0], /one guide-review section/);
  assert.match(pointer.consumer_handoff.required_receipt_assertions[1], /zero duplicate/);
  assert.equal(pointer.consumer_handoff.receipt.status, "not retained in this repository");
  assert.equal(pointer.consumer_handoff.receipt.storage_location, "not declared by the private consumer");
  assert.match(pointer.assertions["A2-replay"], /does not relabel a local rehearsal/);
});
