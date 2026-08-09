#!/usr/bin/env node

/**
 * Relation-specific cross-spine edge evaluation (eval only).
 *
 * Gold labels are immutable evidence. This module generates candidate pairs
 * from relation-specific evidence, assigns leakage-safe group splits, and
 * measures the held-out precision of the generated candidates. It never
 * writes links or touches D1/KV.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CROSS_SPINE_RELATION_POLICIES,
  CROSS_SPINE_MIN_HELD_OUT_PRECISION,
  canonicalCrossSpineRelation,
  checkCrossSpineEdgePolicy,
  crossSpineEvidenceDecision,
} from "../entity_resolution/cross_domain/edge_policy.mjs";

export const CROSS_SPINE_EVAL_SCHEMA = "cityscroll.cross_spine_edge_eval.v1";
export const CROSS_SPINE_EVAL_VERSION = "cross_spine_eval_v1";
export const DEFAULT_MIN_PRECISION = CROSS_SPINE_MIN_HELD_OUT_PRECISION;
export const DEFAULT_HOLDOUT_BUCKETS = 5;
export const DEFAULT_HOLDOUT_BUCKET = 0;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_GOLD_PATH = resolve(ROOT, "entity_resolution/eval/cross_spine_gold_v1.jsonl");
export const DEFAULT_GATE_RECEIPT_PATH = resolve(ROOT, "site/data/cross_spine_edge_gate.json");

const LABELS = new Set(["same", "different"]);
export const RELATION_POLICIES = CROSS_SPINE_RELATION_POLICIES;
const TIERS = new Set(["inferred", "deterministic"]);

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function fail(message) {
  throw new TypeError(message);
}

function canonicalRelation(value) {
  return canonicalCrossSpineRelation(value);
}

/**
 * Return the relation-specific evidence decision for one row.
 * This function deliberately never reads `label`.
 */
export function candidateDecision(row, relation = row?.relation) {
  const canonical = canonicalRelation(relation);
  if (row?.tier === "deterministic" || row?.evidence?.tier === "deterministic") {
    return { relation: canonical, candidate: false, tier: "deterministic", reason: "deterministic_tier" };
  }
  const evidence = crossSpineEvidenceDecision(row, canonical);
  return {
    ...evidence,
    tier: "inferred",
  };
}

/** Generate the in-memory candidate cohort for one or all supported relations. */
export function generateRelationCandidates(rows = [], relation = null) {
  if (!Array.isArray(rows)) fail("candidate rows must be an array");
  const requested = relation ? canonicalRelation(relation) : null;
  return rows
    .filter((row) => !requested || canonicalRelation(row?.relation) === requested)
    .map((row) => ({
      ...row,
      relation: canonicalRelation(row.relation),
      candidate_evaluation: candidateDecision(row, row.relation),
    }))
    .filter((row) => row.candidate_evaluation.candidate);
}

function stableBucket(value, buckets) {
  const digest = createHash("sha256").update(String(value)).digest();
  return digest.readUInt32BE(0) % buckets;
}

function stableRank(value) {
  return createHash("sha256").update(String(value)).digest().readUInt32BE(0);
}

function sideGroup(row, side) {
  const explicit = row?.groups?.[side];
  if (explicit) return clean(explicit);
  const subject = row?.[side]?.subject_ref || row?.[side]?.native_key;
  if (subject) return `${side}:${clean(subject)}`;
  fail(`${row?.id || "row"}: groups.${side} or ${side}.subject_ref is required`);
}

function unionFind(keys) {
  const parent = new Map(keys.map((key) => [key, key]));
  const find = (key) => {
    let root = parent.get(key);
    while (root !== parent.get(root)) root = parent.get(root);
    let current = key;
    while (current !== root) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const join = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(a, b);
  };
  return { find, join };
}

/**
 * Split by connected group components, so neither endpoint group can appear
 * in both train and holdout. This is stricter than splitting by pair id.
 */
export function groupedSplit(rows = [], {
  holdoutBuckets = DEFAULT_HOLDOUT_BUCKETS,
  holdoutBucket = DEFAULT_HOLDOUT_BUCKET,
} = {}) {
  if (!Number.isInteger(holdoutBuckets) || holdoutBuckets < 2) fail("holdoutBuckets must be an integer >= 2");
  if (!Number.isInteger(holdoutBucket) || holdoutBucket < 0 || holdoutBucket >= holdoutBuckets) {
    fail(`holdoutBucket must be in [0, ${holdoutBuckets})`);
  }
  const groups = rows.map((row) => ({
    row,
    left: sideGroup(row, "left"),
    right: sideGroup(row, "right"),
  }));
  const uf = unionFind([...new Set(groups.flatMap(({ left, right }) => [left, right]))]);
  for (const group of groups) uf.join(group.left, group.right);
  const componentByRoot = new Map();
  for (const group of groups) {
    const root = uf.find(group.left);
    if (!componentByRoot.has(root)) componentByRoot.set(root, new Set());
    componentByRoot.get(root).add(group.left);
    componentByRoot.get(root).add(group.right);
  }
  const relationsByRoot = new Map();
  for (const group of groups) {
    const root = uf.find(group.left);
    if (!relationsByRoot.has(root)) relationsByRoot.set(root, new Set());
    relationsByRoot.get(root).add(canonicalRelation(group.row.relation));
  }
  const splitByRoot = new Map();
  for (const [root, members] of componentByRoot) {
    const canonical = [...members].sort().join("|");
    // Independent relation cohorts get independent deterministic buckets so
    // every relation can acquire a holdout without making a shared endpoint
    // leak. Components spanning relations use the unsalted global key.
    const relationSalt = relationsByRoot.get(root).size === 1
      ? [...relationsByRoot.get(root)][0]
      : "shared";
    splitByRoot.set(root, stableBucket(`${relationSalt}|${canonical}`, holdoutBuckets) === holdoutBucket ? "held_out" : "train");
  }
  // Stratify only when the deterministic bucket happened to miss an entire
  // relation. The fallback still moves a whole connected component, never a
  // pair, and is selected without reading labels.
  for (const relation of new Set(groups.map(({ row }) => canonicalRelation(row.relation)))) {
    const relationRoots = [...relationsByRoot] // source: in-memory group graph, not external data.
      .filter(([, relations]) => relations.has(relation))
      .map(([root]) => root);
    if (relationRoots.some((root) => splitByRoot.get(root) === "held_out")) continue;
    const fallback = relationRoots
      .map((root) => {
        const canonical = [...componentByRoot.get(root)].sort().join("|");
        return { root, rank: stableRank(`${relation}|${canonical}`) };
      })
      .sort((left, right) => left.rank - right.rank)[0];
    if (fallback) splitByRoot.set(fallback.root, "held_out");
  }
  const assignments = groups.map(({ row, left, right }) => ({
    id: row.id,
    split: splitByRoot.get(uf.find(left)),
    groups: { left, right },
    component: [...componentByRoot.get(uf.find(left))].sort().join("|"),
  }));
  const heldOutGroups = new Set(assignments.filter((item) => item.split === "held_out").flatMap((item) => [item.groups.left, item.groups.right]));
  const trainGroups = new Set(assignments.filter((item) => item.split === "train").flatMap((item) => [item.groups.left, item.groups.right]));
  if ([...heldOutGroups].some((group) => trainGroups.has(group))) fail("group split leaked an endpoint group");
  const byId = new Map(assignments.map((item) => [item.id, item]));
  return {
    train: rows.filter((row) => byId.get(row.id)?.split === "train"),
    heldOut: rows.filter((row) => byId.get(row.id)?.split === "held_out"),
    assignments,
    trainGroups,
    heldOutGroups,
    holdoutBuckets,
    holdoutBucket,
  };
}

function validateSide(side, path, lineNo) {
  if (!side || typeof side !== "object" || Array.isArray(side)) fail(`line ${lineNo}: ${path} must be an object`);
  if (!clean(side.source_system)) fail(`line ${lineNo}: ${path}.source_system is required`);
  if (!clean(side.display_name)) fail(`line ${lineNo}: ${path}.display_name is required`);
}

/** Parse and validate the versioned cross-spine gold JSONL format. */
export function loadCrossSpineGold(text) {
  if (typeof text !== "string" || !text.trim()) fail("gold file is empty");
  const contentHash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  let meta = null;
  const cases = [];
  const ids = new Set();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const lineNo = index + 1;
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    let row;
    try { row = JSON.parse(raw); } catch (error) { fail(`line ${lineNo}: invalid JSON (${error.message})`); }
    if (!row || typeof row !== "object" || Array.isArray(row)) fail(`line ${lineNo}: expected an object`);
    if (row._meta === true) {
      if (meta) fail(`line ${lineNo}: duplicate _meta record`);
      if (row.schema_version !== 1 || !clean(row.gold_version)) fail(`line ${lineNo}: _meta requires schema_version=1 and gold_version`);
      meta = row;
      continue;
    }
    if (!clean(row.id) || ids.has(row.id)) fail(`line ${lineNo}: unique id is required`);
    ids.add(row.id);
    const relation = canonicalRelation(row.relation);
    if (!RELATION_POLICIES[relation]) fail(`line ${lineNo}: unsupported relation ${row.relation}`);
    if (!LABELS.has(row.label)) fail(`line ${lineNo}: label must be same|different`);
    if (!Array.isArray(row.sources) || row.sources.length === 0) fail(`line ${lineNo}: sources must be non-empty`);
    if (!TIERS.has(row.tier || "inferred")) fail(`line ${lineNo}: tier must be inferred|deterministic`);
    validateSide(row.left, "left", lineNo);
    validateSide(row.right, "right", lineNo);
    sideGroup(row, "left");
    sideGroup(row, "right");
    cases.push({ ...row, relation, tier: row.tier || "inferred" });
  }
  if (!meta) fail("missing leading _meta record");
  if (!cases.length) fail("no labeled cases after _meta");
  if (Number.isInteger(meta.case_count) && meta.case_count !== cases.length) fail(`_meta.case_count=${meta.case_count} but found ${cases.length}`);
  return { meta, cases, contentHash };
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function relationMetric(rows, candidates) {
  const inferredRows = rows.filter((row) => (row.tier || "inferred") === "inferred");
  const deterministicRows = rows.filter((row) => row.tier === "deterministic");
  const positive = inferredRows.filter((row) => row.label === "same").length;
  const truePositive = candidates.filter((row) => row.label === "same").length;
  const falsePositive = candidates.filter((row) => row.label === "different").length;
  const generated = candidates.length;
  return {
    total: rows.length,
    inferred_total: inferredRows.length,
    deterministic_rows: deterministicRows.length,
    deterministic_gold_positive: deterministicRows.filter((row) => row.label === "same").length,
    gold_positive: positive,
    candidates: generated,
    true_positive: truePositive,
    false_positive: falsePositive,
    precision: ratio(truePositive, generated),
    coverage: ratio(truePositive, positive),
    abstentions: rows.length - generated,
    abstention_rate: ratio(rows.length - generated, rows.length),
  };
}

function measureRelations(rows, splitName) {
  const relations = [...new Set(rows.map((row) => row.relation))].sort();
  const byRelation = {};
  for (const relation of relations) {
    const relationRows = rows.filter((row) => row.relation === relation);
    byRelation[relation] = {
      split: splitName,
      ...relationMetric(relationRows, generateRelationCandidates(relationRows, relation)),
    };
  }
  return byRelation;
}

export function evaluateCrossSpineGold({ gold, relation = null, groupSplit = false, minPrecision = DEFAULT_MIN_PRECISION } = {}) {
  if (!gold || !Array.isArray(gold.cases)) fail("gold must be the result of loadCrossSpineGold");
  const selectedRelation = relation ? canonicalRelation(relation) : null;
  if (selectedRelation && !RELATION_POLICIES[selectedRelation]) fail(`unsupported relation ${relation}`);
  const cases = selectedRelation ? gold.cases.filter((row) => row.relation === selectedRelation) : gold.cases;
  if (!cases.length) fail(selectedRelation ? `no gold cases for relation ${selectedRelation}` : "gold has no cases");
  const split = groupSplit ? groupedSplit(cases) : null;
  const all = measureRelations(cases, "all");
  const train = groupSplit ? measureRelations(split.train, "train") : null;
  const heldOut = groupSplit ? measureRelations(split.heldOut, "held_out") : null;
  const relations = [...new Set(cases.map((row) => row.relation))].sort();
  const gate = {};
  for (const relation of relations) {
    const metric = groupSplit ? heldOut[relation] : all[relation];
    gate[relation] = {
      precision: metric?.precision ?? null,
      min_precision: minPrecision,
      passed: metric?.precision != null && metric.precision >= minPrecision,
      status: metric?.precision == null ? "insufficient" : metric.precision >= minPrecision ? "pass" : "fail",
    };
  }
  return {
    schema: CROSS_SPINE_EVAL_SCHEMA,
    eval_version: CROSS_SPINE_EVAL_VERSION,
    gold_version: gold.meta.gold_version,
    content_hash: gold.contentHash,
    relation: selectedRelation,
    group_split: groupSplit,
    split: split ? {
      holdout_buckets: split.holdoutBuckets,
      holdout_bucket: split.holdoutBucket,
      train_rows: split.train.length,
      held_out_rows: split.heldOut.length,
      train_groups: split.trainGroups.size,
      held_out_groups: split.heldOutGroups.size,
      group_leakage: [...split.trainGroups].some((group) => split.heldOutGroups.has(group)),
      assignments: split.assignments,
    } : null,
    all,
    train,
    held_out: heldOut,
    gate,
    ok: Object.values(gate).every((row) => row.passed),
  };
}

function parseArgs(argv) {
  const args = {
    gold: DEFAULT_GOLD_PATH,
    goldProvided: false,
    relation: null,
    groupSplit: false,
    minPrecision: DEFAULT_MIN_PRECISION,
    json: false,
    out: null,
    check: false,
    checkPolicy: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--gold") { args.gold = argv[++index]; args.goldProvided = true; }
    else if (arg === "--relation") args.relation = argv[++index];
    else if (arg === "--group-split") args.groupSplit = true;
    else if (arg === "--min-precision") args.minPrecision = Number(argv[++index]);
    else if (arg === "--json") args.json = true;
    else if (arg === "--out") args.out = argv[++index];
    else if (arg === "--check") args.check = true;
    else if (arg === "--check-policy") args.checkPolicy = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else fail(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.minPrecision) || args.minPrecision < 0 || args.minPrecision > 1) fail("--min-precision must be between 0 and 1");
  // A gate is never allowed to silently become an in-sample measurement.
  if (args.check || args.checkPolicy) args.groupSplit = true;
  if (args.check && !args.out && !args.goldProvided) args.out = DEFAULT_GATE_RECEIPT_PATH;
  return args;
}

function usage() {
  console.error("Usage: node tools/cross_spine_eval.mjs [--gold <path.jsonl>] [--relation <relation>] --group-split [--min-precision 0.90] [--json] [--out <receipt.json>] [--check] [--check-policy]");
}

function main() {
  let args;
  try { args = parseArgs(process.argv); } catch (error) { usage(); console.error(`error: ${error.message}`); process.exitCode = 1; return; }
  if (args.help) { usage(); return; }
  const path = resolve(args.gold);
  if (!existsSync(path)) { console.error(`gold file not found: ${args.gold}`); process.exitCode = 1; return; }
  try {
    const gold = loadCrossSpineGold(readFileSync(path, "utf8"));
    const report = evaluateCrossSpineGold({ gold, relation: args.relation, groupSplit: args.groupSplit, minPrecision: args.minPrecision });
    if (args.checkPolicy) {
      const policyCheck = checkCrossSpineEdgePolicy(report);
      if (!policyCheck.ok) throw new Error(`edge policy failed: ${policyCheck.failures.join(", ") || policyCheck.reason}`);
      console.log(`cross_spine_policy=${policyCheck.policy.version} min_precision=${policyCheck.policy.min_held_out_precision} ok=true`);
    }
    const rendered = `${JSON.stringify(report, null, 2)}\n`;
    if (args.out) {
      if (args.check && existsSync(resolve(args.out)) && readFileSync(resolve(args.out), "utf8") !== rendered) {
        throw new Error(`receipt drift vs --out ${args.out}`);
      }
      if (!args.check) writeFileSync(resolve(args.out), rendered);
    }
    if (args.json) console.log(rendered.trim());
    else {
      for (const [relation, metric] of Object.entries(report.held_out || report.all)) {
        const gate = report.gate[relation];
        console.log(`relation=${relation} split=${metric.split} precision=${metric.precision ?? "null"} coverage=${metric.coverage ?? "null"} abstention=${metric.abstention_rate ?? "null"} candidates=${metric.candidates} gate=${gate.status}`);
      }
      console.log(`group_split=${report.group_split} leakage=${report.split?.group_leakage ?? false} ok=${report.ok}`);
    }
    if (args.check && !report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`cross-spine eval failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
