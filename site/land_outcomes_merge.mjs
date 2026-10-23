/**
 * Merge rich Land outcome seed fields back onto a slim list-snapshot record.
 *
 * The default Land list snapshot keeps first-paint fields only; spine,
 * dispositions, milestones, and related evidence ship in
 * site/data/land_outcomes_seed.json so the list stays inside its byte budget.
 * Build-time materializers and the browser lazy loader both use this helper so
 * detail/authority surfaces keep the same rich semantics.
 */

export const LAND_OUTCOME_SEED_FIELDS = Object.freeze([
  "spine",
  "milestones",
  "statutory_clock",
  "source_observations",
  "actions",
  "approved_actions",
  "dispositions",
  "documents",
  "n_documents",
  "freshness",
]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Overlay seed fields onto a list-snapshot outcome record. */
export function mergeLandOutcomeSeedRecord(baseRecord = {}, seedRecord = null) {
  const base = asObject(baseRecord);
  const seed = asObject(seedRecord);
  if (!Object.keys(seed).length) return { ...base };
  const merged = { ...base };
  for (const key of LAND_OUTCOME_SEED_FIELDS) {
    if (seed[key] !== undefined) merged[key] = seed[key];
  }
  if (seed.project_id && !merged.project_id) merged.project_id = seed.project_id;
  return merged;
}

/** Merge every seeded project into a list-snapshot by_project map. */
export function mergeLandOutcomesByProject(listByProject = {}, seedByProject = {}) {
  const list = asObject(listByProject);
  const seed = asObject(seedByProject);
  const out = { ...list };
  for (const [projectId, seedRecord] of Object.entries(seed)) {
    out[projectId] = mergeLandOutcomeSeedRecord(list[projectId] || { project_id: projectId }, seedRecord);
  }
  return out;
}
