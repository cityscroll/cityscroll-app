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
  const receipt = pointer.consumer_handoff.receipt;
  assert.equal(receipt.status, "retained");
  for (const field of ["repository", "path", "commit", "run_key", "owner", "entry_command"]) {
    assert.equal(typeof receipt[field], "string", `retained receipt requires ${field}`);
    assert.notEqual(receipt[field], "", `retained receipt requires a non-empty ${field}`);
  }
  assert.equal(receipt.repository, "fiduciary-heartbeat");
  assert.equal(receipt.path, "docs/evidence/weekly-review-guide-review-consumer-receipt.json");
  assert.equal(receipt.commit, "262b23f400e7ca2e6327737d956b35db38d0b551");
  assert.equal(receipt.run_key, pointer.producer.run_key);
  assert.equal(receipt.folded_section.section_id, "guide-review-2026-W39");
  assert.equal(receipt.folded_section.section_count, 1);
  assert.deepEqual(receipt.replay_result.new_finding_ids, []);
  assert.equal(receipt.replay_result.section_count, 1);
  assert.match(pointer.assertions["A2-replay"], /zero new items/);
});
