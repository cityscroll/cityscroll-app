/**
 * Pure publication boundary from frozen comparative facts to story signals.
 *
 * Admission uses closed metric-family policies. Held decisions retain private
 * gate detail, while the public projector returns only published signals.
 */

import { COMPARATIVE_FACT_SCHEMA } from "./comparative_receipt.mjs";

export const SIGNAL_ADMISSION_SCHEMA = "cityscroll.comparative_signal_admission.v1";
export const STORY_SIGNAL_SCHEMA = "cityscroll.story_signal.v1";
export const STORY_SIGNAL_READ_MODEL_SCHEMA = "cityscroll.story_signal_read_model.v1";
export const SIGNAL_ADMISSION_METHOD = "comparative_signal_admission_v1";
export const STORY_SIGNAL_READ_MODEL_METHOD = "published_comparative_story_signals_v1";
export const COMPARATIVE_FACT_REFERENCE_SCHEMA = "cityscroll.comparative_fact_reference.v1";

export const SIGNAL_STATES = Object.freeze([
  "eligible",
  "published",
  "held_coverage",
  "held_small_n",
  "held_mnar",
  "held_freshness",
  "held_join",
  "held_semantics",
]);

const DAY_MS = 86_400_000;

const NEGATIVE_INFERENCE_PREDICATES = Object.freeze([
  "vehicle_in_covered_sources",
  "acquisition_current",
  "historical_window_exhaustive",
  "forward_window_exhaustive",
  "window_mature",
  "original_identity_exact",
  "detector_precision_clears_gate",
  "detector_recall_clears_gate",
  "selection_factors_equivalent",
  "alternative_paths_covered",
  "source_complete",
  "not_right_censored",
]);

const POLICIES = Object.freeze({
  award_amount_rank: Object.freeze({
    method: "source_bounded_award_amount_rank_v1",
    sourceContractId: "ocp-recent-contract-awards",
    basis: "bounded_complete",
    minimumPeers: 10,
    maximumPublishedRank: 5,
    maximumVintageLagDays: 2,
    identityGate: "unique_request_id_and_reviewed_agency_identity",
    joinPath: "not_applicable",
    polarity: "positive",
  }),
  successor_solicitation_absence: Object.freeze({
    method: "successor_solicitation_absence_v1",
    sourceContractId: "passport-current-solicitations",
    basis: "derived_join",
    minimumPeers: 1,
    maximumVintageLagDays: 2,
    polarity: "negative",
  }),
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function finiteInteger(value, minimum = 0) {
  return Number.isInteger(value) && value >= minimum;
}

function instant(value) {
  const parsed = Date.parse(clean(value, 80));
  return Number.isFinite(parsed) ? parsed : null;
}

function day(value) {
  const normalized = clean(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const parsed = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== normalized
    ? null
    : normalized;
}

function admissionBase(fact) {
  return {
    schema: SIGNAL_ADMISSION_SCHEMA,
    method: SIGNAL_ADMISSION_METHOD,
    fact_id: clean(fact?.fact_id, 500) || null,
    metric_id: clean(fact?.metric?.id, 120) || null,
  };
}

function held(fact, state, gateId, failedPredicates) {
  return deepFreeze({
    ...admissionBase(fact),
    state,
    public_signal: null,
    backstage: {
      gate_id: gateId,
      failed_predicates: [...new Set(failedPredicates)].sort(),
    },
  });
}

function structuralFailures(fact, policy) {
  const failures = [];
  if (fact?.schema !== COMPARATIVE_FACT_SCHEMA) failures.push("comparative_fact_schema");
  if (!clean(fact?.fact_id)) failures.push("fact_id");
  if (!policy) failures.push("registered_metric_policy");
  if (policy && fact?.metric?.method !== policy.method) failures.push("reproducible_metric_method");
  if (!Number.isFinite(fact?.value)) failures.push("finite_metric_value");
  if (!day(fact?.comparison?.window?.start) || !day(fact?.comparison?.window?.end)) {
    failures.push("defined_comparison_window");
  }
  if (!fact?.comparison?.population || typeof fact.comparison.population !== "object") {
    failures.push("defined_comparison_population");
  }
  if (!instant(fact?.generated_at)) failures.push("generated_at");
  return failures;
}

function coverageFailures(fact, policy) {
  const failures = [];
  const peer = fact.peer_class || {};
  const equivalence = peer.observability_equivalence || {};
  const observation = fact.observation || {};
  const comparison = fact.comparison || {};
  const eligible = comparison.eligible_count;
  const observed = comparison.observed_count;
  if (observation.basis !== policy.basis || equivalence.basis !== policy.basis) {
    failures.push("observation_basis");
  }
  if (!finiteInteger(eligible) || !finiteInteger(observed) || observed > eligible) {
    failures.push("eligible_observed_accounting");
  }
  if (peer.eligible_count !== eligible || peer.observed_count !== observed) {
    failures.push("peer_accounting_matches_fact");
  }
  if (observation.eligible_count !== eligible || observation.observed_count !== observed) {
    failures.push("observation_accounting_matches_fact");
  }
  if (!Array.isArray(observation.source_vintages) || observation.source_vintages.length === 0) {
    failures.push("source_vintages");
  }
  if (!Array.isArray(equivalence.source_contract_versions)
    || equivalence.source_contract_versions.length === 0) {
    failures.push("source_contract_versions");
  }
  if (JSON.stringify(observation.source_vintages) !== JSON.stringify(equivalence.source_vintages)) {
    failures.push("equivalent_source_vintages");
  }
  if (policy.polarity === "positive" && eligible !== observed) {
    failures.push("complete_positive_observation");
  }
  if (policy.polarity === "positive"
    && clean(peer.source_family) !== policy.sourceContractId) {
    failures.push("covered_source_family");
  }
  return failures;
}

function freshnessFailures(fact, policy) {
  const failures = [];
  const generatedAt = instant(fact.generated_at);
  const vintages = fact.observation?.source_vintages || [];
  for (const vintage of vintages) {
    const materializedAt = instant(vintage?.materialized_at);
    if (materializedAt == null || generatedAt == null) {
      failures.push("valid_source_vintage");
      continue;
    }
    const lagDays = (generatedAt - materializedAt) / DAY_MS;
    if (lagDays < 0 || lagDays > policy.maximumVintageLagDays) {
      failures.push("source_within_freshness_window");
    }
  }
  return failures;
}

function joinFailures(fact, policy) {
  const failures = [];
  const subject = fact.subject || {};
  const equivalence = fact.peer_class?.observability_equivalence || {};
  if (!clean(subject.id) || !clean(subject.ref) || !clean(subject.type) || !clean(subject.label)) {
    failures.push("grounded_subject");
  }
  if (!Array.isArray(fact.evidence) || fact.evidence.length === 0) {
    failures.push("retained_evidence");
  } else if (!fact.evidence.some((item) => (
    clean(item?.source_contract_id)
    && clean(item?.source_row_id)
    && /^https:\/\//.test(clean(item?.landing_page))
  ))) {
    failures.push("grounded_evidence");
  }
  if (policy.polarity === "positive") {
    if (equivalence.identity_gate !== policy.identityGate) failures.push("subject_identity_gate");
    if (equivalence.join_path !== policy.joinPath) failures.push("required_join_gate");
    if (fact.provenance?.source_contract?.id !== policy.sourceContractId) {
      failures.push("source_contract_join");
    }
    if (!fact.evidence.some((item) => (
      clean(item?.source_contract_id) === policy.sourceContractId
      && clean(item?.source_row_id) === clean(subject.id)
    ))) {
      failures.push("subject_evidence_join");
    }
  }
  return failures;
}

function mnarFailures(fact, policy) {
  if (policy.polarity !== "negative") return [];
  const contract = fact.observation?.negative_inference_contract || {};
  const failures = NEGATIVE_INFERENCE_PREDICATES.filter((predicate) => contract[predicate] !== true);
  if (fact.observation?.negative_inference !== "allowed") failures.push("negative_inference_allowed");
  return failures;
}

function smallNFailures(fact, policy) {
  return fact.comparison.eligible_count < policy.minimumPeers
    ? ["family_minimum_peer_count"]
    : [];
}

function semanticFailures(fact, policy) {
  const failures = [];
  const comparison = fact.comparison;
  if (fact.data_cleaning_artifact === true || fact.provenance?.data_cleaning_artifact === true) {
    failures.push("not_data_cleaning_artifact");
  }
  if (policy.polarity === "positive") {
    if (!(fact.value > 0)) failures.push("positive_award_amount");
    if (!finiteInteger(comparison.rank, 1) || comparison.rank > comparison.observed_count) {
      failures.push("valid_rank");
    }
    if (comparison.rank > policy.maximumPublishedRank) failures.push("meaningful_award_rank");
    if (!clean(comparison.population?.agency_name)) failures.push("population_label");
    if (fact.peer_class?.observability_equivalence?.observation_quality_class
      !== "source_bounded_positive_observation") {
      failures.push("comparable_observation_conditions");
    }
  }
  return failures;
}

function ordinal(value) {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  return `${value}${value % 10 === 1 ? "st" : value % 10 === 2 ? "nd" : value % 10 === 3 ? "rd" : "th"}`;
}

function money(value) {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

const MONTHS = Object.freeze([
  "Jan.", "Feb.", "March", "April", "May", "June",
  "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec.",
]);

function dateLabel(value) {
  const [year, month, date] = value.split("-").map(Number);
  return `${MONTHS[month - 1]} ${date}, ${year}`;
}

function basisSentence(fact, policy) {
  if (fact.metric.id === "award_amount_rank") {
    return `This ${money(fact.value)} award is ${ordinal(fact.comparison.rank)}-largest among ${fact.comparison.observed_count} ${clean(fact.comparison.population.agency_name)} award rows observed in the OCP snapshot from ${dateLabel(fact.comparison.window.start)} through ${dateLabel(fact.comparison.window.end)}.`;
  }
  if (policy.polarity === "negative") {
    return `No successor solicitation was observed for ${clean(fact.subject.label)} in the exhaustive ${dateLabel(fact.comparison.window.start)} through ${dateLabel(fact.comparison.window.end)} window.`;
  }
  return null;
}

function storySignal(fact, sentence) {
  const evidence = fact.evidence.map((item) => ({
    kind: clean(item.kind, 80),
    source_contract_id: clean(item.source_contract_id, 160),
    source_row_id: clean(item.source_row_id, 200),
    href: clean(item.landing_page, 500),
  }));
  return deepFreeze({
    schema: STORY_SIGNAL_SCHEMA,
    signal_id: `story_signal:${fact.fact_id}`,
    fact_id: fact.fact_id,
    subject: {
      type: fact.subject.type,
      id: fact.subject.id,
      ref: fact.subject.ref,
      label: fact.subject.label,
    },
    metric: {
      id: fact.metric.id,
      family: fact.metric.family,
      unit: fact.metric.unit,
    },
    value: fact.value,
    basis_sentence: sentence,
    comparison: {
      population: {
        object_type: clean(fact.comparison.population.object_type, 80),
        source_family: clean(fact.comparison.population.source_family, 160),
        agency_id: clean(fact.comparison.population.agency_id, 160) || null,
        agency_name: clean(fact.comparison.population.agency_name, 200) || null,
      },
      eligible_count: fact.comparison.eligible_count,
      observed_count: fact.comparison.observed_count,
      window: { ...fact.comparison.window },
      rank: fact.comparison.rank,
    },
    comparison_receipt: {
      schema: COMPARATIVE_FACT_REFERENCE_SCHEMA,
      receipt_schema: fact.schema,
      receipt_id: fact.fact_id,
      metric_method: fact.metric.method,
      peer_basis: {
        class_id: fact.peer_class.class_id,
        observability_basis: fact.peer_class.observability_equivalence.basis,
        source_contract_versions: [...fact.peer_class.observability_equivalence.source_contract_versions],
        source_vintages: fact.peer_class.observability_equivalence.source_vintages.map((item) => ({ ...item })),
        inclusion_rule: fact.peer_class.observability_equivalence.inclusion_rule,
        identity_gate: fact.peer_class.observability_equivalence.identity_gate,
        observation_quality_class: fact.peer_class.observability_equivalence.observation_quality_class,
        censoring_class: fact.peer_class.observability_equivalence.censoring_class,
        selected_level: fact.peer_class.selected_level,
        small_n_policy_id: fact.peer_class.small_n_policy_id,
      },
      generated_at: fact.generated_at,
    },
    evidence,
    generated_at: fact.generated_at,
  });
}

/** Evaluate one materialized fact in a deterministic, fail-closed gate order. */
export function admitComparativeFact(fact, { materialize = true } = {}) {
  const policy = POLICIES[fact?.metric?.id] || null;
  const structural = structuralFailures(fact, policy);
  if (structural.length) return held(fact, "held_semantics", "receipt_contract", structural);

  const coverage = coverageFailures(fact, policy);
  if (coverage.length) return held(fact, "held_coverage", "coverage", coverage);

  const freshness = freshnessFailures(fact, policy);
  if (freshness.length) return held(fact, "held_freshness", "freshness", freshness);

  const joins = joinFailures(fact, policy);
  if (joins.length) return held(fact, "held_join", "join", joins);

  const mnar = mnarFailures(fact, policy);
  if (mnar.length) return held(fact, "held_mnar", "negative_inference", mnar);

  const smallN = smallNFailures(fact, policy);
  if (smallN.length) return held(fact, "held_small_n", "small_n", smallN);

  const semantics = semanticFailures(fact, policy);
  const sentence = semantics.length ? null : basisSentence(fact, policy);
  if (!sentence) semantics.push("deterministic_headline");
  if (semantics.length) return held(fact, "held_semantics", "semantics", semantics);

  const publicSignal = materialize ? storySignal(fact, sentence) : null;
  return deepFreeze({
    ...admissionBase(fact),
    state: materialize ? "published" : "eligible",
    public_signal: publicSignal,
    backstage: {
      gate_id: materialize ? "materialized" : "eligible",
      failed_predicates: [],
    },
  });
}

/** Held and merely eligible decisions have no resident-facing representation. */
export function projectPublishedStorySignal(admission) {
  return admission?.state === "published" && admission.public_signal?.schema === STORY_SIGNAL_SCHEMA
    ? admission.public_signal
    : null;
}

/** Build a public-only materialization; backstage admission records never enter it. */
export function buildPublishedStorySignalReadModel(facts = []) {
  const orderedFacts = (Array.isArray(facts) ? facts : [])
    .slice()
    .sort((left, right) => clean(left?.fact_id).localeCompare(clean(right?.fact_id)));
  const signals = orderedFacts
    .map((fact) => projectPublishedStorySignal(admitComparativeFact(fact)))
    .filter(Boolean)
    .sort((left, right) => left.signal_id.localeCompare(right.signal_id));
  const generatedAt = orderedFacts
    .map((fact) => clean(fact?.generated_at, 80))
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  return deepFreeze({
    schema: STORY_SIGNAL_READ_MODEL_SCHEMA,
    method: STORY_SIGNAL_READ_MODEL_METHOD,
    generated_at: generatedAt,
    signals,
  });
}
