import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildEntityAuditSample,
  estimateEntityAudit,
  formatEntityAuditLabelSheet,
} from "../../entity_resolution/eval/entity_audit_sampling.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const CLI = join(ROOT, "tools/export_entity_audit_sample.mjs");
const COMMITTED_AUDIT = join(ROOT, "entity_resolution/eval/entity_audits/2026-08-01");

function entity(id, overrides = {}) {
  const recordCount = overrides.record_count ?? 2;
  return {
    audit_id: `era-${id}`,
    component_id: `erc-${id}`,
    corpus: "gold",
    entity_type: "vendor",
    unit_kind: "resolved_entity",
    record_count: recordCount,
    source_count: 1,
    false_split_callout: false,
    authority_key_case: false,
    min_link_confidence: 0.95,
    max_boundary_unresolved_confidence: null,
    observations: Array.from({ length: recordCount }, (_, index) => ({ id: `${id}-${index}` })),
    ...overrides,
  };
}

function population() {
  return [
    ...Array.from({ length: 6 }, (_, index) => entity(`false-${index}`, {
      unit_kind: "reference_entity",
      false_split_callout: true,
    })),
    ...Array.from({ length: 2 }, (_, index) => entity(`large-${index}`, { record_count: 6 })),
    ...Array.from({ length: 2 }, (_, index) => entity(`single-${index}`, { record_count: 1 })),
    ...Array.from({ length: 2 }, (_, index) => entity(`low-${index}`, {
      max_boundary_unresolved_confidence: 0.72,
    })),
    ...Array.from({ length: 2 }, (_, index) => entity(`authority-${index}`, { authority_key_case: true })),
    ...Array.from({ length: 2 }, (_, index) => entity(`other-${index}`)),
  ];
}

test("sampling is deterministic, covers every stratum, and oversamples false splits", () => {
  const first = buildEntityAuditSample(population(), { sampleSize: 11, seed: "test-seed" });
  const second = buildEntityAuditSample(population(), { sampleSize: 11, seed: "test-seed" });
  assert.deepEqual(first, second);
  assert.equal(first.sample.length, 11);
  assert.equal(first.receipt.primary_signal, "false_split");
  assert.equal(first.receipt.strata.false_split.sampled, 4);
  assert.equal(first.receipt.strata.false_split.inclusion_probability, 4 / 6);
  assert.equal(first.receipt.strata.large_cluster.sampled, 2);
  assert.equal(first.receipt.strata.singleton.sampled, 2);
  assert.equal(first.receipt.strata.low_confidence.sampled, 1);
  assert.equal(first.receipt.strata.authority_key.sampled, 1);
  assert.equal(first.receipt.strata.other_cluster.sampled, 1);
  assert.ok(first.sample.every((row) => (
    row.base_weight === 1 / row.inclusion_probability &&
    row.observations.length === row.record_count &&
    row.stratum_eligible === first.receipt.strata[row.stratum].eligible
  )));
});

test("weighted estimates use recorded probabilities and suppress undersampled strata", () => {
  const selected = buildEntityAuditSample(population().slice(0, 4), { sampleSize: 4 }).sample;
  selected[0].judgment = "false_split";
  selected[1].judgment = "correct";
  for (const row of selected.slice(0, 2)) {
    row.reviewer = "reviewer-1";
    row.reviewed_at = "2026-08-01";
  }
  let report = estimateEntityAudit(formatEntityAuditLabelSheet(selected), { minReviewedPerStratum: 2 });
  assert.equal(report.status, "estimated");
  assert.equal(report.false_split_rate, 0.5);
  assert.equal(report.strata.false_split.status, "estimated");

  selected[1].judgment = "";
  selected[1].reviewer = "";
  selected[1].reviewed_at = "";
  report = estimateEntityAudit(formatEntityAuditLabelSheet(selected), { minReviewedPerStratum: 2 });
  assert.equal(report.status, "insufficient");
  assert.equal(report.false_split_rate, null);
  assert.equal(report.strata.false_split.status, "insufficient");
});

test("a completely reviewed one-entity stratum is a sufficient census", () => {
  const sample = buildEntityAuditSample([
    entity("only-false-split", { false_split_callout: true }),
  ], { sampleSize: 1 }).sample;
  sample[0].judgment = "false_split";
  sample[0].reviewer = "reviewer-1";
  sample[0].reviewed_at = "2026-08-01";
  const report = estimateEntityAudit(formatEntityAuditLabelSheet(sample), { minReviewedPerStratum: 2 });
  assert.equal(report.status, "estimated");
  assert.equal(report.strata.false_split.status, "estimated");
  assert.equal(report.false_split_rate, 1);
});

test("export CLI writes a label sheet and provenance receipt idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "entity-audit-"));
  const input = join(dir, "component-report.json");
  const out = join(dir, "audit");
  writeFileSync(input, `${JSON.stringify({
    kind: "entity_component_evaluation",
    schema_version: 1,
    matcher_version: "fixture",
    audit_population: population(),
  })}\n`);
  const args = [
    CLI,
    "--input", input,
    "--out-dir", out,
    "--observed-on", "2026-08-01",
    "--sample-size", "11",
    "--seed", "test-seed",
  ];
  try {
    const first = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    for (const name of ["audit_sample.jsonl", "label_sheet.csv", "receipt.json"]) {
      assert.equal(existsSync(join(out, name)), true);
    }
    const receipt = JSON.parse(readFileSync(join(out, "receipt.json"), "utf8"));
    assert.equal(receipt.input.kind, "entity_component_evaluation");
    assert.match(receipt.input.sha256, /^[a-f0-9]{64}$/);
    assert.match(receipt.artifacts.sample.sha256, /^[a-f0-9]{64}$/);
    assert.match(receipt.artifacts.label_sheet.sha256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.strata.false_split.sampled, 4);

    const second = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /unchanged .*audit_sample\.jsonl/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("committed audit receipt preserves all named strata and artifact provenance", () => {
  const receipt = JSON.parse(readFileSync(join(COMMITTED_AUDIT, "receipt.json"), "utf8"));
  assert.equal(receipt.kind, "entity_centric_audit_receipt");
  assert.equal(receipt.primary_signal, "false_split");
  assert.equal(receipt.population_size, 37);
  assert.equal(receipt.sample_size, 16);
  for (const stratum of [
    "false_split", "large_cluster", "singleton", "low_confidence", "authority_key",
  ]) {
    assert.ok(receipt.strata[stratum].eligible > 0, `${stratum} must be represented`);
    assert.ok(receipt.strata[stratum].inclusion_probability > 0);
  }
  assert.equal(
    receipt.artifacts.label_sheet.path,
    "entity_resolution/eval/entity_audits/2026-08-01/label_sheet.csv",
  );
  assert.match(receipt.artifacts.sample.sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.artifacts.label_sheet.sha256, /^[a-f0-9]{64}$/);
});
