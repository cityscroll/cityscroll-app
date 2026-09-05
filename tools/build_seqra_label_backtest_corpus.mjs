#!/usr/bin/env node
/**
 * SEQRA-08: build/check the labelled-corpus and rolling-origin-fold receipt
 * this card's acceptance criteria (A1-A5, negative rule) exercise, over the
 * committed synthetic fixture at
 * warehouse/fixtures/seqra-labels/label_builder_fixtures.mjs.
 *
 * `npm run warehouse:seqra:labels` (this card's `verify` field, shared with
 * SEQRA-02) runs tools/check_seqra_ontology.mjs, which execs this tool's
 * `--check` mode -- matching how tools/check_seqra_document_pipeline.mjs
 * already delegates to per-card builder tools for SEQRA-04/05. This tool is
 * also independently runnable for the card's own development loop.
 *
 * No network access: every input is the committed synthetic fixture, which
 * itself reuses SEQRA-02's contradiction fixture, SEQRA-06's multi-lot
 * spatial/implementation fixture, and SEQRA-07's actor-resolution/public-
 * position builder rather than re-authoring parallel data (this is also
 * this card's canary backtest: an end-to-end run over real prerequisite
 * outputs, not an isolated mock).
 *
 * Usage:
 *   node tools/build_seqra_label_backtest_corpus.mjs [--check]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertFoldFamilyDisjointness,
  buildAsOfFeatureSnapshot,
  buildProjectFamilies,
  buildRollingOriginFolds,
  classifyReviewPathLabel,
  classifySupplementalReviewLabel,
  EXCLUSION_REASONS,
  PROCESS_PATH_LABELS,
  SUPPLEMENTAL_REVIEW_HORIZONS,
  summarizeTargetFoldPopulation,
} from "../warehouse/lib/seqra_label_builder.mjs";
import {
  LABEL_CORPUS_FOLDS,
  LABEL_CORPUS_PROJECTS,
  LABEL_CORPUS_REVIEWS,
  OBSERVATION_HORIZON,
} from "../warehouse/fixtures/seqra-labels/label_builder_fixtures.mjs";
import { FINAL_BEFORE_DRAFT_EVENTS, FINAL_BEFORE_DRAFT_FIXTURE_KEYS } from "../warehouse/fixtures/seqra-ontology/review_event_log_fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/seqra_label_backtest_corpus_latest.json");

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
    const detail = fn();
    checks.push({ name, result: "pass", detail: detail ?? null });
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

// ---------------------------------------------------------------------------
// The corpus build itself: as-of snapshots + both targets' labels for every
// review, project families, and rolling-origin fold assignments. Computed
// once, then exercised by every check below (and reused for the written
// receipt) so the receipt describes exactly what the checks verified.
// ---------------------------------------------------------------------------
const { families, projectToFamily } = buildProjectFamilies(LABEL_CORPUS_PROJECTS);

const snapshotsByReview = new Map();
for (const review of LABEL_CORPUS_REVIEWS) {
  snapshotsByReview.set(
    review.reviewKey,
    buildAsOfFeatureSnapshot({
      reviewKey: review.reviewKey,
      cutoff: review.cutoff,
      events: review.events,
      publicPositions: review.publicPositions,
      bblHistory: review.bblHistory ?? null,
      spatialLayerRegistry: review.spatialLayerRegistry ?? null,
    }),
  );
}

const foldRows = LABEL_CORPUS_REVIEWS.map((review) => ({
  reviewKey: review.reviewKey,
  familyId: projectToFamily.get(review.projectKey),
  cutoff: review.cutoff,
}));
const foldAssignments = buildRollingOriginFolds({ rows: foldRows, folds: LABEL_CORPUS_FOLDS });

function labelRowsFor(targetName, foldId, split, horizon = null) {
  return foldAssignments
    .filter((assignment) => assignment.fold_id === foldId && (assignment.split === split || assignment.split === "excluded"))
    .map((assignment) => {
      if (assignment.split === "excluded") {
        return { reviewKey: assignment.review_key, label: null, censored: false, excludedReason: assignment.excluded_reason };
      }
      const review = LABEL_CORPUS_REVIEWS.find((r) => r.reviewKey === assignment.review_key);
      const snapshot = snapshotsByReview.get(assignment.review_key);
      if (!snapshot.ok) {
        return { reviewKey: assignment.review_key, label: null, censored: false, excludedReason: snapshot.reason };
      }
      if (targetName === "process_path") {
        return { reviewKey: assignment.review_key, label: classifyReviewPathLabel(snapshot.review_state), censored: false, excludedReason: null };
      }
      const outcome = classifySupplementalReviewLabel({
        reviewKey: assignment.review_key,
        cutoff: review.cutoff,
        horizon,
        fullEvents: review.events,
        determinationDate: review.determinationDate,
        implementationCompletionDate: review.implementationCompletionDate,
        observationHorizon: OBSERVATION_HORIZON,
      });
      return { reviewKey: assignment.review_key, label: outcome.label, censored: outcome.censored, excludedReason: null };
    });
}

const targetFoldPopulations = [];
for (const fold of LABEL_CORPUS_FOLDS) {
  for (const split of ["train", "test"]) {
    targetFoldPopulations.push(
      summarizeTargetFoldPopulation({ targetName: "process_path", foldId: fold.foldId, split, labelRows: labelRowsFor("process_path", fold.foldId, split) }),
    );
    for (const horizon of SUPPLEMENTAL_REVIEW_HORIZONS) {
      targetFoldPopulations.push(
        summarizeTargetFoldPopulation({
          targetName: `supplemental_review:${horizon}`,
          foldId: fold.foldId,
          split,
          labelRows: labelRowsFor("supplemental_review", fold.foldId, split, horizon),
        }),
      );
    }
  }
}

// -- A1: every feature in a fold is public by its cutoff; the temporal leakage count is zero. --
check("A1: every review's as-of snapshot is contradiction-free and reports zero temporal-leakage violations", () => {
  let totalChecked = 0;
  for (const review of LABEL_CORPUS_REVIEWS) {
    const snapshot = snapshotsByReview.get(review.reviewKey);
    assertTrue(snapshot.ok, `${review.reviewKey}: expected a valid as-of snapshot, got ${JSON.stringify(snapshot)}`);
    assertEqual(snapshot.leakage_audit.violation_count, 0, `${review.reviewKey}: leakage audit`);
    totalChecked += snapshot.leakage_audit.checked_count;
  }
  return { reviews_checked: LABEL_CORPUS_REVIEWS.length, records_audited: totalChecked, total_leakage_violations: 0 };
});

// -- A1 (contradiction path): reuses SEQRA-02's own fixture rather than re-authoring one. --
check("A1: a contradictory review's log is refused at the cutoff, never given a guessed feature snapshot", () => {
  const snapshot = buildAsOfFeatureSnapshot({
    reviewKey: FINAL_BEFORE_DRAFT_FIXTURE_KEYS.FINAL_BEFORE_DRAFT_REVIEW_KEY,
    cutoff: "2026-04-01T00:00:00.000Z",
    events: FINAL_BEFORE_DRAFT_EVENTS,
  });
  assertEqual(snapshot.ok, false, "contradictory review must not resolve to ok:true");
  assertEqual(snapshot.reason, EXCLUSION_REASONS.CONTRADICTION_AT_CUTOFF, "refusal reason");
  return { refused: true };
});

// -- A2 / negative rule: open reviews are right-censored, never counted as completed non-events. --
check("A2 / negative rule: no review still open as of its own horizon is ever scored as a supplemental-review negative", () => {
  let censoredCount = 0;
  let scoredCount = 0;
  for (const review of LABEL_CORPUS_REVIEWS) {
    for (const horizon of SUPPLEMENTAL_REVIEW_HORIZONS) {
      const outcome = classifySupplementalReviewLabel({
        reviewKey: review.reviewKey,
        cutoff: review.cutoff,
        horizon,
        fullEvents: review.events,
        determinationDate: review.determinationDate,
        implementationCompletionDate: review.implementationCompletionDate,
        observationHorizon: OBSERVATION_HORIZON,
      });
      if (outcome.censored) {
        assertEqual(outcome.label, null, `${review.reviewKey}/${horizon}: a censored row must carry no label`);
        censoredCount += 1;
      } else {
        assertTrue(outcome.label === 0 || outcome.label === 1, `${review.reviewKey}/${horizon}: an uncensored row must carry a definite label`);
        scoredCount += 1;
      }
    }
  }
  assertTrue(censoredCount > 0, "the fixture must exercise at least one censored row");
  return { censored_count: censoredCount, scored_count: scoredCount };
});

// -- A3: fold membership is grouped by project family; no family appears in both training and test. --
check("A3: project families group correctly and no fold assigns one family to both train and test", () => {
  const disjointness = assertFoldFamilyDisjointness(foldAssignments);
  assertTrue(disjointness.ok, `family train/test disjointness violated: ${JSON.stringify(disjointness.violations)}`);
  const sharedBblFamily = projectToFamily.get("project:zap:sample-labels-alpha-v1");
  assertEqual(projectToFamily.get("project:zap:sample-labels-alpha-v2"), sharedBblFamily, "two review generations of the same BBL must resolve to one family");
  const conflictExcluded = foldAssignments.filter((a) => a.fold_id === "fold-2024h2" && a.family_id === sharedBblFamily);
  assertTrue(conflictExcluded.length > 0 && conflictExcluded.every((a) => a.split === "excluded"), "the conflicting family must be excluded from fold-2024h2 on both sides");
  return { family_count: families.length, fold_count: LABEL_CORPUS_FOLDS.length };
});

// -- A4: population count and prevalence per target and fold, with an explicit reason for each excluded row. --
check("A4: every target/fold/split population reports population, exclusion reasons, and prevalence", () => {
  for (const population of targetFoldPopulations) {
    assertEqual(
      population.population,
      population.eligible_population + Object.values(population.excluded_by_reason).reduce((a, b) => a + b, 0),
      `${population.target_name}/${population.fold_id}/${population.split}: population must equal eligible + excluded`,
    );
    assertEqual(
      population.eligible_population,
      population.censored_count + population.labeled_population,
      `${population.target_name}/${population.fold_id}/${population.split}: eligible must equal censored + labeled`,
    );
  }
  return { population_receipts: targetFoldPopulations.length };
});

// -- A5: fold definitions are reproducible; re-deriving from the receipt's own recorded recipe yields identical membership. --
check("A5: re-deriving folds from the recorded rows/folds recipe reproduces identical membership", () => {
  const recordedRecipe = JSON.parse(stringify({ rows: foldRows, folds: LABEL_CORPUS_FOLDS }));
  const rederived = buildRollingOriginFolds(recordedRecipe);
  assertEqual(stringify(rederived), stringify(foldAssignments), "re-derived fold assignments must match byte-for-byte");
  return { reproduced: true };
});

// -- Prerequisite adapter integration: the full-integration review actually calls through to SEQRA-06 and SEQRA-07's own builders. --
check("prerequisite adapters: the full-integration review's snapshot carries real SEQRA-06 spatial features and a filtered SEQRA-07 public position", () => {
  const snapshot = snapshotsByReview.get(LABEL_CORPUS_REVIEWS.find((r) => r.spatialLayerRegistry).reviewKey);
  assertTrue(snapshot.ok && snapshot.spatial && snapshot.spatial.features.length > 0, "expected at least one SEQRA-06 spatial feature");
  assertEqual(snapshot.positions.length, 1, "only the pre-cutoff SEQRA-07 public position may be included");
  return { spatial_feature_count: snapshot.spatial.features.length, positions_included: snapshot.positions.length };
});

check("existing warehouse test suite for this card's own module stays green", () => {
  execFileSync(process.execPath, ["--test", "test/warehouse_seqra_label_builder.test.mjs"], { cwd: ROOT, stdio: "pipe" });
  return { suites_run: 1 };
});

const failed = checks.filter((c) => c.result === "fail");
const gateResult = failed.length === 0 ? "pass" : "fail";

const receipt = {
  schema: "cityscroll.seqra_label_backtest_corpus_receipt.v1",
  process_path_labels: PROCESS_PATH_LABELS,
  supplemental_review_horizons: SUPPLEMENTAL_REVIEW_HORIZONS,
  project_families: families,
  fold_definitions: LABEL_CORPUS_FOLDS,
  fold_row_recipe: foldRows,
  fold_assignments: foldAssignments,
  target_fold_populations: targetFoldPopulations,
  checks,
  gate: { result: gateResult, failed_check_count: failed.length },
};

const next = stringify(receipt);
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== "--check") throw new Error("Usage: node tools/build_seqra_label_backtest_corpus.mjs [--check]");
}

if (args.has("--check")) {
  let current = null;
  try {
    current = readFileSync(RECEIPT, "utf8");
  } catch {
    current = null;
  }
  if (current !== next) {
    console.error(next);
    throw new Error(`${path.relative(ROOT, RECEIPT)} is stale; run: node tools/build_seqra_label_backtest_corpus.mjs`);
  }
} else {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, next);
}

if (gateResult !== "pass") {
  console.error(next);
  throw new Error(`SEQRA-08 label-backtest-corpus gate failed: ${failed.map((c) => `${c.name}: ${c.message}`).join(" | ")}`);
}
console.log(`SEQRA label-backtest-corpus gate OK (${checks.length} checks)`);
