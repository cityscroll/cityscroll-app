#!/usr/bin/env node
/**
 * SEQRA-02: the narrow `npm run warehouse:seqra:labels` command surface the
 * card's `verify` field names. This is not the label-builder or backtest
 * corpus later cards (SEQRA-08) own -- it validates the process ontology and
 * as-of projector this card actually delivers: schema shape, relation
 * integrity over a multi-action/multi-review/multi-BBL fixture, cutoff
 * reproduction and replay-order independence, draft/final coexistence, the
 * two required contradiction fixtures (final-before-draft, conflicting
 * determinations), and that the SEQRA-01 California/CEQA rejection path
 * still admits zero rows. No network access; every input is a retained
 * fixture or a previously committed SEQRA-01 receipt.
 *
 * Default mode runs the checks and writes the receipt. `--check` reruns and
 * diffs against the committed receipt, matching every other warehouse
 * builder's `--check` convention.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { SEQRA_ONTOLOGY_ENTITY_TYPES, SEQRA_ONTOLOGY_RELATIONS } from "../warehouse/lib/seqra_ontology_spec.mjs";
import { validateOntologyGraph } from "../warehouse/lib/seqra_ontology_graph.mjs";
import { SAMPLE_MULTI_BBL_PROJECT_GRAPH } from "../warehouse/fixtures/seqra-ontology/multi_action_multi_bbl_project.mjs";
import {
  buildAppendOnlyLog,
  detectContradictions,
  projectReviewStateAsOf,
  CONTRADICTION_TYPES,
} from "../warehouse/lib/seqra_review_event_log.mjs";
import {
  CLEAN_REVIEW_EVENTS,
  CLEAN_REVIEW_FIXTURE_CUTOFFS,
  CLEAN_REVIEW_FIXTURE_KEYS,
  CONFLICTING_DETERMINATIONS_EVENTS,
  CONFLICTING_DETERMINATIONS_FIXTURE_KEYS,
  FINAL_BEFORE_DRAFT_EVENTS,
  FINAL_BEFORE_DRAFT_FIXTURE_KEYS,
} from "../warehouse/fixtures/seqra-ontology/review_event_log_fixtures.mjs";
import { summarizeScopeClassification } from "../warehouse/lib/seqra_scope_classifier.mjs";
import { SEQRA_JURISDICTION_FIXTURE_BATCH } from "../warehouse/fixtures/seqra-inventory/jurisdiction_fixture_batch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/seqra_ontology_projector_latest.json");
const SEQRA01_INVENTORY_RECEIPT = path.join(ROOT, "warehouse/receipts/proof/seqra_source_inventory_latest.json");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function stringify(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, result: "pass" });
  } catch (error) {
    checks.push({ name, result: "fail", message: error.message });
  }
}
function assertTrue(value, message) {
  if (!value) throw new Error(message);
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

check("ontology schema files are not stale", () => {
  execFileSync(process.execPath, ["tools/build_seqra_ontology_schemas.mjs", "--check"], { cwd: ROOT, stdio: "pipe" });
});

check("fifteen commissioned core entities are declared", () => {
  assertEqual(SEQRA_ONTOLOGY_ENTITY_TYPES.length, 15, "entity count");
});

check("thirteen commissioned relations are declared", () => {
  assertEqual(SEQRA_ONTOLOGY_RELATIONS.length, 13, "relation count");
});

check("multi-action, multi-review, multi-BBL project graph validates with zero findings (A4)", () => {
  const findings = validateOntologyGraph(SAMPLE_MULTI_BBL_PROJECT_GRAPH);
  assertEqual(findings.length, 0, `graph findings: ${findings.join("; ")}`);
  assertTrue(SAMPLE_MULTI_BBL_PROJECT_GRAPH.government_action.length >= 2, "multiple government actions");
  assertTrue(SAMPLE_MULTI_BBL_PROJECT_GRAPH.environmental_review.length >= 2, "multiple environmental reviews");
  assertTrue(SAMPLE_MULTI_BBL_PROJECT_GRAPH.project[0].bbl_list.length >= 2, "multiple BBLs");
});

let cleanProjections = {};
check("clean review event log projects correctly at three historical cutoffs (A1)", () => {
  buildAppendOnlyLog(CLEAN_REVIEW_EVENTS); // throws on any schema violation
  for (const [label, cutoff] of Object.entries(CLEAN_REVIEW_FIXTURE_CUTOFFS)) {
    const projection = projectReviewStateAsOf(CLEAN_REVIEW_EVENTS, { reviewKey: CLEAN_REVIEW_FIXTURE_KEYS.CLEAN_REVIEW_KEY, cutoff });
    assertTrue(projection.ok, `${label}: expected a clean projection`);
    cleanProjections[label] = projection;
  }
});

check("draft and final documents coexist with explicit supersession, never row overwrite (A5)", () => {
  const after = cleanProjections.AFTER_DETERMINATION;
  assertTrue(after?.ok, "AFTER_DETERMINATION projection must exist");
  const deis = after.documents[CLEAN_REVIEW_FIXTURE_KEYS.DEIS_KEY];
  const feis = after.documents[CLEAN_REVIEW_FIXTURE_KEYS.FEIS_KEY];
  assertTrue(Boolean(deis) && Boolean(feis), "both draft and final documents must remain present");
  assertEqual(deis.superseded_by_document_key, CLEAN_REVIEW_FIXTURE_KEYS.FEIS_KEY, "draft must be linked to its superseding final");
});

check("replay order does not change the projection (A3)", () => {
  const forward = projectReviewStateAsOf(CLEAN_REVIEW_EVENTS, { reviewKey: CLEAN_REVIEW_FIXTURE_KEYS.CLEAN_REVIEW_KEY, cutoff: CLEAN_REVIEW_FIXTURE_CUTOFFS.AFTER_DETERMINATION });
  const reversed = projectReviewStateAsOf([...CLEAN_REVIEW_EVENTS].reverse(), { reviewKey: CLEAN_REVIEW_FIXTURE_KEYS.CLEAN_REVIEW_KEY, cutoff: CLEAN_REVIEW_FIXTURE_CUTOFFS.AFTER_DETERMINATION });
  assertEqual(stringify(forward), stringify(reversed), "forward vs reversed replay");
});

check("a final document before its draft fails visibly (A6)", () => {
  const contradictions = detectContradictions(FINAL_BEFORE_DRAFT_EVENTS);
  assertEqual(contradictions.length, 1, "contradiction count");
  assertEqual(contradictions[0].type, CONTRADICTION_TYPES.FINAL_BEFORE_DRAFT, "contradiction type");
  const projection = projectReviewStateAsOf(FINAL_BEFORE_DRAFT_EVENTS, { reviewKey: FINAL_BEFORE_DRAFT_FIXTURE_KEYS.FINAL_BEFORE_DRAFT_REVIEW_KEY, cutoff: "2026-12-31T00:00:00.000Z" });
  assertEqual(projection.ok, false, "projection must refuse to produce a state");
});

check("two conflicting determinations for one action fail visibly (A6)", () => {
  const contradictions = detectContradictions(CONFLICTING_DETERMINATIONS_EVENTS);
  assertEqual(contradictions.length, 1, "contradiction count");
  assertEqual(contradictions[0].type, CONTRADICTION_TYPES.CONFLICTING_DETERMINATIONS, "contradiction type");
  const projection = projectReviewStateAsOf(CONFLICTING_DETERMINATIONS_EVENTS, { reviewKey: CONFLICTING_DETERMINATIONS_FIXTURE_KEYS.CONFLICTING_DETERMINATION_REVIEW_KEY, cutoff: "2026-12-31T00:00:00.000Z" });
  assertEqual(projection.ok, false, "projection must refuse to produce a state");
});

let scopeSummary = null;
check("SEQRA-01 California/CEQA rejection remains at zero admitted rows (A7 non-regression)", () => {
  scopeSummary = summarizeScopeClassification(SEQRA_JURISDICTION_FIXTURE_BATCH);
  assertEqual(scopeSummary.california_or_ceqa_admitted_count, 0, "california_or_ceqa_admitted_count");
});

let seqra01ReceiptPresent = false;
check("the retained SEQRA-01 source inventory receipt is present and parseable (reuse, no new fetch)", () => {
  seqra01ReceiptPresent = existsSync(SEQRA01_INVENTORY_RECEIPT);
  assertTrue(seqra01ReceiptPresent, `missing ${path.relative(ROOT, SEQRA01_INVENTORY_RECEIPT)}`);
  JSON.parse(readFileSync(SEQRA01_INVENTORY_RECEIPT, "utf8"));
});

const failed = checks.filter((c) => c.result === "fail");
const gateResult = failed.length === 0 ? "pass" : "fail";

// No generated_at field: this receipt is a pure function of retained
// fixtures and committed inputs (no live fetch, no wall clock), so two
// consecutive runs -- and --check against a committed copy -- are
// byte-identical.
const receipt = {
  schema: "cityscroll.seqra_ontology_projector_receipt.v1",
  entity_type_count: SEQRA_ONTOLOGY_ENTITY_TYPES.length,
  relation_count: SEQRA_ONTOLOGY_RELATIONS.length,
  checks,
  california_or_ceqa_admitted_count: scopeSummary?.california_or_ceqa_admitted_count ?? null,
  seqra01_inventory_receipt_present: seqra01ReceiptPresent,
  gate: { result: gateResult, failed_check_count: failed.length },
};

const next = stringify(receipt);
const args = new Set(process.argv.slice(2));
if (args.has("--check")) {
  let current = null;
  try {
    current = readFileSync(RECEIPT, "utf8");
  } catch {
    current = null;
  }
  if (current !== next) {
    console.error(next);
    throw new Error(`${path.relative(ROOT, RECEIPT)} is stale; run: node tools/check_seqra_ontology.mjs`);
  }
} else {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, next);
}

if (gateResult !== "pass") {
  console.error(next);
  throw new Error(`SEQRA ontology gate failed: ${failed.map((c) => `${c.name}: ${c.message}`).join(" | ")}`);
}
console.log(`SEQRA ontology/projector gate OK (${checks.length} checks)`);
