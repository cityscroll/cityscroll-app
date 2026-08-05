#!/usr/bin/env node
/**
 * Entity-resolution metrics harness (eval only; no production traffic).
 *
 * Loads a versioned gold JSONL and prints pair-level scorer metrics. Unless
 * --dry-run or --predictions is supplied, conventional matcher v0 generates
 * in-memory predictions. With --blocker token_v0, candidate_recall is also
 * computed and blocked-out pairs remain unresolved.
 *
 * Usage:
 *   node entity_resolution/eval/run_metrics.mjs \
 *     --gold entity_resolution/eval/gold_v1.jsonl --dry-run
 *
 *   node entity_resolution/eval/run_metrics.mjs \
 *     --gold entity_resolution/eval/gold_v1.jsonl --blocker token_v0
 *
 * Optional:
 *   --predictions <path.jsonl>   predicted pairs {id|left,right, decision}
 *   --blocker <name>             token_v0 | none  (candidate generation)
 *   --pipeline                   run matcher + conservative policy predictions
 *
 * Exit codes:
 *   0  gold valid; metrics printed
 *   1  usage error, I/O failure, or malformed gold
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { applyTokenV0, BLOCKER_ID as TOKEN_V0_ID } from "./blockers/token_v0.mjs";
import { extractFeatures } from "../features/index.mjs";
import { MATCHERS_VERSION, scorePair } from "../matchers/index.mjs";
import { POLICIES_VERSION, routeDecision } from "../policies/index.mjs";

const METRIC_KEYS = [
  "precision",
  "recall",
  "candidate_recall",
  "unresolved_rate",
  "false_merge",
  "false_split",
];

const ENTITY_TYPES = new Set(["vendor", "agency", "procurement", "location", "official"]);
const LABELS = new Set(["same", "different"]);

const KNOWN_BLOCKERS = new Set(["token_v0", "none"]);

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error(`  Usage: node entity_resolution/eval/run_metrics.mjs --gold <path.jsonl> [--dry-run]
       [--predictions <path.jsonl>] [--blocker token_v0|none] [--json]
       [--pipeline]  run matcher + conservative policy predictions
       [--examples N]   (blocked-in/out true-match examples; default 5 with blocker)`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    gold: null,
    dryRun: false,
    predictions: null,
    blocker: null,
    json: false,
    examples: null,
    pipeline: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gold") out.gold = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--predictions") out.predictions = argv[++i];
    else if (a === "--blocker") out.blocker = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--pipeline") out.pipeline = true;
    else if (a === "--examples") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) usage("--examples requires a non-negative number");
      out.examples = n;
    } else if (a === "--help" || a === "-h") usage();
    else usage(`unknown argument: ${a}`);
  }
  if (!out.gold) usage("--gold is required");
  if (out.blocker != null && !KNOWN_BLOCKERS.has(out.blocker)) {
    usage(`unknown blocker "${out.blocker}" (known: ${[...KNOWN_BLOCKERS].join(", ")})`);
  }
  return out;
}

/**
 * Run a named blocker over gold cases. Returns candidates Set + detail rows,
 * or null when no blocker / blocker=none.
 */
export function runBlocker(name, cases) {
  if (!name || name === "none") return null;
  if (name === TOKEN_V0_ID || name === "token_v0") {
    return applyTokenV0(cases);
  }
  return null;
}

/**
 * Run conventional matcher v0 over gold rows. When candidateIds is supplied,
 * blocked-out rows stay unresolved so evaluation preserves blocker semantics.
 */
export function predictWithMatcher(cases, candidateIds = null) {
  const predictions = new Map();
  for (const row of cases) {
    if (candidateIds && !candidateIds.has(row.id)) {
      predictions.set(row.id, "unresolved");
      continue;
    }
    const features = extractFeatures(row.left, row.right, {
      entityType: row.entity_type,
    });
    const score = scorePair(row.left, row.right, features);
    predictions.set(row.id, score.decision);
  }
  return predictions;
}

/**
 * Run matcher + conservative policy over gold rows. The policy layer adds
 * alias-registry-backed same-decisions for unresolved matcher pairs. When
 * candidateIds is supplied, blocked-out rows stay unresolved.
 */
export function predictWithPipeline(cases, candidateIds = null) {
  const predictions = new Map();
  for (const row of cases) {
    if (candidateIds && !candidateIds.has(row.id)) {
      predictions.set(row.id, "unresolved");
      continue;
    }
    const features = extractFeatures(row.left, row.right, {
      entityType: row.entity_type,
    });
    const score = scorePair(row.left, row.right, features);
    const routed = routeDecision(score, {
      left: row.left,
      right: row.right,
      entityType: row.entity_type,
    });
    predictions.set(row.id, routed.decision);
  }
  return predictions;
}

/**
 * Pick a few gold-same rows for blocked-in and blocked-out documentation.
 */
export function pickBlockExamples(details, limit = 5) {
  const same = (details || []).filter((d) => d.label === "same");
  const blockedIn = same.filter((d) => d.blocked_in).slice(0, limit);
  const blockedOut = same.filter((d) => !d.blocked_in).slice(0, limit);
  return { blocked_in: blockedIn, blocked_out: blockedOut };
}

function failGold(msg, detail) {
  console.error(`malformed gold: ${msg}`);
  if (detail) console.error(detail);
  process.exit(1);
}

/**
 * @param {string} text
 * @returns {{ meta: object|null, cases: object[], contentHash: string }}
 */
export function loadGold(text) {
  if (typeof text !== "string" || !text.trim()) {
    failGold("file is empty");
  }
  const contentHash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const lines = text.split(/\r?\n/);
  let meta = null;
  const cases = [];
  const seenIds = new Set();

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;

    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      failGold(`line ${lineNo}: invalid JSON`, String(e.message || e));
    }
    if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
      failGold(`line ${lineNo}: expected a JSON object`);
    }

    if (obj._meta === true) {
      if (meta) failGold(`line ${lineNo}: duplicate _meta record`);
      if (obj.schema_version == null) {
        failGold(`line ${lineNo}: _meta requires schema_version`);
      }
      if (!obj.gold_version || typeof obj.gold_version !== "string") {
        failGold(`line ${lineNo}: _meta requires gold_version string`);
      }
      meta = obj;
      continue;
    }

    validateCase(obj, lineNo, seenIds);
    cases.push(obj);
  }

  if (!meta) failGold("missing leading _meta record (versioned gold required)");
  if (cases.length === 0) failGold("no labeled cases after _meta");
  if (typeof meta.case_count === "number" && meta.case_count !== cases.length) {
    failGold(
      `_meta.case_count=${meta.case_count} but found ${cases.length} cases (update meta when adding cases)`,
    );
  }
  return { meta, cases, contentHash };
}

function validateSide(side, path, lineNo) {
  if (!side || typeof side !== "object" || Array.isArray(side)) {
    failGold(`line ${lineNo}: ${path} must be an object`);
  }
  if (!side.source_system || typeof side.source_system !== "string") {
    failGold(`line ${lineNo}: ${path}.source_system required string`);
  }
  if (!side.display_name || typeof side.display_name !== "string") {
    failGold(`line ${lineNo}: ${path}.display_name required string`);
  }
  // native_key optional for pure spelling pairs; preferred for multi-source.
}

function validateCase(obj, lineNo, seenIds) {
  if (!obj.id || typeof obj.id !== "string") {
    failGold(`line ${lineNo}: id required string`);
  }
  if (seenIds.has(obj.id)) failGold(`line ${lineNo}: duplicate id ${obj.id}`);
  seenIds.add(obj.id);

  if (!ENTITY_TYPES.has(obj.entity_type)) {
    failGold(
      `line ${lineNo}: entity_type must be one of ${[...ENTITY_TYPES].join("|")}`,
    );
  }
  if (!LABELS.has(obj.label)) {
    failGold(`line ${lineNo}: label must be same|different`);
  }
  if (!Array.isArray(obj.sources) || obj.sources.length === 0) {
    failGold(`line ${lineNo}: sources must be a non-empty array`);
  }
  for (const s of obj.sources) {
    if (typeof s !== "string" || !s) {
      failGold(`line ${lineNo}: sources entries must be non-empty strings`);
    }
  }
  validateSide(obj.left, "left", lineNo);
  validateSide(obj.right, "right", lineNo);
}

/**
 * Load optional predictions JSONL.
 * Each line: { "id": "<gold id>", "decision": "same"|"different"|"unresolved" }
 * or { "gold_id": "...", "decision": "..." }
 */
export function loadPredictions(text) {
  if (!text || !text.trim()) return new Map();
  const map = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      console.error(`malformed predictions: line ${i + 1}: ${e.message || e}`);
      process.exit(1);
    }
    const id = obj.id || obj.gold_id;
    const decision = obj.decision;
    if (!id || !decision) {
      console.error(`malformed predictions: line ${i + 1}: need id and decision`);
      process.exit(1);
    }
    if (!["same", "different", "unresolved"].includes(decision)) {
      console.error(
        `malformed predictions: line ${i + 1}: decision must be same|different|unresolved`,
      );
      process.exit(1);
    }
    map.set(id, decision);
  }
  return map;
}

/**
 * Candidate set for candidate_recall: set of gold ids that made it past blocking.
 * JSONL lines: { "id": "<gold id>" } or { "gold_id": "..." }
 */
export function loadCandidates(text) {
  if (!text || !text.trim()) return null;
  const set = new Set();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
    const id = obj.id || obj.gold_id;
    if (id) set.add(id);
  }
  return set;
}

/**
 * Compute metrics from gold cases + optional predictions.
 * Without predictions (dry-run), all metric values are null.
 *
 * Definitions (pair-level on gold rows):
 *   precision     = TP / (TP+FP) among predicted "same"
 *   recall        = TP / (TP+FN) among gold "same"
 *   candidate_recall = |gold same ∩ candidates| / |gold same|
 *   unresolved_rate  = unresolved predictions / |gold|
 *   false_merge   = FP count (pred same, gold different) — count, not rate
 *   false_split   = FN count (pred different/unresolved, gold same) — count
 */
export function computeMetrics(cases, predictions, candidates) {
  const empty = Object.fromEntries(METRIC_KEYS.map((k) => [k, null]));
  if (!predictions || predictions.size === 0) {
    // Dry-run / no matcher: keys present, values null.
    // candidate_recall stays null until a blocker supplies candidates.
    if (candidates && candidates.size >= 0) {
      // If candidates provided without predictions, still compute candidate_recall.
      const goldSame = cases.filter((c) => c.label === "same");
      const denom = goldSame.length;
      const hit = goldSame.filter((c) => candidates.has(c.id)).length;
      return {
        ...empty,
        candidate_recall: denom === 0 ? null : hit / denom,
      };
    }
    return empty;
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let unresolved = 0;
  let falseMerge = 0;
  let falseSplit = 0;
  let goldSame = 0;
  let goldSameInCandidates = 0;

  for (const c of cases) {
    const pred = predictions.get(c.id) || "unresolved";
    if (pred === "unresolved") unresolved += 1;

    if (c.label === "same") {
      goldSame += 1;
      if (candidates && candidates.has(c.id)) goldSameInCandidates += 1;
      if (pred === "same") tp += 1;
      else {
        fn += 1;
        falseSplit += 1;
      }
    } else {
      // gold different
      if (pred === "same") {
        fp += 1;
        falseMerge += 1;
      }
    }
  }

  const precisionDen = tp + fp;
  const recallDen = tp + fn;

  return {
    precision: precisionDen === 0 ? null : tp / precisionDen,
    recall: recallDen === 0 ? null : tp / recallDen,
    candidate_recall:
      candidates == null
        ? null
        : goldSame === 0
          ? null
          : goldSameInCandidates / goldSame,
    unresolved_rate: cases.length === 0 ? null : unresolved / cases.length,
    false_merge: falseMerge,
    false_split: falseSplit,
  };
}

function composition(cases) {
  const byType = {};
  const byLabel = { same: 0, different: 0 };
  const bySourcePair = {};
  let multiSource = 0;
  for (const c of cases) {
    byType[c.entity_type] = (byType[c.entity_type] || 0) + 1;
    byLabel[c.label] = (byLabel[c.label] || 0) + 1;
    const uniq = new Set(c.sources);
    if (uniq.size >= 2) multiSource += 1;
    const pairKey = [...uniq].sort().join("+") || "unknown";
    bySourcePair[pairKey] = (bySourcePair[pairKey] || 0) + 1;
  }
  return {
    n: cases.length,
    by_entity_type: byType,
    by_label: byLabel,
    multi_source: multiSource,
    by_source_set: bySourcePair,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const goldPath = resolve(args.gold);
  if (!existsSync(goldPath)) usage(`gold file not found: ${args.gold}`);

  let goldText;
  try {
    goldText = readFileSync(goldPath, "utf8");
  } catch (e) {
    console.error(`error reading gold: ${e.message || e}`);
    process.exit(1);
  }

  const { meta, cases, contentHash } = loadGold(goldText);

  // Candidate generation (er-05): offline blocker → candidate set for candidate_recall.
  // No production auto-links; eval-only in-memory pairs.
  let candidates = null;
  let blockerDetails = null;
  const blockerResult = runBlocker(args.blocker, cases);
  if (blockerResult) {
    candidates = blockerResult.candidateIds;
    blockerDetails = blockerResult.details;
  }

  let predictions = null;
  let predictionsSource = null;
  if (args.dryRun) {
    predictions = null;
  } else if (args.predictions) {
    const pText = readFileSync(resolve(args.predictions), "utf8");
    predictions = loadPredictions(pText);
    predictionsSource = args.predictions;
  } else if (args.pipeline) {
    predictions = predictWithPipeline(cases, candidates);
    predictionsSource = `pipeline:${POLICIES_VERSION}`;
  } else {
    predictions = predictWithMatcher(cases, candidates);
    predictionsSource = MATCHERS_VERSION;
  }

  const metrics = computeMetrics(cases, predictions, candidates);

  // candidate_recall must land in [0,1] when a blocker supplies candidates.
  if (metrics.candidate_recall != null) {
    const cr = metrics.candidate_recall;
    if (!(typeof cr === "number" && cr >= 0 && cr <= 1)) {
      console.error(`internal error: candidate_recall out of range: ${cr}`);
      process.exit(1);
    }
  }

  const exampleLimit =
    args.examples != null ? args.examples : blockerDetails ? 5 : 0;
  const examples =
    blockerDetails && exampleLimit > 0
      ? pickBlockExamples(blockerDetails, exampleLimit)
      : null;

  const report = {
    gold_path: args.gold,
    gold_version: meta.gold_version,
    schema_version: meta.schema_version,
    content_hash: contentHash,
    dry_run: Boolean(args.dryRun),
    predictions_source: predictionsSource,
    blocker: args.blocker || null,
    composition: composition(cases),
    metrics,
    block_examples: examples,
  };

  // Always print metric keys first as plain KEY=VALUE lines for greppability.
  for (const k of METRIC_KEYS) {
    const v = metrics[k];
    const rendered = v === null || v === undefined ? "null" : String(v);
    console.log(`${k}=${rendered}`);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("---");
    console.log(`gold_version=${meta.gold_version}`);
    console.log(`schema_version=${meta.schema_version}`);
    console.log(`content_hash=${contentHash}`);
    console.log(`cases=${cases.length}`);
    console.log(`dry_run=${report.dry_run}`);
    console.log(`predictions_source=${predictionsSource || "null"}`);
    console.log(`blocker=${args.blocker || "null"}`);
    console.log(
      `composition=${JSON.stringify(report.composition)}`,
    );
    if (examples) {
      // Document blocked-in / blocked-out true matches (no silent drop).
      console.log("---");
      console.log("block_examples (gold label=same only)");
      if (examples.blocked_in.length === 0) {
        console.log("blocked_in: (none in sample)");
      } else {
        for (const d of examples.blocked_in) {
          console.log(
            `blocked_in\t${d.id}\t${d.entity_type}\tkeys=${d.shared_keys.join(",") || "-"}\t"${d.left_name}" ↔ "${d.right_name}"`,
          );
        }
      }
      if (examples.blocked_out.length === 0) {
        console.log("blocked_out: (none — all gold same pairs retained)");
      } else {
        for (const d of examples.blocked_out) {
          console.log(
            `blocked_out\t${d.id}\t${d.entity_type}\tkeys=-\t"${d.left_name}" ↔ "${d.right_name}"`,
          );
        }
      }
      const goldSame = cases.filter((c) => c.label === "same").length;
      const retained = candidates ? [...candidates].filter((id) => {
        const row = cases.find((c) => c.id === id);
        return row && row.label === "same";
      }).length : 0;
      console.log(
        `blocker_summary\tgold_same=${goldSame}\tretained=${retained}\tdropped=${goldSame - retained}`,
      );
    }
  }

  // Sanity: every metric key present.
  for (const k of METRIC_KEYS) {
    if (!(k in metrics)) {
      console.error(`internal error: missing metric key ${k}`);
      process.exit(1);
    }
  }
}

// Run when executed directly (not when imported by tests).
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);

if (isMain) {
  main();
}
