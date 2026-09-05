import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertFoldFamilyDisjointness,
  auditFeatureLeakage,
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
  FINAL_BEFORE_DRAFT_EVENTS,
  FINAL_BEFORE_DRAFT_FIXTURE_KEYS,
} from "../warehouse/fixtures/seqra-ontology/review_event_log_fixtures.mjs";
import {
  LABEL_CORPUS_FOLDS,
  LABEL_CORPUS_PROJECTS,
  LABEL_CORPUS_REVIEWS,
  OBSERVATION_HORIZON,
  R4_CUTOFF,
  R4_REVIEW_KEY,
  R6_CUTOFF,
  R6_DETERMINATION_DATE,
  R6_COMPLETION_DATE,
  R6_REVIEW_KEY,
} from "../warehouse/fixtures/seqra-labels/label_builder_fixtures.mjs";

function buildAllSnapshots() {
  const { families, projectToFamily } = buildProjectFamilies(LABEL_CORPUS_PROJECTS);
  const snapshotsByReview = new Map();
  for (const review of LABEL_CORPUS_REVIEWS) {
    const snapshot = buildAsOfFeatureSnapshot({
      reviewKey: review.reviewKey,
      cutoff: review.cutoff,
      events: review.events,
      publicPositions: review.publicPositions,
      bblHistory: review.bblHistory ?? null,
      spatialLayerRegistry: review.spatialLayerRegistry ?? null,
    });
    snapshotsByReview.set(review.reviewKey, snapshot);
  }
  return { families, projectToFamily, snapshotsByReview };
}

describe("SEQRA-08 label builder (A1, A2, A3, A4, A5, negative rule)", () => {
  it("A1: every review's as-of snapshot reports zero temporal-leakage violations", () => {
    const { snapshotsByReview } = buildAllSnapshots();
    for (const review of LABEL_CORPUS_REVIEWS) {
      const snapshot = snapshotsByReview.get(review.reviewKey);
      assert.equal(snapshot.ok, true, `${review.reviewKey}: expected a valid as-of snapshot`);
      assert.equal(snapshot.leakage_audit.violation_count, 0, `${review.reviewKey}: leakage audit must report zero violations`);
      assert.ok(snapshot.leakage_audit.checked_count > 0, `${review.reviewKey}: leakage audit must actually check something`);
    }
  });

  it("A1: auditFeatureLeakage independently catches a record whose availability postdates the cutoff (not just trusts the safe builder)", () => {
    const leaky = {
      event_key: "review_event:leaky:1",
      available_to_public_at: "2024-06-01T00:00:00.000Z",
    };
    const result = auditFeatureLeakage({ cutoff: "2024-01-01T00:00:00.000Z", includedEvents: [leaky] });
    assert.equal(result.violation_count, 1);
    assert.equal(result.violations[0].key, "review_event:leaky:1");
  });

  it("A1: a contradictory review is refused at the cutoff, never given a guessed feature snapshot", () => {
    const snapshot = buildAsOfFeatureSnapshot({
      reviewKey: FINAL_BEFORE_DRAFT_FIXTURE_KEYS.FINAL_BEFORE_DRAFT_REVIEW_KEY,
      cutoff: "2026-04-01T00:00:00.000Z",
      events: FINAL_BEFORE_DRAFT_EVENTS,
    });
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.reason, EXCLUSION_REASONS.CONTRADICTION_AT_CUTOFF);
    assert.ok(snapshot.contradictions.length > 0);
  });

  it("target A: every process-path label is one of spec.md's five categories, and an unresolved review is its own category rather than a guess", () => {
    const { snapshotsByReview } = buildAllSnapshots();
    const r4Snapshot = snapshotsByReview.get(R4_REVIEW_KEY);
    const label = classifyReviewPathLabel(r4Snapshot.review_state);
    assert.equal(label, "unknown_or_incomplete");
    for (const review of LABEL_CORPUS_REVIEWS) {
      const snapshot = snapshotsByReview.get(review.reviewKey);
      assert.ok(PROCESS_PATH_LABELS.includes(classifyReviewPathLabel(snapshot.review_state)));
    }
  });

  it("A2 / negative rule: an open review's supplemental-review labels are right-censored, never a negative", () => {
    for (const horizon of SUPPLEMENTAL_REVIEW_HORIZONS) {
      const result = classifySupplementalReviewLabel({
        reviewKey: R4_REVIEW_KEY,
        cutoff: R4_CUTOFF,
        horizon,
        fullEvents: [],
        determinationDate: null,
        implementationCompletionDate: null,
        observationHorizon: OBSERVATION_HORIZON,
      });
      assert.equal(result.censored, true, `${horizon}: an open review must be censored, not scored`);
      assert.equal(result.label, null, `${horizon}: a censored row must carry no label`);
    }
  });

  it("A2: the same review can be censored on one horizon and a true (fully observed) negative on another", () => {
    const within90 = classifySupplementalReviewLabel({
      reviewKey: "review-under-test",
      cutoff: "2025-08-01T00:00:00.000Z",
      horizon: "within_90_days",
      fullEvents: [],
      observationHorizon: OBSERVATION_HORIZON,
    });
    assert.equal(within90.censored, false);
    assert.equal(within90.label, 0);

    const within180 = classifySupplementalReviewLabel({
      reviewKey: "review-under-test",
      cutoff: "2025-08-01T00:00:00.000Z",
      horizon: "within_180_days",
      fullEvents: [],
      observationHorizon: OBSERVATION_HORIZON,
    });
    assert.equal(within180.censored, true);
  });

  it("target E: a supplemental event before the window end is a positive at every horizon it falls inside, and negative at a horizon it falls outside", () => {
    const before90 = classifySupplementalReviewLabel({
      reviewKey: R6_REVIEW_KEY,
      cutoff: R6_CUTOFF,
      horizon: "within_90_days",
      fullEvents: LABEL_CORPUS_REVIEWS.find((r) => r.reviewKey === R6_REVIEW_KEY).events,
      determinationDate: R6_DETERMINATION_DATE,
      implementationCompletionDate: R6_COMPLETION_DATE,
      observationHorizon: OBSERVATION_HORIZON,
    });
    assert.equal(before90.label, 0, "the memo lands after the 90-day window");

    const before180 = classifySupplementalReviewLabel({
      reviewKey: R6_REVIEW_KEY,
      cutoff: R6_CUTOFF,
      horizon: "before_final_determination",
      fullEvents: LABEL_CORPUS_REVIEWS.find((r) => r.reviewKey === R6_REVIEW_KEY).events,
      determinationDate: R6_DETERMINATION_DATE,
      implementationCompletionDate: R6_COMPLETION_DATE,
      observationHorizon: OBSERVATION_HORIZON,
    });
    assert.equal(before180.label, 1, "the memo lands before the final determination");
  });

  it("A3: two review generations of the same site (shared BBL) resolve to one project family", () => {
    const { projectToFamily } = buildProjectFamilies(LABEL_CORPUS_PROJECTS);
    const alphaV1Family = projectToFamily.get("project:zap:sample-labels-alpha-v1");
    const alphaV2Family = projectToFamily.get("project:zap:sample-labels-alpha-v2");
    assert.equal(alphaV1Family, alphaV2Family);
    const betaFamily = projectToFamily.get("project:zap:sample-labels-beta");
    assert.notEqual(alphaV1Family, betaFamily);
  });

  it("A3: a fold whose train/test boundary would split a family excludes that family from both sides; a fold where it does not keeps both members", () => {
    const { projectToFamily } = buildProjectFamilies(LABEL_CORPUS_PROJECTS);
    const rows = LABEL_CORPUS_REVIEWS.map((review) => ({
      reviewKey: review.reviewKey,
      familyId: projectToFamily.get(review.projectKey),
      cutoff: review.cutoff,
    }));
    const assignments = buildRollingOriginFolds({ rows, folds: LABEL_CORPUS_FOLDS });

    const disjointness = assertFoldFamilyDisjointness(assignments);
    assert.equal(disjointness.ok, true, JSON.stringify(disjointness.violations));

    const conflictedFold = assignments.filter((a) => a.fold_id === "fold-2024h2" && a.family_id.includes("a9ce80"));
    assert.ok(conflictedFold.length > 0, "the shared-BBL family must appear in fold-2024h2's assignments");
    assert.ok(
      conflictedFold.every((a) => a.split === "excluded" && a.excluded_reason === EXCLUSION_REASONS.FAMILY_TRAIN_TEST_CONFLICT),
      "a family split across fold-2024h2's train/test boundary must be excluded from both sides",
    );

    const resolvedFold = assignments.filter((a) => a.fold_id === "fold-2025h2" && a.family_id.includes("a9ce80"));
    assert.equal(resolvedFold.length, 2);
    assert.ok(resolvedFold.every((a) => a.split === "train"), "the same family must not be excluded in a fold where both members land on the same side");
  });

  it("negative rule: fold assignment is strictly time-ordered, never a random row split -- no train row's cutoff exceeds its fold's train boundary, and every test row's cutoff falls after it", () => {
    const { projectToFamily } = buildProjectFamilies(LABEL_CORPUS_PROJECTS);
    const rows = LABEL_CORPUS_REVIEWS.map((review) => ({
      reviewKey: review.reviewKey,
      familyId: projectToFamily.get(review.projectKey),
      cutoff: review.cutoff,
    }));
    const assignments = buildRollingOriginFolds({ rows, folds: LABEL_CORPUS_FOLDS });
    const foldsById = Object.fromEntries(LABEL_CORPUS_FOLDS.map((f) => [f.foldId, f]));
    for (const assignment of assignments) {
      const fold = foldsById[assignment.fold_id];
      const cutoffMs = Date.parse(assignment.cutoff);
      if (assignment.split === "train") assert.ok(cutoffMs <= Date.parse(fold.trainEnd));
      if (assignment.split === "test") assert.ok(cutoffMs > Date.parse(fold.testStart) && cutoffMs <= Date.parse(fold.testEnd));
    }
  });

  it("A4: population, exclusion reasons and prevalence are reported per target and fold, and the eligible population excludes only named reasons", () => {
    const { projectToFamily } = buildProjectFamilies(LABEL_CORPUS_PROJECTS);
    const rows = LABEL_CORPUS_REVIEWS.map((review) => ({
      reviewKey: review.reviewKey,
      familyId: projectToFamily.get(review.projectKey),
      cutoff: review.cutoff,
    }));
    const assignments = buildRollingOriginFolds({ rows, folds: LABEL_CORPUS_FOLDS });
    const foldRows = assignments.filter((a) => a.fold_id === "fold-2024h2" && (a.split === "train" || a.split === "excluded"));
    const labelRows = foldRows.map((a) => ({ reviewKey: a.review_key, label: 0, censored: false, excludedReason: a.excluded_reason }));

    const summary = summarizeTargetFoldPopulation({ targetName: "process_path", foldId: "fold-2024h2", split: "train", labelRows });
    assert.equal(summary.population, labelRows.length);
    assert.equal(summary.population, summary.eligible_population + Object.values(summary.excluded_by_reason).reduce((a, b) => a + b, 0));
    assert.equal(summary.excluded_by_reason[EXCLUSION_REASONS.FAMILY_TRAIN_TEST_CONFLICT], 2);
    assert.deepEqual(summary.prevalence, { 0: 1 });
  });

  it("A5: fold construction is deterministic -- rerunning on the same recorded rows/folds recipe yields byte-identical membership regardless of input array order", () => {
    const { projectToFamily } = buildProjectFamilies(LABEL_CORPUS_PROJECTS);
    const rows = LABEL_CORPUS_REVIEWS.map((review) => ({
      reviewKey: review.reviewKey,
      familyId: projectToFamily.get(review.projectKey),
      cutoff: review.cutoff,
    }));
    const first = buildRollingOriginFolds({ rows, folds: LABEL_CORPUS_FOLDS });
    const second = buildRollingOriginFolds({ rows: [...rows].reverse(), folds: [...LABEL_CORPUS_FOLDS].reverse() });
    assert.deepEqual(second, first);

    // Re-deriving from the receipt's own recorded recipe (not the corpus's live objects) must reproduce identical membership (G5).
    const recordedRecipe = JSON.parse(JSON.stringify({ rows, folds: LABEL_CORPUS_FOLDS }));
    const rederived = buildRollingOriginFolds(recordedRecipe);
    assert.deepEqual(rederived, first);
  });

  it("prerequisite adapter integration: the full-integration review reuses SEQRA-06's spatial/implementation joins and SEQRA-07's public-position builder end to end", () => {
    const { snapshotsByReview } = buildAllSnapshots();
    const snapshot = snapshotsByReview.get(R6_REVIEW_KEY);
    assert.equal(snapshot.ok, true);
    assert.ok(snapshot.spatial.features.length > 0, "SEQRA-06 spatial join must have produced at least one feature");
    assert.equal(snapshot.positions.length, 1, "only the pre-cutoff SEQRA-07 public position may be included");
    assert.equal(snapshot.leakage_audit.violation_count, 0);
  });
});
