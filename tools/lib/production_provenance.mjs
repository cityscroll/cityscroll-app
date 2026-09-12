/**
 * Provenance envelope for a live production GET. Credentials never enter this
 * object. A path that did not answer is not-yet-observed, never passed.
 */

export const PRODUCTION_PROVENANCE_SCHEMA = "cityscroll.production_provenance.v1";
export const PRODUCTION_EVIDENCE_CLASS = "live-production-read";
export const PRODUCTION_PATH_STATES = Object.freeze(["passed", "not-yet-observed", "failed"]);

export function productionProvenance({
  observed_at,
  tool,
  source_revision = null,
  bases = [],
  methods = ["GET"],
} = {}) {
  if (!observed_at || Number.isNaN(Date.parse(observed_at))) {
    throw new Error("production provenance requires a valid observed_at timestamp");
  }
  if (!tool) throw new Error("production provenance requires the observing tool");
  return {
    schema: PRODUCTION_PROVENANCE_SCHEMA,
    evidence_class: PRODUCTION_EVIDENCE_CLASS,
    isolated: false,
    observed_at,
    observer: {
      tool,
      source_revision: source_revision || null,
    },
    methods: [...methods],
    bases: [...bases],
  };
}

/** Structural check for a live production GET envelope. Credentials never appear here. */
export function assertProductionProvenance(value, { requireSourceRevision = false } = {}) {
  if (!value || value.schema !== PRODUCTION_PROVENANCE_SCHEMA) {
    throw new Error(`provenance schema must be ${PRODUCTION_PROVENANCE_SCHEMA}`);
  }
  if (value.evidence_class !== PRODUCTION_EVIDENCE_CLASS) {
    throw new Error("provenance evidence_class must be live-production-read");
  }
  if (value.isolated !== false) {
    throw new Error("live production provenance must not be labeled isolated");
  }
  if (!value.observed_at || Number.isNaN(Date.parse(value.observed_at))) {
    throw new Error("provenance requires a valid observed_at timestamp");
  }
  if (!value.observer?.tool) {
    throw new Error("provenance requires observer.tool");
  }
  if (requireSourceRevision && !value.observer.source_revision) {
    throw new Error("provenance requires observer.source_revision");
  }
  if (!Array.isArray(value.methods) || value.methods.length === 0) {
    throw new Error("provenance requires methods");
  }
  if (!Array.isArray(value.bases) || value.bases.length === 0) {
    throw new Error("provenance requires bases");
  }
  return value;
}

export function productionPathObservation({
  id,
  url,
  method = "GET",
  status = null,
  state,
  assertion,
  evidence = null,
  note = null,
}) {
  if (!PRODUCTION_PATH_STATES.includes(state)) {
    throw new Error(`production path state must be one of ${PRODUCTION_PATH_STATES.join(", ")}`);
  }
  if (state === "passed" && (status == null || status >= 400)) {
    throw new Error("a passed production path must record a successful HTTP status");
  }
  return {
    id,
    url,
    method,
    status,
    state,
    assertion,
    evidence,
    note,
  };
}
