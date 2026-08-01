import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildEntityComponentReport } from "../entity_resolution/evaluation/entity_components.mjs";
import { deriveAuthorityCases, loadSourceRecords } from "../entity_resolution/evaluation/authority.mjs";
import { loadGold } from "../entity_resolution/eval/run_metrics.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOLD = join(ROOT, "entity_resolution/eval/gold_v0.jsonl");
const AUTHORITY = join(ROOT, "entity_resolution/eval/fixtures/source_records_authority_v0.jsonl");
const CLI = join(ROOT, "entity_resolution/eval/run_entity_components.mjs");
const COMMITTED_REPORT = join(ROOT, "entity_resolution/eval/components/2026-08-01/report.json");
const COMMITTED_RECEIPT = join(ROOT, "entity_resolution/eval/components/2026-08-01/receipt.json");

function pair(id, label, left, right, entityType = "vendor") {
  return { id, label, entity_type: entityType, left, right };
}

const side = (key, name, attrs = {}) => ({ source_system: "fixture", native_key: key, display_name: name, attrs });

test("entity metrics distinguish fragmented truth components from negative-constraint over-merges", () => {
  const report = buildEntityComponentReport({ goldCases: [
    pair("same-a", "same", side("a", "Alpha Services"), side("b", "Alpha Service Group")),
    pair("same-b", "same", side("b", "Alpha Service Group"), side("c", "A. S. Group")),
    pair("different", "different", side("d", "Metro Builders LP"), side("e", "Metro Builders LP")),
  ] });
  assert.equal(report.metrics.gold.reference_entity_components, 1);
  assert.equal(report.metrics.gold.under_split_entity_components, 1);
  assert.equal(report.metrics.gold.under_split_entity_rate, 1);
  assert.equal(report.metrics.gold.violated_negative_constraints, 1);
  assert.equal(report.metrics.gold.over_merged_predicted_components, 1);
  assert.equal(report.false_split_priority[0].record_count, 3);
  assert.ok(report.sample.some((row) => row.stratum === "gold_over_merge"));
  assert.ok(report.audit_population.some((row) => row.over_merge_callout));
  assert.ok(report.audit_population.some((row) => (
    row.unit_kind === "reference_entity" && row.false_split_callout
  )));
  const singletonReport = buildEntityComponentReport({ goldCases: [
    pair("separate", "different", side("s1", "North Consulting"), side("s2", "South Catering")),
  ] });
  assert.equal(singletonReport.audit_population.filter((row) => row.record_count === 1).length, 2);
});

test("sampling is deterministic, stratified, and never truncates a component", () => {
  const goldCases = [
    pair("g-same", "same", side("g1", "Gold Fragment One"), side("g2", "Other Gold Name")),
  ];
  const authorityCases = [
    {
      ...pair(
        "a-same",
        "same",
        side("a1", "Authority Exact LLC", { pin: "84124P0003001" }),
        side("a2", "AUTHORITY EXACT LLC", { epin: "84124P0003001" }),
        "procurement",
      ),
      authority_label: "same",
    },
  ];
  const first = buildEntityComponentReport({ goldCases, authorityCases }, { sampleSize: 2 });
  const second = buildEntityComponentReport({ goldCases, authorityCases }, { sampleSize: 2 });
  assert.deepEqual(first.sample, second.sample);
  assert.deepEqual(first.sample.map((row) => row.stratum), ["gold_false_split", "authority_control"]);
  assert.ok(first.sample.every((row) => row.observations.length === row.record_count));
});

test("committed gold and authority fixture produce numeric entity-centric metrics", () => {
  const gold = loadGold(readFileSync(GOLD, "utf8"));
  const authorityRows = loadSourceRecords(readFileSync(AUTHORITY, "utf8"));
  const report = buildEntityComponentReport({
    goldCases: gold.cases,
    authorityCases: deriveAuthorityCases(authorityRows),
  });
  // After agency rename aliases (DoITT→OTI, DA county↔borough, Business→SBS),
  // gold reference components recover fully: under_split drops 1 → 0.
  assert.deepEqual(report.metrics.gold, {
    reference_entity_components: 20,
    recovered_entity_components: 20,
    under_split_entity_components: 0,
    entity_component_recall: 1,
    under_split_entity_rate: 0,
    predicted_multi_record_components: 24,
    over_merged_predicted_components: 0,
    over_merge_component_rate: 0,
    negative_constraints: 7,
    violated_negative_constraints: 0,
    negative_constraint_violation_rate: 0,
  });
  assert.equal(report.metrics.authority.entity_component_recall, 1);
  assert.equal(report.metrics.authority.under_split_entity_rate, 0);
  assert.ok(report.sample.length > 0 && report.sample.length <= 8);
  assert.equal(report.parameters.sampling_unit, "whole_reference_component");
  assert.equal(report.false_split_priority.length, 0);
});

test("committed report and receipt reproduce the characterized fixture", () => {
  // Frozen 2026-08-01 snapshot still records the pre-alias residual (gv0-026).
  // Live metrics above prove the residual is closed on current HEAD.
  const committed = JSON.parse(readFileSync(COMMITTED_REPORT, "utf8"));
  const receipt = JSON.parse(readFileSync(COMMITTED_RECEIPT, "utf8"));
  assert.deepEqual(receipt.metrics, committed.metrics);
  assert.deepEqual(receipt.pairwise_metrics, committed.pairwise_metrics);
  assert.ok(committed.pairwise_metrics.candidate_recall >= 0);
  assert.ok(committed.pairwise_metrics.candidate_recall <= 1);
  assert.equal(receipt.sample_sha256, "06d1fafb3c080419be659e4f07bf6976c946414c9b269af1302a2408b9887fec");
  assert.deepEqual(committed.false_split_priority.map((row) => row.reference_case_ids), [["gv0-026"]]);
});

test("CLI prints stable metric keys and JSON report without production mutations", () => {
  const result = spawnSync(process.execPath, [CLI, "--gold", GOLD, "--source-records", AUTHORITY, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^gold_entity_component_recall=/m);
  assert.match(result.stdout, /^authority_under_split_entity_rate=/m);
  assert.match(result.stdout, /^false_split_priority_components=/m);
  assert.doesNotMatch(result.stdout, /INSERT|UPDATE|DELETE|public route/i);
});
