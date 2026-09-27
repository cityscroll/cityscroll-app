/**
 * Fixed-dossier temporal observations and deterministic materialization.
 *
 * These inputs are the bounded commissioning dossier plus already-retained
 * source judgments. This module performs no discovery or publisher fetches.
 */

import { createHash } from "node:crypto";

import {
  CONNECTED_HISTORY_CHANGE_KINDS,
  CONNECTED_HISTORY_TIME_CASE_FAMILY,
  CONNECTED_HISTORY_TIME_COMPARISON_SCHEMA,
  CONNECTED_HISTORY_TIME_METHOD,
  CONNECTED_HISTORY_TIME_STATE_SCHEMA,
  CONNECTED_HISTORY_TIME_VERSION,
  compareConnectedHistoryStates,
  normalizeConnectedHistoryObservation,
  orderConnectedHistoryEntries,
  projectConnectedHistoryStateAsOf,
} from "../../site/connected_history_time.mjs";

export const CONNECTED_HISTORY_TIME_ARTIFACT_SCHEMA =
  "cityscroll.connected_history_time_artifact.v1";
export const CONNECTED_HISTORY_TIME_RECEIPT_SCHEMA =
  "cityscroll.connected_history_time_receipt.v1";

export const CONNECTED_HISTORY_TIME_GENERATED_AT = "2026-09-26T00:00:00.000Z";
export const CONNECTED_HISTORY_TIME_SOURCE_POLICY =
  "fixed-six-case-dossier-and-retained-inputs-only";
export const CONNECTED_HISTORY_TIME_DOSSIER_FAMILIES = Object.freeze([
  "coyle",
  "franklin-avenue",
  "kingsbridge-armory",
  "sixth-avenue",
  "thirty-first-avenue",
  "lighthouse-point",
]);

const observed = CONNECTED_HISTORY_TIME_GENERATED_AT;

function source(sourceSystem, sourceRecordId, locator, quote) {
  return Object.freeze({
    judgment_basis: "fixed_dossier_source_judgment",
    source_system: sourceSystem,
    source_record_id: sourceRecordId,
    source_span: Object.freeze({ locator, quote }),
  });
}

function fact({
  observation_id,
  family_id,
  history_family,
  subject_ref,
  assertion_key,
  comparison_key = assertion_key,
  fact_kind,
  event_class,
  lifecycle_action,
  event_time,
  publication_time = null,
  value,
  scope = {},
  preliminary = false,
  source_judgment,
}) {
  return Object.freeze({
    case_family: CONNECTED_HISTORY_TIME_CASE_FAMILY,
    observation_id,
    family_id,
    history_family,
    subject_ref,
    assertion_key,
    comparison_key,
    fact_kind,
    event_class,
    change_kind: "civic_event",
    lifecycle_action,
    event_time: Object.freeze(event_time),
    publication_time: publication_time ? Object.freeze(publication_time) : null,
    observed_at: observed,
    value: Object.freeze(value),
    scope: Object.freeze(scope),
    preliminary,
    source_judgment,
  });
}

/**
 * Dated facts required by the acceptance contract. The intentionally non-chronological input
 * order exercises the ordering implementation rather than pre-sorting data.
 */
export const CONNECTED_HISTORY_TIME_OBSERVATIONS = Object.freeze([
  fact({
    observation_id: "franklin-later-proposal-2024",
    family_id: "franklin-avenue",
    history_family: "land_application_history",
    subject_ref: "land:application:C230356ZMK",
    assertion_key: "later-application-proposal",
    fact_kind: "proposal_epoch",
    event_class: "planned",
    lifecycle_action: "proposed",
    event_time: { value: "2024", precision: "year" },
    value: { application_ids: ["C230356ZMK", "N230357(A)ZRK", "C230358ZSK"], identity_merged: false },
    scope: { footprint: "brooklyn-1192-63-and-66", phase: "later-application" },
    source_judgment: source(
      "zap-project-action-report",
      "zap:document:230356-official-report",
      "official_report_later_applications",
      "C230356ZMK and N230357(A)ZRK",
    ),
  }),
  fact({
    observation_id: "franklin-earlier-proposal-2021",
    family_id: "franklin-avenue",
    history_family: "land_application_history",
    subject_ref: "land:application:C200184ZMK",
    assertion_key: "earlier-application-proposal",
    fact_kind: "proposal_epoch",
    event_class: "planned",
    lifecycle_action: "proposed",
    event_time: { value: "2021", precision: "year" },
    value: { application_ids: ["C200184ZMK", "N200185ZRK", "C200186ZSK", "C200187ZSK"], identity_merged: false },
    scope: { footprint: "960-franklin-avenue", phase: "earlier-application" },
    source_judgment: source(
      "zap-project-action-report",
      "zap:document:230356-official-report",
      "official_report_predecessor_applications",
      "C200184ZMK",
    ),
  }),
  fact({
    observation_id: "franklin-earlier-withdrawal-2021",
    family_id: "franklin-avenue",
    history_family: "land_application_history",
    subject_ref: "land:application:C200184ZMK",
    assertion_key: "earlier-application-disposition",
    fact_kind: "disposition",
    event_class: "decided",
    lifecycle_action: "withdrawn",
    event_time: { value: "2021", precision: "year" },
    value: { disposition: "withdrawn", applies_to: "earlier-application-only" },
    scope: { footprint: "960-franklin-avenue", phase: "earlier-application" },
    source_judgment: source(
      "zap-project-action-report",
      "zap:document:230356-official-report",
      "official_report_predecessor_disposition",
      "earlier 960 Franklin applications",
    ),
  }),
  fact({
    observation_id: "franklin-later-amendment-2024",
    family_id: "franklin-avenue",
    history_family: "land_application_history",
    subject_ref: "land:application:N230357(A)ZRK",
    assertion_key: "later-application-amendment",
    fact_kind: "application_version",
    event_class: "planned",
    lifecycle_action: "amended",
    event_time: { value: "2024", precision: "year" },
    value: { application_id: "N230357(A)ZRK", amended: true, identity_merged: false },
    scope: { footprint: "brooklyn-1192-63-and-66", phase: "later-application" },
    source_judgment: source(
      "zap-project-action-report",
      "zap:document:230356-official-report",
      "official_report_amended_application",
      "N230357(A)ZRK",
    ),
  }),

  fact({
    observation_id: "kingsbridge-redevelopment-2025",
    family_id: "kingsbridge-armory",
    history_family: "environmental_review_history",
    subject_ref: "ceqr:25DME006X",
    assertion_key: "redevelopment-proposal-epoch",
    fact_kind: "proposal_epoch",
    event_class: "planned",
    lifecycle_action: "proposed",
    event_time: { value: "2025", precision: "year" },
    value: { ceqr_id: "25DME006X", project_id: "2025X0262", proposal: "redevelopment" },
    scope: { footprint: "bronx-3247-10-and-2", phase: "2025-redevelopment" },
    source_judgment: source("ceqr", "ceqr:25DME006X", "ceqr_access_details", "25DME006X"),
  }),
  fact({
    observation_id: "kingsbridge-retail-2009",
    family_id: "kingsbridge-armory",
    history_family: "environmental_review_history",
    subject_ref: "ceqr:08DME004X",
    assertion_key: "retail-proposal-epoch",
    fact_kind: "proposal_epoch",
    event_class: "planned",
    lifecycle_action: "proposed",
    event_time: { value: "2009", precision: "year" },
    value: { ceqr_id: "08DME004X", proposal: "retail" },
    scope: { footprint: "kingsbridge-armory", phase: "2009-retail" },
    source_judgment: source("ceqr", "ceqr:13DME013X", "successive_proposal_reference", "08DME004X"),
  }),
  fact({
    observation_id: "kingsbridge-ice-center-2013",
    family_id: "kingsbridge-armory",
    history_family: "environmental_review_history",
    subject_ref: "ceqr:13DME013X",
    assertion_key: "ice-center-proposal-epoch",
    fact_kind: "proposal_epoch",
    event_class: "planned",
    lifecycle_action: "proposed",
    event_time: { value: "2013", precision: "year" },
    value: { ceqr_id: "13DME013X", proposal: "ice-center" },
    scope: { footprint: "kingsbridge-armory", phase: "2013-ice-center" },
    source_judgment: source("ceqr", "ceqr:13DME013X", "oec_environmental_quality_review_page", "13DME013X"),
  }),
  fact({
    observation_id: "kingsbridge-operation-forecast-2018",
    family_id: "kingsbridge-armory",
    history_family: "environmental_review_history",
    subject_ref: "ceqr:13DME013X",
    assertion_key: "ice-center-operation-forecast",
    fact_kind: "forecast",
    event_class: "planned",
    lifecycle_action: "forecast",
    event_time: { value: "2013", precision: "year" },
    value: { expected_operation: { value: "2018", precision: "year" }, realized: false },
    scope: { footprint: "kingsbridge-armory", phase: "2013-ice-center" },
    source_judgment: source(
      "ceqr",
      "ceqr:13DME013X",
      "anticipated_operation_forecast",
      "2018 forecast, not an opening",
    ),
  }),

  fact({
    observation_id: "lighthouse-first-phase-opening-2025",
    family_id: "lighthouse-point",
    history_family: "component_phase_history",
    subject_ref: "edc:opening:lighthouse-point-phase-1-2025-06-05",
    assertion_key: "phase-1-residential-opening",
    fact_kind: "component_status",
    event_class: "realized",
    lifecycle_action: "opened",
    event_time: { value: "2025-06-05", precision: "day" },
    publication_time: { value: "2025-06-05", precision: "day" },
    value: { status: "opened", units: 115, closes_parent_project: false },
    scope: { footprint: "lighthouse-point", metric: "housing-units", phase: "phase-1-residential", population: "residential-units", unit: "units" },
    source_judgment: source(
      "edc-press-release",
      "edc:press-release:lighthouse-point-opening-2025-06-05",
      "opening_announcement_first_residential_phase",
      "first residential phase with 115 units",
    ),
  }),
  fact({
    observation_id: "lighthouse-plan-2014",
    family_id: "lighthouse-point",
    history_family: "component_phase_history",
    subject_ref: "edc:project:lighthouse-point",
    assertion_key: "historical-component-plan",
    fact_kind: "component_plan",
    event_class: "planned",
    lifecycle_action: "proposed",
    event_time: { value: "2014", precision: "year" },
    value: { basis: "2014 lease", status: "planned-components" },
    scope: { footprint: "lighthouse-point", phase: "whole-plan" },
    source_judgment: source("edc", "edc:project:lighthouse-point", "lease_and_planned_components", "2014 lease and planned components"),
  }),
  fact({
    observation_id: "lighthouse-future-phase-2025",
    family_id: "lighthouse-point",
    history_family: "component_phase_history",
    subject_ref: "edc:phase:lighthouse-point-phase-2",
    assertion_key: "phase-2-future-status",
    fact_kind: "component_status",
    event_class: "planned",
    lifecycle_action: "proposed",
    event_time: { value: "2025-06-05", precision: "day" },
    publication_time: { value: "2025-06-05", precision: "day" },
    value: { status: "future", opened: false },
    scope: { footprint: "lighthouse-point", phase: "phase-2" },
    source_judgment: source(
      "edc-press-release",
      "edc:press-release:lighthouse-point-opening-2025-06-05",
      "opening_announcement_future_phase",
      "Phase 2 remains future",
    ),
  }),

  fact({
    observation_id: "thirty-first-avenue-phase-ii-2026",
    family_id: "thirty-first-avenue",
    history_family: "corridor_measurement_history",
    subject_ref: "dot:phase:31st-avenue-phase-ii",
    assertion_key: "phase-ii-proposal",
    fact_kind: "phase_status",
    event_class: "planned",
    lifecycle_action: "proposed",
    event_time: { value: "2026-05", precision: "month" },
    publication_time: { value: "2026-05", precision: "month" },
    value: { status: "proposal", phase: "phase-ii" },
    scope: { footprint: "vernon-boulevard-to-51st-street", phase: "phase-ii" },
    source_judgment: source(
      "dot-project-materials",
      "dot:31-ave-phase-ii-steinway-st-51-st-may2026-2.pdf",
      "phase_ii_materials_title",
      "31st Avenue Phase II",
    ),
  }),
  fact({
    observation_id: "thirty-first-avenue-preliminary-period-2024",
    family_id: "thirty-first-avenue",
    history_family: "corridor_measurement_history",
    subject_ref: "dot:phase:31st-avenue-phase-i",
    assertion_key: "phase-i-preliminary-measurement",
    fact_kind: "measurement_period",
    event_class: "realized",
    lifecycle_action: "measured",
    event_time: { value: "2024", precision: "year" },
    value: { status: "preliminary", result: "before-and-after-observations", numeric_value_published: false },
    scope: {
      footprint: "vernon-boulevard-to-51st-street",
      metric: "preliminary-before-after-observations",
      phase: "phase-i",
      population: "not-published",
      unit: "not-published",
      measurement_period: "2024",
    },
    preliminary: true,
    source_judgment: source(
      "dot-project-materials",
      "dot:31-ave-phase-ii-steinway-st-51-st-may2026-2.pdf",
      "phase_i_implementation_period",
      "preliminary before/after observations; measurement period 2024",
    ),
  }),
]);

export const CONNECTED_HISTORY_TIME_QUERY_JUDGMENTS = Object.freeze([
  Object.freeze({
    id: "franklin-proposal-epochs",
    family_id: "franklin-avenue",
    before_civic_time: "2021-12-31",
    after_civic_time: "2024-12-31",
    belief_time: observed,
    expected_before: Object.freeze([
      "franklin-earlier-proposal-2021",
      "franklin-earlier-withdrawal-2021",
    ]),
    expected_after: Object.freeze([
      "franklin-earlier-proposal-2021",
      "franklin-earlier-withdrawal-2021",
      "franklin-later-amendment-2024",
      "franklin-later-proposal-2024",
    ]),
    forbidden_after: Object.freeze([]),
    negative_assertion: "The earlier and later application identifiers remain separate.",
  }),
  Object.freeze({
    id: "kingsbridge-proposal-epochs",
    family_id: "kingsbridge-armory",
    before_civic_time: "2013-12-31",
    after_civic_time: "2025-12-31",
    belief_time: observed,
    expected_before: Object.freeze([
      "kingsbridge-retail-2009",
      "kingsbridge-ice-center-2013",
      "kingsbridge-operation-forecast-2018",
    ]),
    expected_after: Object.freeze([
      "kingsbridge-retail-2009",
      "kingsbridge-ice-center-2013",
      "kingsbridge-operation-forecast-2018",
      "kingsbridge-redevelopment-2025",
    ]),
    forbidden_after: Object.freeze([]),
    negative_assertion: "The expected 2018 operation remains a forecast, never an opening.",
  }),
  Object.freeze({
    id: "lighthouse-component-status",
    family_id: "lighthouse-point",
    before_civic_time: "2014-12-31",
    after_civic_time: "2025-12-31",
    belief_time: observed,
    expected_before: Object.freeze(["lighthouse-plan-2014"]),
    expected_after: Object.freeze([
      "lighthouse-plan-2014",
      "lighthouse-first-phase-opening-2025",
      "lighthouse-future-phase-2025",
    ]),
    forbidden_after: Object.freeze([]),
    negative_assertion: "Opening Phase 1 does not mark Phase 2 or the parent project complete.",
  }),
  Object.freeze({
    id: "thirty-first-avenue-periods",
    family_id: "thirty-first-avenue",
    before_civic_time: "2024-12-31",
    after_civic_time: "2026-12-31",
    belief_time: observed,
    expected_before: Object.freeze(["thirty-first-avenue-preliminary-period-2024"]),
    expected_after: Object.freeze([
      "thirty-first-avenue-preliminary-period-2024",
      "thirty-first-avenue-phase-ii-2026",
    ]),
    forbidden_after: Object.freeze([]),
    negative_assertion: "Preliminary Phase I measurements remain distinct from the Phase II proposal.",
  }),
]);

function idList(state) {
  return state.entries.map((entry) => entry.observation_id).sort();
}

/** Check a module-produced state against an independent fixed-dossier judgment. */
export function checkConnectedHistorySourceJudgment(pair, judgment) {
  const errors = [];
  const before = new Set(idList(pair.before));
  const after = new Set(idList(pair.after));
  for (const id of judgment.expected_before) {
    if (!before.has(id)) errors.push(`missing_before:${judgment.id}:${id}`);
  }
  for (const id of judgment.expected_after) {
    if (!after.has(id)) errors.push(`missing_after:${judgment.id}:${id}`);
  }
  for (const id of judgment.forbidden_after) {
    if (after.has(id)) errors.push(`forbidden_after:${judgment.id}:${id}`);
  }
  if (before.size !== judgment.expected_before.length) {
    errors.push(`unexpected_before_count:${judgment.id}`);
  }
  if (after.size !== judgment.expected_after.length) {
    errors.push(`unexpected_after_count:${judgment.id}`);
  }
  return errors;
}

function hashOf(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Census retained change kinds and numeric facts so an empty stratum is a
 * recorded zero rather than an omitted key.
 */
export function reportConnectedHistoryTimeKindPopulation(observations = []) {
  const change_kind_population = Object.fromEntries(
    CONNECTED_HISTORY_CHANGE_KINDS.map((kind) => [kind, 0]),
  );
  const fact_kind_population = {};
  let numeric_observation_population = 0;
  for (const row of observations) {
    const changeKind = row?.change_kind;
    if (Object.hasOwn(change_kind_population, changeKind)) {
      change_kind_population[changeKind] += 1;
    }
    const factKind = row?.fact_kind;
    if (factKind) {
      fact_kind_population[factKind] = (fact_kind_population[factKind] || 0) + 1;
    }
    if (typeof row?.numeric_value === "number" && Number.isFinite(row.numeric_value)) {
      numeric_observation_population += 1;
    }
  }
  const sortedFactKinds = Object.fromEntries(
    Object.entries(fact_kind_population).sort(([left], [right]) => left.localeCompare(right)),
  );
  const unrepresented_fact_kinds = [
    ...CONNECTED_HISTORY_CHANGE_KINDS
      .filter((kind) => change_kind_population[kind] === 0)
      .map((kind) => ({ kind, population: 0 })),
  ];
  if (numeric_observation_population === 0) {
    unrepresented_fact_kinds.push({ kind: "numeric", population: 0 });
  }
  unrepresented_fact_kinds.sort((left, right) => left.kind.localeCompare(right.kind));
  return {
    change_kind_population,
    fact_kind_population: sortedFactKinds,
    numeric_observation_population,
    unrepresented_fact_kinds,
  };
}

function buildPair(observations, judgment) {
  const before = projectConnectedHistoryStateAsOf(observations, {
    familyId: judgment.family_id,
    civicTime: judgment.before_civic_time,
    beliefTime: judgment.belief_time,
  });
  const after = projectConnectedHistoryStateAsOf(observations, {
    familyId: judgment.family_id,
    civicTime: judgment.after_civic_time,
    beliefTime: judgment.belief_time,
  });
  return {
    id: judgment.id,
    evidence_class: "module_oracle",
    source_judgment: {
      basis: "fixed_dossier_source_judgment",
      expected_before: [...judgment.expected_before],
      expected_after: [...judgment.expected_after],
      forbidden_after: [...judgment.forbidden_after],
      negative_assertion: judgment.negative_assertion,
    },
    before,
    after,
    comparison: compareConnectedHistoryStates(before, after),
  };
}

export function buildConnectedHistoryTimeArtifact() {
  const observations = CONNECTED_HISTORY_TIME_OBSERVATIONS.map(normalizeConnectedHistoryObservation);
  const query_pairs = CONNECTED_HISTORY_TIME_QUERY_JUDGMENTS.map((judgment) =>
    buildPair(observations, judgment));
  const observedFamilyIds = new Set(observations.map((row) => row.family_id));
  const dossier_outcomes = CONNECTED_HISTORY_TIME_DOSSIER_FAMILIES.map((family_id) => ({
    family_id,
    temporal_observations: observations.filter((row) => row.family_id === family_id).length,
    outcome: observedFamilyIds.has(family_id)
      ? "retained_temporal_facts"
      : "insufficient_retained_temporal_evidence_for_this_comparison",
    substitute_family_used: false,
  }));

  const ordering_controls = [...observedFamilyIds].sort().map((family_id) => {
    const familyRows = observations.filter((row) => row.family_id === family_id);
    const forward = orderConnectedHistoryEntries(familyRows);
    const converse = orderConnectedHistoryEntries([...familyRows].reverse());
    return {
      family_id,
      evidence_class: "module_oracle",
      intermediate_state_observed: forward.receipt.intermediate_steps.length > 1,
      forward: forward.receipt,
      converse: converse.receipt,
      outputs_equal: JSON.stringify(forward.receipt.output_observation_ids)
        === JSON.stringify(converse.receipt.output_observation_ids),
    };
  });

  const kindReport = reportConnectedHistoryTimeKindPopulation(observations);
  const base = {
    schema: CONNECTED_HISTORY_TIME_ARTIFACT_SCHEMA,
    version: CONNECTED_HISTORY_TIME_VERSION,
    generated_at: CONNECTED_HISTORY_TIME_GENERATED_AT,
    method: CONNECTED_HISTORY_TIME_METHOD,
    source_policy: CONNECTED_HISTORY_TIME_SOURCE_POLICY,
    observations,
    dossier_outcomes,
    query_pairs,
    ordering_controls,
    change_kind_population: kindReport.change_kind_population,
    fact_kind_population: kindReport.fact_kind_population,
    numeric_observation_population: kindReport.numeric_observation_population,
    unrepresented_fact_kinds: kindReport.unrepresented_fact_kinds,
    counts: {
      dossier_families: dossier_outcomes.length,
      families_with_temporal_facts: observedFamilyIds.size,
      observations: observations.length,
      query_pairs: query_pairs.length,
      source_judgments: CONNECTED_HISTORY_TIME_QUERY_JUDGMENTS.length,
    },
  };
  return Object.freeze({ ...base, selection_hash: hashOf(base) });
}

/** Recompute all claims so stale/self-declared booleans cannot satisfy checks. */
export function verifyConnectedHistoryTimeArtifact(artifact) {
  const errors = [];
  if (artifact?.schema !== CONNECTED_HISTORY_TIME_ARTIFACT_SCHEMA) errors.push("schema");
  if (artifact?.version !== CONNECTED_HISTORY_TIME_VERSION) errors.push("version");
  if (artifact?.source_policy !== CONNECTED_HISTORY_TIME_SOURCE_POLICY) {
    errors.push("source_policy");
  }
  const dossierIds = (artifact?.dossier_outcomes || []).map((row) => row.family_id).sort();
  if (JSON.stringify(dossierIds) !== JSON.stringify([...CONNECTED_HISTORY_TIME_DOSSIER_FAMILIES].sort())) {
    errors.push("dossier_family_set");
  }
  const observations = (artifact?.observations || []).map((row) => {
    try {
      return normalizeConnectedHistoryObservation(row);
    } catch (error) {
      errors.push(`observation:${error.message}`);
      return null;
    }
  }).filter(Boolean);
  const expectedCounts = {
    dossier_families: CONNECTED_HISTORY_TIME_DOSSIER_FAMILIES.length,
    families_with_temporal_facts: new Set(observations.map((row) => row.family_id)).size,
    observations: observations.length,
    query_pairs: CONNECTED_HISTORY_TIME_QUERY_JUDGMENTS.length,
    source_judgments: CONNECTED_HISTORY_TIME_QUERY_JUDGMENTS.length,
  };
  if (JSON.stringify(artifact?.counts || null) !== JSON.stringify(expectedCounts)) {
    errors.push("counts");
  }
  const kindReport = reportConnectedHistoryTimeKindPopulation(observations);
  if (JSON.stringify(artifact?.change_kind_population || null)
    !== JSON.stringify(kindReport.change_kind_population)) {
    errors.push("change_kind_population");
  }
  if (JSON.stringify(artifact?.fact_kind_population || null)
    !== JSON.stringify(kindReport.fact_kind_population)) {
    errors.push("fact_kind_population");
  }
  if (artifact?.numeric_observation_population !== kindReport.numeric_observation_population) {
    errors.push("numeric_observation_population");
  }
  if (JSON.stringify(artifact?.unrepresented_fact_kinds || null)
    !== JSON.stringify(kindReport.unrepresented_fact_kinds)) {
    errors.push("unrepresented_fact_kinds");
  }
  for (const judgment of CONNECTED_HISTORY_TIME_QUERY_JUDGMENTS) {
    const rebuilt = buildPair(observations, judgment);
    errors.push(...checkConnectedHistorySourceJudgment(rebuilt, judgment));
    const retained = (artifact?.query_pairs || []).find((pair) => pair.id === judgment.id);
    if (!retained) {
      errors.push(`missing_query_pair:${judgment.id}`);
      continue;
    }
    if (retained.evidence_class !== "module_oracle") errors.push(`unlabelled_module_oracle:${judgment.id}`);
    if (JSON.stringify(idList(retained.before)) !== JSON.stringify(idList(rebuilt.before))) {
      errors.push(`stale_before:${judgment.id}`);
    }
    if (JSON.stringify(idList(retained.after)) !== JSON.stringify(idList(rebuilt.after))) {
      errors.push(`stale_after:${judgment.id}`);
    }
    if (retained.comparison?.schema !== CONNECTED_HISTORY_TIME_COMPARISON_SCHEMA) {
      errors.push(`comparison_schema:${judgment.id}`);
    }
  }
  for (const familyId of [...new Set(observations.map((row) => row.family_id))]) {
    const familyRows = observations.filter((row) => row.family_id === familyId);
    const forward = orderConnectedHistoryEntries(familyRows);
    const converse = orderConnectedHistoryEntries([...familyRows].reverse());
    const control = (artifact?.ordering_controls || []).find((row) => row.family_id === familyId);
    if (!control) {
      errors.push(`missing_ordering_control:${familyId}`);
      continue;
    }
    if (forward.receipt.intermediate_steps.length < 2) errors.push(`missing_intermediate_state:${familyId}`);
    if (JSON.stringify(forward.receipt.output_observation_ids)
      !== JSON.stringify(converse.receipt.output_observation_ids)) {
      errors.push(`non_deterministic_order:${familyId}`);
    }
    if (JSON.stringify(control.forward?.output_observation_ids)
      !== JSON.stringify(forward.receipt.output_observation_ids)) {
      errors.push(`stale_forward_order:${familyId}`);
    }
    if (JSON.stringify(control.converse?.output_observation_ids)
      !== JSON.stringify(converse.receipt.output_observation_ids)) {
      errors.push(`stale_converse_order:${familyId}`);
    }
  }
  if (artifact && typeof artifact === "object") {
    const { selection_hash: claimedHash, ...withoutHash } = artifact;
    if (hashOf(withoutHash) !== claimedHash) {
      errors.push("selection_hash");
    }
  } else {
    errors.push("selection_hash");
  }
  return { valid: errors.length === 0, errors };
}

/** Receipt verification.state comes from the verifier result, never a constant. */
export function buildConnectedHistoryTimeReceipt(artifact, verification) {
  const state = verification?.valid ? "passed" : "failed";
  return {
    schema: CONNECTED_HISTORY_TIME_RECEIPT_SCHEMA,
    version: CONNECTED_HISTORY_TIME_VERSION,
    artifact: "site/data/connected_history_time.json",
    generated_at: CONNECTED_HISTORY_TIME_GENERATED_AT,
    method: CONNECTED_HISTORY_TIME_METHOD,
    selection_hash: artifact.selection_hash,
    counts: artifact.counts,
    source_policy: artifact.source_policy,
    unrepresented_fact_kinds: artifact.unrepresented_fact_kinds,
    verification: {
      state,
      ...(state === "failed" ? { errors: [...(verification?.errors || [])] } : {}),
      module_oracle_queries: artifact.query_pairs.length,
      ordering_converse_controls: artifact.ordering_controls.length,
    },
  };
}

export function materializeConnectedHistoryTime() {
  const artifact = buildConnectedHistoryTimeArtifact();
  const verification = verifyConnectedHistoryTimeArtifact(artifact);
  const receipt = buildConnectedHistoryTimeReceipt(artifact, verification);
  if (!verification.valid) {
    throw new Error(`connected history time artifact failed verification: ${verification.errors.join(", ")}`);
  }
  return { artifact, receipt };
}
