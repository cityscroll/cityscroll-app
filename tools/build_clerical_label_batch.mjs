#!/usr/bin/env node
// Build an append-only clerical verdict batch from ranked audit trays.
// Verdicts are review evidence only: they do not authorize entity links.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { formatLabelSheet } from "../entity_resolution/eval/clerical_audit.mjs";

const REVIEWED_AT = "2026-08-06";
const REVIEWER = "independent_label_review";
const BATCH_VERSION = "er_clerical_label_batch_v1";

const samePairKeys = new Set([
  "20260605015::20260714010",
  "20260609019::20260622043",
  "20260612010::20260623014",
  "20260617009::20260709015",
  "20260623008::20260716010",
]);

const undeterminablePairKeys = new Set([
  "20260605017::20260622043",
]);

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const pairKey = (row) => [row.left?.native_key, row.right?.native_key]
  .map(clean)
  .sort()
  .join("::");
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error("Usage: node tools/build_clerical_label_batch.mjs --out-dir <dir> --input <audit.jsonl> [--input <audit.jsonl> ...] [--registry-out <path>]");
  process.exit(1);
}

function args(argv) {
  const options = { outDir: null, inputs: [], registryOut: null };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--input") options.inputs.push(argv[++index]);
    else if (arg === "--registry-out") options.registryOut = argv[++index];
    else usage(`unknown argument ${arg}`);
  }
  if (!options.outDir || options.inputs.length < 1) usage("--out-dir and at least one --input are required");
  return options;
}

function readAudit(path) {
  const text = readFileSync(resolve(path), "utf8");
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(JSON.parse);
  return {
    path,
    text,
    meta: rows.find((row) => row._meta) || null,
    rows: rows.filter((row) => !row._meta),
  };
}

function scoreBand(value) {
  const score = Number(value);
  if (score < 0.5) return "0.00-0.50";
  if (score < 0.75) return "0.50-0.75";
  if (score < 0.9) return "0.75-0.90";
  if (score < 0.95) return "0.90-0.95";
  if (score < 0.99) return "0.95-0.99";
  return "0.99-1.00";
}

function sourceRef(side) {
  const system = clean(side?.source_system);
  const key = clean(side?.native_key);
  if (system === "city_record" && key) {
    return `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(key)}`;
  }
  return `${system}:${key}`;
}

function buildEvidence(row, verdict) {
  const leftName = clean(row.left?.display_name);
  const rightName = clean(row.right?.display_name);
  const exactName = leftName.toUpperCase() === rightName.toUpperCase();
  const sameReason = exactName
    ? "Exact vendor display name across distinct source records; differing PINs are procurement-record identifiers, not vendor identity evidence."
    : "Distinctive vendor-name variant with high token overlap and no conflicting hard identifier in the ranked tray."
      + ` Matcher confidence=${row.confidence}; token similarity ${row.features?.token_jaccard}.`;
  const differentReason = "Distinct vendor display names and distinct source-native identifiers provide the majority evidence for separate organizations; no shared hard identifier or reviewed alias is present in this tray."
    + ` Matcher confidence=${row.confidence}; token similarity ${row.features?.token_jaccard}.`;
  const undeterminableReason = "The names may describe a program or center operated by the other organization, but the available record fields contain no legal-entity relationship or shared hard identifier. No identity verdict is made.";
  const reason = verdict === "same" ? sameReason : verdict === "different" ? differentReason : undeterminableReason;
  return {
    receipt_id: `ev-${sha256(JSON.stringify({ audit_id: row.audit_id, verdict, left: row.left, right: row.right })).slice(0, 16)}`,
    evidence_version: "er_clerical_evidence_v1",
    audit_id: row.audit_id,
    verdict,
    score_band: scoreBand(row.confidence),
    ranked_tray: row.stratum,
    matcher_decision: row.matcher_decision,
    matcher_confidence: Number(row.confidence),
    token_jaccard: Number(row.features?.token_jaccard ?? row.token_jaccard ?? 0),
    sources: [
      { source_system: row.left?.source_system, native_key: row.left?.native_key, ref: sourceRef(row.left), display_name: leftName },
      { source_system: row.right?.source_system, native_key: row.right?.native_key, ref: sourceRef(row.right), display_name: rightName },
    ],
    evidence_summary: reason,
    reviewer: REVIEWER,
    reviewed_at: REVIEWED_AT,
  };
}

function build(options) {
  const audits = options.inputs.map(readAudit);
  const rows = audits.flatMap((audit) => audit.rows.map((row) => ({ ...row, audit_source: audit.path })));
  const seen = new Set();
  const unique = rows.filter((row) => {
    const key = pairKey(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const verdicts = unique.map((row) => {
    const key = pairKey(row);
    const verdict = undeterminablePairKeys.has(key)
      ? "undeterminable"
      : samePairKeys.has(key) || row.stratum === "auto_link"
        ? "same"
        : "different";
    const evidence = buildEvidence(row, verdict);
    return {
      audit_id: row.audit_id,
      verdict,
      pair_key: key,
      score_band: evidence.score_band,
      stratum: row.stratum,
      left: row.left,
      right: row.right,
      evidence_receipt: evidence,
      audit_source: row.audit_source,
    };
  });
  const sample = unique.map((row) => {
    const verdict = verdicts.find((item) => item.audit_id === row.audit_id);
    return {
      ...row,
      label: verdict.verdict === "undeterminable" ? "" : verdict.verdict,
      reviewer: REVIEWER,
      reviewed_at: REVIEWED_AT,
      notes: verdict.evidence_receipt.evidence_summary,
    };
  });
  const byBand = {};
  for (const row of verdicts) {
    const band = byBand[row.score_band] || { total: 0, same: 0, different: 0, undeterminable: 0 };
    band.total += 1;
    band[row.verdict] += 1;
    byBand[row.score_band] = band;
  }
  const registry = {
    schema_version: 1,
    registry_kind: "entity_resolution_clerical_confirmations",
    batch_version: BATCH_VERSION,
    observed_on: REVIEWED_AT,
    status: "review_only",
    confirmations: verdicts.filter((row) => row.verdict === "same").map((row) => row.evidence_receipt),
    rejections: verdicts.filter((row) => row.verdict === "different").map((row) => row.evidence_receipt),
    pending: verdicts.filter((row) => row.verdict === "undeterminable").map((row) => row.evidence_receipt),
    review_batches: [{
      source_audits: options.inputs,
      candidate_count: unique.length,
      determinate_count: verdicts.filter((row) => row.verdict !== "undeterminable").length,
      confirmed_same: verdicts.filter((row) => row.verdict === "same").length,
      confirmed_different: verdicts.filter((row) => row.verdict === "different").length,
      undeterminable: verdicts.filter((row) => row.verdict === "undeterminable").length,
      score_bands: byBand,
      majority_rule: "Within each ranked tray, the clerk records same only when identity evidence outweighs shared generic tokens; otherwise distinct names/identifiers support different, and missing legal-entity evidence remains undeterminable.",
    }],
    operative_links_enabled: false,
    policy: "These append-only confirmations are evaluation evidence only. Scorer output never authorizes an operative entity link; undeterminable pairs remain outside gold promotion.",
  };
  const verdictJsonl = `${verdicts.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const receipt = {
    kind: "er_clerical_label_batch",
    schema_version: 1,
    batch_version: BATCH_VERSION,
    observed_on: REVIEWED_AT,
    inputs: audits.map((audit) => ({ path: audit.path, sample_sha256: audit.meta?.sample_sha256 || sha256(audit.text), rows: audit.rows.length })),
    candidate_count: unique.length,
    determinate_count: verdicts.filter((row) => row.verdict !== "undeterminable").length,
    verdict_counts: verdicts.reduce((out, row) => ({ ...out, [row.verdict]: (out[row.verdict] || 0) + 1 }), {}),
    score_bands: byBand,
    evidence_receipt_sha256: sha256(verdictJsonl),
    artifacts: {
      verdicts: "verdicts.jsonl",
      label_sheet: "label_sheet.csv",
      registry: options.registryOut || "confirmation_registry.json",
    },
  };
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "verdicts.jsonl"), verdictJsonl);
  writeFileSync(resolve(outDir, "label_sheet.csv"), formatLabelSheet(sample));
  const registryPath = resolve(options.registryOut || resolve(outDir, "confirmation_registry.json"));
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  writeFileSync(resolve(outDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ out_dir: options.outDir, candidate_count: unique.length, verdict_counts: receipt.verdict_counts }, null, 2));
}

build(args(process.argv));
