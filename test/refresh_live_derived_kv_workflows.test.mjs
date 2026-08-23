import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("payroll title mart and land upcoming hearings are not refreshed through git PRs", () => {
  assert.equal(
    fs.existsSync(path.join(ROOT, ".github/workflows/payroll-title-warehouse-lookup.yml")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, ".github/workflows/land-upcoming-hearings.yml")),
    false,
  );
  const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.doesNotMatch(ci, /payroll-title-warehouse-lookup/);
  assert.doesNotMatch(ci, /land-upcoming-hearings/);
  const policy = fs.readFileSync(path.join(ROOT, "tools/merge_queue_policy.json"), "utf8");
  assert.doesNotMatch(policy, /payroll-title-warehouse-lookup/);
  assert.doesNotMatch(policy, /land-upcoming-hearings/);
});
