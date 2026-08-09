#!/usr/bin/env node

/** Build v3 gold by retaining immutable v2 cases and adding procedure relations. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LAND_USE_PROCEDURE_KINDS } from "../worker/src/lib/subject_registry.mjs";
import { loadCrossSpineGold } from "./cross_spine_eval.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CROSS_SPINE_GOLD_V3_PATH = resolve(ROOT, "entity_resolution/eval/cross_spine_gold_v3.jsonl");
export const CROSS_SPINE_GOLD_V3_CONFIG_PATH = resolve(
  ROOT,
  "entity_resolution/eval/cross_spine_gold_v3/procedure_relations.json",
);
const V2_PATH = resolve(ROOT, "entity_resolution/eval/cross_spine_gold_v2.jsonl");
const PROCEDURE_LABELS = Object.freeze({
  landmark_designation: "Landmark designation",
  rezoning: "Rezoning",
  ulurp: "Uniform Land Use Review Procedure",
  special_permit: "Special permit",
  city_map_change: "City map change",
  site_selection: "Site selection",
});

const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new TypeError(message); };

function procedureSide(kind, config) {
  if (!LAND_USE_PROCEDURE_KINDS.includes(kind)) fail(`unknown procedure kind ${kind}`);
  return {
    source_system: "cityscroll_procedure_vocabulary",
    source_record_id: `${config.vocabulary_version}:${kind}`,
    source_url: config.vocabulary_source_url,
    display_name: PROCEDURE_LABELS[kind],
    subject_ref: `procedure:${kind}`,
  };
}

function procedureRows(base, config) {
  const landRows = base.cases.filter((row) => row.relation === "mandate_land_use");
  return landRows.flatMap((row) => {
    const cohort = config.cohorts?.[row.source_cohort];
    if (!cohort) fail(`missing procedure mapping for ${row.source_cohort}`);
    const procedureKind = row.label === "same"
      ? cohort.procedure_kind
      : cohort.negative_procedure_kind;
    const procedure = procedureSide(procedureKind, config);
    const kindExact = row.label === "same";
    return [
      {
        id: row.id.replace("xsg-v2-land-", "xsg-v3-mandate-procedure-"),
        relation: "mandate_governs_procedure",
        tier: "inferred",
        label: row.label,
        evaluation_split: "held_out",
        source_cohort: row.source_cohort,
        sources: [row.left.source_system, procedure.source_system],
        evidence_basis: "The law text is classified to one closed procedure kind; a different procedure kind is the hard negative.",
        groups: { left: row.left.subject_ref, right: procedure.subject_ref },
        left: row.left,
        right: procedure,
        features: {
          mandate_quote_verified: true,
          procedure_kind_exact: kindExact,
          procedure_vocabulary_member: true,
        },
      },
      {
        id: row.id.replace("xsg-v2-land-", "xsg-v3-project-procedure-"),
        relation: "project_participates_in_procedure",
        tier: "inferred",
        label: row.label,
        evaluation_split: "held_out",
        source_cohort: row.source_cohort,
        sources: [row.right.source_system, procedure.source_system],
        evidence_basis: "The publisher project action code maps to one closed procedure kind; a different procedure kind is the hard negative.",
        groups: { left: row.right.subject_ref, right: procedure.subject_ref },
        left: row.right,
        right: procedure,
        features: {
          project_subject_exact: true,
          publisher_action_kind_exact: kindExact,
          procedure_vocabulary_member: true,
        },
      },
    ];
  });
}

export function buildCrossSpineGoldV3() {
  const v2Source = readFileSync(V2_PATH, "utf8");
  const configSource = readFileSync(CROSS_SPINE_GOLD_V3_CONFIG_PATH, "utf8");
  const base = loadCrossSpineGold(v2Source);
  const config = JSON.parse(configSource);
  if (config.schema !== "cityscroll.cross_spine_procedure_gold_config.v1") fail("unsupported procedure gold config");
  if (config.gold_version !== "cross_spine_gold_v3" || config.source_gold_version !== base.meta.gold_version) {
    fail("procedure gold version mismatch");
  }
  const added = procedureRows(base, config);
  const rows = [...base.cases, ...added];
  if (new Set(rows.map((row) => row.id)).size !== rows.length) fail("case ids must be unique");
  const meta = {
    _meta: true,
    gold_version: "cross_spine_gold_v3",
    schema_version: 3,
    case_count: rows.length,
    split_strategy: "frozen_field_cases_with_component_isolation",
    description: "V3 retains immutable v2 relation cases and adds publisher-grounded positive and hard-negative procedure relation cases.",
    base_gold: {
      path: "cross_spine_gold_v2.jsonl",
      gold_version: base.meta.gold_version,
      case_count: base.cases.length,
      sha256: hash(v2Source),
    },
    additions: [{
      path: "cross_spine_gold_v3/procedure_relations.json",
      relations: config.relations,
      case_count: added.length,
      sha256: hash(configSource),
    }],
  };
  const rendered = `${[meta, ...rows].map((row) => JSON.stringify(row)).join("\n")}\n`;
  loadCrossSpineGold(rendered);
  return rendered;
}

function main() {
  const check = process.argv.includes("--check");
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--check");
  if (unknown.length) fail(`unknown argument: ${unknown[0]}`);
  const rendered = buildCrossSpineGoldV3();
  if (check) {
    if (!existsSync(CROSS_SPINE_GOLD_V3_PATH)
        || readFileSync(CROSS_SPINE_GOLD_V3_PATH, "utf8") !== rendered) {
      throw new Error("generated gold drift: run node tools/build_cross_spine_gold_v3.mjs");
    }
    console.log(`cross_spine_gold_v3=clean cases=${rendered.trim().split(/\r?\n/).length - 1}`);
    return;
  }
  writeFileSync(CROSS_SPINE_GOLD_V3_PATH, rendered);
  console.log(`wrote ${CROSS_SPINE_GOLD_V3_PATH}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) {
    console.error(`cross-spine gold v3 build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
