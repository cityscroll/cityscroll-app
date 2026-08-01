// Shared claim-layer vocabulary for public multi-source claims.
//
// source_assertion  — publisher field value with provenance
// cityscroll_interpretation — CityScroll compare/join/parse reading (never a silent winner)
// derived_conclusion — product-facing summary citing evidence assertion ids
//
// Charter: docs/adr/evidence-assertion-layer.md

export const CLAIM_LAYER_VERSION = "claim_layer_v1";

export const CLAIM_CLASSIFICATIONS = Object.freeze({
  SOURCE_ASSERTION: "source_assertion",
  CITYSCROLL_INTERPRETATION: "cityscroll_interpretation",
  DERIVED_CONCLUSION: "derived_conclusion",
});

export const CLAIM_READER_LABELS = Object.freeze({
  source_assertion: "Source assertion",
  cityscroll_interpretation: "CityScroll interpretation",
  derived_conclusion: "Derived conclusion",
});

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * Build a publisher-attributed assertion (never a CityScroll pick).
 * @param {{ source_system: string, source_field: string, value: unknown, source_system_id?: string, source_url?: string, recorded_at?: string }} input
 */
export function sourceAssertionClaim(input = {}) {
  const source_system = clean(input.source_system);
  const source_field = clean(input.source_field);
  if (!source_system || !source_field || input.value == null || input.value === "") {
    return null;
  }
  const claim = {
    classification: CLAIM_CLASSIFICATIONS.SOURCE_ASSERTION,
    source_system,
    source_field,
    value: input.value,
  };
  const source_system_id = clean(input.source_system_id);
  const source_url = clean(input.source_url);
  const recorded_at = clean(input.recorded_at);
  if (source_system_id) claim.source_system_id = source_system_id;
  if (source_url) claim.source_url = source_url;
  if (recorded_at) claim.recorded_at = recorded_at;
  return claim;
}

/**
 * CityScroll reading of evidence — conflict, agreement, or other status.
 * Must not carry a selected_value when resolution is unresolved.
 * @param {{ status: string, resolution?: string, summary: string, evidence_assertion_ids?: string[], comparison_values?: unknown[] }} input
 */
export function interpretationClaim(input = {}) {
  const status = clean(input.status) || "unspecified";
  const resolution = clean(input.resolution) || "unresolved";
  const summary = clean(input.summary);
  if (!summary) return null;
  const claim = {
    classification: CLAIM_CLASSIFICATIONS.CITYSCROLL_INTERPRETATION,
    status,
    resolution,
    summary,
  };
  if (Array.isArray(input.evidence_assertion_ids) && input.evidence_assertion_ids.length) {
    claim.evidence_assertion_ids = input.evidence_assertion_ids.map(clean).filter(Boolean);
  }
  if (Array.isArray(input.comparison_values)) {
    claim.comparison_values = [...input.comparison_values];
  }
  // Hard rule: unresolved interpretations never smuggle a selected winner.
  if (resolution !== "unresolved" && Object.hasOwn(input, "selected_value")) {
    claim.selected_value = input.selected_value;
  }
  return claim;
}

/**
 * Product-facing summary built from evidence (dossier name, etc.).
 * @param {{ value: unknown, summary: string, evidence_assertion_ids?: string[], fact?: string, label?: string }} input
 */
export function derivedConclusionClaim(input = {}) {
  const summary = clean(input.summary);
  if (input.value == null || input.value === "" || !summary) return null;
  const claim = {
    classification: CLAIM_CLASSIFICATIONS.DERIVED_CONCLUSION,
    value: input.value,
    summary,
    evidence_assertion_ids: Array.isArray(input.evidence_assertion_ids)
      ? input.evidence_assertion_ids.map(clean).filter(Boolean)
      : [],
  };
  const fact = clean(input.fact);
  const label = clean(input.label);
  if (fact) claim.fact = fact;
  if (label) claim.label = label;
  return claim;
}

/**
 * Bundle two disagreeing source assertions with an unresolved interpretation.
 * Deliberately omits derived_conclusion so product surfaces cannot invent a winner.
 *
 * @param {{ fact: string, label?: string, left: object, right: object, summary?: string }} input
 */
export function conflictClaimBundle(input = {}) {
  const fact = clean(input.fact);
  const left = sourceAssertionClaim(input.left || {});
  const right = sourceAssertionClaim(input.right || {});
  if (!fact || !left || !right) return null;

  const label = clean(input.label) || fact;
  const summary = clean(input.summary)
    || `CityScroll reads the two source values as different ${label.toLowerCase()} assertions; neither value is selected.`;

  const interpretation = interpretationClaim({
    status: "conflict",
    resolution: "unresolved",
    summary,
    comparison_values: [left.value, right.value],
  });

  return {
    version: CLAIM_LAYER_VERSION,
    fact,
    label,
    assertions: [left, right],
    interpretation,
    // Explicit absence: disagreement surfaces must not emit a winning derived conclusion.
    derived_conclusion: null,
  };
}

/**
 * Attach claim_layer bundles onto OCP-style disagreement rows (field + city_record + ocp).
 */
export function labelOcpDisagreements(disagreements = [], opts = {}) {
  const citySystem = clean(opts.city_source_system) || "city_record";
  const ocpSystem = clean(opts.ocp_source_system) || "ocp-recent-awards";
  const list = Array.isArray(disagreements) ? disagreements : [];
  return list.map((row) => {
    if (!row || typeof row !== "object") return row;
    const field = clean(row.field);
    if (!field) return { ...row, claim_layer: null };
    const label = field === "amount" ? "Contract amount" : field === "date" ? "Start date" : field;
    const cityField = field === "amount" ? "contract_amount" : "start_date";
    const ocpField = field === "amount" ? "contract_amount" : "start_date";
    const claim_layer = conflictClaimBundle({
      fact: field === "amount" ? "contract_amount" : field === "date" ? "start_date" : field,
      label,
      left: {
        source_system: citySystem,
        source_field: cityField,
        value: row.city_record,
        source_system_id: opts.city_source_system_id,
      },
      right: {
        source_system: ocpSystem,
        source_field: ocpField,
        value: row.ocp,
        source_system_id: opts.ocp_source_system_id,
      },
    });
    return { ...row, claim_layer };
  });
}

export function readerLabelFor(classification) {
  return CLAIM_READER_LABELS[clean(classification)] || clean(classification);
}
