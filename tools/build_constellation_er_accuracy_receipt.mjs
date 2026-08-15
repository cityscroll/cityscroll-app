#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  evaluateCrossSpineGold,
  loadCrossSpineGold,
} from "./cross_spine_eval.mjs";

export const CONSTELLATION_ER_ACCURACY_SCHEMA = "cityscroll.constellation_er_accuracy.v1";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_GOLD = resolve(ROOT, "entity_resolution/eval/cross_spine_gold_v3.jsonl");
const DEFAULT_SHADOW = resolve(ROOT, "site/data/cross_spine_shadow_census.json");
const DEFAULT_MANDATES = resolve(ROOT, "site/data/agency_obligations_lookup.json");
const DEFAULT_OUT = resolve(ROOT, "docs/evidence/ebcg-er-accuracy/receipt.json");

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function certifiedMandate(row = {}) {
  return row.quote_verified === true
    || row.certification?.quote_verified === true
    || row.certification?.status === "auto_certified";
}

export function buildConstellationErAccuracyReceipt({ gold, shadowCensus = {}, mandates = {} } = {}) {
  const report = evaluateCrossSpineGold({ gold, groupSplit: true });
  const relationEntries = Object.entries(report.held_out || {});
  const perRelation = Object.fromEntries(relationEntries.map(([relation, metric]) => [relation, {
    precision: metric.precision,
    recall: metric.recall,
    support: metric.candidates,
    false_merge: metric.false_merge,
    false_split: metric.false_split,
    gate: report.gate[relation].status,
    source_cohorts: report.gate[relation].source_cohorts,
  }]));
  const mandateRows = Object.values(mandates.by_agency || {})
    .flatMap((bucket) => Array.isArray(bucket?.obligations) ? bucket.obligations : []);
  const verifiedMandates = mandateRows.filter(certifiedMandate).length;
  const shadowRelations = shadowCensus.relations || {};
  const evidenceOnlyByRelation = Object.fromEntries(Object.entries(shadowRelations)
    .map(([relation, value]) => [relation, Number(value?.totals?.evidence_only) || 0])
    .filter(([, count]) => count > 0));
  const publicInferred = sum(Object.values(shadowRelations).map((row) => row?.totals?.public_inferred));
  const evidenceOnly = sum(Object.values(shadowRelations).map((row) => row?.totals?.evidence_only));
  const relationCount = relationEntries.length;
  const passedRelations = Object.values(report.gate).filter((gate) => gate.passed).length;
  const sourceSystems = [...new Set(gold.cases.flatMap((row) => [
    row.left?.source_system,
    row.right?.source_system,
  ]).filter(Boolean))].sort();

  return {
    schema: CONSTELLATION_ER_ACCURACY_SCHEMA,
    task: "cityscroll-kraken/ebcg-01-er-accuracy-coverage",
    target_cohort: {
      ...report.target_cohort,
      tier: "inferred",
      split_strategy: gold.meta.split_strategy,
      source_systems: sourceSystems,
    },
    matcher: {
      version: report.matcher_version,
      evaluation_version: report.eval_version,
      gold_version: report.gold_version,
      gold_content_hash: report.content_hash,
    },
    held_out_metrics: {
      relations_measured: relationCount,
      relations_passing: passedRelations,
      relation_coverage: relationCount ? passedRelations / relationCount : null,
      support: sum(relationEntries.map(([, metric]) => metric.candidates)),
      true_positive: sum(relationEntries.map(([, metric]) => metric.true_positive)),
      false_merge: sum(relationEntries.map(([, metric]) => metric.false_merge)),
      false_split: sum(relationEntries.map(([, metric]) => metric.false_split)),
      per_relation: perRelation,
    },
    public_total_contract: {
      rule: "Only standable or confirmed links contribute to constellation edge totals.",
      excluded_from_edge_totals: [
        "tentative",
        "probabilistic",
        "not_yet_classified",
        "evidence_only",
        "name_mentions",
      ],
      agency_mandates: {
        corpus_rows: mandateRows.length,
        verified_links: verifiedMandates,
        provisional_rows_excluded: mandateRows.length - verifiedMandates,
        source: "site/data/agency_obligations_lookup.json",
      },
      vendor_footprints: {
        edge_total_field: "confirmed_count",
        browse_result_receipt_field: "confirmed_count",
        name_mentions_field: "mention_count",
        rule: "Only confirmed links drive edge totals and Browse pivots; name mentions remain separately labeled discovery context.",
      },
    },
    publication_gate: {
      opened_relations: Object.entries(report.gate)
        .filter(([, gate]) => gate.passed)
        .map(([relation]) => relation)
        .sort(),
      provisional_cross_spine_candidates: {
        public_inferred: publicInferred,
        evidence_only: evidenceOnly,
        evidence_only_by_relation: evidenceOnlyByRelation,
        source: "site/data/cross_spine_shadow_census.json",
      },
    },
    improved: [
      "Held-out metrics now name recall plus false-merge and false-split equivalents with the matcher policy version.",
      "Agency mandate totals now count verified standable links instead of the wider extraction corpus.",
      "Vendor footprint totals and Browse pivots now share the confirmed-link denominator while name mentions remain separately labeled.",
    ],
    stayed_provisional: [
      `${mandateRows.length - verifiedMandates} quote-miss mandate extractions remain excluded from public edge totals.`,
      `${evidenceOnly} evidence-only cross-spine candidates remain off public inferred-edge totals.`,
      "Vendor name mentions remain discovery scope, not reviewed identity links.",
    ],
    verification: [
      "node --test test/cross_spine_eval.test.mjs test/cross_spine_shadow_census.test.mjs",
      "node --test test/agency_constellation.test.mjs test/vendor_footprint.test.mjs",
      "node tools/build_constellation_er_accuracy_receipt.mjs --check",
    ],
  };
}

function parseArgs(argv) {
  const args = { check: false, out: DEFAULT_OUT };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--check") args.check = true;
    else if (argv[index] === "--out") args.out = resolve(argv[++index]);
    else throw new TypeError(`unknown argument: ${argv[index]}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const receipt = buildConstellationErAccuracyReceipt({
    gold: loadCrossSpineGold(readFileSync(DEFAULT_GOLD, "utf8")),
    shadowCensus: JSON.parse(readFileSync(DEFAULT_SHADOW, "utf8")),
    mandates: JSON.parse(readFileSync(DEFAULT_MANDATES, "utf8")),
  });
  const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
  if (args.check) {
    if (!existsSync(args.out) || readFileSync(args.out, "utf8") !== rendered) {
      throw new Error(`receipt drift vs ${args.out}`);
    }
    console.log(`constellation_er_accuracy=clean relations=${receipt.held_out_metrics.relations_measured} provisional=${receipt.publication_gate.provisional_cross_spine_candidates.evidence_only}`);
    return;
  }
  writeFileSync(args.out, rendered);
  console.log(`wrote ${args.out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch (error) {
    console.error(`constellation ER accuracy receipt failed: ${error.message}`);
    process.exitCode = 1;
  }
}
