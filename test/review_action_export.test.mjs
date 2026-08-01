import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  exportReviewActionsToGoldCases,
  formatReviewActionGoldJsonl,
  normalizeReviewActionRow,
} from "../entity_resolution/eval/review_action_export.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = JSON.parse(readFileSync(
  join(ROOT, "entity_resolution/eval/fixtures/review_actions_v0.json"),
  "utf8",
));

test("normalizeReviewActionRow exports same/different and skips defer without personal data", () => {
  const same = normalizeReviewActionRow(FIXTURE.rows[0]);
  assert.equal(same.status, "exportable");
  assert.equal(same.decision, "same");
  assert.equal(same.left.display_name.includes("HNTB"), true);

  const deferred = normalizeReviewActionRow(FIXTURE.rows[2]);
  assert.equal(deferred.status, "skipped");
  assert.equal(deferred.reason, "non_exportable_decision");

  const fixtureEmail = ["reviewer", "example.com"].join("@");
  const withActor = normalizeReviewActionRow({
    ...FIXTURE.rows[0],
    actor: fixtureEmail,
    note: "private free text",
    email: fixtureEmail,
  });
  const encoded = JSON.stringify(withActor);
  assert.equal(encoded.includes(fixtureEmail), false);
  assert.equal(encoded.includes("private free text"), false);
  assert.equal(encoded.includes("reviewer"), false);
});

test("exportReviewActionsToGoldCases builds known arithmetic and provenance", () => {
  const exported = exportReviewActionsToGoldCases(FIXTURE.rows, {
    goldVersion: "v1",
    exportedOn: "2026-08-01",
  });
  assert.equal(exported.cases.length, 2);
  assert.equal(exported.skipped.length, 1);
  assert.equal(exported.receipt.exportable_cases, 2);
  assert.equal(exported.receipt.skipped_rows, 1);
  assert.equal(exported.receipt.skipped_reasons.non_exportable_decision, 1);
  assert.deepEqual(exported.cases.map((item) => item.label).sort(), ["different", "same"]);
  for (const item of exported.cases) {
    assert.ok(item.review_action_provenance.action_id);
    assert.ok(item.review_action_provenance.pair_id);
    assert.equal(item.review_action_provenance.export_method, "review_action_export_v1");
  }
  const jsonl = formatReviewActionGoldJsonl(exported.cases, exported.receipt);
  assert.match(jsonl, /"kind":"review_action_gold_candidates"/);
  assert.equal(jsonl.includes("example.com"), false);
});

test("fixture CLI prints deterministic counts", () => {
  const result = spawnSync(
    process.execPath,
    ["tools/export_review_actions_to_gold.mjs", "--fixtures", "--gold-version", "v1"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /exportable_cases=2/);
  assert.match(result.stdout, /skipped_rows=1/);
  assert.match(result.stdout, /skip reason=non_exportable_decision/);
  assert.equal(result.stdout.includes("example.com"), false);
});
