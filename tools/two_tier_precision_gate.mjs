/**
 * Shared precision promotion policy.
 *
 * Comparative precision answers whether a replacement is better than the
 * control it replaces. Absolute precision answers whether a reader may see
 * the result as an unlabeled fact. They are intentionally separate gates.
 */

export const COMPARATIVE_PRECISION_FLOOR = "beats_control_baseline";
export const ABSOLUTE_UNLABELED_PRECISION_FLOOR = 0.95;

const isRate = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1;

export function evaluateTwoTierPrecision({
  candidatePrecision,
  controlBaseline,
  candidateSampleSize,
  controlSampleSize,
  labelMode = "labeled",
  candidateReceipt,
  controlReceipt,
} = {}) {
  const candidate = Number(candidatePrecision);
  const control = Number(controlBaseline);
  const comparativePassed = isRate(candidate) && isRate(control) && candidate > control;
  const absolutePassed = isRate(candidate) && candidate >= ABSOLUTE_UNLABELED_PRECISION_FLOOR;
  const comparativeEvidencePresent = Number.isInteger(candidateSampleSize) && candidateSampleSize > 0
    && Number.isInteger(controlSampleSize) && controlSampleSize > 0
    && Boolean(candidateReceipt) && Boolean(controlReceipt);
  const labeled = labelMode === "labeled";
  const unlabeled = labelMode === "unlabeled";
  return {
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
      applies_to: "unlabeled_fact",
    },
    can_ship_labeled: labeled && comparativePassed && comparativeEvidencePresent,
    can_ship_unlabeled: unlabeled && absolutePassed && comparativeEvidencePresent,
  };
}
