import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  aggregateCoverage,
  preserveLastKnownSnapshot,
  validateCoverageEntry
} from "../worker/src/lib/coverage_ledger.mjs";

const ledger = JSON.parse(readFileSync(new URL("../data/coverage_ledger.json", import.meta.url)));
const entries = ledger.processes.flatMap((process) => process.stages);

test("every empty coverage field has a typed missingness reason", () => {
  for (const entry of entries) validateCoverageEntry(entry);
  assert.ok(entries.some((entry) => entry.missing_reason === "source_unavailable"));
  assert.ok(entries.some((entry) => entry.missing_reason === "not_published"));
});

test("a failed probe preserves prior facts with a stale receipt", () => {
  const prior = entries.find((entry) => entry.observed_fields.length);
  const stale = preserveLastKnownSnapshot(prior, {
    attempted_at: "2026-07-29T13:00:00Z",
    status: "failed",
    reason: "upstream_timeout"
  });
  assert.deepEqual(stale.observed_fields, prior.observed_fields);
  assert.equal(stale.content_hash, prior.content_hash);
  assert.equal(stale.fetch_status, "stale");
  assert.equal(stale.stale_receipt.reason, "upstream_timeout");
});

test("aggregate gap counts reconcile to the per-matter ledger", () => {
  assert.deepEqual(aggregateCoverage(entries), ledger.aggregate);
  for (const counts of Object.values(ledger.aggregate)) {
    assert.equal(counts.total, ledger.coverage.process_count);
    assert.equal(counts.complete + counts.partial + counts.missing, counts.total);
  }
});

test("ABO/PARIS blanks remain qualified and never become zero", () => {
  assert.deepEqual(ledger.source_policies.paris_abo, {
    data_quality: "self_reported_unverified",
    reporting_threshold_usd: 5000,
    blank_amount_semantics: "unknown_not_zero"
  });
});
