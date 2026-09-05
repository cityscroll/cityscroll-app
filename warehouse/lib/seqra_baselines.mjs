/**
 * SEQRA-09: interpretable multi-target baselines over SEQRA-08's labelled
 * corpus, with out-of-time calibration, error reporting and a source-tier
 * ablation.
 *
 * Why baselines first. The workstream spec puts regularized linear models,
 * a discrete-time survival model and an ordinal model ahead of anything
 * more elaborate, and this module is the reason that ordering is
 * enforceable rather than aspirational: until a fitted baseline has been
 * measured out-of-time against a documented naive comparator, a later model
 * has nothing to beat and no way to show that document or institutional
 * enrichment bought anything.
 *
 * What this module does NOT do:
 *  - it never collapses the targets into one project-risk score. Each target
 *    is fitted, scored and reported separately, and there is no code path
 *    that combines them into a single number (negative rule);
 *  - it emits no resident-facing legal conclusion, and no probability of
 *    anyone suing anyone. `assertNoForbiddenEstimate` is the callable form
 *    of that rule (A5);
 *  - it does not re-derive the corpus. Rows, folds, families, censoring and
 *    denominators all come from SEQRA-08 (`warehouse/lib/seqra_label_builder
 *    .mjs`), whose leakage audit is re-run here per snapshot rather than
 *    assumed.
 *
 * Determinism. Every model here is fitted by a fixed number of full-batch
 * gradient steps from an all-zero start, over rows in a sorted order, and
 * every transcendental it needs is computed by `expDeterministic` /
 * `logDeterministic` below rather than by `Math.exp` / `Math.log`. IEEE-754
 * pins the results of `+ - * /` exactly; it does not pin `Math.exp`, whose
 * last bits are free to differ between platforms and V8 versions. A receipt
 * that has to be byte-identical in CI and on a contributor's laptop cannot
 * be built on an unpinned primitive, so this module does not use one.
 */
import {
  buildAsOfFeatureSnapshot,
  buildProjectFamilies,
  buildRollingOriginFolds,
  classifyReviewPathLabel,
  classifySupplementalReviewLabel,
  PROCESS_PATH_LABELS,
  SUPPLEMENTAL_REVIEW_HORIZONS,
  summarizeTargetFoldPopulation,
} from "./seqra_label_builder.mjs";
import { buildAppendOnlyLog, projectReviewStateAsOf } from "./seqra_review_event_log.mjs";
import { SEQRA_TOPIC_ASSESSMENT_STATES } from "./seqra_ontology_spec.mjs";

export const SEQRA_BASELINES_SCHEMA = "cityscroll.seqra_baselines.v1";

export class SeqraBaselineError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeqraBaselineError";
  }
}

// ---------------------------------------------------------------------------
// Platform-pinned transcendentals.
// ---------------------------------------------------------------------------

// fdlibm's split of ln 2. LN2_HI's low 21 mantissa bits are zero, so k * LN2_HI
// is exact for every exponent this module can produce.
const LN2_HI = 6.93147180369123816490e-01;
const LN2_LO = 1.90821492927058770002e-10;
const LOG2E = 1.44269504088896338700e+00;
const SQRT2 = 1.41421356237309504880e+00;
const SQRT1_2 = 7.07106781186547524401e-01;

function pow2(exponent) {
  let result = 1;
  const steps = exponent < 0 ? -exponent : exponent;
  for (let i = 0; i < steps; i++) result = exponent < 0 ? result / 2 : result * 2;
  return result;
}

/**
 * exp(x) to within about one ulp, using only IEEE-754-exact arithmetic:
 * argument reduction to |r| <= ln(2)/2 followed by a 16-term Taylor series.
 */
export function expDeterministic(x) {
  if (!Number.isFinite(x)) throw new SeqraBaselineError(`expDeterministic requires a finite argument, got ${x}`);
  if (x > 709) return Number.MAX_VALUE;
  if (x < -745) return 0;
  const k = Math.round(x * LOG2E);
  const r = (x - k * LN2_HI) - k * LN2_LO;
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= 16; n++) {
    term = (term * r) / n;
    sum += term;
  }
  return sum * pow2(k);
}

/**
 * log(x) to within about one ulp, by the same rule: binary exponent extraction
 * (exact, since halving and doubling are exact) plus the atanh series, which
 * converges on |(m-1)/(m+1)| <= 0.1716 in a dozen terms.
 */
export function logDeterministic(x) {
  if (!(x > 0) || !Number.isFinite(x)) throw new SeqraBaselineError(`logDeterministic requires a positive finite argument, got ${x}`);
  let mantissa = x;
  let exponent = 0;
  while (mantissa >= SQRT2) {
    mantissa /= 2;
    exponent += 1;
  }
  while (mantissa < SQRT1_2) {
    mantissa *= 2;
    exponent -= 1;
  }
  const s = (mantissa - 1) / (mantissa + 1);
  const sSquared = s * s;
  let term = s;
  let sum = s;
  for (let n = 1; n <= 12; n++) {
    term *= sSquared;
    sum += term / (2 * n + 1);
  }
  return 2 * sum + exponent * LN2_HI + exponent * LN2_LO;
}

export function sigmoid(z) {
  if (z >= 0) return 1 / (1 + expDeterministic(-z));
  const e = expDeterministic(z);
  return e / (1 + e);
}

function softmax(scores) {
  let max = scores[0];
  for (const score of scores) if (score > max) max = score;
  const exps = scores.map((score) => expDeterministic(score - max));
  let total = 0;
  for (const value of exps) total += value;
  return exps.map((value) => value / total);
}

/** log1p via the pinned log, so feature construction is pinned too. */
function log1pDeterministic(x) {
  return logDeterministic(1 + x);
}

const PROBABILITY_FLOOR = 1e-12;
function clampProbability(p) {
  if (p < PROBABILITY_FLOOR) return PROBABILITY_FLOOR;
  if (p > 1 - PROBABILITY_FLOOR) return 1 - PROBABILITY_FLOOR;
  return p;
}

// ---------------------------------------------------------------------------
// Source tiers (A3).
// ---------------------------------------------------------------------------

export const SOURCE_TIERS = Object.freeze([
  "structured",
  "structured_plus_documents",
  "structured_plus_documents_plus_institutional",
]);

/**
 * Which tier each feature belongs to. A tier's feature set is the union of
 * its own features and every earlier tier's, so the ablation is nested:
 * "did adding documents help" is a question about one comparison, not about
 * two unrelated feature sets.
 */
export const FEATURE_TIERS = Object.freeze({
  regime_is_ceqr: "structured",
  eas_or_eaf_accepted: "structured",
  lead_agency_established: "structured",
  years_since_first_event: "structured",
  log_structural_milestone_count: "structured",
  log_project_family_size: "structured",

  log_topic_assessment_count: "structured_plus_documents",
  log_topics_screened: "structured_plus_documents",
  log_topics_detailed: "structured_plus_documents",
  detailed_topic_share: "structured_plus_documents",
  document_count: "structured_plus_documents",
  has_draft_document: "structured_plus_documents",
  topic_is_detailed_at_cutoff: "structured_plus_documents",
  topic_screen_rank: "structured_plus_documents",

  log_position_count: "structured_plus_documents_plus_institutional",
  log_opposing_position_count: "structured_plus_documents_plus_institutional",
  opposing_position_share: "structured_plus_documents_plus_institutional",
  log_distinct_organizations: "structured_plus_documents_plus_institutional",
});

function tierRank(tier) {
  const rank = SOURCE_TIERS.indexOf(tier);
  if (rank < 0) throw new SeqraBaselineError(`unknown source tier ${JSON.stringify(tier)}`);
  return rank;
}

/** The feature names a tier may use, in a fixed order. */
export function featureNamesForTier(tier, availableNames) {
  const limit = tierRank(tier);
  return availableNames.filter((name) => {
    const featureTier = FEATURE_TIERS[name];
    if (!featureTier) throw new SeqraBaselineError(`feature ${JSON.stringify(name)} is not assigned to a source tier`);
    return tierRank(featureTier) <= limit;
  });
}

// ---------------------------------------------------------------------------
// The ordinal ladder for the technical-issue-state target.
// ---------------------------------------------------------------------------

/**
 * SEQRA-02's frozen `SEQRA_TOPIC_ASSESSMENT_STATES` is a nominal set: it
 * records what happened to a topic, not how far from resolved it is. An
 * ordinal baseline needs a monotone ladder, so this is the declared,
 * reviewable collapse of those eleven states onto five levels of "how
 * unresolved is this technical issue". It is a projection for modelling, not
 * a change to the ontology, and it is exhaustive by construction: a state
 * missing from the map is refused rather than defaulted.
 */
export const TECHNICAL_ISSUE_ORDINAL_LEVELS = Object.freeze([
  "resolved_without_analysis",
  "analysed_no_impact",
  "impact_identified_or_addressed",
  "contested",
  "unmitigated",
]);

const TOPIC_STATE_TO_ORDINAL_LEVEL = Object.freeze({
  not_located: "resolved_without_analysis",
  screened_out: "resolved_without_analysis",
  detailed_analysis: "analysed_no_impact",
  impact_identified: "impact_identified_or_addressed",
  mitigation_proposed: "impact_identified_or_addressed",
  mitigated: "impact_identified_or_addressed",
  agency_response_complete: "impact_identified_or_addressed",
  disputed_in_comments: "contested",
  supplementation_requested: "contested",
  supplementation_denied: "contested",
  unmitigated: "unmitigated",
});

export function mapTopicStateToOrdinalLevel(state) {
  const level = TOPIC_STATE_TO_ORDINAL_LEVEL[state];
  if (!level) throw new SeqraBaselineError(`topic assessment state ${JSON.stringify(state)} has no declared ordinal level`);
  return level;
}

/** Every ontology state must have a level: an ontology addition must break this, not slip through. */
export function auditOrdinalLadderCoverage() {
  const missing = SEQRA_TOPIC_ASSESSMENT_STATES.filter((state) => !(state in TOPIC_STATE_TO_ORDINAL_LEVEL));
  return { ok: missing.length === 0, missing_states: missing, level_count: TECHNICAL_ISSUE_ORDINAL_LEVELS.length };
}

// ---------------------------------------------------------------------------
// Features, derived only from an as-of snapshot (so the leakage discipline is
// SEQRA-08's, not a second implementation of it).
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Review-level features from one SEQRA-08 as-of snapshot. Every value is a
 * function of events already public at the snapshot's own cutoff; nothing
 * here reads the review's later history, and `snapshot.leakage_audit` is the
 * independent check that this held.
 */
export function buildReviewFeatures({ snapshot, regime, familySize } = {}) {
  if (!snapshot || snapshot.ok !== true) {
    throw new SeqraBaselineError("buildReviewFeatures requires an ok:true as-of feature snapshot");
  }
  const state = snapshot.review_state;
  const cutoffMs = Date.parse(snapshot.cutoff);
  // The structured tier counts only structural milestones. Counting every
  // event would smuggle the document tier (topic assessments) and the
  // institutional tier (recorded positions) into the structured feature set
  // through the back door, and the ablation below would then be measuring
  // nothing.
  const structuralMilestones = state.milestones.filter(
    (milestone) => milestone.event_type !== "topic_assessed" && milestone.event_type !== "position_taken",
  );
  const milestoneTimes = state.milestones.map((milestone) => Date.parse(milestone.effective_at));
  const firstEventMs = milestoneTimes.length > 0 ? Math.min(...milestoneTimes) : cutoffMs;

  const topics = Object.values(state.topics);
  const screened = topics.length;
  const detailed = topics.filter((topic) => topic.state === "detailed_analysis").length;
  const positions = state.positions;
  const opposing = positions.filter((position) => position.position === "oppose").length;
  const organizations = new Set(positions.map((position) => position.organization_key));

  return {
    regime_is_ceqr: regime === "CEQR" ? 1 : 0,
    eas_or_eaf_accepted: state.milestones.some((m) => m.event_type === "eas_or_eaf_accepted") ? 1 : 0,
    lead_agency_established: state.milestones.some((m) => m.event_type === "lead_agency_established") ? 1 : 0,
    years_since_first_event: (cutoffMs - firstEventMs) / (365 * DAY_MS),
    log_structural_milestone_count: log1pDeterministic(structuralMilestones.length),
    log_project_family_size: log1pDeterministic(familySize ?? 1),

    log_topic_assessment_count: log1pDeterministic(topics.length),
    log_topics_screened: log1pDeterministic(screened),
    log_topics_detailed: log1pDeterministic(detailed),
    detailed_topic_share: screened > 0 ? detailed / screened : 0,
    document_count: Object.keys(state.documents).length,
    has_draft_document: Object.values(state.documents).some((doc) => doc.document_stage === "draft") ? 1 : 0,

    log_position_count: log1pDeterministic(positions.length),
    log_opposing_position_count: log1pDeterministic(opposing),
    opposing_position_share: positions.length > 0 ? opposing / positions.length : 0,
    log_distinct_organizations: log1pDeterministic(organizations.size),
  };
}

// ---------------------------------------------------------------------------
// Design matrices.
// ---------------------------------------------------------------------------

function designMatrix(rows, featureNames) {
  return rows.map((row) => featureNames.map((name) => {
    const value = row.features[name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new SeqraBaselineError(`row ${row.row_key}: feature ${name} is not a finite number`);
    }
    return value;
  }));
}

/** Train-fold standardization only. Test rows are transformed, never consulted. */
function fitStandardizer(matrix) {
  const columns = matrix[0]?.length ?? 0;
  const means = new Array(columns).fill(0);
  const deviations = new Array(columns).fill(1);
  if (matrix.length === 0) return { means, deviations };
  for (let c = 0; c < columns; c++) {
    let total = 0;
    for (const row of matrix) total += row[c];
    means[c] = total / matrix.length;
    let sumSquares = 0;
    for (const row of matrix) {
      const delta = row[c] - means[c];
      sumSquares += delta * delta;
    }
    const deviation = Math.sqrt(sumSquares / matrix.length);
    deviations[c] = deviation > 1e-9 ? deviation : 1;
  }
  return { means, deviations };
}

function applyStandardizer(matrix, standardizer) {
  return matrix.map((row) => row.map((value, c) => (value - standardizer.means[c]) / standardizer.deviations[c]));
}

// ---------------------------------------------------------------------------
// Models. Full-batch gradient descent from zero, fixed step, fixed iteration
// count: no early stopping on a validation split (there is no validation
// split to spend), no randomness, no convergence criterion whose trip point
// could differ by one iteration between platforms.
// ---------------------------------------------------------------------------

export const DEFAULT_FIT_OPTIONS = Object.freeze({
  iterations: 900,
  learningRate: 0.5,
  l2Penalty: 1.0,
});


/** Newton steps for the IRLS fitter. Fixed, not adaptive: see fitBinaryLogistic. */
export const IRLS_ITERATIONS = 12;

/** Regularized multinomial (softmax) logistic regression. */
export function fitMultinomialLogistic({ matrix, labels, classCount, options = DEFAULT_FIT_OPTIONS } = {}) {
  const featureCount = matrix[0]?.length ?? 0;
  const weights = Array.from({ length: classCount }, () => new Array(featureCount).fill(0));
  const intercepts = new Array(classCount).fill(0);
  const n = matrix.length;
  if (n === 0) return { weights, intercepts, class_count: classCount, feature_count: featureCount, fitted_rows: 0 };

  for (let iteration = 0; iteration < options.iterations; iteration++) {
    const weightGradients = Array.from({ length: classCount }, () => new Array(featureCount).fill(0));
    const interceptGradients = new Array(classCount).fill(0);
    for (let i = 0; i < n; i++) {
      const row = matrix[i];
      const scores = new Array(classCount);
      for (let k = 0; k < classCount; k++) {
        let score = intercepts[k];
        for (let f = 0; f < featureCount; f++) score += weights[k][f] * row[f];
        scores[k] = score;
      }
      const probabilities = softmax(scores);
      for (let k = 0; k < classCount; k++) {
        const residual = probabilities[k] - (labels[i] === k ? 1 : 0);
        interceptGradients[k] += residual;
        for (let f = 0; f < featureCount; f++) weightGradients[k][f] += residual * row[f];
      }
    }
    for (let k = 0; k < classCount; k++) {
      intercepts[k] -= (options.learningRate * interceptGradients[k]) / n;
      for (let f = 0; f < featureCount; f++) {
        const gradient = weightGradients[k][f] / n + (options.l2Penalty * weights[k][f]) / n;
        weights[k][f] -= options.learningRate * gradient;
      }
    }
  }
  return { weights, intercepts, class_count: classCount, feature_count: featureCount, fitted_rows: n };
}

export function predictMultinomial(model, row) {
  const scores = new Array(model.class_count);
  for (let k = 0; k < model.class_count; k++) {
    let score = model.intercepts[k];
    for (let f = 0; f < model.feature_count; f++) score += model.weights[k][f] * row[f];
    scores[k] = score;
  }
  return softmax(scores);
}

/**
 * Cholesky solve for a symmetric positive-definite system. Used by the IRLS
 * fitter below; every operation is `+ - * /` or `Math.sqrt`, all of which
 * IEEE-754 pins exactly, so a fitted coefficient is the same number on every
 * platform.
 */
function solveSymmetricPositiveDefinite(matrix, vector) {
  const size = vector.length;
  const lower = Array.from({ length: size }, () => new Array(size).fill(0));
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= i; j++) {
      let total = matrix[i][j];
      for (let k = 0; k < j; k++) total -= lower[i][k] * lower[j][k];
      if (i === j) {
        if (!(total > 0)) throw new SeqraBaselineError("normal-equation matrix is not positive definite; increase the L2 penalty");
        lower[i][i] = Math.sqrt(total);
      } else {
        lower[i][j] = total / lower[j][j];
      }
    }
  }
  const forward = new Array(size).fill(0);
  for (let i = 0; i < size; i++) {
    let total = vector[i];
    for (let k = 0; k < i; k++) total -= lower[i][k] * forward[k];
    forward[i] = total / lower[i][i];
  }
  const solution = new Array(size).fill(0);
  for (let i = size - 1; i >= 0; i--) {
    let total = forward[i];
    for (let k = i + 1; k < size; k++) total -= lower[k][i] * solution[k];
    solution[i] = total / lower[i][i];
  }
  return solution;
}

/**
 * Regularized binary logistic regression, fitted by ridge-penalised IRLS
 * (Newton-Raphson on the penalised likelihood).
 *
 * Gradient descent was the first thing tried here and it is the wrong tool for
 * this particular design matrix: the discrete-time hazard model below carries
 * one dummy per time bin alongside standardized features, which makes the
 * Hessian badly conditioned, and a first-order method reports "the documents
 * tier does not help" when what actually happened is that its coefficients had
 * not moved yet. Newton is scale-free in exactly the direction that matters,
 * converges in well under the fixed iteration budget, and stays deterministic:
 * fixed iteration count, no line search, no convergence test whose trip point
 * could differ between platforms. The ridge term is what keeps the step
 * defined when a fold's rows are separable.
 */
export function fitBinaryLogistic({ matrix, labels, options = DEFAULT_FIT_OPTIONS } = {}) {
  const featureCount = matrix[0]?.length ?? 0;
  const n = matrix.length;
  if (n === 0) return { weights: new Array(featureCount).fill(0), intercept: 0, feature_count: featureCount, fitted_rows: 0 };

  const size = featureCount + 1;
  const penalty = options.l2Penalty;
  const coefficients = new Array(size).fill(0);

  for (let iteration = 0; iteration < IRLS_ITERATIONS; iteration++) {
    const hessian = Array.from({ length: size }, () => new Array(size).fill(0));
    const gradient = new Array(size).fill(0);
    for (let i = 0; i < n; i++) {
      const row = matrix[i];
      let score = coefficients[0];
      for (let f = 0; f < featureCount; f++) score += coefficients[f + 1] * row[f];
      const mean = sigmoid(score);
      const weight = Math.max(mean * (1 - mean), 1e-8);
      const residual = mean - labels[i];
      gradient[0] += residual;
      for (let f = 0; f < featureCount; f++) gradient[f + 1] += residual * row[f];
      hessian[0][0] += weight;
      for (let a = 0; a < featureCount; a++) {
        hessian[0][a + 1] += weight * row[a];
        hessian[a + 1][0] += weight * row[a];
        for (let b = 0; b < featureCount; b++) hessian[a + 1][b + 1] += weight * row[a] * row[b];
      }
    }
    // Ridge on the coefficients, never on the intercept: penalising the
    // intercept would shrink the fitted base rate toward one half, which is
    // not a prior anyone holds about environmental review.
    for (let f = 0; f < featureCount; f++) {
      gradient[f + 1] += penalty * coefficients[f + 1];
      hessian[f + 1][f + 1] += penalty;
    }
    hessian[0][0] += 1e-8;
    const step = solveSymmetricPositiveDefinite(hessian, gradient);
    for (let index = 0; index < size; index++) coefficients[index] -= step[index];
  }

  return {
    weights: coefficients.slice(1),
    intercept: coefficients[0],
    feature_count: featureCount,
    fitted_rows: n,
    fit_method: "ridge_penalised_irls",
    irls_iterations: IRLS_ITERATIONS,
    l2_penalty: penalty,
  };
}

export function predictBinary(model, row) {
  let score = model.intercept;
  for (let f = 0; f < model.feature_count; f++) score += model.weights[f] * row[f];
  return sigmoid(score);
}

/**
 * Proportional-odds (cumulative-link) ordinal logistic regression: one shared
 * coefficient vector plus `levelCount - 1` ordered thresholds. Ordering is
 * enforced by construction -- the thresholds are the first threshold plus a
 * running sum of softplus-transformed gaps -- so a fit can never produce a
 * negative cumulative probability the way an unconstrained multiclass fit
 * over an ordered label can.
 */
export function fitOrdinalLogistic({ matrix, labels, levelCount, options = DEFAULT_FIT_OPTIONS } = {}) {
  const featureCount = matrix[0]?.length ?? 0;
  const gapCount = levelCount - 1;
  const weights = new Array(featureCount).fill(0);
  const rawThresholds = new Array(gapCount).fill(0);
  for (let g = 1; g < gapCount; g++) rawThresholds[g] = 0;
  const n = matrix.length;
  if (n === 0) return { weights, raw_thresholds: rawThresholds, level_count: levelCount, feature_count: featureCount, fitted_rows: 0 };

  const softplus = (value) => (value > 30 ? value : logDeterministic(1 + expDeterministic(value)));
  const softplusDerivative = (value) => (value > 30 ? 1 : sigmoid(value));

  for (let iteration = 0; iteration < options.iterations; iteration++) {
    const weightGradients = new Array(featureCount).fill(0);
    const thresholdGradients = new Array(gapCount).fill(0);
    const thresholds = thresholdsFromRaw(rawThresholds, softplus);

    for (let i = 0; i < n; i++) {
      const row = matrix[i];
      let score = 0;
      for (let f = 0; f < featureCount; f++) score += weights[f] * row[f];
      const level = labels[i];
      // P(Y <= j) = sigmoid(theta_j - score)
      const lowerIndex = level - 1;
      const upperIndex = level;
      const lower = lowerIndex >= 0 ? sigmoid(thresholds[lowerIndex] - score) : 0;
      const upper = upperIndex < gapCount ? sigmoid(thresholds[upperIndex] - score) : 1;
      const probability = clampProbability(upper - lower);

      const upperDerivative = upperIndex < gapCount ? upper * (1 - upper) : 0;
      const lowerDerivative = lowerIndex >= 0 ? lower * (1 - lower) : 0;

      // d(-log p)/d(score) = (upperDerivative - lowerDerivative) / p
      const scoreGradient = (upperDerivative - lowerDerivative) / probability;
      for (let f = 0; f < featureCount; f++) weightGradients[f] += scoreGradient * row[f];

      if (upperIndex < gapCount) thresholdGradients[upperIndex] += -upperDerivative / probability;
      if (lowerIndex >= 0) thresholdGradients[lowerIndex] += lowerDerivative / probability;
    }

    // Chain the threshold gradients back through the ordering reparameterization.
    const rawGradients = new Array(gapCount).fill(0);
    for (let g = 0; g < gapCount; g++) {
      if (g === 0) {
        for (let j = 0; j < gapCount; j++) rawGradients[0] += thresholdGradients[j];
      } else {
        let total = 0;
        for (let j = g; j < gapCount; j++) total += thresholdGradients[j];
        rawGradients[g] = total * softplusDerivative(rawThresholds[g]);
      }
    }

    for (let f = 0; f < featureCount; f++) {
      const gradient = weightGradients[f] / n + (options.l2Penalty * weights[f]) / n;
      weights[f] -= options.learningRate * gradient;
    }
    for (let g = 0; g < gapCount; g++) rawThresholds[g] -= (options.learningRate * rawGradients[g]) / n;
  }

  return { weights, raw_thresholds: rawThresholds, level_count: levelCount, feature_count: featureCount, fitted_rows: n };
}

function thresholdsFromRaw(rawThresholds, softplus) {
  const thresholds = new Array(rawThresholds.length);
  let running = rawThresholds[0];
  thresholds[0] = running;
  for (let g = 1; g < rawThresholds.length; g++) {
    running += softplus(rawThresholds[g]);
    thresholds[g] = running;
  }
  return thresholds;
}

export function predictOrdinal(model, row) {
  const softplus = (value) => (value > 30 ? value : logDeterministic(1 + expDeterministic(value)));
  const thresholds = thresholdsFromRaw(model.raw_thresholds, softplus);
  let score = 0;
  for (let f = 0; f < model.feature_count; f++) score += model.weights[f] * row[f];
  const probabilities = new Array(model.level_count);
  let previous = 0;
  for (let j = 0; j < model.level_count - 1; j++) {
    const cumulative = sigmoid(thresholds[j] - score);
    probabilities[j] = cumulative - previous;
    previous = cumulative;
  }
  probabilities[model.level_count - 1] = 1 - previous;
  return probabilities.map((value) => (value < 0 ? 0 : value));
}

// ---------------------------------------------------------------------------
// Discrete-time survival baseline for "how long until the next milestone".
// ---------------------------------------------------------------------------

export const SURVIVAL_BIN_DAYS = 15;
export const SURVIVAL_BIN_COUNT = 40;

function binIndexForDays(days) {
  const index = Math.floor(days / SURVIVAL_BIN_DAYS);
  return index >= SURVIVAL_BIN_COUNT ? SURVIVAL_BIN_COUNT - 1 : index;
}

/**
 * The baseline hazard's shape, as three smooth terms in normalized time
 * rather than one free parameter per bin.
 *
 * One dummy per bin is the textbook discrete-time specification and it was
 * tried first. It behaves badly here for a specific reason: forty free
 * intercepts against a fold that holds sixty-nine reviews, all of them
 * shrunk toward zero by the same ridge term as the features -- and a bin
 * coefficient shrunk toward zero is not a neutral prior, it is a prior that
 * the milestone is equally likely to arrive in that bin as not. A
 * log-plus-quadratic trend spans the same rising-then-falling shape in three
 * parameters that every fold can afford to estimate.
 */
function survivalTimeBasis(binIndex) {
  const normalizedTime = (binIndex + 0.5) / SURVIVAL_BIN_COUNT;
  return [logDeterministic(normalizedTime), normalizedTime, normalizedTime * normalizedTime];
}

/**
 * Person-period expansion, then one logistic hazard model over
 * `[features, baseline-hazard basis]`. The basis is what keeps a duration
 * error attributable to the features rather than to an assumption that a
 * milestone is as likely in month one as in month eighteen.
 */
export function fitDiscreteTimeSurvival({ matrix, durations, events, options = DEFAULT_FIT_OPTIONS } = {}) {
  const featureCount = matrix[0]?.length ?? 0;
  const expandedMatrix = [];
  const expandedLabels = [];
  for (let i = 0; i < matrix.length; i++) {
    const lastBin = binIndexForDays(durations[i]);
    for (let b = 0; b <= lastBin; b++) {
      expandedMatrix.push([...matrix[i], ...survivalTimeBasis(b)]);
      expandedLabels.push(b === lastBin && events[i] === 1 ? 1 : 0);
    }
  }
  const hazardModel = fitBinaryLogistic({ matrix: expandedMatrix, labels: expandedLabels, options });
  return {
    hazard_model: hazardModel,
    feature_count: featureCount,
    bin_count: SURVIVAL_BIN_COUNT,
    bin_days: SURVIVAL_BIN_DAYS,
    person_period_rows: expandedMatrix.length,
  };
}

/** Survival curve, plus the p25/p50/p75 day estimates the review card renders as a range. */
export function predictSurvivalQuantiles(model, row) {
  const survival = [];
  let running = 1;
  for (let b = 0; b < model.bin_count; b++) {
    const hazard = predictBinary(model.hazard_model, [...row, ...survivalTimeBasis(b)]);
    running *= 1 - hazard;
    survival.push(running);
  }
  // Linear interpolation inside the bin the curve crosses, rather than the
  // bin's midpoint: a bin-width floor on the reported error would be an
  // artefact of the discretisation, not a property of the estimate.
  const quantileDay = (target) => {
    let previous = 1;
    for (let b = 0; b < survival.length; b++) {
      if (survival[b] <= target) {
        const span = previous - survival[b];
        const fraction = span > 0 ? (previous - target) / span : 0;
        return b * model.bin_days + fraction * model.bin_days;
      }
      previous = survival[b];
    }
    return model.bin_count * model.bin_days;
  };
  return {
    survival,
    p25_days: quantileDay(0.75),
    p50_days: quantileDay(0.5),
    p75_days: quantileDay(0.25),
  };
}

/**
 * Kaplan-Meier median: the documented naive comparator for the duration
 * target. Deliberately not "the mean of the observed durations" -- that
 * statistic is biased downward by exactly the censoring this corpus carries,
 * and a comparator that is wrong in a known direction is not a fair bar.
 */
export function kaplanMeierMedianDays(durations, events) {
  const rows = durations
    .map((duration, index) => ({ duration, event: events[index] }))
    .sort((a, b) => (a.duration - b.duration) || (b.event - a.event));
  let atRisk = rows.length;
  let survival = 1;
  for (let i = 0; i < rows.length; i++) {
    const time = rows[i].duration;
    let deaths = 0;
    let leaving = 0;
    let j = i;
    while (j < rows.length && rows[j].duration === time) {
      if (rows[j].event === 1) deaths += 1;
      leaving += 1;
      j += 1;
    }
    if (deaths > 0 && atRisk > 0) survival *= 1 - deaths / atRisk;
    if (survival <= 0.5) return time;
    atRisk -= leaving;
    i = j - 1;
  }
  return null;
}

/** Harrell's concordance over comparable pairs (the earlier row must be uncensored). */
export function concordanceIndex(predictedDays, durations, events) {
  let concordant = 0;
  let comparable = 0;
  let tied = 0;
  for (let i = 0; i < durations.length; i++) {
    if (events[i] !== 1) continue;
    for (let j = 0; j < durations.length; j++) {
      if (i === j) continue;
      if (durations[j] <= durations[i]) continue;
      comparable += 1;
      if (predictedDays[i] < predictedDays[j]) concordant += 1;
      else if (predictedDays[i] === predictedDays[j]) tied += 1;
    }
  }
  if (comparable === 0) return { concordance: null, comparable_pairs: 0, concordant_pairs: 0, tied_pairs: 0 };
  return {
    concordance: (concordant + 0.5 * tied) / comparable,
    comparable_pairs: comparable,
    concordant_pairs: concordant,
    tied_pairs: tied,
  };
}

// ---------------------------------------------------------------------------
// Calibration and error reports (A4).
// ---------------------------------------------------------------------------

export const RELIABILITY_BIN_COUNT = 10;

/** Reliability bins over [0, 1] with the counts that make each bin readable as evidence rather than a curve. */
export function reliabilityBins(pairs, binCount = RELIABILITY_BIN_COUNT) {
  const bins = Array.from({ length: binCount }, (_, index) => ({
    bin_lower: index / binCount,
    bin_upper: (index + 1) / binCount,
    count: 0,
    mean_predicted: null,
    observed_rate: null,
    predicted_total: 0,
    outcome_total: 0,
  }));
  for (const { probability, outcome } of pairs) {
    let index = Math.floor(probability * binCount);
    if (index >= binCount) index = binCount - 1;
    if (index < 0) index = 0;
    bins[index].count += 1;
    bins[index].predicted_total += probability;
    bins[index].outcome_total += outcome;
  }
  for (const bin of bins) {
    if (bin.count > 0) {
      bin.mean_predicted = bin.predicted_total / bin.count;
      bin.observed_rate = bin.outcome_total / bin.count;
    }
    delete bin.predicted_total;
    delete bin.outcome_total;
  }
  return bins;
}

export function expectedCalibrationError(bins, total) {
  if (total === 0) return null;
  let error = 0;
  for (const bin of bins) {
    if (bin.count === 0) continue;
    const gap = bin.observed_rate - bin.mean_predicted;
    error += (bin.count / total) * (gap < 0 ? -gap : gap);
  }
  return error;
}

export function maximumCalibrationError(bins) {
  let worst = null;
  for (const bin of bins) {
    if (bin.count === 0) continue;
    const gap = bin.observed_rate - bin.mean_predicted;
    const magnitude = gap < 0 ? -gap : gap;
    if (worst === null || magnitude > worst) worst = magnitude;
  }
  return worst;
}

/**
 * The full calibration and error report for one set of out-of-time
 * classification estimates. `predictions` is one probability vector per row;
 * `outcomes` is the realized class index per row.
 */
export function scoreClassification({ predictions, outcomes, classNames }) {
  const classCount = classNames.length;
  const n = predictions.length;
  if (n === 0) {
    return {
      scored_rows: 0,
      log_loss: null,
      brier_score: null,
      error_rate: null,
      top_label_expected_calibration_error: null,
      top_label_maximum_calibration_error: null,
      top_label_reliability_bins: reliabilityBins([]),
      per_class: classNames.map((name) => ({ class_name: name, support: 0, one_vs_rest_expected_calibration_error: null, one_vs_rest_maximum_calibration_error: null, one_vs_rest_brier: null, error_rate: null })),
    };
  }

  let logLossTotal = 0;
  let brierTotal = 0;
  let errors = 0;
  const topLabelPairs = [];
  const perClassPairs = classNames.map(() => []);
  const perClassSupport = new Array(classCount).fill(0);
  const perClassErrors = new Array(classCount).fill(0);

  for (let i = 0; i < n; i++) {
    const probabilities = predictions[i];
    const outcome = outcomes[i];
    logLossTotal += -logDeterministic(clampProbability(probabilities[outcome]));
    for (let k = 0; k < classCount; k++) {
      const indicator = outcome === k ? 1 : 0;
      const delta = probabilities[k] - indicator;
      brierTotal += delta * delta;
      perClassPairs[k].push({ probability: probabilities[k], outcome: indicator });
    }
    let best = 0;
    for (let k = 1; k < classCount; k++) if (probabilities[k] > probabilities[best]) best = k;
    topLabelPairs.push({ probability: probabilities[best], outcome: best === outcome ? 1 : 0 });
    perClassSupport[outcome] += 1;
    if (best !== outcome) {
      errors += 1;
      perClassErrors[outcome] += 1;
    }
  }

  const topBins = reliabilityBins(topLabelPairs);
  return {
    scored_rows: n,
    log_loss: logLossTotal / n,
    brier_score: brierTotal / n,
    error_rate: errors / n,
    top_label_expected_calibration_error: expectedCalibrationError(topBins, n),
    top_label_maximum_calibration_error: maximumCalibrationError(topBins),
    top_label_reliability_bins: topBins,
    per_class: classNames.map((name, k) => {
      const bins = reliabilityBins(perClassPairs[k]);
      let classBrier = 0;
      for (const pair of perClassPairs[k]) {
        const delta = pair.probability - pair.outcome;
        classBrier += delta * delta;
      }
      // The per-class bins are summarized rather than carried: a receipt that
      // reproduced every one-versus-rest reliability curve for every class, at
      // every tier, on every fold would be tens of megabytes of JSON that
      // nobody reads. The top-label curve is kept in full; the per-class
      // calibration is kept as the two numbers a reader acts on.
      return {
        class_name: name,
        support: perClassSupport[k],
        one_vs_rest_expected_calibration_error: expectedCalibrationError(bins, n),
        one_vs_rest_maximum_calibration_error: maximumCalibrationError(bins),
        one_vs_rest_brier: classBrier / n,
        error_rate: perClassSupport[k] > 0 ? perClassErrors[k] / perClassSupport[k] : null,
      };
    }),
  };
}

/** Ordinal error alongside the classification report: distance matters when the label is ordered. */
export function scoreOrdinal({ predictions, outcomes, levelNames }) {
  const base = scoreClassification({ predictions, outcomes, classNames: levelNames });
  if (predictions.length === 0) return { ...base, mean_absolute_ordinal_error: null, expected_absolute_ordinal_error: null };
  let absoluteError = 0;
  let expectedAbsoluteError = 0;
  for (let i = 0; i < predictions.length; i++) {
    let best = 0;
    for (let k = 1; k < levelNames.length; k++) if (predictions[i][k] > predictions[i][best]) best = k;
    absoluteError += best > outcomes[i] ? best - outcomes[i] : outcomes[i] - best;
    for (let k = 0; k < levelNames.length; k++) {
      const distance = k > outcomes[i] ? k - outcomes[i] : outcomes[i] - k;
      expectedAbsoluteError += predictions[i][k] * distance;
    }
  }
  return {
    ...base,
    mean_absolute_ordinal_error: absoluteError / predictions.length,
    expected_absolute_ordinal_error: expectedAbsoluteError / predictions.length,
  };
}

/** Duration error report: concordance, absolute error, and the interval coverage the card's timing range is judged on. */
export function scoreDuration({ quantiles, durations, events }) {
  const uncensored = [];
  for (let i = 0; i < durations.length; i++) if (events[i] === 1) uncensored.push(i);
  const predictedMedians = quantiles.map((quantile) => quantile.p50_days);
  const concordance = concordanceIndex(predictedMedians, durations, events);

  if (uncensored.length === 0) {
    return {
      scored_rows: durations.length,
      uncensored_rows: 0,
      censored_rows: durations.length,
      mean_absolute_error_days: null,
      median_absolute_error_days: null,
      interquartile_interval_coverage: null,
      median_side_balance: null,
      ...concordance,
    };
  }

  const absoluteErrors = uncensored
    .map((index) => {
      const delta = durations[index] - predictedMedians[index];
      return delta < 0 ? -delta : delta;
    })
    .sort((a, b) => a - b);
  const mean = absoluteErrors.reduce((total, value) => total + value, 0) / absoluteErrors.length;
  const middle = absoluteErrors.length % 2 === 1
    ? absoluteErrors[(absoluteErrors.length - 1) / 2]
    : (absoluteErrors[absoluteErrors.length / 2 - 1] + absoluteErrors[absoluteErrors.length / 2]) / 2;

  let inside = 0;
  let below = 0;
  for (const index of uncensored) {
    if (durations[index] >= quantiles[index].p25_days && durations[index] <= quantiles[index].p75_days) inside += 1;
    if (durations[index] <= predictedMedians[index]) below += 1;
  }

  return {
    scored_rows: durations.length,
    uncensored_rows: uncensored.length,
    censored_rows: durations.length - uncensored.length,
    mean_absolute_error_days: mean,
    median_absolute_error_days: middle,
    interquartile_interval_coverage: inside / uncensored.length,
    median_side_balance: below / uncensored.length,
    ...concordance,
  };
}

// ---------------------------------------------------------------------------
// Naive comparators (A1).
// ---------------------------------------------------------------------------

/** Class prevalence on the training fold, predicted unchanged for every test row. */
export function prevalenceComparator(labels, classCount) {
  const counts = new Array(classCount).fill(0);
  for (const label of labels) counts[label] += 1;
  const total = labels.length;
  if (total === 0) return new Array(classCount).fill(1 / classCount);
  return counts.map((count) => count / total);
}

// ---------------------------------------------------------------------------
// A5: the forbidden-estimate rule, as a callable check rather than a comment.
// ---------------------------------------------------------------------------

/**
 * Each pattern is a whole-token sequence, not a substring. A substring rule
 * was the first thing written here and it fails in both directions that
 * matter: it flags `technical_issue_state` (which contains "sue") while
 * missing `lawsuitProbability` (whose camel case hides the word boundary).
 */
export const FORBIDDEN_ESTIMATE_PATTERNS = Object.freeze([
  "lawsuit",
  "lawsuits",
  "litigation",
  "litigate",
  "sue",
  "sued",
  "suing",
  "article_78",
  "article78",
  "challenge_probability",
  "legal_risk",
  "legal_exposure",
  "liability",
]);

function normalizeForForbiddenScan(text) {
  const collapsed = String(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `_${collapsed}_`;
}

/** Which forbidden token sequences appear in this text, if any. */
export function findForbiddenEstimateTerms(text) {
  const normalized = normalizeForForbiddenScan(text);
  return FORBIDDEN_ESTIMATE_PATTERNS.filter((pattern) => normalized.includes(`_${pattern}_`));
}

/**
 * Refuse any field name, target name or rendered label that reads as a
 * resident-facing prediction of legal exposure. This card reports how a
 * review has moved and how it is likely to move next; it does not tell a
 * resident how likely anyone is to sue, and there is no estimate in this
 * module that could be renamed into one without tripping this.
 */
export function assertNoForbiddenEstimate(names, context = "estimate") {
  const offenders = [];
  for (const name of names) {
    for (const pattern of findForbiddenEstimateTerms(name)) offenders.push({ name, pattern });
  }
  if (offenders.length > 0) {
    throw new SeqraBaselineError(`${context}: forbidden estimate name(s) ${JSON.stringify(offenders)}`);
  }
  return { ok: true, checked_count: names.length, patterns: FORBIDDEN_ESTIMATE_PATTERNS };
}

// ---------------------------------------------------------------------------
// Corpus assembly: SEQRA-08's primitives, applied to a review set.
// ---------------------------------------------------------------------------

const NEXT_MILESTONE_EXCLUDED_TYPES = Object.freeze(["position_taken", "topic_assessed"]);

/**
 * Turn a review set into the per-review rows every target is scored on:
 * an as-of feature snapshot at the cutoff, the eventual review-path label at
 * the observation horizon, the supplemental-review labels per horizon, the
 * next-milestone type and duration (right-censored at the horizon), and the
 * per-topic ordinal rows.
 *
 * The review-path label is read from the review's state at the OBSERVATION
 * HORIZON, not at the cutoff. SEQRA-08's corpus records the as-of-cutoff
 * label, which is the right thing for a corpus and the wrong thing for a
 * prediction target: a cutoff placed after the classifying milestone would
 * make the label a feature. Every cutoff in this corpus therefore sits before
 * its review's classification, and the label is the outcome that followed.
 */
export function buildBaselineCorpus({ reviews, projects, folds, observationHorizon } = {}) {
  if (!Array.isArray(reviews) || reviews.length === 0) throw new SeqraBaselineError("buildBaselineCorpus requires reviews: []");
  if (!Array.isArray(projects) || projects.length === 0) throw new SeqraBaselineError("buildBaselineCorpus requires projects: []");
  if (!Array.isArray(folds) || folds.length === 0) throw new SeqraBaselineError("buildBaselineCorpus requires folds: []");
  if (typeof observationHorizon !== "string") throw new SeqraBaselineError("buildBaselineCorpus requires observationHorizon");

  const { families, projectToFamily } = buildProjectFamilies(projects);
  const familySize = new Map();
  for (const family of families) familySize.set(family.family_id, family.member_project_keys.length);

  const rows = [];
  const leakage = { checked_count: 0, violation_count: 0 };
  const refusals = [];

  for (const review of [...reviews].sort((a, b) => (a.reviewKey < b.reviewKey ? -1 : 1))) {
    const snapshot = buildAsOfFeatureSnapshot({
      reviewKey: review.reviewKey,
      cutoff: review.cutoff,
      events: review.events,
      publicPositions: review.publicPositions ?? [],
      bblHistory: review.bblHistory ?? null,
      spatialLayerRegistry: review.spatialLayerRegistry ?? null,
    });
    if (!snapshot.ok) {
      refusals.push({ review_key: review.reviewKey, reason: snapshot.reason });
      continue;
    }
    leakage.checked_count += snapshot.leakage_audit.checked_count;
    leakage.violation_count += snapshot.leakage_audit.violation_count;

    const familyId = projectToFamily.get(review.projectKey);
    if (!familyId) throw new SeqraBaselineError(`review ${review.reviewKey}: project ${review.projectKey} is in no family`);

    const log = buildAppendOnlyLog(review.events);
    const horizonState = projectReviewStateAsOf(log.events, { reviewKey: review.reviewKey, cutoff: observationHorizon });
    if (!horizonState.ok) {
      refusals.push({ review_key: review.reviewKey, reason: "contradiction_at_observation_horizon" });
      continue;
    }

    const features = buildReviewFeatures({ snapshot, regime: review.regime, familySize: familySize.get(familyId) });

    const supplemental = {};
    for (const horizon of SUPPLEMENTAL_REVIEW_HORIZONS) {
      supplemental[horizon] = classifySupplementalReviewLabel({
        reviewKey: review.reviewKey,
        cutoff: review.cutoff,
        horizon,
        fullEvents: log.events,
        determinationDate: review.determinationDate,
        implementationCompletionDate: review.implementationCompletionDate,
        observationHorizon,
      });
    }

    const cutoffMs = Date.parse(review.cutoff);
    const horizonMs = Date.parse(observationHorizon);
    const nextMilestone = horizonState.milestones
      .filter((milestone) => !NEXT_MILESTONE_EXCLUDED_TYPES.includes(milestone.event_type))
      .filter((milestone) => Date.parse(milestone.effective_at) > cutoffMs)
      .sort((a, b) => Date.parse(a.effective_at) - Date.parse(b.effective_at))[0] ?? null;
    const censoredDurationDays = Math.floor((horizonMs - cutoffMs) / DAY_MS);
    const nextMilestoneDurationDays = nextMilestone
      ? Math.floor((Date.parse(nextMilestone.effective_at) - cutoffMs) / DAY_MS)
      : censoredDurationDays;

    const topicRows = Object.keys(snapshot.review_state.topics).sort().map((topic, rank) => {
      const horizonTopic = horizonState.topics[topic];
      return {
        technical_topic: topic,
        screen_rank: rank,
        state_at_cutoff: snapshot.review_state.topics[topic].state,
        state_at_horizon: horizonTopic ? horizonTopic.state : snapshot.review_state.topics[topic].state,
      };
    });

    rows.push({
      row_key: `baseline_row:${review.reviewKey}`,
      review_key: review.reviewKey,
      project_key: review.projectKey,
      family_id: familyId,
      cutoff: review.cutoff,
      features,
      review_path_label: classifyReviewPathLabel(horizonState),
      supplemental_review: supplemental,
      next_milestone_event_type: nextMilestone ? nextMilestone.event_type : null,
      next_milestone_duration_days: nextMilestoneDurationDays > 0 ? nextMilestoneDurationDays : 1,
      next_milestone_observed: nextMilestone ? 1 : 0,
      topic_rows: topicRows,
      snapshot,
      horizon_state: horizonState,
    });
  }

  const foldAssignments = buildRollingOriginFolds({
    rows: rows.map((row) => ({ reviewKey: row.review_key, familyId: row.family_id, cutoff: row.cutoff })),
    folds,
  });

  return {
    schema: SEQRA_BASELINES_SCHEMA,
    observation_horizon: observationHorizon,
    families,
    rows,
    fold_assignments: foldAssignments,
    feature_leakage_audit: { ...leakage, schema: "cityscroll.seqra_baseline_feature_leakage_rollup.v1" },
    refusals,
  };
}

/** Rows per fold and split, in a fixed order, so a fit never depends on input order. */
export function splitRowsByFold(corpus, foldId) {
  const byReview = new Map(corpus.rows.map((row) => [row.review_key, row]));
  const train = [];
  const test = [];
  const excluded = [];
  for (const assignment of corpus.fold_assignments) {
    if (assignment.fold_id !== foldId) continue;
    const row = byReview.get(assignment.review_key);
    if (!row) continue;
    if (assignment.split === "train") train.push(row);
    else if (assignment.split === "test") test.push(row);
    else excluded.push({ ...row, excluded_reason: assignment.excluded_reason });
  }
  const byKey = (a, b) => (a.row_key < b.row_key ? -1 : a.row_key > b.row_key ? 1 : 0);
  return { train: train.sort(byKey), test: test.sort(byKey), excluded: excluded.sort(byKey) };
}

// ---------------------------------------------------------------------------
// Target definitions. Each one names its own rows, its own label, its own
// naive comparator and its own scorer. They are never combined.
// ---------------------------------------------------------------------------

const REVIEW_LEVEL_FEATURE_NAMES = Object.freeze(Object.keys(FEATURE_TIERS).filter(
  (name) => name !== "topic_is_detailed_at_cutoff" && name !== "topic_screen_rank",
));

const TOPIC_LEVEL_FEATURE_NAMES = Object.freeze(Object.keys(FEATURE_TIERS));

/** The corpus rows a target scores, with the label attached and censored rows named. */
function classificationRowsFor(target, rows) {
  const kept = [];
  let censored = 0;
  for (const row of rows) {
    const outcome = target.labelOf(row);
    if (outcome === null) {
      censored += 1;
      continue;
    }
    kept.push({ row, outcome });
  }
  return { kept, censored };
}

export function buildTargetDefinitions() {
  const targets = [];

  targets.push({
    name: "review_path",
    kind: "classification",
    class_names: [...PROCESS_PATH_LABELS],
    feature_names: REVIEW_LEVEL_FEATURE_NAMES,
    comparator: "train_fold_class_prevalence",
    unit_description: "one row per environmental review, at its own cutoff",
    labelOf: (row) => PROCESS_PATH_LABELS.indexOf(row.review_path_label),
  });

  for (const horizon of SUPPLEMENTAL_REVIEW_HORIZONS) {
    targets.push({
      name: `supplemental_review:${horizon}`,
      kind: "classification",
      class_names: ["no_supplemental_review", "supplemental_review"],
      feature_names: REVIEW_LEVEL_FEATURE_NAMES,
      comparator: "train_fold_class_prevalence",
      unit_description: `one row per environmental review, right-censored when the ${horizon} window closes after the observation horizon`,
      labelOf: (row) => {
        const outcome = row.supplemental_review[horizon];
        return outcome.censored ? null : outcome.label;
      },
    });
  }

  targets.push({
    name: "next_milestone_type",
    kind: "classification",
    class_names: NEXT_MILESTONE_CLASS_NAMES,
    feature_names: REVIEW_LEVEL_FEATURE_NAMES,
    comparator: "train_fold_class_prevalence",
    unit_description: "one row per environmental review, censored when no further milestone was observed by the horizon",
    labelOf: (row) => {
      if (row.next_milestone_observed !== 1) return null;
      const index = NEXT_MILESTONE_CLASS_NAMES.indexOf(row.next_milestone_event_type);
      return index < 0 ? null : index;
    },
  });

  targets.push({
    name: "next_milestone_duration",
    kind: "duration",
    feature_names: REVIEW_LEVEL_FEATURE_NAMES,
    comparator: "train_fold_kaplan_meier_median",
    unit_description: "days from the cutoff to the next review milestone, right-censored at the observation horizon",
  });

  targets.push({
    name: "technical_issue_state",
    kind: "ordinal",
    class_names: [...TECHNICAL_ISSUE_ORDINAL_LEVELS],
    feature_names: TOPIC_LEVEL_FEATURE_NAMES,
    comparator: "train_fold_class_prevalence",
    unit_description: "one row per (review, technical topic) screened before the cutoff",
  });

  return targets;
}

/**
 * The milestone types this target predicts. Fixed rather than derived from the
 * corpus so a fold whose test window happens to contain no scoping hearing
 * still reports that class with zero support instead of silently renumbering
 * every other class.
 */
export const NEXT_MILESTONE_CLASS_NAMES = Object.freeze([
  "type_ii_classified",
  "negative_declaration_issued",
  "conditioned_negative_declaration_issued",
  "positive_declaration_issued",
  "draft_scope_issued",
  "scoping_hearing_held",
  "final_scope_issued",
  "draft_document_published",
  "public_hearing_held",
  "final_document_published",
  "findings_adopted",
  "final_determination_issued",
  "technical_memorandum_issued",
  "supplemental_eis_initiated",
  "mitigation_committed",
  "alternative_considered",
]);

function topicRowsFor(rows) {
  const out = [];
  for (const row of rows) {
    for (const topic of row.topic_rows) {
      out.push({
        row_key: `${row.row_key}:${topic.technical_topic}`,
        review_key: row.review_key,
        cutoff: row.cutoff,
        technical_topic: topic.technical_topic,
        features: {
          ...row.features,
          topic_is_detailed_at_cutoff: topic.state_at_cutoff === "detailed_analysis" ? 1 : 0,
          topic_screen_rank: topic.screen_rank / 12,
        },
        ordinal_level: TECHNICAL_ISSUE_ORDINAL_LEVELS.indexOf(mapTopicStateToOrdinalLevel(topic.state_at_horizon)),
      });
    }
  }
  return out.sort((a, b) => (a.row_key < b.row_key ? -1 : a.row_key > b.row_key ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Fit + evaluate: one target, one tier, one fold. Always fit on train only,
// always score on test only.
// ---------------------------------------------------------------------------

/**
 * Fit one classification target on one fold's training rows. Returned as a
 * fitted predictor rather than a table of numbers so that the review card and
 * the backtest report cannot drift apart: the estimate a card shows is
 * produced by this same function, on this same fold's training rows, as the
 * calibration printed beside it.
 */
export function fitClassificationBaseline({ target, tier, trainRows, options = DEFAULT_FIT_OPTIONS } = {}) {
  const featureNames = featureNamesForTier(tier, target.feature_names);
  const train = classificationRowsFor(target, trainRows);
  const classCount = target.class_names.length;
  const trainMatrix = designMatrix(train.kept.map((entry) => entry.row), featureNames);
  const standardizer = fitStandardizer(trainMatrix);
  const standardizedTrain = applyStandardizer(trainMatrix, standardizer);
  const trainLabels = train.kept.map((entry) => entry.outcome);
  const prevalence = prevalenceComparator(trainLabels, classCount);

  let model = null;
  if (train.kept.length > 0) {
    model = classCount === 2
      ? fitBinaryLogistic({ matrix: standardizedTrain, labels: trainLabels, options })
      : fitMultinomialLogistic({ matrix: standardizedTrain, labels: trainLabels, classCount, options });
  }

  const transform = (rows) => applyStandardizer(designMatrix(rows, featureNames), standardizer);
  const predictRows = (rows) => {
    const matrix = transform(rows);
    if (model === null) return matrix.map(() => prevalence);
    if (classCount === 2) {
      return matrix.map((row) => {
        const positive = predictBinary(model, row);
        return [1 - positive, positive];
      });
    }
    return matrix.map((row) => predictMultinomial(model, row));
  };

  return {
    feature_names: featureNames,
    class_names: target.class_names,
    prevalence,
    fitted: model !== null,
    train_rows: train.kept.length,
    train_censored_rows: train.censored,
    predictRows,
  };
}

function evaluateClassificationFold({ target, tier, trainRows, testRows, options }) {
  const fit = fitClassificationBaseline({ target, tier, trainRows, options });
  const train = classificationRowsFor(target, trainRows);
  const test = classificationRowsFor(target, testRows);
  const featureNames = fit.feature_names;
  const testRowObjects = test.kept.map((entry) => entry.row);
  const testLabels = test.kept.map((entry) => entry.outcome);
  const prevalence = fit.prevalence;
  const comparatorPredictions = testLabels.map(() => prevalence);
  const modelPredictions = test.kept.length === 0 ? [] : fit.predictRows(testRowObjects);

  return {
    baseline: scoreClassification({ predictions: modelPredictions, outcomes: testLabels, classNames: target.class_names }),
    comparator: scoreClassification({ predictions: comparatorPredictions, outcomes: testLabels, classNames: target.class_names }),
    pooling: { predictions: modelPredictions, comparator_predictions: comparatorPredictions, outcomes: testLabels },
    train_rows: train.kept.length,
    train_censored_rows: train.censored,
    test_rows: test.kept.length,
    test_censored_rows: test.censored,
    feature_names: featureNames,
    fitted: fit.fitted && test.kept.length > 0,
    comparator_distribution: Object.fromEntries(target.class_names.map((name, index) => [name, prevalence[index]])),
  };
}

/** Fit the ordinal technical-issue-state baseline on one fold's training rows. */
export function fitOrdinalBaseline({ target, tier, trainRows, options = DEFAULT_FIT_OPTIONS } = {}) {
  const featureNames = featureNamesForTier(tier, target.feature_names);
  const train = topicRowsFor(trainRows);
  const levelCount = target.class_names.length;
  const trainMatrix = designMatrix(train, featureNames);
  const standardizer = fitStandardizer(trainMatrix);
  const standardizedTrain = applyStandardizer(trainMatrix, standardizer);
  const trainLabels = train.map((row) => row.ordinal_level);
  const prevalence = prevalenceComparator(trainLabels, levelCount);

  const model = train.length > 0
    ? fitOrdinalLogistic({ matrix: standardizedTrain, labels: trainLabels, levelCount, options })
    : null;

  const predictTopicRows = (rows) => {
    const matrix = applyStandardizer(designMatrix(rows, featureNames), standardizer);
    if (model === null) return matrix.map(() => prevalence);
    return matrix.map((row) => predictOrdinal(model, row));
  };

  return {
    feature_names: featureNames,
    level_names: target.class_names,
    prevalence,
    fitted: model !== null,
    train_rows: train.length,
    predictTopicRows,
    expandTopicRows: topicRowsFor,
  };
}

function evaluateOrdinalFold({ target, tier, trainRows, testRows, options }) {
  const fit = fitOrdinalBaseline({ target, tier, trainRows, options });
  const train = topicRowsFor(trainRows);
  const test = topicRowsFor(testRows);
  const featureNames = fit.feature_names;
  const testLabels = test.map((row) => row.ordinal_level);
  const prevalence = fit.prevalence;
  const comparatorPredictions = testLabels.map(() => prevalence);
  const modelPredictions = test.length === 0 ? [] : fit.predictTopicRows(test);
  const fitted = fit.fitted && test.length > 0;

  return {
    baseline: scoreOrdinal({ predictions: modelPredictions, outcomes: testLabels, levelNames: target.class_names }),
    comparator: scoreOrdinal({ predictions: comparatorPredictions, outcomes: testLabels, levelNames: target.class_names }),
    pooling: { predictions: modelPredictions, comparator_predictions: comparatorPredictions, outcomes: testLabels },
    train_rows: train.length,
    train_censored_rows: 0,
    test_rows: test.length,
    test_censored_rows: 0,
    feature_names: featureNames,
    fitted,
    comparator_distribution: Object.fromEntries(target.class_names.map((name, index) => [name, prevalence[index]])),
  };
}

/** Fit the discrete-time survival baseline on one fold's training rows. */
export function fitDurationBaseline({ target, tier, trainRows, options = DEFAULT_FIT_OPTIONS } = {}) {
  const featureNames = featureNamesForTier(tier, target.feature_names);
  const trainMatrix = designMatrix(trainRows, featureNames);
  const standardizer = fitStandardizer(trainMatrix);
  const standardizedTrain = applyStandardizer(trainMatrix, standardizer);
  const trainDurations = trainRows.map((row) => row.next_milestone_duration_days);
  const trainEvents = trainRows.map((row) => row.next_milestone_observed);
  const comparatorMedian = kaplanMeierMedianDays(trainDurations, trainEvents) ?? SURVIVAL_BIN_DAYS * SURVIVAL_BIN_COUNT;

  const model = trainRows.length > 0
    ? fitDiscreteTimeSurvival({ matrix: standardizedTrain, durations: trainDurations, events: trainEvents, options })
    : null;

  const predictRows = (rows) => {
    const matrix = applyStandardizer(designMatrix(rows, featureNames), standardizer);
    if (model === null) {
      return matrix.map(() => ({ p25_days: comparatorMedian, p50_days: comparatorMedian, p75_days: comparatorMedian, survival: [] }));
    }
    return matrix.map((row) => predictSurvivalQuantiles(model, row));
  };

  return {
    feature_names: featureNames,
    comparator_median_days: comparatorMedian,
    fitted: model !== null,
    train_rows: trainRows.length,
    predictRows,
  };
}

function evaluateDurationFold({ target, tier, trainRows, testRows, options }) {
  const fit = fitDurationBaseline({ target, tier, trainRows, options });
  const featureNames = fit.feature_names;
  const testDurations = testRows.map((row) => row.next_milestone_duration_days);
  const testEvents = testRows.map((row) => row.next_milestone_observed);
  const comparatorMedian = fit.comparator_median_days;
  const comparatorQuantiles = testRows.map(() => ({
    p25_days: comparatorMedian,
    p50_days: comparatorMedian,
    p75_days: comparatorMedian,
    survival: [],
  }));
  const baselineQuantiles = testRows.length === 0 ? [] : fit.predictRows(testRows);
  const fitted = fit.fitted && testRows.length > 0;

  return {
    baseline: scoreDuration({ quantiles: baselineQuantiles, durations: testDurations, events: testEvents }),
    comparator: scoreDuration({ quantiles: comparatorQuantiles, durations: testDurations, events: testEvents }),
    pooling: { quantiles: baselineQuantiles, comparator_quantiles: comparatorQuantiles, durations: testDurations, events: testEvents },
    train_rows: trainRows.length,
    train_censored_rows: trainRows.filter((row) => row.next_milestone_observed !== 1).length,
    test_rows: testRows.length,
    test_censored_rows: testEvents.filter((event) => event !== 1).length,
    feature_names: featureNames,
    fitted,
    comparator_median_days: comparatorMedian,
  };
}

function evaluateFold(args) {
  if (args.target.kind === "classification") return evaluateClassificationFold(args);
  if (args.target.kind === "ordinal") return evaluateOrdinalFold(args);
  if (args.target.kind === "duration") return evaluateDurationFold(args);
  throw new SeqraBaselineError(`unknown target kind ${JSON.stringify(args.target.kind)}`);
}

/**
 * The primary metric each kind is judged on, and the direction that counts as
 * better. Named once, here, so "did the baseline beat the comparator" is a
 * single comparison rather than a per-target argument.
 */
export const PRIMARY_METRIC = Object.freeze({
  classification: { metric: "log_loss", lower_is_better: true },
  ordinal: { metric: "expected_absolute_ordinal_error", lower_is_better: true },
  // Concordance, not absolute error, is the duration target's primary metric,
  // and the reason is the censoring this corpus carries rather than a
  // preference for the number that looks better. Absolute error can only be
  // computed on rows whose milestone was actually observed, so it conditions
  // on the outcome: it silently rewards a predictor that says "soon" about
  // everything, because the reviews that would have proved it wrong are
  // exactly the ones it cannot score. Concordance is defined over every
  // comparable pair including censored ones. Absolute error, median absolute
  // error and interval coverage are all still reported next to it -- the
  // point is that the pass/fail comparison is made on the metric that the
  // censoring does not bias.
  duration: { metric: "concordance", lower_is_better: false },
});

function pairWeightedConcordance(perFold, side) {
  let weighted = 0;
  let comparable = 0;
  let concordant = 0;
  let tied = 0;
  for (const fold of perFold) {
    const report = fold[side];
    if (report.concordance === null || report.comparable_pairs === 0) continue;
    weighted += report.concordance * report.comparable_pairs;
    comparable += report.comparable_pairs;
    concordant += report.concordant_pairs;
    tied += report.tied_pairs;
  }
  return {
    concordance: comparable === 0 ? null : weighted / comparable,
    comparable_pairs: comparable,
    concordant_pairs: concordant,
    tied_pairs: tied,
  };
}

/**
 * Pooled metrics are the concatenation of every fold's own out-of-time test
 * predictions -- never a refit over the whole corpus, which would report an
 * in-sample number under an out-of-time heading.
 */
function poolFolds(target, perFold) {
  if (target.kind === "duration") {
    const quantiles = [];
    const comparatorQuantiles = [];
    const durations = [];
    const events = [];
    for (const fold of perFold) {
      quantiles.push(...fold.pooling.quantiles);
      comparatorQuantiles.push(...fold.pooling.comparator_quantiles);
      durations.push(...fold.pooling.durations);
      events.push(...fold.pooling.events);
    }
    // Concordance is pooled as a pair-weighted mean of the per-fold values,
    // not recomputed over the concatenation. Concatenating first would score
    // pairs drawn from two different folds, whose predictions came from two
    // different models -- and it would hand the constant-median comparator a
    // spurious ranking ability it does not have, since its "constant" differs
    // between folds. Within a fold the comparator ties every pair, which is
    // the 0.5 a coin-flip ranking deserves.
    return {
      baseline: { ...scoreDuration({ quantiles, durations, events }), ...pairWeightedConcordance(perFold, "baseline"), concordance_pooling: "pair_weighted_mean_of_per_fold" },
      comparator: { ...scoreDuration({ quantiles: comparatorQuantiles, durations, events }), ...pairWeightedConcordance(perFold, "comparator"), concordance_pooling: "pair_weighted_mean_of_per_fold" },
    };
  }
  const predictions = [];
  const comparatorPredictions = [];
  const outcomes = [];
  for (const fold of perFold) {
    predictions.push(...fold.pooling.predictions);
    comparatorPredictions.push(...fold.pooling.comparator_predictions);
    outcomes.push(...fold.pooling.outcomes);
  }
  if (target.kind === "ordinal") {
    return {
      baseline: scoreOrdinal({ predictions, outcomes, levelNames: target.class_names }),
      comparator: scoreOrdinal({ predictions: comparatorPredictions, outcomes, levelNames: target.class_names }),
    };
  }
  return {
    baseline: scoreClassification({ predictions, outcomes, classNames: target.class_names }),
    comparator: scoreClassification({ predictions: comparatorPredictions, outcomes, classNames: target.class_names }),
  };
}

/**
 * Did this tier's fitted baseline beat its documented naive comparator on the
 * out-of-time holdout? Reported, never asserted: a corpus on which a baseline
 * loses to prevalence is a finding about the corpus, and a receipt that could
 * only say "yes" would not be evidence of anything.
 */
export function compareToComparator(kind, pooled) {
  const { metric, lower_is_better: lowerIsBetter } = PRIMARY_METRIC[kind];
  const baselineValue = pooled.baseline[metric];
  const comparatorValue = pooled.comparator[metric];
  if (baselineValue === null || comparatorValue === null) {
    return { metric, baseline: baselineValue, comparator: comparatorValue, improvement: null, beats_comparator: null };
  }
  const improvement = lowerIsBetter ? comparatorValue - baselineValue : baselineValue - comparatorValue;
  return {
    metric,
    lower_is_better: lowerIsBetter,
    baseline: baselineValue,
    comparator: comparatorValue,
    improvement,
    beats_comparator: improvement > 0,
  };
}

/**
 * Fit and score one target across every fold and every source tier.
 * Out-of-time throughout: a fold's model never sees that fold's test rows,
 * and the pooled report is the concatenation of per-fold test predictions,
 * never a refit over everything.
 */
export function evaluateTarget({ corpus, folds, target, options = DEFAULT_FIT_OPTIONS } = {}) {
  const tiers = {};
  for (const tier of SOURCE_TIERS) {
    const perFold = [];
    for (const fold of folds) {
      const { train, test, excluded } = splitRowsByFold(corpus, fold.foldId);
      const evaluation = evaluateFold({ target, tier, trainRows: train, testRows: test, options });
      perFold.push({
        fold_id: fold.foldId,
        train_end: fold.trainEnd,
        test_start: fold.testStart,
        test_end: fold.testEnd,
        excluded_rows: excluded.length,
        ...evaluation,
      });
    }
    const pooled = poolFolds(target, perFold);
    tiers[tier] = {
      per_fold: perFold.map(({ pooling, ...rest }) => rest),
      pooled,
      comparison_to_naive_comparator: compareToComparator(target.kind, pooled),
    };
  }

  // A3: the nested tier comparison. "Did documents add anything" is the step
  // from tier 1 to tier 2 on the same out-of-time metric, and "did
  // institutional signals add anything" is the step from tier 2 to tier 3.
  const { metric, lower_is_better: lowerIsBetter } = PRIMARY_METRIC[target.kind];
  const ablation = [];
  for (let index = 0; index < SOURCE_TIERS.length; index++) {
    const tier = SOURCE_TIERS[index];
    const value = tiers[tier].pooled.baseline[metric];
    const previous = index === 0 ? null : tiers[SOURCE_TIERS[index - 1]].pooled.baseline[metric];
    const delta = previous === null || value === null ? null : (lowerIsBetter ? previous - value : value - previous);
    ablation.push({
      source_tier: tier,
      metric,
      lower_is_better: lowerIsBetter,
      value,
      previous_tier: index === 0 ? null : SOURCE_TIERS[index - 1],
      improvement_over_previous_tier: delta,
      adds_value_over_previous_tier: delta === null ? null : delta > 0,
      comparison_to_naive_comparator: tiers[tier].comparison_to_naive_comparator,
    });
  }

  return {
    target: target.name,
    kind: target.kind,
    comparator: target.comparator,
    unit_description: target.unit_description,
    class_names: target.class_names ?? null,
    primary_metric: metric,
    tiers,
    source_tier_ablation: ablation,
  };
}


// ---------------------------------------------------------------------------
// Per-review estimates for the internal review card.
// ---------------------------------------------------------------------------

/**
 * Produce every estimate the internal review card shows for one review,
 * from models fitted on one fold's TRAINING rows only. The review must be in
 * that fold's test split: a card whose estimates came from a model that had
 * already seen the review would be showing an in-sample number under an
 * out-of-time heading, and the calibration printed next to it would be a
 * claim about a different quantity entirely.
 */
export function buildReviewEstimates({ corpus, foldId, tier, reviewKey, targets, options = DEFAULT_FIT_OPTIONS } = {}) {
  const { train, test } = splitRowsByFold(corpus, foldId);
  const row = test.find((candidate) => candidate.review_key === reviewKey);
  if (!row) {
    throw new SeqraBaselineError(`review ${reviewKey} is not in fold ${foldId}'s test split; a card may only be built from a held-out review`);
  }

  const estimates = {};
  for (const target of targets) {
    if (target.kind === "classification") {
      const fit = fitClassificationBaseline({ target, tier, trainRows: train, options });
      const probabilities = fit.predictRows([row])[0];
      const ranked = target.class_names
        .map((name, index) => ({ class_name: name, probability: probabilities[index] }))
        .sort((a, b) => b.probability - a.probability || (a.class_name < b.class_name ? -1 : 1));
      estimates[target.name] = { kind: "classification", ranked, top: ranked[0], fitted: fit.fitted, train_rows: fit.train_rows };
    } else if (target.kind === "duration") {
      const fit = fitDurationBaseline({ target, tier, trainRows: train, options });
      const quantiles = fit.predictRows([row])[0];
      estimates[target.name] = {
        kind: "duration",
        p25_days: quantiles.p25_days,
        p50_days: quantiles.p50_days,
        p75_days: quantiles.p75_days,
        comparator_median_days: fit.comparator_median_days,
        fitted: fit.fitted,
        train_rows: fit.train_rows,
      };
    } else if (target.kind === "ordinal") {
      const fit = fitOrdinalBaseline({ target, tier, trainRows: train, options });
      const topicRows = fit.expandTopicRows([row]);
      const predictions = topicRows.length > 0 ? fit.predictTopicRows(topicRows) : [];
      estimates[target.name] = {
        kind: "ordinal",
        fitted: fit.fitted,
        train_rows: fit.train_rows,
        per_topic: topicRows.map((topicRow, index) => {
          const probabilities = predictions[index];
          const ranked = target.class_names
            .map((name, level) => ({ level_name: name, probability: probabilities[level] }))
            .sort((a, b) => b.probability - a.probability || (a.level_name < b.level_name ? -1 : 1));
          return {
            technical_topic: topicRow.technical_topic,
            state_at_cutoff: row.topic_rows.find((candidate) => candidate.technical_topic === topicRow.technical_topic)?.state_at_cutoff ?? null,
            ranked,
            top: ranked[0],
          };
        }),
      };
    }
  }

  assertNoForbiddenEstimate(Object.keys(estimates), "buildReviewEstimates");
  return { review_key: reviewKey, fold_id: foldId, source_tier: tier, estimates };
}

/**
 * Source freshness and missing-data warnings for one review, as of its own
 * cutoff. This is the card's "what did we not know" section, and it is
 * deliberately built from absences: a topic the record never mentions, a
 * source that has published nothing recently, an institution that has taken
 * no position. SEQRA-02's own rule applies -- absence of a mention is not
 * evidence of a screening decision, so an unmentioned topic is reported as
 * missing rather than as screened out.
 */
export function buildSourceFreshness(row, observationHorizon) {
  const state = row.snapshot.review_state;
  const bySource = new Map();
  for (const milestone of state.milestones) {
    const previous = bySource.get(milestone.event_type) ?? null;
    if (previous === null || milestone.effective_at > previous) bySource.set(milestone.event_type, milestone.effective_at);
  }
  const latestEvent = state.milestones.reduce((latest, milestone) => (latest === null || milestone.effective_at > latest ? milestone.effective_at : latest), null);
  const cutoffMs = Date.parse(row.cutoff);
  const staleDays = latestEvent === null ? null : Math.floor((cutoffMs - Date.parse(latestEvent)) / DAY_MS);

  const warnings = [];
  if (latestEvent === null) warnings.push("no public review event is recorded for this review as of the cutoff");
  if (staleDays !== null && staleDays > 180) warnings.push(`the most recent public review event is ${staleDays} days before the cutoff`);
  if (Object.keys(state.topics).length === 0) warnings.push("no technical topic assessment has been published, so no topic can be reported as screened out");
  if (state.positions.length === 0) warnings.push("no institutional position has been recorded, which is not the same as no institution having one");
  if (Object.keys(state.documents).length === 0) warnings.push("no environmental review document has been published as of the cutoff");

  return {
    cutoff: row.cutoff,
    observation_horizon: observationHorizon,
    latest_public_event_at: latestEvent,
    days_since_latest_public_event: staleDays,
    event_type_last_seen: Object.fromEntries([...bySource.entries()].sort()),
    warnings,
  };
}
