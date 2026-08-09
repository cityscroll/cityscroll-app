#!/usr/bin/env node

/** Build the immutable v2 cross-spine gold from per-relation field-case shards. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCrossSpineGold } from "./cross_spine_eval.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CROSS_SPINE_GOLD_V2_DIR = resolve(ROOT, "entity_resolution/eval/cross_spine_gold_v2");
export const CROSS_SPINE_GOLD_V2_PATH = resolve(ROOT, "entity_resolution/eval/cross_spine_gold_v2.jsonl");
export const CROSS_SPINE_GOLD_V2_RELATIONS = Object.freeze([
  "mandate_contract",
  "mandate_land_use",
  "mandate_meeting",
  "mandate_rule",
]);

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const hash = (value) => createHash("sha256").update(value).digest("hex");

function fail(message) {
  throw new TypeError(message);
}

function sourceSide(side, defaults, cohortId, relation, caseId) {
  const merged = { ...(defaults || {}), ...(side || {}) };
  const sourceSystem = clean(merged.source_system);
  const sourceRecordId = clean(merged.source_record_id);
  const sourceUrl = clean(merged.source_url);
  const subjectRef = clean(merged.subject_ref);
  const displayName = clean(merged.display_name);
  if (!sourceSystem || !sourceRecordId || !sourceUrl || !subjectRef || !displayName) {
    fail(`${relation}/${cohortId}/${caseId}: each side requires source_system, source_record_id, source_url, subject_ref, and display_name`);
  }
  return {
    source_system: sourceSystem,
    source_record_id: sourceRecordId,
    source_url: sourceUrl,
    display_name: displayName,
    subject_ref: subjectRef,
  };
}

export function expandCrossSpineShard(shard, shardName = "shard") {
  if (shard?.schema !== "cityscroll.cross_spine_gold_shard.v2") fail(`${shardName}: unsupported shard schema`);
  if (shard?.gold_version !== "cross_spine_gold_v2") fail(`${shardName}: gold_version must be cross_spine_gold_v2`);
  const relation = clean(shard.relation);
  if (!CROSS_SPINE_GOLD_V2_RELATIONS.includes(relation)) fail(`${shardName}: unsupported relation ${relation}`);
  if (!Array.isArray(shard.cohorts) || shard.cohorts.length < 3) fail(`${shardName}: at least three source cohorts are required`);

  const rows = [];
  const cohortIds = new Set();
  for (const cohort of shard.cohorts) {
    const cohortId = clean(cohort?.id);
    if (!cohortId || cohortIds.has(cohortId)) fail(`${shardName}: source cohort ids must be unique`);
    cohortIds.add(cohortId);
    if (!Array.isArray(cohort.sources) || cohort.sources.length < 2) fail(`${shardName}/${cohortId}: at least two publisher sources are required`);
    if (!Array.isArray(cohort.cases) || cohort.cases.length === 0) fail(`${shardName}/${cohortId}: cases are required`);
    const labels = new Set(cohort.cases.map((row) => row.label));
    if (!labels.has("same") || !labels.has("different")) {
      fail(`${shardName}/${cohortId}: publisher-backed positive and hard-negative labels are both required`);
    }
    for (const item of cohort.cases) {
      const id = clean(item.id);
      if (!id) fail(`${shardName}/${cohortId}: case id is required`);
      const left = sourceSide(item.left, cohort.left, cohortId, relation, id);
      const right = sourceSide(item.right, cohort.right, cohortId, relation, id);
      rows.push({
        id,
        relation,
        tier: clean(item.tier) || "inferred",
        label: item.label,
        evaluation_split: "held_out",
        source_cohort: cohortId,
        sources: [...new Set(cohort.sources.map(clean).filter(Boolean))],
        evidence_basis: clean(item.evidence_basis || cohort.evidence_basis),
        groups: { left: left.subject_ref, right: right.subject_ref },
        left,
        right,
        features: { ...(cohort.features || {}), ...(item.features || {}) },
      });
    }
  }
  return { relation, rows };
}

export function buildCrossSpineGoldV2({ shardDir = CROSS_SPINE_GOLD_V2_DIR } = {}) {
  const rows = [];
  const shardReceipts = [];
  for (const relation of CROSS_SPINE_GOLD_V2_RELATIONS) {
    const shardPath = resolve(shardDir, `${relation}.json`);
    if (!existsSync(shardPath)) fail(`missing shard ${shardPath}`);
    const source = readFileSync(shardPath, "utf8");
    const expanded = expandCrossSpineShard(JSON.parse(source), shardPath);
    if (expanded.relation !== relation) fail(`${shardPath}: expected relation ${relation}`);
    rows.push(...expanded.rows);
    shardReceipts.push({
      relation,
      path: `cross_spine_gold_v2/${relation}.json`,
      case_count: expanded.rows.length,
      sha256: hash(source),
    });
  }
  const ids = new Set(rows.map((row) => row.id));
  if (ids.size !== rows.length) fail("case ids must be unique across shards");
  const meta = {
    _meta: true,
    gold_version: "cross_spine_gold_v2",
    schema_version: 2,
    case_count: rows.length,
    split_strategy: "frozen_field_cases_with_component_isolation",
    description: "Publisher-backed per-relation field cases frozen before v2 evaluation. Source cohorts include positive and hard-negative labels; explicit held-out assignments remain connected-component isolated.",
    shards: shardReceipts,
  };
  const rendered = `${[meta, ...rows].map((row) => JSON.stringify(row)).join("\n")}\n`;
  loadCrossSpineGold(rendered);
  return rendered;
}

function main() {
  const check = process.argv.includes("--check");
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--check");
  if (unknown.length) fail(`unknown argument: ${unknown[0]}`);
  const rendered = buildCrossSpineGoldV2();
  if (check) {
    if (!existsSync(CROSS_SPINE_GOLD_V2_PATH) || readFileSync(CROSS_SPINE_GOLD_V2_PATH, "utf8") !== rendered) {
      throw new Error(`generated gold drift: run node tools/build_cross_spine_gold_v2.mjs`);
    }
    console.log(`cross_spine_gold_v2=clean cases=${rendered.trim().split(/\r?\n/).length - 1}`);
    return;
  }
  writeFileSync(CROSS_SPINE_GOLD_V2_PATH, rendered);
  console.log(`wrote ${CROSS_SPINE_GOLD_V2_PATH}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(`cross-spine gold v2 build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
