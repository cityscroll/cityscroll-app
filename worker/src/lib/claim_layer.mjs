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
 * When opts.subject_ref is a valid registry ref (e.g. notice:20240723114), every claim
 * row carries the same subject so assertion layer and civic-time agree on the object.
 */
export function labelOcpDisagreements(disagreements = [], opts = {}) {
  const citySystem = clean(opts.city_source_system) || "city_record";
  const ocpSystem = clean(opts.ocp_source_system) || "ocp-recent-awards";
  const subjectRef = clean(opts.subject_ref);
  const list = Array.isArray(disagreements) ? disagreements : [];
  return list.map((row) => {
    if (!row || typeof row !== "object") return row;
    const field = clean(row.field);
    if (!field) return { ...row, claim_layer: null };
    const label = field === "amount" ? "Contract amount" : field === "date" ? "Start date" : field;
    const cityField = field === "amount" ? "contract_amount" : "start_date";
    const ocpField = field === "amount" ? "contract_amount" : "start_date";
    let claim_layer = conflictClaimBundle({
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
    if (claim_layer && subjectRef) {
      claim_layer = { ...claim_layer, subject_ref: subjectRef };
    }
    return { ...row, claim_layer };
  });
}

export function readerLabelFor(classification) {
  return CLAIM_READER_LABELS[clean(classification)] || clean(classification);
}

/**
 * True when a claim_layer bundle fully labels a multi-source disagreement:
 * ≥2 source assertions, unresolved CityScroll interpretation, no derived winner.
 */
export function isCompleteClaimLayer(layer) {
  if (!layer || typeof layer !== "object") return false;
  if (clean(layer.version) !== CLAIM_LAYER_VERSION) return false;
  const assertions = Array.isArray(layer.assertions) ? layer.assertions : [];
  if (assertions.length < 2) return false;
  if (!assertions.every((a) => a && a.classification === CLAIM_CLASSIFICATIONS.SOURCE_ASSERTION)) {
    return false;
  }
  const interp = layer.interpretation;
  if (!interp || interp.classification !== CLAIM_CLASSIFICATIONS.CITYSCROLL_INTERPRETATION) {
    return false;
  }
  if (clean(interp.resolution) !== "unresolved") return false;
  // Hard rule: labeled public disagreements must not pick a winner.
  if (layer.derived_conclusion != null) return false;
  if (Object.hasOwn(interp, "selected_value")) return false;
  return true;
}

/**
 * True when every disagreement row on a join carries a complete claim_layer.
 */
export function disagreementsFullyLabeled(disagreements = []) {
  const list = Array.isArray(disagreements) ? disagreements : [];
  if (!list.length) return false;
  return list.every((row) => isCompleteClaimLayer(row?.claim_layer));
}

/**
 * Extract corroboration / disagreement payload from a join result, lifecycle
 * side-car, or a bare corroboration object.
 */
function extractCorroboration(input) {
  if (!input || typeof input !== "object") return null;
  if (input.ocp_award && typeof input.ocp_award === "object") {
    return extractCorroboration(input.ocp_award);
  }
  if (input.corroboration && typeof input.corroboration === "object") {
    return input.corroboration;
  }
  if (Array.isArray(input.disagreements) || Object.hasOwn(input, "agree")) {
    return input;
  }
  return null;
}

/**
 * public_claim_labeled_disagree_rate on OCP-joined awards:
 *
 *   labeled_disagreements / ocp_joined_with_field_disagreement
 *
 * Eligible cases are OCP **matched** joins (or bare corroborations) that have
 * at least one amount/date disagreement. A case is labeled only when every
 * disagreement row has a complete claim_layer (source assertions + unresolved
 * interpretation + null derived_conclusion).
 *
 * Agreeing joins and unmatched/unknown/ambiguous joins are not eligible —
 * there is no public multi-source conflict to label.
 *
 * @param {Array<object>} cases join results, { ocp_award }, or corroborations
 * @returns {{
 *   metric: string,
 *   version: string,
 *   eligible: number,
 *   labeled: number,
 *   rate: number,
 *   cases: Array<object>
 * }}
 */
export function measurePublicClaimLabeledDisagreeRate(cases = []) {
  const rows = Array.isArray(cases) ? cases : [];
  const details = [];
  let eligible = 0;
  let labeled = 0;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = clean(row.id) || clean(row.notice_id) || clean(row.request_id) || null;

    // Prefer explicit join status when present (ocp_award or join result).
    const joinStatus = clean(
      row.status
      || row.ocp_award?.status
      || (row.corroboration || Array.isArray(row.disagreements) ? "matched" : ""),
    );

    if (joinStatus && joinStatus !== "matched") {
      details.push({
        id,
        eligible: false,
        labeled: false,
        reason: `join_status_${joinStatus || "missing"}`,
      });
      continue;
    }

    const corr = extractCorroboration(row);
    if (!corr) {
      details.push({ id, eligible: false, labeled: false, reason: "no_corroboration" });
      continue;
    }

    const disagreements = Array.isArray(corr.disagreements) ? corr.disagreements : [];
    const hasDisagreement = disagreements.length > 0 || corr.agree === false;
    if (!hasDisagreement || disagreements.length === 0) {
      details.push({
        id,
        eligible: false,
        labeled: false,
        reason: "no_field_disagreement",
        agree: corr.agree !== false && disagreements.length === 0,
      });
      continue;
    }

    eligible += 1;
    const ok = disagreementsFullyLabeled(disagreements);
    if (ok) labeled += 1;
    details.push({
      id,
      eligible: true,
      labeled: ok,
      disagreement_count: disagreements.length,
      fields: disagreements.map((d) => clean(d?.field)).filter(Boolean),
      labeled_rows: disagreements.filter((d) => isCompleteClaimLayer(d?.claim_layer)).length,
    });
  }

  const rate = eligible === 0 ? 0 : labeled / eligible;
  return {
    metric: "public_claim_labeled_disagree_rate",
    version: CLAIM_LAYER_VERSION,
    eligible,
    labeled,
    rate,
    cases: details,
  };
}
