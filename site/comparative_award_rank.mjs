/**
 * Pure compiler for the source-bounded OCP award-amount rank pilot.
 *
 * It consumes a committed source materialization and emits static comparative
 * receipts. It never queries a source, infers absence, or publishes a story.
 */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { MONEY_HONESTY_CAP } from "./agency_vendor_rollup.mjs";
import {
  buildDerivedFeatureRollup,
  featureDayStamp,
} from "./derived_feature_rollup.mjs";
import {
  COMPARATIVE_COVERAGE_RECEIPT_SCHEMA,
  COMPARATIVE_FACT_READ_MODEL_SCHEMA,
  createComparativeFact,
} from "./comparative_receipt.mjs";

export const AWARD_RANK_COMPARATIVE_METHOD = "source_bounded_award_amount_rank_v1";
export const AWARD_RANK_READ_MODEL_METHOD = "materialized_award_rank_receipts_v1";
export const AWARD_RANK_SOURCE_CONTRACT_ID = "ocp-recent-contract-awards";

export const AWARD_RANK_SMALL_N_POLICY = Object.freeze({
  id: "award_amount_rank_small_n_v1",
  metric_family: "source_bounded_award_rank",
  minimum_rank_count: 10,
  minimum_percentile_count: 40,
  below_rank_minimum: "withhold_fact",
  below_percentile_minimum: "rank_only",
});

const EXCLUSION_REASONS = Object.freeze([
  "not_award",
  "invalid_window_date",
  "outside_window",
  "missing_subject_identity",
  "duplicate_subject_identity",
  "unresolved_agency_identity",
  "invalid_amount",
]);

function amount(value) {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 && parsed < MONEY_HONESTY_CAP ? parsed : null;
}

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sourceReceiptProblems(lookup, sourceContract) {
  const rows = Array.isArray(lookup?.rows) ? lookup.rows : null;
  const snapshot = sourceContract?.warehouse_snapshot;
  const problems = [];
  if (!rows) problems.push("missing_materialized_rows");
  if (lookup?.schema_version !== 1) problems.push("unsupported_source_schema");
  if (lookup?.source !== "warehouse" || lookup?.mode !== "bulk_warehouse") problems.push("invalid_materialization_mode");
  if (lookup?.dataset_id !== "qyyg-4tf5") problems.push("wrong_source_dataset");
  if (!featureDayStamp(lookup?.materialized_at)) problems.push("missing_source_vintage");
  if (!Number.isInteger(lookup?.row_count) || lookup.row_count !== rows?.length) problems.push("source_row_count_mismatch");
  if (sourceContract?.id !== AWARD_RANK_SOURCE_CONTRACT_ID
    || sourceContract?.status !== "live"
    || sourceContract?.dataset_id !== lookup?.dataset_id
    || sourceContract?.delivery_tier !== "edge-materialized") {
    problems.push("incomplete_source_contract");
  }
  if (snapshot?.status !== "materialized"
    || snapshot?.artifact !== "site/data/ocp_awards_warehouse_lookup.json"
    || snapshot?.materialized_at !== lookup?.materialized_at
    || snapshot?.row_count !== lookup?.row_count) {
    problems.push("incomplete_source_snapshot_receipt");
  }
  return [...new Set(problems)].sort();
}

function emptyReadModel(lookup, reasons, options = {}) {
  return {
    schema: COMPARATIVE_FACT_READ_MODEL_SCHEMA,
    method: AWARD_RANK_READ_MODEL_METHOD,
    generated_at: lookup?.materialized_at || null,
    source_artifact: {
      dataset_id: lookup?.dataset_id || null,
      materialized_at: lookup?.materialized_at || null,
      row_count: Number.isInteger(lookup?.row_count) ? lookup.row_count : null,
    },
    window: {
      start: options.windowStart || "2024-01-01",
      end: featureDayStamp(lookup?.materialized_at),
      end_inclusive: true,
    },
    small_n_policies: { award_amount_rank: AWARD_RANK_SMALL_N_POLICY },
    coverage_receipt: {
      schema: COMPARATIVE_COVERAGE_RECEIPT_SCHEMA,
      state: "unavailable",
      reasons,
      source_count: Array.isArray(lookup?.rows) ? lookup.rows.length : 0,
      eligible_count: 0,
      observed_count: 0,
      fact_count: 0,
      exclusions_by_reason: {},
      derived_feature_rollup: null,
    },
    facts: [],
  };
}

function excludedCounter() {
  return Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, 0]));
}

function compactExclusions(counts) {
  return Object.fromEntries(EXCLUSION_REASONS
    .filter((reason) => counts[reason] > 0)
    .map((reason) => [reason, counts[reason]]));
}

function classifyRows(rows, window) {
  const exclusions = excludedCounter();
  const inWindow = [];
  for (const row of rows) {
    if (text(row?.type_of_notice_description) !== "Award") {
      exclusions.not_award += 1;
      continue;
    }
    const startDate = featureDayStamp(row?.start_date);
    if (!startDate) {
      exclusions.invalid_window_date += 1;
      continue;
    }
    if (startDate < window.start || startDate > window.end) {
      exclusions.outside_window += 1;
      continue;
    }
    const subjectId = text(row?.request_id);
    if (!subjectId) {
      exclusions.missing_subject_identity += 1;
      continue;
    }
    inWindow.push({ row, startDate, subjectId });
  }

  const subjectCounts = new Map();
  for (const candidate of inWindow) {
    subjectCounts.set(candidate.subjectId, (subjectCounts.get(candidate.subjectId) || 0) + 1);
  }

  const eligible = [];
  for (const candidate of inWindow) {
    if (subjectCounts.get(candidate.subjectId) !== 1) {
      exclusions.duplicate_subject_identity += 1;
      continue;
    }
    const identity = resolveAgencyIdentity(candidate.row?.agency_name);
    if (!identity?.matched || !identity.canonical_id) {
      exclusions.unresolved_agency_identity += 1;
      continue;
    }
    const awardAmount = amount(candidate.row?.contract_amount);
    if (awardAmount == null) {
      exclusions.invalid_amount += 1;
      continue;
    }
    eligible.push({
      ...candidate,
      amount: awardAmount,
      agencyId: identity.canonical_id,
      agencyName: identity.canonical_name,
    });
  }
  eligible.sort((left, right) => left.agencyId.localeCompare(right.agencyId)
    || right.amount - left.amount
    || left.subjectId.localeCompare(right.subjectId));
  return { eligible, exclusions: compactExclusions(exclusions) };
}

function sourceVintage(lookup, sourceContractsSchemaVersion) {
  return {
    source_contract_id: AWARD_RANK_SOURCE_CONTRACT_ID,
    source_contract_schema_version: sourceContractsSchemaVersion,
    dataset_id: lookup.dataset_id,
    materialized_at: lookup.materialized_at,
    row_count: lookup.row_count,
  };
}

function comparisonClass(group, window, vintage) {
  const first = group[0];
  return {
    class_id: [
      "award_amount_rank",
      AWARD_RANK_SOURCE_CONTRACT_ID,
      first.agencyId,
      window.start,
      window.end,
    ].join(":"),
    metric_family: "source_bounded_award_rank",
    object_type: "award",
    source_family: AWARD_RANK_SOURCE_CONTRACT_ID,
    peer_dimensions: {
      agency_id: first.agencyId,
      agency_name: first.agencyName,
      source_family: AWARD_RANK_SOURCE_CONTRACT_ID,
      fiscal_window: null,
      method_family: null,
      category: null,
    },
    observability_equivalence: {
      basis: "bounded_complete",
      source_contract_versions: [`source_contracts.v${vintage.source_contract_schema_version}:${AWARD_RANK_SOURCE_CONTRACT_ID}`],
      source_vintages: [vintage],
      acquisition_mode: "bulk_warehouse",
      inclusion_rule: "award row in the explicit window with unique request_id, canonical agency, and positive amount below the money-honesty cap",
      identity_gate: "unique_request_id_and_reviewed_agency_identity",
      join_path: "not_applicable",
      observation_quality_class: "source_bounded_positive_observation",
      censoring_class: "historical_window_only",
      historical_start: window.start,
      historical_end: window.end,
    },
    eligible_count: group.length,
    observed_count: group.length,
    exclusions_by_reason: {},
    selected_level: "source_agency_window",
    rejected_levels: [],
    small_n_policy_id: AWARD_RANK_SMALL_N_POLICY.id,
  };
}

function factsForGroup(group, {
  lookup,
  selectedSubjectIds,
  sourceContract,
  sourceContractsSchemaVersion,
  window,
}) {
  if (group.length < AWARD_RANK_SMALL_N_POLICY.minimum_rank_count) return [];
  const vintage = sourceVintage(lookup, sourceContractsSchemaVersion);
  const peerClass = comparisonClass(group, window, vintage);
  const population = {
    object_type: "award",
    source_family: AWARD_RANK_SOURCE_CONTRACT_ID,
    agency_id: group[0].agencyId,
    agency_name: group[0].agencyName,
  };
  const facts = [];
  let tieStart = 0;
  while (tieStart < group.length) {
    let tieEnd = tieStart;
    while (tieEnd + 1 < group.length && group[tieEnd + 1].amount === group[tieStart].amount) tieEnd += 1;
    const rank = tieStart + 1;
    const tieCount = tieEnd - tieStart + 1;
    const percentileAvailable = group.length >= AWARD_RANK_SMALL_N_POLICY.minimum_percentile_count;
    const percentile = percentileAvailable
      ? Math.round(((group.length - tieStart) / group.length) * 10_000) / 100
      : null;
    for (let index = tieStart; index <= tieEnd; index += 1) {
      const candidate = group[index];
      if (selectedSubjectIds && !selectedSubjectIds.has(candidate.subjectId)) continue;
      const subjectRef = `ocp_award:${candidate.subjectId}`;
      facts.push(createComparativeFact({
        factId: ["comparative_fact", "award_amount_rank", subjectRef, window.start, window.end].join(":"),
        subject: {
          type: "ocp_award",
          id: candidate.subjectId,
          ref: subjectRef,
          label: text(candidate.row.short_title) || `Award ${candidate.subjectId}`,
          agency_id: candidate.agencyId,
          pin: text(candidate.row.pin) || null,
        },
        metric: {
          id: "award_amount_rank",
          family: "distributional_position",
          unit: "USD",
          method: AWARD_RANK_COMPARATIVE_METHOD,
        },
        value: candidate.amount,
        peerClass,
        comparison: {
          population,
          eligible_count: group.length,
          observed_count: group.length,
          window,
          rank,
          tie_count: tieCount,
          percentile,
          percentile_status: percentileAvailable ? "available" : "withheld_small_n",
        },
        observation: {
          basis: "bounded_complete",
          negative_inference: "forbidden",
          eligible_count: group.length,
          observed_count: group.length,
          eligible_population: population,
          observed_population: population,
          known_selection_factors: [
            "OCP Recent Contract Awards source only",
            "explicit historical window",
            "resolved agency identities only",
            "positive amounts below the money-honesty cap only",
            "unique request identifiers only",
          ],
          source_vintages: [vintage],
        },
        evidence: [{
          kind: "source_row",
          source_contract_id: AWARD_RANK_SOURCE_CONTRACT_ID,
          dataset_id: lookup.dataset_id,
          source_row_id: candidate.subjectId,
          source_row_date: candidate.startDate,
          landing_page: sourceContract.landing_page,
          materialized_at: lookup.materialized_at,
        }],
        provenance: {
          compiler_method: AWARD_RANK_COMPARATIVE_METHOD,
          source_contract: {
            id: AWARD_RANK_SOURCE_CONTRACT_ID,
            schema_version: sourceContractsSchemaVersion,
          },
          source_artifact: {
            dataset_id: lookup.dataset_id,
            materialized_at: lookup.materialized_at,
            row_count: lookup.row_count,
          },
        },
        generatedAt: lookup.materialized_at,
      }));
    }
    tieStart = tieEnd + 1;
  }
  return facts;
}

/** Build the deterministic static read model for the single approved pilot family. */
export function buildAwardRankComparativeReadModel(lookup, options = {}) {
  const sourceContract = options.sourceContract || null;
  const problems = sourceReceiptProblems(lookup, sourceContract);
  const window = {
    start: featureDayStamp(options.windowStart) || "2024-01-01",
    end: featureDayStamp(lookup?.materialized_at),
    end_inclusive: true,
  };
  if (problems.length || !window.end || window.start > window.end) {
    return emptyReadModel(lookup, problems.length ? problems : ["invalid_comparison_window"], options);
  }

  const { eligible, exclusions } = classifyRows(lookup.rows, window);
  const groups = new Map();
  for (const candidate of eligible) {
    if (!groups.has(candidate.agencyId)) groups.set(candidate.agencyId, []);
    groups.get(candidate.agencyId).push(candidate);
  }

  const sourceContractsSchemaVersion = Number.isInteger(options.sourceContractsSchemaVersion)
    ? options.sourceContractsSchemaVersion
    : 1;
  const selectedSubjectIds = Array.isArray(options.subjectIds)
    ? new Set(options.subjectIds.map(text).filter(Boolean))
    : null;
  const facts = [...groups.keys()].sort().flatMap((agencyId) => factsForGroup(groups.get(agencyId), {
    lookup,
    selectedSubjectIds,
    sourceContract,
    sourceContractsSchemaVersion,
    window,
  }));
  facts.sort((left, right) => left.peer_class.class_id.localeCompare(right.peer_class.class_id)
    || left.comparison.rank - right.comparison.rank
    || left.subject.id.localeCompare(right.subject.id));

  const rollupRows = eligible.map((candidate) => ({
    id: candidate.subjectId,
    date: candidate.startDate,
    observed_at: lookup.materialized_at,
    state: "eligible",
    relation: "comparative_peer",
  }));
  const derivedFeatureRollup = buildDerivedFeatureRollup(rollupRows, {
    totalCount: eligible.length,
    asOf: window.end,
    referenceDay: window.end,
  });

  return {
    schema: COMPARATIVE_FACT_READ_MODEL_SCHEMA,
    method: AWARD_RANK_READ_MODEL_METHOD,
    generated_at: lookup.materialized_at,
    source_artifact: {
      dataset_id: lookup.dataset_id,
      materialized_at: lookup.materialized_at,
      row_count: lookup.row_count,
    },
    materialization_scope: selectedSubjectIds
      ? { kind: "subject_allowlist", subject_ids: [...selectedSubjectIds].sort() }
      : { kind: "all_eligible_subjects", subject_ids: null },
    window,
    small_n_policies: { award_amount_rank: AWARD_RANK_SMALL_N_POLICY },
    coverage_receipt: {
      schema: COMPARATIVE_COVERAGE_RECEIPT_SCHEMA,
      state: "bounded_complete",
      reasons: [],
      source_count: lookup.rows.length,
      eligible_count: eligible.length,
      observed_count: eligible.length,
      fact_count: facts.length,
      exclusions_by_reason: exclusions,
      derived_feature_rollup: derivedFeatureRollup,
    },
    facts,
  };
}
