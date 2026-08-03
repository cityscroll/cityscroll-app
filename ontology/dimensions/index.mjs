// Dimension catalog — register evaluators for the multi-flywheel runner.

import { DIMENSION_IDS } from "./shared.mjs";
import {
  evaluateDataIntegrity,
  DIMENSION_ID as DATA_INTEGRITY,
} from "./data_integrity.mjs";
import { evaluateReadability, DIMENSION_ID as READABILITY } from "./readability.mjs";
import { evaluateOntologyEnrichment, DIMENSION_ID as ONTOLOGY_ENRICHMENT } from "./ontology_enrichment.mjs";
import { evaluateCoverage, DIMENSION_ID as COVERAGE } from "./coverage.mjs";
import {
  evaluateCrossSourceConsistency,
  DIMENSION_ID as CROSS_SOURCE,
} from "./cross_source_consistency.mjs";
import {
  evaluateLocationResolution,
  DIMENSION_ID as LOCATION_RESOLUTION,
} from "./location_resolution.mjs";

export { DIMENSION_IDS, MULTI_FLYWHEEL_POLICY_VERSION, MULTI_CARD_SCHEMA, makeDimensionCard, rankCards } from "./shared.mjs";

export const DIMENSION_EVALUATORS = Object.freeze({
  [DATA_INTEGRITY]: evaluateDataIntegrity,
  [READABILITY]: evaluateReadability,
  [ONTOLOGY_ENRICHMENT]: evaluateOntologyEnrichment,
  [COVERAGE]: evaluateCoverage,
  [CROSS_SOURCE]: evaluateCrossSourceConsistency,
  [LOCATION_RESOLUTION]: evaluateLocationResolution,
});

export function getEvaluator(dimensionId) {
  const fn = DIMENSION_EVALUATORS[dimensionId];
  if (!fn) throw new TypeError(`no evaluator for dimension: ${dimensionId}`);
  return fn;
}

export function listDimensions() {
  return [...DIMENSION_IDS];
}
