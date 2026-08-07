/**
 * Shared precision promotion policy.
 *
 * Comparative precision answers whether a replacement is better than the
 * control it replaces. Consequence tiers decide whether that replacement may
 * ship as a quiet navigational suggestion or must clear the strict fact bar.
 */

export const COMPARATIVE_PRECISION_FLOOR = "beats_control_baseline";
export const ABSOLUTE_UNLABELED_PRECISION_FLOOR = 0.95;
export const CONSEQUENCE_SURFACE_TIERS = Object.freeze({
  navigational_pivot: Object.freeze({
    consequence_tier: "navigational_exploratory",
    required_floor: COMPARATIVE_PRECISION_FLOOR,
    confidence_marker: "quiet",
  }),
  navigational_family_grouping: Object.freeze({
    consequence_tier: "navigational_exploratory",
    required_floor: COMPARATIVE_PRECISION_FLOOR,
    confidence_marker: "quiet",
  }),
  navigational_related_record: Object.freeze({
    consequence_tier: "navigational_exploratory",
    required_floor: COMPARATIVE_PRECISION_FLOOR,
    confidence_marker: "quiet",
  }),
  money_total: Object.freeze({
    consequence_tier: "high_consequence",
    required_floor: ABSOLUTE_UNLABELED_PRECISION_FLOOR,
    confidence_marker: null,
  }),
  legal_actionable_instruction: Object.freeze({
    consequence_tier: "high_consequence",
    required_floor: ABSOLUTE_UNLABELED_PRECISION_FLOOR,
    confidence_marker: null,
  }),
  official_result_claim: Object.freeze({
    consequence_tier: "high_consequence",
    required_floor: ABSOLUTE_UNLABELED_PRECISION_FLOOR,
    confidence_marker: null,
  }),
});

export const DEFAULT_SURFACE_CLASS = "navigational_family_grouping";

const isRate = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1;

export function evaluateTwoTierPrecision({
  candidatePrecision,
  controlBaseline,
  candidateSampleSize,
  controlSampleSize,
  labelMode = "labeled",
  candidateReceipt,
  controlReceipt,
  surfaceClass = DEFAULT_SURFACE_CLASS,
} = {}) {
  const candidate = Number(candidatePrecision);
  const control = Number(controlBaseline);
  const surface = CONSEQUENCE_SURFACE_TIERS[surfaceClass];
  if (!surface) throw new Error(`Unknown precision surface class: ${surfaceClass}`);
  const comparativePassed = isRate(candidate) && isRate(control) && candidate > control;
  const absolutePassed = isRate(candidate) && candidate >= ABSOLUTE_UNLABELED_PRECISION_FLOOR;
  const comparativeEvidencePresent = Number.isInteger(candidateSampleSize) && candidateSampleSize > 0
    && Number.isInteger(controlSampleSize) && controlSampleSize > 0
    && Boolean(candidateReceipt) && Boolean(controlReceipt);
  const labeled = labelMode === "labeled";
  const unlabeled = labelMode === "unlabeled";
  const highConsequence = surface.consequence_tier === "high_consequence";
  const evidenceBacked = comparativePassed && comparativeEvidencePresent;
  const strictFloorPassed = absolutePassed && comparativeEvidencePresent;
  const canShipLabeled = labeled && (highConsequence ? strictFloorPassed : evidenceBacked);
  const canShipUnlabeled = unlabeled && highConsequence && strictFloorPassed;
  return {
    surface_class: surfaceClass,
    consequence_tier: surface.consequence_tier,
    required_precision_floor: surface.required_floor,
    confidence_marker: surface.confidence_marker,
    comparative: {
      floor: COMPARATIVE_PRECISION_FLOOR,
      candidate_precision: isRate(candidate) ? candidate : null,
      control_baseline: isRate(control) ? control : null,
      beats_control: comparativePassed,
      evidence_present: comparativeEvidencePresent,
      passed: comparativePassed && comparativeEvidencePresent,
      candidate_receipt: candidateReceipt || null,
      control_receipt: controlReceipt || null,
    },
    absolute: {
      floor: ABSOLUTE_UNLABELED_PRECISION_FLOOR,
      candidate_precision: isRate(candidate) ? candidate : null,
      passed: absolutePassed,
      applies_to: "high_consequence_surface",
      required: highConsequence,
    },
    can_ship_labeled: canShipLabeled,
    can_ship_unlabeled: canShipUnlabeled,
  };
}
