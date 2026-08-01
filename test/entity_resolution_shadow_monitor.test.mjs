import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SHADOW_MONITOR_SCHEMA_VERSION,
  SHADOW_MONITOR_VERSION,
  buildShadowMonitorReceipt,
  compareShadowMonitorReceipts,
} from "../entity_resolution/evaluation/shadow_monitoring.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "entity_resolution/eval/fixtures/shadow_monitoring_v0.json");
const RECEIPT = join(ROOT, "entity_resolution/eval/monitoring/2026-08-01/receipt.json");
const CLI = join(ROOT, "tools/run_er_shadow_monitor.mjs");

function fixture() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

test("fixture monitor exposes rates with denominators, distributions, growth, and freshness", () => {
  const receipt = buildShadowMonitorReceipt(fixture());
  assert.equal(receipt.schema_version, SHADOW_MONITOR_SCHEMA_VERSION);
  assert.equal(receipt.monitor_version, SHADOW_MONITOR_VERSION);
  assert.deepEqual(receipt.signals.authority.candidate_recall, {
    status: "measured",
    numerator: 1,
    denominator: 1,
    value: 1,
    caveat: null,
  });
  assert.equal(receipt.signals.candidates.unresolved_rate.numerator, 2);
  assert.equal(receipt.signals.candidates.unresolved_rate.denominator, 4);
  assert.equal(receipt.signals.candidates.false_split_leads_per_observation.value, 0.4);
  assert.deepEqual(receipt.signals.candidates.score_distribution.buckets, {
    "[0,0.5)": 0,
    "[0.5,0.8)": 2,
    "[0.8,0.9)": 0,
    "[0.9,0.95)": 0,
    "[0.95,1]": 2,
  });
  assert.equal(receipt.signals.clusters.expanded_clusters, 2);
  assert.equal(receipt.signals.clusters.link_growth_rate.value, 1.5);
  assert.equal(receipt.signals.coverage.orphan_rate.value, 0.2);
  assert.equal(receipt.signals.contradiction_rate.value, 0.25);
  assert.equal(receipt.signals.coverage.shadow_capture_coverage.denominator, 6);
  assert.equal(receipt.signals.source_freshness.stale_sources, 1);
  assert.deepEqual(
    receipt.signals.source_freshness.sources.map((source) => [source.source_system, source.state]),
    [["city_record", "fresh"], ["passport", "stale"]],
  );
  assert.equal(receipt.signals.resolution_runs.emitted_score_distributions, 1);
  assert.deepEqual(Object.keys(receipt.input.source_snapshot_sha256), ["city_record", "passport"]);
  assert.ok(Object.values(receipt.input.relation_sha256).every((hash) => /^[a-f0-9]{64}$/.test(hash)));
});

test("missing inputs are insufficient, never confident zero rates", () => {
  const receipt = buildShadowMonitorReceipt({
    observed_at: "2026-08-01T12:00:00.000Z",
    source_records: [],
    entity_links: [],
    resolution_runs: [],
    current_records: [],
  });
  for (const signal of [
    receipt.signals.authority.candidate_recall,
    receipt.signals.authority.authority_conflict_auto_link_rate,
    receipt.signals.candidates.unresolved_rate,
    receipt.signals.coverage.orphan_rate,
    receipt.signals.coverage.shadow_capture_coverage,
    receipt.signals.contradiction_rate,
    receipt.signals.clusters.link_growth_rate,
  ]) {
    assert.equal(signal.status, "insufficient");
    assert.equal(signal.denominator, 0);
    assert.equal(signal.value, null);
  }
  assert.equal(receipt.signals.source_freshness.status, "insufficient");
  assert.ok(receipt.caveats.some((line) => /No source records/.test(line)));
});

test("receipt comparison accepts compatible policy windows and refuses version drift", () => {
  const baseline = buildShadowMonitorReceipt(fixture());
  const current = buildShadowMonitorReceipt(fixture(), { baseline });
  assert.equal(current.comparison.status, "compatible");
  assert.deepEqual(current.comparison.deltas, {
    candidate_recall: 0,
    unresolved_rate: 0,
    orphan_rate: 0,
    contradiction_rate: 0,
  });

  const changed = structuredClone(baseline);
  changed.policy_versions.matcher = "conventional_v_next";
  const comparison = compareShadowMonitorReceipts(baseline, changed);
  assert.equal(comparison.status, "incompatible");
  assert.deepEqual(comparison.reasons, ["policy_versions_changed"]);
  assert.deepEqual(comparison.deltas, {});
});

test("committed monitoring receipt reproduces the fixture snapshot", () => {
  const generated = buildShadowMonitorReceipt(fixture());
  const committed = JSON.parse(readFileSync(RECEIPT, "utf8"));
  assert.deepEqual(committed, generated);
  assert.match(committed.input.snapshot_sha256, /^[a-f0-9]{64}$/);
});

test("CLI fixture mode prints stable signal keys and validates the receipt", () => {
  const result = spawnSync(process.execPath, [CLI, "--fixture", "--out", RECEIPT, "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^candidate_recall_numerator=1$/m);
  assert.match(result.stdout, /^unresolved_rate_denominator=4$/m);
  assert.match(result.stdout, /^contradiction_rate=0\.25$/m);
  assert.match(result.stdout, /^source_freshness_status=measured$/m);
  assert.doesNotMatch(result.stdout, /INSERT|UPDATE|DELETE|public route/i);
});
