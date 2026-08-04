/**
 * Land upcoming-hearings empty-state classifier (hearing-attender persona).
 * Pure: no DOM. Distinguishes "zero future published dates" from "filters hid rows".
 */

/**
 * @param {object|null|undefined} snap land_upcoming_hearings.json shape
 * @param {{ allCount?: number, filteredCount?: number }} counts
 * @returns {{ kind: "has_rows"|"none_future"|"filters"|"empty", extracted?: number, generated_at?: string|null }}
 */
export function landHearingsEmptyState(snap, counts = {}) {
  const filteredCount = Number(counts.filteredCount);
  if (Number.isFinite(filteredCount) && filteredCount > 0) {
    return { kind: "has_rows" };
  }
  const allCount = Number(counts.allCount);
  const mat = snap && typeof snap === "object" ? snap.materialization || {} : {};
  const extracted = Number(mat.hearings_extracted);
  const upcomingSnap = Number(mat.upcoming_count);
  const corpusEmpty = !Number.isFinite(allCount) || allCount === 0;
  if (
    corpusEmpty
    && Number.isFinite(extracted)
    && extracted > 0
    && (upcomingSnap === 0 || !Number.isFinite(upcomingSnap))
  ) {
    return {
      kind: "none_future",
      extracted,
      generated_at: snap?.generated_at || null,
    };
  }
  if (Number.isFinite(allCount) && allCount > 0) {
    return { kind: "filters" };
  }
  return { kind: "empty" };
}
