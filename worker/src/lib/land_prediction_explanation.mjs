// Evidence-preserving explanation contract for LUP2-C8.
//
// This module describes model associations. It does not infer a causal
// mechanism, institutional control, or the reason a probability moved.

export const LAND_PREDICTION_EXPLANATION_SCHEMA =
  "cityscroll.land_prediction_explanation.v1";
export const LAND_PREDICTION_EXPLANATION_VERSION = 1;
export const LAND_PREDICTION_EXPLANATION_COMPARISON_SCHEMA =
  "cityscroll.land_prediction_explanation_comparison.v1";

const KNOWN_STATES = new Set(["known", "no_known_position", "neutral_mixed"]);

function text(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function stableSort(rows, key = "reason_id") {
  return [...rows].sort((left, right) => String(left[key]).localeCompare(String(right[key])));
}

function sourceHref(source) {
  if (typeof source === "string") {
    return /^(?:https?:\/\/|\/)/.test(source.trim()) ? source.trim() : null;
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const candidate = source.href ?? source.url ?? source.source_href ?? source.route;
  return typeof candidate === "string" && /^(?:https?:\/\/|\/)/.test(candidate.trim())
    ? candidate.trim()
    : null;
}

function evidenceReference(row, fallbackId, index) {
  const evidenceId = text(row?.evidence_id) || text(fallbackId) || `unresolved:${index}`;
  const href = sourceHref(row?.source);
  return {
    evidence_id: evidenceId,
    status: href ? "resolvable" : "unavailable",
    href,
    evidence_type: text(row?.evidence_type),
    observed_at: text(row?.observed_at),
    effective_at: text(row?.effective_at),
    source: row?.source ?? null,
    source_statement_status: text(row?.observation) ? "retained" : "unavailable",
    source_statement: text(row?.observation),
    availability_note: href
      ? null
      : "No exact stable route is available for this retained evidence reference; this is not proof that evidence does not exist.",
  };
}

function evidenceReferences(contributor) {
  const rows = Array.isArray(contributor?.evidence) ? contributor.evidence : [];
  const ids = Array.isArray(contributor?.evidence_ids) ? contributor.evidence_ids.map(String) : [];
  const length = Math.max(rows.length, ids.length);
  return Array.from({ length }, (_, index) => evidenceReference(rows[index], ids[index], index))
    .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
}

function reasonExplanation(contributor) {
  const direction = contributor.direction === "toward_approved"
    ? "was associated with a higher modeled approval estimate"
    : contributor.direction === "away_from_approved"
      ? "was associated with a lower modeled approval estimate"
      : "had a neutral modeled association";
  return `${contributor.feature_key} (${contributor.state}) ${direction}. This is a predictive association, not a causal or control claim.`;
}

function reasonFromContributor(contributor) {
  const state = KNOWN_STATES.has(contributor?.state) ? contributor.state : "unknown";
  if (state === "unknown") return null;
  return {
    reason_id: text(contributor.key) || `feature:${text(contributor.feature_key) || "unknown"}`,
    feature_key: text(contributor.feature_key) || "unknown",
    feature_state: state,
    feature_value: contributor.value ?? null,
    direction: ["toward_approved", "away_from_approved", "neutral"].includes(contributor.direction)
      ? contributor.direction
      : "neutral",
    contribution: Number.isFinite(contributor.contribution) ? contributor.contribution : null,
    explanation: reasonExplanation({ ...contributor, state }),
    interpretation: "predictive_association",
    evidence: evidenceReferences(contributor),
  };
}

function unknownSignal(feature) {
  return {
    reason_id: `unknown:${feature.key}`,
    feature_key: feature.key,
    feature_state: "unknown",
    explanation: `${feature.key} was unavailable or insufficient at this snapshot cutoff. Missingness is not evidence for or against approval.`,
    interpretation: "missing_or_insufficient_signal",
    evidence: [],
  };
}

export function buildLandPredictionExplanation(prediction) {
  const contributors = Array.isArray(prediction?.major_contributors)
    ? prediction.major_contributors
    : [];
  const features = Array.isArray(prediction?.feature_state?.features)
    ? prediction.feature_state.features
    : [];
  const knownReasons = stableSort(contributors.map(reasonFromContributor).filter(Boolean));
  const unknownSignals = stableSort(features.filter((feature) => feature?.state === "unknown").map(unknownSignal));
  const hasUnavailableEvidence = knownReasons.some((reason) =>
    reason.evidence.some((reference) => reference.status === "unavailable"));
  return {
    schema: LAND_PREDICTION_EXPLANATION_SCHEMA,
    schema_version: LAND_PREDICTION_EXPLANATION_VERSION,
    status: knownReasons.length ? "available" : "unavailable",
    prediction_id: text(prediction?.prediction_id),
    subject_ref: text(prediction?.subject_ref),
    application_id: text(prediction?.application_id),
    prediction_as_of: text(prediction?.prediction_as_of),
    model_name: text(prediction?.model_name),
    model_version: text(prediction?.model_version),
    known_reasons: knownReasons,
    unknown_signals: unknownSignals,
    evidence_status: hasUnavailableEvidence ? "partially_unavailable" : knownReasons.length ? "available" : "unavailable",
    basis: "predictive association from a fitted logistic model; not a causal claim",
    unavailable_note: knownReasons.length
      ? null
      : "No material grounded contributors are available for this prediction; this does not mean there is no relevant evidence.",
    interpretation: {
      supported: "predictive_association",
      causal_interpretation: "unavailable",
      institutional_control: "unavailable_without_separate_source_backed_contract",
    },
  };
}

function assertExplanation(value, label) {
  if (!value || value.schema !== LAND_PREDICTION_EXPLANATION_SCHEMA) {
    throw new TypeError(`${label} must use ${LAND_PREDICTION_EXPLANATION_SCHEMA}`);
  }
  if (!Array.isArray(value.known_reasons) || !Array.isArray(value.unknown_signals)) {
    throw new TypeError(`${label} must retain known_reasons and unknown_signals`);
  }
  return value;
}

function evidenceFingerprint(reason) {
  return (reason.evidence || []).map((row) => `${row.evidence_id}|${row.status}|${row.href || ""}`).sort();
}

function reasonFingerprint(reason) {
  return JSON.stringify({
    feature_key: reason.feature_key,
    feature_state: reason.feature_state,
    feature_value: reason.feature_value,
    direction: reason.direction,
    contribution: reason.contribution,
    evidence: evidenceFingerprint(reason),
  });
}

function indexReasons(explanation) {
  return new Map([
    ...explanation.known_reasons,
    ...explanation.unknown_signals,
  ].map((reason) => [reason.reason_id, reason]));
}

export function compareLandPredictionExplanations(before, after) {
  const left = assertExplanation(before?.explanation || before, "before explanation");
  const right = assertExplanation(after?.explanation || after, "after explanation");
  if (left.application_id !== right.application_id || left.subject_ref !== right.subject_ref) {
    throw new TypeError("prediction snapshots must describe the same project and subject");
  }
  const beforeReasons = indexReasons(left);
  const afterReasons = indexReasons(right);
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  const stillUnknown = [];
  for (const id of [...new Set([...beforeReasons.keys(), ...afterReasons.keys()])].sort()) {
    const oldReason = beforeReasons.get(id) || null;
    const newReason = afterReasons.get(id) || null;
    if (!oldReason) added.push(newReason);
    else if (!newReason) removed.push(oldReason);
    else if (reasonFingerprint(oldReason) !== reasonFingerprint(newReason)) {
      changed.push({ reason_id: id, before: oldReason, after: newReason });
    } else {
      unchanged.push(newReason);
      if (newReason.feature_state === "unknown") stillUnknown.push(newReason);
    }
  }
  const beforeProbability = Number.isFinite(before?.probability) ? before.probability : null;
  const afterProbability = Number.isFinite(after?.probability) ? after.probability : null;
  return {
    schema: LAND_PREDICTION_EXPLANATION_COMPARISON_SCHEMA,
    schema_version: 1,
    subject_ref: left.subject_ref,
    application_id: left.application_id,
    snapshot: { before: left.prediction_as_of, after: right.prediction_as_of },
    model: {
      before: { name: left.model_name, version: left.model_version },
      after: { name: right.model_name, version: right.model_version },
      changed: left.model_name !== right.model_name || left.model_version !== right.model_version,
    },
    probability: {
      before: beforeProbability,
      after: afterProbability,
      delta: beforeProbability === null || afterProbability === null
        ? null
        : Number((afterProbability - beforeProbability).toFixed(8)),
      measurement_only: true,
    },
    reasons: {
      added: stableSort(added),
      removed: stableSort(removed),
      changed: stableSort(changed),
      unchanged: stableSort(unchanged),
      still_unknown: stableSort(stillUnknown),
    },
    interpretation: {
      temporal_association: "available",
      causal_interpretation: "unavailable",
      note: "Reason and probability changes are measurements between snapshots; temporal ordering does not establish why the probability moved.",
    },
  };
}

export function projectLandPredictionExplanation(prediction) {
  if (!prediction || prediction.promotion_status !== "shadow_only_until_backtest_gate") {
    return {
      schema: LAND_PREDICTION_EXPLANATION_SCHEMA,
      schema_version: LAND_PREDICTION_EXPLANATION_VERSION,
      status: "unavailable",
      known_reasons: [],
      unknown_signals: [],
      unavailable_note: "A grounded shadow-prediction explanation is unavailable.",
    };
  }
  try {
    return assertExplanation(prediction.explanation, "prediction explanation");
  } catch {
    return {
      schema: LAND_PREDICTION_EXPLANATION_SCHEMA,
      schema_version: LAND_PREDICTION_EXPLANATION_VERSION,
      status: "unavailable",
      known_reasons: [],
      unknown_signals: [],
      unavailable_note: "A grounded explanation was not provided; the incumbent prediction remains available.",
    };
  }
}
