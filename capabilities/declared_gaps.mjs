// The capability gaps CityScroll declares about itself.
//
// A declared gap is a question the public surface deliberately does not answer, written
// down once so a machine caller can NAME what is missing instead of inferring it from a
// silence. This module is the single authority: the generated integration client's
// unsupported-question recipe, the MCP server instructions, and the list_capability_gaps
// tool all read this list. A gap is only ever added here by review — nothing derives one
// from prose, and nothing states a gap that is not on this list.
//
// Keep this module transport-neutral: it names capability references, and the surfaces
// that carry it resolve those to their own tool or route names.

export const DECLARED_CAPABILITY_GAPS_SCHEMA = "cityscroll.declared_capability_gaps.v1";

export const DECLARED_CAPABILITY_GAPS = Object.freeze([
  Object.freeze({
    id: "civic.outcome.prediction",
    recipeId: "unsupported-outcome-prediction",
    question: "What outcome will a public decision definitely produce?",
    meaning: "The public surface reports what the record states about a decision, including where it stands in its review path. It does not forecast how a pending decision will be decided.",
    nearest: Object.freeze(["land.project.get@1", "land.decision_path.get@1"]),
  }),
]);

export function declaredGapById(id) {
  return DECLARED_CAPABILITY_GAPS.find((gap) => gap.id === String(id || "")) || null;
}

/**
 * Fails closed on a malformed declaration, so a surface never publishes half a gap.
 * Returns the list of problems; empty means every declared gap is complete.
 */
export function validateDeclaredCapabilityGaps(gaps = DECLARED_CAPABILITY_GAPS) {
  const problems = [];
  const seen = new Set();
  for (const gap of gaps) {
    const at = `declared gap ${gap?.id || "(unnamed)"}`;
    for (const field of ["id", "recipeId", "question", "meaning"]) {
      if (typeof gap?.[field] !== "string" || gap[field].length === 0) problems.push(`${at}: ${field} is required`);
    }
    if (seen.has(gap?.id)) problems.push(`${at}: duplicate gap id`);
    seen.add(gap?.id);
    if (!Array.isArray(gap?.nearest) || gap.nearest.length === 0) {
      problems.push(`${at}: at least one nearest capability reference is required`);
    }
  }
  return problems;
}
