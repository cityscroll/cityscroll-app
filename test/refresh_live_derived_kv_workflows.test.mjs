import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("live-derived daily caches are not refreshed through git PRs", () => {
  assert.equal(
    fs.existsSync(path.join(ROOT, ".github/workflows/payroll-title-warehouse-lookup.yml")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, ".github/workflows/land-upcoming-hearings.yml")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, ".github/workflows/land-zap-freshness-refresh.yml")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, ".github/workflows/staffing-exams-refresh.yml")),
    false,
  );
  const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.doesNotMatch(ci, /payroll-title-warehouse-lookup/);
  assert.doesNotMatch(ci, /land-upcoming-hearings/);
  assert.doesNotMatch(ci, /land-zap-freshness-refresh/);
  assert.doesNotMatch(ci, /staffing-exams-refresh/);
  const policy = fs.readFileSync(path.join(ROOT, "tools/merge_queue_policy.json"), "utf8");
  assert.doesNotMatch(policy, /payroll-title-warehouse-lookup/);
  assert.doesNotMatch(policy, /land-upcoming-hearings/);
  assert.doesNotMatch(policy, /land-zap-freshness-refresh/);
  assert.doesNotMatch(policy, /staffing-exams-refresh/);
});
