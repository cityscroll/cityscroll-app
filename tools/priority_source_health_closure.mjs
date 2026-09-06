/**
 * Priority-source observation closure.
 *
 * Classifies every canonical source-health contract, publishes active-source
 * observability coverage, and keeps acquisition input vintage distinct from
 * later materialization. A rebuild of an old warehouse snapshot cannot clear
 * ingestion staleness.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeClock } from "../ontology/source_health.mjs";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const PRIORITY_SOURCE_HEALTH_CLOSURE_SCHEMA = "cityscroll.priority_source_health_closure.v1";
export const PRIORITY_SOURCE_HEALTH_CLOSURE_EXTENSION_VERSION = 1;

export const OBSERVATION_CLASSES = Object.freeze([
  "observed",
  "legitimately-historical-or-manual",
  "disabled-or-candidate",
  "requires-observation-producer",
]);

export const PRIORITY_SOURCE_FAMILIES = Object.freeze([
  Object.freeze({ id: "city-record", label: "City Record", source_ids: Object.freeze(["city-record"]) }),
  Object.freeze({
    id: "passport",
    label: "PASSPort contracts/RFX",
    source_ids: Object.freeze(["passport-public-contracts", "passport-public-rfx"]),
    producer: "worker-d1-passport-ingest-meta",
  }),
  Object.freeze({
    id: "checkbook",
    label: "Checkbook contracts/spending",
    source_ids: Object.freeze(["checkbook-contracts", "checkbook-spending"]),
  }),
  Object.freeze({ id: "legistar", label: "Legistar", source_ids: Object.freeze(["nyc-council-legistar"]) }),
  Object.freeze({ id: "rules-rss", label: "Rules RSS", source_ids: Object.freeze(["nyc-rules-rss"]) }),
  Object.freeze({ id: "zap-projects", label: "ZAP projects", source_ids: Object.freeze(["zap-projects"]) }),
  Object.freeze({
    id: "community-board-minutes",
    label: "Community-board minutes",
    source_ids: Object.freeze(["non-council-board-minutes"]),
  }),
]);

export const PRIORITY_SOURCE_IDS = Object.freeze(
  PRIORITY_SOURCE_FAMILIES.flatMap((family) => family.source_ids),
);

const HISTORICAL_MODES = new Set(["historical", "manual-conditional", "pointer"]);
const ACTIVE_STATUSES = new Set(["live", "build-time"]);
const MISSING_RUN = /^missing:/;

function validAt(value) {
  return normalizeClock(value).at;
}

function clockKnown(clock) {
  return Boolean(validAt(clock?.at) || validAt(clock));
}

function observationClocks(observation = {}) {
  const healthClocks = observation?.health?.clocks || {};
  const operatorClocks = observation?.operator?.clocks || {};
  return {
    publisher: healthClocks.publisher_updated || null,
    checked: healthClocks.cityscroll_checked_acquired || operatorClocks.checked || null,
    acquired: operatorClocks.acquired || healthClocks.cityscroll_checked_acquired || null,
    serving: healthClocks.cityscroll_serving || observation?.serving || null,
  };
}

function realProducerRuns(observation = {}) {
  const runs = [
    ...(observation?.operator?.runs || []),
    ...(observation?.runs || []),
  ];
  const receipts = observation?.operator?.acquisition_receipts || observation?.acquisition_receipts || [];
  return [...runs, ...receipts].filter((row) => {
    const runId = String(row?.run_id || "");
    const at = validAt(row?.at || row?.observed_at);
    return at && runId && !MISSING_RUN.test(runId);
  });
}

function hasCityScrollControlledEvidence(observation = {}) {
  const clocks = observationClocks(observation);
  if (clockKnown(clocks.checked) || clockKnown(clocks.acquired)) return true;
  return realProducerRuns(observation).length > 0;
}

export function isActiveObservabilitySource(contract = {}) {
  if (!ACTIVE_STATUSES.has(contract.status)) return false;
  const mode = contract?.freshness_contract?.mode;
  if (HISTORICAL_MODES.has(mode)) return false;
  if (contract.status === "manual") return false;
  return true;
}

export function classifySourceObservation(contract = {}, observation = null, options = {}) {
  const candidate = options.candidates?.has?.(contract.id) === true || contract.research_state === "candidate";
  if (contract.status === "disabled" || candidate) return "disabled-or-candidate";
  const mode = contract?.freshness_contract?.mode;
  if (HISTORICAL_MODES.has(mode) || contract.status === "manual") {
    return "legitimately-historical-or-manual";
  }
  if (hasCityScrollControlledEvidence(observation)) return "observed";
  return "requires-observation-producer";
}

export function classifyRegistryCensus(registry = {}, projection = {}, options = {}) {
  const byId = new Map((projection?.observations || []).map((row) => [row.source_id, row]));
  const rows = [...(registry?.contracts || [])]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((contract) => {
      const observation = byId.get(contract.id) || null;
      const observationClass = classifySourceObservation(contract, observation, options);
      const active = isActiveObservabilitySource(contract);
      return {
        source_id: contract.id,
        status: contract.status,
        freshness_mode: contract?.freshness_contract?.mode || null,
        active,
        observation_class: observationClass,
        priority_family: PRIORITY_SOURCE_FAMILIES.find((family) => family.source_ids.includes(contract.id))?.id || null,
      };
    });
  const counts = Object.fromEntries(OBSERVATION_CLASSES.map((id) => [
    id,
    rows.filter((row) => row.observation_class === id).length,
  ]));
  const activeRows = rows.filter((row) => row.active);
  const observedActive = activeRows.filter((row) => row.observation_class === "observed");
  return {
    schema: "cityscroll.source_observation_census.v1",
    contract_count: rows.length,
    counts,
    active_source_observability: {
      numerator: observedActive.length,
      denominator: activeRows.length,
      definition: "Observed active sources over live/build-time sources that are not historical, manual, pointer, disabled, or candidate.",
    },
    rows,
  };
}

/**
 * Acquisition clocks come from ingest/check evidence. Materialization timestamps
 * are serving clocks. Mixing them would let a rebuild of an old snapshot look
 * like a fresh acquisition.
 */
export function acquisitionObservationDate(payload = {}) {
  const snapshot = payload?.snapshot_date;
  const snapshotAt = typeof snapshot === "string" && /^\d{4}-\d{2}-\d{2}T/.test(snapshot)
    ? snapshot
    : null;
  return newest([
    payload?.observed_at,
    payload?.observed_at_utc,
    payload?.finished_at,
    payload?.completed_at,
    payload?.retrieved_at,
    payload?.fetched_at,
    payload?.pulled_at,
    payload?.ingested_at,
    payload?.source?.pulled_at,
    payload?.source?.retrieved_at,
    payload?.source?.fetched_at,
    payload?.source?.observed_at,
    snapshotAt,
  ]);
}

export function servingObservationDate(payload = {}) {
  return newest([
    payload?.served_at,
    payload?.materialized_at,
    payload?.generated_at,
  ]);
}

function newest(values) {
  return values
    .map(validAt)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
}

export function materializationDoesNotClearAcquisition({
  inputVintage = null,
  servedAt = null,
  now = null,
  maxStaleDays = null,
} = {}) {
  const inputAt = validAt(inputVintage);
  const served = validAt(servedAt);
  const asOf = validAt(now);
  if (!inputAt || !asOf || maxStaleDays == null) {
    return {
      acquisition_stale: inputAt == null,
      serving_rebuilt: Boolean(served && inputAt && Date.parse(served) > Date.parse(inputAt)),
      cleared_by_rebuild: false,
    };
  }
  const ageDays = (Date.parse(asOf) - Date.parse(inputAt)) / 86_400_000;
  const acquisitionStale = ageDays > Number(maxStaleDays);
  const rebuilt = Boolean(served && Date.parse(served) > Date.parse(inputAt));
  return {
    acquisition_stale: acquisitionStale,
    serving_rebuilt: rebuilt,
    cleared_by_rebuild: false,
    input_vintage: inputAt,
    served_at: served,
  };
}

export function unchangedOldCatalogIsNotFreshnessProof({
  previousChecksum = null,
  nextChecksum = null,
  previousInputVintage = null,
  nextInputVintage = null,
} = {}) {
  const sameChecksum = previousChecksum && nextChecksum && previousChecksum === nextChecksum;
  const sameVintage = validAt(previousInputVintage) && validAt(nextInputVintage)
    && validAt(previousInputVintage) === validAt(nextInputVintage);
  return {
    freshness_proved: false,
    unchanged_catalog: Boolean(sameChecksum || sameVintage),
    reason: (sameChecksum || sameVintage)
      ? "unchanged-old-catalog-is-not-freshness-proof"
      : "catalog-change-not-established",
  };
}

export function noChangeCheckReceipt({
  source_contract_id,
  observed_at,
  run_id,
  input_vintage = null,
  publisher_updated_at = null,
  publisher_clock_basis = null,
} = {}) {
  return {
    schema: "cityscroll.source_acquisition_receipt.v1",
    source_contract_id,
    observed_at: validAt(observed_at),
    status: "succeeded",
    run_id,
    publisher_clock_basis: publisher_clock_basis || null,
    publisher_updated_at: validAt(publisher_updated_at),
    clock_kind: "check",
    event_kind: "successful-no-change-check",
    input_vintage: validAt(input_vintage),
  };
}

export const FIXTURE_CASES = Object.freeze([
  "partial-acquisition",
  "failed-check",
  "unsearched-scope",
  "fresh-empty",
  "successful-no-change-check",
  "unavailable-serving",
  "valid-fallback",
  "expired-fallback",
  "old-input-rematerialization",
]);

export function fixtureObservation(kind, sourceId = "fixture-source") {
  const now = "2026-09-06T12:00:00.000Z";
  const base = {
    source_id: sourceId,
    publisher_updated_at: null,
    checked_at: now,
    acquired_at: null,
    acquisition_status: "unknown",
    serving: { status: "unknown", at: null, fallback_valid: false, max_age_days: 7 },
  };
  switch (kind) {
    case "partial-acquisition":
      return { ...base, acquisition_status: "partial", acquired_at: now, check_status: "partial" };
    case "failed-check":
      return { ...base, check_status: "failed", acquisition_status: "failed" };
    case "unsearched-scope":
      return { ...base, checked_at: null, check_status: "unknown", acquisition_status: "unknown" };
    case "fresh-empty":
      return {
        ...base,
        acquisition_status: "succeeded",
        acquired_at: now,
        check_status: "succeeded",
        population: 0,
        serving: { status: "current", at: now, fallback_valid: false, max_age_days: 7 },
      };
    case "successful-no-change-check":
      return {
        ...base,
        check_status: "succeeded",
        acquisition_status: "succeeded",
        acquired_at: "2026-09-01T12:00:00.000Z",
        checked_at: now,
        clock_kind: "check",
        event_kind: "successful-no-change-check",
        input_vintage: "2026-09-01T12:00:00.000Z",
      };
    case "unavailable-serving":
      return {
        ...base,
        acquisition_status: "succeeded",
        acquired_at: now,
        serving: { status: "unavailable", at: null, fallback_valid: false, max_age_days: 7 },
      };
    case "valid-fallback":
      return {
        ...base,
        acquisition_status: "failed",
        serving: { status: "fallback", at: "2026-09-05T12:00:00.000Z", fallback_valid: true, max_age_days: 7 },
      };
    case "expired-fallback":
      return {
        ...base,
        acquisition_status: "failed",
        serving: { status: "fallback", at: "2026-07-01T12:00:00.000Z", fallback_valid: false, max_age_days: 7 },
      };
    case "old-input-rematerialization":
      return {
        ...base,
        acquisition_status: "succeeded",
        acquired_at: "2026-06-01T12:00:00.000Z",
        input_vintage: "2026-06-01T12:00:00.000Z",
        serving: { status: "current", at: now, fallback_valid: false, max_age_days: 7 },
      };
    default:
      throw new Error(`unknown fixture case: ${kind}`);
  }
}

export function familyRetentionRow(family, observationById = new Map(), options = {}) {
  const sources = family.source_ids.map((sourceId) => {
    const observation = observationById.get(sourceId) || null;
    const clocks = observationClocks(observation);
    const run = realProducerRuns(observation)[0] || null;
    const inputVintage = validAt(observation?.input_vintage)
      || validAt(observation?.operator?.clocks?.acquired?.at)
      || validAt(clocks.acquired?.at);
    const served = validAt(clocks.serving?.at);
    const cityscrollControlled = hasCityScrollControlledEvidence(observation);
    return {
      source_id: sourceId,
      attempt_at: validAt(clocks.checked?.at) || validAt(run?.at) || validAt(run?.observed_at),
      result_at: inputVintage || validAt(clocks.checked?.at),
      acquisition_or_no_change: Boolean(
        observation?.event_kind === "successful-no-change-check"
        || observation?.acquisition_status === "succeeded"
        || clocks.acquired?.state === "KNOWN",
      ),
      producer_run_id: run?.run_id || null,
      producer: run?.adapter || family.producer || null,
      input_vintage: inputVintage,
      served_artifact_at: served,
      cityscroll_controlled_evidence: cityscrollControlled,
      publisher_date_unknown: !clockKnown(clocks.publisher),
      obligation_open: !cityscrollControlled,
    };
  });
  return {
    family_id: family.id,
    label: family.label,
    sources,
    obligation_open: sources.some((row) => row.obligation_open),
    evidence_class: options.evidence_class || "committed-receipt",
  };
}

export function buildPrioritySourceHealthClosure({
  registry,
  projection,
  candidates = new Set(),
  boardClosure = null,
  rail = null,
  before = null,
  evidenceRevision = null,
} = {}) {
  const census = classifyRegistryCensus(registry, projection, { candidates });
  const byId = new Map((projection?.observations || []).map((row) => [row.source_id, row]));
  const families = PRIORITY_SOURCE_FAMILIES.map((family) => familyRetentionRow(family, byId));
  const openPriority = families.filter((row) => row.obligation_open).map((row) => row.family_id);
  const gaps = census.rows
    .filter((row) => row.observation_class === "requires-observation-producer" && !row.priority_family)
    .map((row) => row.source_id);
  return {
    schema: PRIORITY_SOURCE_HEALTH_CLOSURE_SCHEMA,
    evidence_revision: evidenceRevision || projection?.generated_at || null,
    census,
    families,
    open_priority_families: openPriority,
    remaining_non_priority_observation_gaps: gaps,
    board_measurement: boardClosure || null,
    warehouse_rail: rail || null,
    before_after: {
      before: before || null,
      after: {
        active_source_observability: census.active_source_observability,
        priority_families_closed: families.filter((row) => !row.obligation_open).map((row) => row.family_id),
        board_dispositions: boardClosure?.counts || null,
      },
    },
  };
}

export function cardSynthesisOwner(root = ROOT) {
  const available = existsSync(join(root, "tools/diagnostic_card_producer.py"))
    && existsSync(join(root, "data/diagnostic-card-producer.v1.json"));
  return {
    available,
    owner: available ? "diagnostic-card-producer" : null,
    note: available
      ? "Automatic card synthesis remains that owner's delivery obligation; this closure only links the existing producer."
      : "Card synthesis is not available in this tree; health findings still upsert into the repair observation identity.",
  };
}

export function loadJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function inspectWarehouseRefreshRail(options = {}) {
  const installed = options.installed === true;
  const lastExecution = options.last_execution || null;
  if (!installed) {
    return {
      installed: false,
      last_execution: null,
      blocker: "uninstalled-schedule",
      evidence_class: "named-blocker",
    };
  }
  if (!lastExecution) {
    return {
      installed: true,
      last_execution: null,
      blocker: "absent-live-receipt",
      evidence_class: "named-blocker",
    };
  }
  return {
    installed: true,
    last_execution: lastExecution,
    blocker: null,
    evidence_class: options.evidence_class || "live-host-inspection",
    identity: options.identity || "com.cityscroll.first-class-refresh",
    schedule: options.schedule || "10 7 * * *",
  };
}
