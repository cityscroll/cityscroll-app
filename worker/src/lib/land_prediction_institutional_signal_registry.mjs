// Research-only candidate registry for Land-Use Prediction v2.
//
// This module is deliberately not imported by the production prediction path.
// It is a quarantine boundary: a candidate can be recorded, tested, promoted,
// or rejected without becoming a feature. Promotion is only valid when a
// historical evaluation records useful held-out predictive value.

export const LAND_PREDICTION_INSTITUTIONAL_SIGNAL_REGISTRY_SCHEMA =
  "cityscroll.land_prediction_institutional_signal_registry.v1";
export const LAND_PREDICTION_INSTITUTIONAL_SIGNAL_REGISTRY_VERSION = 1;
export const LAND_INSTITUTIONAL_SIGNAL_REGISTRY_SCHEMA =
  LAND_PREDICTION_INSTITUTIONAL_SIGNAL_REGISTRY_SCHEMA;
export const LAND_INSTITUTIONAL_SIGNAL_REGISTRY_VERSION =
  LAND_PREDICTION_INSTITUTIONAL_SIGNAL_REGISTRY_VERSION;

export const INSTITUTIONAL_SIGNAL_STATUSES = Object.freeze([
  "proposed",
  "testing",
  "promoted",
  "rejected",
]);

export const INSTITUTIONAL_SIGNAL_CANDIDATE_FIELDS = Object.freeze([
  "id",
  "formal_actor_process",
  "candidate_practical_actor",
  "claimed_mechanism",
  "relevant_stage",
  "possible_evidence_sources",
  "rival_explanation",
  "falsifier",
  "status",
  "promotion_evidence",
  "rejection_rationale",
]);

const REGISTRY_FIELDS = new Set([
  "schema_version",
  "queue",
  "production_admission",
  "candidates",
]);
const CANDIDATE_FIELDS = new Set(INSTITUTIONAL_SIGNAL_CANDIDATE_FIELDS);

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactFields(value, fields, label) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw new TypeError(`${label} has unknown field ${key}`);
  }
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function isJsonValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  return Object.entries(value).every(([key, child]) => typeof key === "string" && isJsonValue(child, seen));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function narrativeValue(value, label) {
  if (typeof value === "string") return requiredText(value, label);
  assertPlainObject(value, label);
  if (!isJsonValue(value) || !Object.keys(value).length) {
    throw new TypeError(`${label} must be a non-empty string or JSON object`);
  }
  return canonicalJson(value);
}

function nonEmptyNarrativeList(value, label) {
  const values = Array.isArray(value) ? value : [value];
  if (!values.length) throw new TypeError(`${label} must contain at least one item`);
  return values.map((item, index) => narrativeValue(item, `${label}[${index}]`));
}

function optionalNarrativeValue(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return narrativeValue(value, label);
}

function promotionEvidence(value) {
  assertPlainObject(value, "candidate promotion_evidence");
  if (!isJsonValue(value)) throw new TypeError("candidate promotion_evidence must be JSON data");

  const hasHistoricalEvidence = value.historical_evidence === true
    || value.historical === true
    || value.historical_evaluation === true;
  if (!hasHistoricalEvidence) {
    throw new TypeError("promotion_evidence must identify historical evidence");
  }
  const hasUsefulValue = value.useful_predictive_value === true
    || value.predictive_value === true
    || value.incremental_predictive_value === true;
  if (!hasUsefulValue) {
    throw new TypeError("promotion_evidence must establish useful predictive value");
  }
  const heldOutCount = [
    value.held_out_application_count,
    value.held_out_count,
    value.test_count,
  ].find((candidate) => Number.isInteger(candidate) && candidate > 0);
  if (!heldOutCount) {
    throw new TypeError("promotion_evidence must report a positive held-out population");
  }
  const hasMetric = (value.metric && typeof value.metric === "object")
    || (value.baseline_metric !== undefined && value.candidate_metric !== undefined)
    || value.metric_name !== undefined;
  if (!hasMetric) {
    throw new TypeError("promotion_evidence must report a baseline/candidate metric");
  }
  if (!["evaluation_id", "evaluation", "study", "source"].some((key) => {
    const candidate = value[key];
    return candidate !== null && candidate !== undefined && String(candidate).trim() !== "";
  })) {
    throw new TypeError("promotion_evidence must identify an inspectable evaluation");
  }
  return canonicalJson(value);
}

function normalizeCandidate(raw) {
  assertPlainObject(raw, "institutional signal candidate");
  assertExactFields(raw, CANDIDATE_FIELDS, "institutional signal candidate");

  const candidate = {
    id: requiredText(raw.id, "candidate.id"),
    formal_actor_process: narrativeValue(raw.formal_actor_process, "candidate.formal_actor_process"),
    candidate_practical_actor: narrativeValue(raw.candidate_practical_actor, "candidate.candidate_practical_actor"),
    claimed_mechanism: narrativeValue(raw.claimed_mechanism, "candidate.claimed_mechanism"),
    relevant_stage: nonEmptyNarrativeList(raw.relevant_stage, "candidate.relevant_stage"),
    possible_evidence_sources: nonEmptyNarrativeList(
      raw.possible_evidence_sources,
      "candidate.possible_evidence_sources",
    ),
    rival_explanation: nonEmptyNarrativeList(raw.rival_explanation, "candidate.rival_explanation"),
    falsifier: nonEmptyNarrativeList(raw.falsifier, "candidate.falsifier"),
    status: requiredText(raw.status, "candidate.status").toLowerCase(),
    promotion_evidence: null,
    rejection_rationale: null,
  };

  if (!INSTITUTIONAL_SIGNAL_STATUSES.includes(candidate.status)) {
    throw new TypeError(`unsupported institutional signal status: ${raw.status}`);
  }

  if (candidate.status === "promoted") {
    if (raw.promotion_evidence === null || raw.promotion_evidence === undefined) {
      throw new TypeError("promoted candidate requires promotion_evidence");
    }
    candidate.promotion_evidence = promotionEvidence(raw.promotion_evidence);
  } else if (raw.promotion_evidence !== null && raw.promotion_evidence !== undefined) {
    throw new TypeError("promotion_evidence is only valid for a promoted candidate");
  }

  if (candidate.status === "rejected") {
    candidate.rejection_rationale = optionalNarrativeValue(
      raw.rejection_rationale,
      "candidate.rejection_rationale",
    );
    if (candidate.rejection_rationale === null) {
      throw new TypeError("rejected candidate requires rejection_rationale");
    }
  } else if (raw.rejection_rationale !== null && raw.rejection_rationale !== undefined) {
    throw new TypeError("rejection_rationale is only valid for a rejected candidate");
  }

  return candidate;
}

function normalizeRegistry(raw) {
  assertPlainObject(raw, "institutional signal registry");
  assertExactFields(raw, REGISTRY_FIELDS, "institutional signal registry");
  if (raw.schema_version !== LAND_PREDICTION_INSTITUTIONAL_SIGNAL_REGISTRY_VERSION) {
    throw new TypeError(`unsupported institutional signal registry schema_version: ${raw.schema_version}`);
  }
  if (raw.queue !== "research") throw new TypeError("institutional signal registry queue must be research");
  if (raw.production_admission !== "not_admitted") {
    throw new TypeError("institutional signal registry must remain outside production admission");
  }
  if (!Array.isArray(raw.candidates)) throw new TypeError("institutional signal registry candidates must be an array");

  const candidates = raw.candidates.map(normalizeCandidate)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new TypeError("institutional signal candidate ids must be unique");
  }
  return {
    schema_version: LAND_PREDICTION_INSTITUTIONAL_SIGNAL_REGISTRY_VERSION,
    queue: "research",
    production_admission: "not_admitted",
    candidates,
  };
}

/** Validate a research queue without admitting any candidate to prediction. */
export function validateLandPredictionInstitutionalSignalRegistry(registry) {
  return normalizeRegistry(registry);
}

/** Build a deterministic research-only candidate registry. */
export function buildLandPredictionInstitutionalSignalRegistry(input = {}) {
  assertPlainObject(input, "institutional signal registry input");
  return normalizeRegistry({
    schema_version: LAND_PREDICTION_INSTITUTIONAL_SIGNAL_REGISTRY_VERSION,
    queue: "research",
    production_admission: "not_admitted",
    candidates: input.candidates ?? [],
  });
}

/** Append a candidate while preserving every existing, including rejected, record. */
export function addLandPredictionInstitutionalSignal(registry, candidate) {
  const current = validateLandPredictionInstitutionalSignalRegistry(registry);
  return buildLandPredictionInstitutionalSignalRegistry({
    candidates: [...current.candidates, candidate],
  });
}

/** Change only a candidate's research status; records are never removed. */
export function updateLandPredictionInstitutionalSignalStatus(registry, candidateId, status, evidence = {}) {
  const current = validateLandPredictionInstitutionalSignalRegistry(registry);
  const id = requiredText(candidateId, "candidateId");
  const nextStatus = requiredText(status, "status").toLowerCase();
  if (!INSTITUTIONAL_SIGNAL_STATUSES.includes(nextStatus)) {
    throw new TypeError(`unsupported institutional signal status: ${status}`);
  }
  if (!current.candidates.some((candidate) => candidate.id === id)) {
    throw new RangeError(`unknown institutional signal candidate: ${id}`);
  }
  const existing = current.candidates.find((candidate) => candidate.id === id);
  if (["promoted", "rejected"].includes(existing.status) && existing.status !== nextStatus) {
    throw new TypeError(`${existing.status} candidate status is terminal`);
  }
  const candidates = current.candidates.map((candidate) => {
    if (candidate.id !== id) return candidate;
    const next = { ...candidate, status: nextStatus };
    if (nextStatus === "promoted") next.promotion_evidence = evidence;
    if (nextStatus === "rejected") next.rejection_rationale = evidence;
    if (nextStatus !== "promoted") next.promotion_evidence = null;
    if (nextStatus !== "rejected") next.rejection_rationale = null;
    return next;
  });
  return buildLandPredictionInstitutionalSignalRegistry({ candidates });
}

/** The initial hypothesis from Card 7, quarantined as a proposed candidate. */
export const MEMBER_DEFERENCE_CANDIDATE = deepFreeze({
  id: "member-deference-land-use",
  formal_actor_process: "New York City Council disposition through the Land Use Committee and Council process",
  candidate_practical_actor: "The local Council member representing the application's district at prediction_as_of",
  claimed_mechanism: "Other Council members may defer to the local member's project-specific position on a land-use application.",
  relevant_stage: ["council_land_use_committee", "council_disposition"],
  possible_evidence_sources: [
    "Project-specific Council member statements, hearing remarks, and requested modifications",
    "City Council and Land Use Committee actions and disposition records",
    "Time-based held-out application outcomes with formal-process feature ablations",
    "Evidence of negotiations, constituency response, concessions, and project viability available to the member",
  ],
  rival_explanation: [
    "H2 — information/sensor mechanism: the member's position predicts outcomes because the member observes negotiations, constituency response, applicant concessions, and project viability that CityScroll does not otherwise observe.",
  ],
  falsifier: [
    "After controlling for available formal-process signals, the member stance provides no useful out-of-sample lift in held-out historical applications.",
    "Stance evidence becomes available only after the forecast stage, leaving no meaningful early forecasting value.",
  ],
  status: "proposed",
  promotion_evidence: null,
  rejection_rationale: null,
});

export const LAND_PREDICTION_INSTITUTIONAL_SIGNAL_REGISTRY = deepFreeze(
  buildLandPredictionInstitutionalSignalRegistry({
    candidates: [MEMBER_DEFERENCE_CANDIDATE],
  }),
);

export const LAND_INSTITUTIONAL_SIGNAL_REGISTRY = LAND_PREDICTION_INSTITUTIONAL_SIGNAL_REGISTRY;
