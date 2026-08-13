/** Browser-safe projection of the closed vocabulary in ontology/cross_spine.mjs. */

export const CROSS_SPINE_CONFIDENCE = Object.freeze(["confirmed", "review", "unmatched"]);

const CONFIDENCE = new Set(CROSS_SPINE_CONFIDENCE);

export function normalizeCrossSpineConfidence(value) {
  const candidate = typeof value === "object" && value !== null
    ? value.confidence || value.join_confidence || value.status
    : value;
  const normalized = String(candidate ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return CONFIDENCE.has(normalized) ? normalized : null;
}
