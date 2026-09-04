/**
 * SEQRA-06: stable-key builders for the spatial/implementation join layer.
 *
 * None of these keys are commissioned core-ontology entities (see
 * warehouse/lib/seqra_ontology_spec.mjs's fifteen fixed entity types) -- they
 * identify derived join products this card introduces on top of the frozen
 * `project` and `land_use_determination` entities, so they live in their own
 * module rather than growing the ontology spec. Every builder reuses
 * seqra_stable_keys.mjs's token normalization so a BBL, layer id, or vintage
 * label collides across this module and SEQRA-02's the same way.
 */
import { normalizeKeyToken, SeqraStableKeyError } from "./seqra_stable_keys.mjs";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const BBL = /^\d{10}$/;

function requireBbl(bbl, fieldName = "bbl") {
  if (typeof bbl !== "string" || !BBL.test(bbl)) {
    throw new SeqraStableKeyError(`${fieldName} must be a normalized 10-digit BBL, got ${JSON.stringify(bbl)}`);
  }
  return bbl;
}

function requireDateOnly(value, fieldName) {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) {
    throw new SeqraStableKeyError(`${fieldName} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
  }
  return value;
}

/** `project_bbl_history:{project_key}` */
export function buildProjectBblHistoryKey({ projectKey } = {}) {
  if (typeof projectKey !== "string" || !projectKey.startsWith("project:")) {
    throw new SeqraStableKeyError(`projectKey must be a project stable key, got ${JSON.stringify(projectKey)}`);
  }
  return `project_bbl_history:${projectKey}`;
}

/** `spatial_feature:{layer_type}:{bbl}:{layer_vintage}` -- one per BBL+layer+vintage join result. */
export function buildSpatialFeatureKey({ layerType, bbl, layerVintage } = {}) {
  const layerToken = normalizeKeyToken(layerType, "layerType");
  const normalizedBbl = requireBbl(bbl);
  const vintageToken = normalizeKeyToken(layerVintage, "layerVintage");
  return `spatial_feature:${layerToken}:${normalizedBbl}:${vintageToken}`;
}

/** `spatial_coverage_gap:{layer_type}:{bbl}:{cutoff}` -- a refused join, never a joined value. */
export function buildSpatialCoverageGapKey({ layerType, bbl, cutoff } = {}) {
  const layerToken = normalizeKeyToken(layerType, "layerType");
  const normalizedBbl = requireBbl(bbl);
  const dateToken = requireDateOnly(cutoff, "cutoff");
  return `spatial_coverage_gap:${layerToken}:${normalizedBbl}:${dateToken}`;
}

/** `implementation_event:{source_system}:{source_event_id}` */
export function buildImplementationEventKey({ sourceSystem, sourceEventId } = {}) {
  const systemToken = normalizeKeyToken(sourceSystem, "sourceSystem");
  const idToken = normalizeKeyToken(sourceEventId, "sourceEventId");
  return `implementation_event:${systemToken}:${idToken}`;
}

/** `remedy_exposure_projection:{determination_key}:{cutoff}` */
export function buildRemedyExposureProjectionKey({ determinationKey, cutoff } = {}) {
  if (typeof determinationKey !== "string" || !determinationKey.startsWith("determination:")) {
    throw new SeqraStableKeyError(`determinationKey must be a determination stable key, got ${JSON.stringify(determinationKey)}`);
  }
  const dateToken = requireDateOnly(cutoff, "cutoff");
  return `remedy_exposure_projection:${determinationKey}:${dateToken}`;
}

export { requireBbl, requireDateOnly };
