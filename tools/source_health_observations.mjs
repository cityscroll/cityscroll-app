import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import {
  HEALTH_STATUSES,
  evaluateSourceHealth,
  normalizeClock,
  normalizeRelationshipCoverage,
} from "../ontology/source_health.mjs";
import { normalizeSourceState } from "../ontology/source_state.mjs";
import {
  SERVE_LOOKUP_CONTRACTS,
  servePublishFindings,
} from "../warehouse/lib/serve_publish_contract.mjs";

const SERVE_ARTIFACTS = Object.freeze({
  city_record_pin_chain: "site/data/city_record_pin_chain_warehouse_lookup.json",
  doing_business: "site/data/doing_business_warehouse_lookup.json",
  ocp_awards: "site/data/ocp_awards_warehouse_lookup.json",
  payroll_title: "site/data/payroll_title_warehouse_lookup.json",
  zap_projects: "site/data/zap_projects_warehouse_lookup.json",
  zap_bbl: "site/data/zap_bbl_warehouse_lookup.json",
});

// Receipts that already name a canonical contract without `source_contract_id`.
const RECEIPT_SCHEMA_CONTRACTS = Object.freeze({
  "cityscroll.checkbook_contracts_population_receipt.v1": Object.freeze(["checkbook-contracts"]),
  "cityscroll.checkbook_spending_population_receipt.v1": Object.freeze(["checkbook-spending"]),
});

export const ACQUISITION_RECEIPT_SCHEMA = "cityscroll.source_acquisition_receipt.v1";
export const ACQUISITION_RECEIPT_STATUSES = Object.freeze([
  "succeeded",
  "failed",
  "partial",
  "held",
]);

/**
 * The source-health narrow waist. A materialization or benchmark timestamp is
 * not an acquisition receipt: it has no source identity or observation clock.
 * Keep this validator small so build tools, Worker adapters, and the external
 * scheduler can all use the same contract without importing desk code.
 */
export function validateAcquisitionReceipt(receipt, options = {}) {
  const errors = [];
  const required = [
    "source_contract_id",
    "observed_at",
    "status",
    "run_id",
    "publisher_clock_basis",
    "publisher_updated_at",
  ];
  for (const field of required) {
    if (!Object.hasOwn(receipt || {}, field)) errors.push(`missing ${field}`);
  }
  if (typeof receipt?.source_contract_id !== "string" || !receipt.source_contract_id.trim()) {
    errors.push("source_contract_id must be a non-empty string");
  }
  if (!validAt(receipt?.observed_at)) errors.push("observed_at must be a valid timestamp");
  if (!ACQUISITION_RECEIPT_STATUSES.includes(receipt?.status)) {
    errors.push(`status must be one of ${ACQUISITION_RECEIPT_STATUSES.join(", ")}`);
  }
  if (typeof receipt?.run_id !== "string" || !receipt.run_id.trim()) {
    errors.push("run_id must be a non-empty string");
  }
  if (receipt?.publisher_clock_basis !== null && typeof receipt?.publisher_clock_basis !== "string") {
    errors.push("publisher_clock_basis must be a string or null");
  }
  if (receipt?.publisher_updated_at !== null && !validAt(receipt?.publisher_updated_at)) {
    errors.push("publisher_updated_at must be a valid timestamp or null");
  }
  if (validAt(receipt?.publisher_updated_at) && validAt(receipt?.observed_at)
    && Date.parse(receipt.publisher_updated_at) > Date.parse(receipt.observed_at)) {
    errors.push("publisher_updated_at cannot be after observed_at");
  }
  if (options.sourceIds && !options.sourceIds.has(receipt?.source_contract_id)) {
    errors.push(`${receipt?.source_contract_id || "<missing>"}: source health receipt has no canonical contract`);
  }
  if (receipt?.schema && receipt.schema !== ACQUISITION_RECEIPT_SCHEMA) {
    errors.push(`schema must be ${ACQUISITION_RECEIPT_SCHEMA}`);
  }
  return errors.sort();
}

export function assertAcquisitionReceipt(receipt, options = {}) {
  const errors = validateAcquisitionReceipt(receipt, options);
  if (errors.length) throw new Error(`invalid source acquisition receipt:\n${errors.join("\n")}`);
  return receipt;
}

function normalizedReceipt(input, sourceId, fallbackPath = null, clockKind = "acquisition") {
  const observedAt = validAt(input?.observed_at);
  const status = ACQUISITION_RECEIPT_STATUSES.includes(input?.status) ? input.status : "succeeded";
  const receipt = {
    schema: ACQUISITION_RECEIPT_SCHEMA,
    source_contract_id: sourceId,
    observed_at: observedAt,
    status,
    run_id: String(input?.run_id || input?.receipt_id || fallbackPath || `${sourceId}:${observedAt || "unknown"}`),
    publisher_clock_basis: input?.publisher_clock_basis || null,
    publisher_updated_at: notAfter(input?.publisher_updated_at, observedAt),
    clock_kind: clockKind,
  };
  assertAcquisitionReceipt(receipt);
  return receipt;
}

const ABO_DATASET_CONTRACTS = Object.freeze({
  "8w5p-k45m": "abo-local-authorities",
  "d84c-dk28": "abo-local-development-corporations",
  "ehig-g5x3": "abo-state-authorities",
});

const ADDITIONAL_SERVE_LOOKUPS = Object.freeze([
  {
    path: "site/data/abo_award_residual_lookup.json",
    sourceIds(payload) {
      return Array.isArray(payload?.source_contracts) ? payload.source_contracts : [];
    },
    at(payload) {
      return payload?.observed_at || payload?.generated_at || payload?.materialized_at;
    },
  },
  {
    path: "site/data/procurement_spine_sources.json",
    sourceIds(payload) {
      const ids = [];
      if (payload?.sources?.checkbook_contracts?.source_system === "checkbook-contracts") {
        ids.push("checkbook-contracts");
      }
      if (payload?.sources?.passport_contracts?.source_system === "passport-public-contracts") {
        ids.push("passport-public-contracts");
      }
      return ids;
    },
    at(payload, sourceId) {
      if (sourceId === "checkbook-contracts") {
        return payload?.sources?.checkbook_contracts?.pulled_at || null;
      }
      if (sourceId === "passport-public-contracts") {
        return payload?.sources?.passport_contracts?.pulled_at
          || payload?.sources?.passport_contracts?.population?.pulled_on
          || null;
      }
      return null;
    },
  },
]);

const COVERAGE_ALIASES = Object.freeze({
  "city-record-notices": Object.freeze(["city-record"]),
  "abo-external-awards": Object.freeze([
    "abo-local-authorities",
    "abo-local-development-corporations",
    "abo-state-authorities",
  ]),
  "legistar-events": Object.freeze(["nyc-council-legistar"]),
  "legistar-event-items": Object.freeze(["nyc-council-legistar"]),
  "legistar-votes": Object.freeze(["nyc-council-legistar"]),
  "legistar-attachments": Object.freeze(["nyc-council-legistar"]),
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableText(value) {
  return JSON.stringify(stableValue(value));
}

export function redactCredentialValues(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(^|[?&\s;])((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|token|s)\s*=\s*)[^&\s;]+/gi, "$1$2[REDACTED]")
    .replace(/(["'](?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|token)["']\s*:\s*["'])[^"']+/gi, "$1[REDACTED]")
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[opurs]_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function fingerprint(contract) {
  const expectation = {
    id: contract.id,
    status: contract.status,
    delivery_tier: contract.delivery_tier,
    freshness_contract: contract.freshness_contract,
    health_policy: contract.health_policy,
  };
  return createHash("sha256").update(stableText(expectation)).digest("hex");
}

function validAt(value) {
  return normalizeClock(value).at;
}

function newestAt(values) {
  return values
    .map(validAt)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
}

function observationDate(payload) {
  return newestAt([
    payload?.observed_at,
    payload?.observed_at_utc,
    payload?.finished_at,
    payload?.completed_at,
    payload?.generated_at,
    payload?.materialized_at,
    payload?.observed_on,
    payload?.snapshot_date,
    payload?.retrieved_at,
    payload?.fetched_at,
    payload?.pulled_at,
    payload?.source?.pulled_at,
    payload?.source?.retrieved_at,
    payload?.source?.fetched_at,
    payload?.source?.observed_at,
  ]);
}

function notAfter(value, observedAt) {
  const at = validAt(value);
  if (!at) return null;
  if (observedAt && Date.parse(at) > Date.parse(observedAt)) return null;
  return at;
}

function publisherDate(payload, observedAt, sourceId, registry) {
  const contract = (registry?.contracts || []).find((row) => row.id === sourceId);
  const datasetId = typeof contract?.dataset_id === "string" ? contract.dataset_id : null;
  const namedIds = receiptSourceIds(payload);
  const inventoryDates = Array.isArray(payload?.source_inventory)
    ? payload.source_inventory
      .filter((row) => !datasetId || row?.dataset === datasetId)
      .map((row) => row?.award_date_max)
    : [];
  // A multi-source receipt must not copy another dataset's award date onto this contract.
  const scopedInventory = datasetId || namedIds.length <= 1 ? inventoryDates : [];
  return newestAt([
    payload?.publisher_updated_at,
    payload?.source_summary?.publisher_updated_at,
    payload?.source_summary?.start_date_max,
    payload?.rows_updated_at,
    ...scopedInventory,
  ].map((value) => notAfter(value, observedAt)).filter(Boolean));
}

export function receiptSourceIds(payload) {
  const ids = [];
  if (typeof payload?.source_contract_id === "string" && payload.source_contract_id.trim()) {
    ids.push(payload.source_contract_id.trim());
  }
  if (typeof payload?.source?.source_contract_id === "string" && payload.source.source_contract_id.trim()) {
    ids.push(payload.source.source_contract_id.trim());
  }
  if (Array.isArray(payload?.source_contracts)) {
    for (const id of payload.source_contracts) {
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
  }
  const schemaIds = RECEIPT_SCHEMA_CONTRACTS[payload?.schema];
  if (schemaIds) ids.push(...schemaIds);
  return [...new Set(ids)];
}

function canonicalTargets(coverageId, contractIds) {
  if (contractIds.has(coverageId)) return [coverageId];
  return COVERAGE_ALIASES[coverageId] || [];
}

function coverageStatus(rows) {
  const statuses = rows.map((row) => String(row?.dual_write?.after || row?.live_observation?.status || "unknown"));
  if (!statuses.length) return "not-declared";
  if (statuses.every((status) => status === "complete")) return "complete";
  if (statuses.every((status) => status === "gap")) return "gap";
  if (statuses.some((status) => status === "stale")) return "stale";
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "held")) return "held";
  return "partial";
}

function coverageByContract(registry, census) {
  const contractIds = new Set((registry.contracts || []).map((contract) => contract.id));
  const grouped = new Map();
  const orphanIds = [];
  for (const row of census?.sources || []) {
    const targets = canonicalTargets(row?.id, contractIds);
    if (!targets.length) {
      orphanIds.push(row?.id || "(missing coverage id)");
      continue;
    }
    for (const id of targets) {
      const values = grouped.get(id) || [];
      values.push(row);
      grouped.set(id, values);
    }
  }
  if (orphanIds.length) {
    throw new Error(`relationship coverage has no canonical contract: ${orphanIds.sort().join(", ")}`);
  }
  return new Map([...grouped.entries()].map(([id, rows]) => {
    const rowCount = rows.reduce((sum, row) => sum + (Number(row?.live_observation?.row_count) || 0), 0);
    const status = coverageStatus(rows);
    const measuredAt = newestAt(rows.map((row) => row?.live_observation?.measured_at));
    const sourceState = normalizeSourceState({
      contract: registry.contracts.find((contract) => contract.id === id),
      coverage: rows.length === 1 ? rows[0] : {
        id,
        dual_write: { after: status },
        live_observation: { status, row_count: rowCount, measured_at: measuredAt },
      },
      coverageId: rows.map((row) => row.id).sort().join(","),
    });
    return [id, normalizeRelationshipCoverage({
      status: sourceState.source_records_coverage.status,
      row_count: sourceState.source_records_coverage.row_count,
      measured_at: sourceState.source_records_coverage.measured_at,
      join_status: ["failed", "held"].includes(status) ? status : "accepted",
    })];
  }));
}

function evidenceItem(kind, path, at, status) {
  return { kind, path: path || null, at: validAt(at), status };
}

function sortedEvidence(items) {
  const seen = new Set();
  return items
    .filter((item) => item?.at)
    .sort((left, right) => (
      Date.parse(right.at) - Date.parse(left.at)
      || String(left.kind).localeCompare(String(right.kind))
      || String(left.path).localeCompare(String(right.path))
    ))
    .filter((item) => {
      const key = stableText(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function baseObservation(contract) {
  return {
    source_id: contract.id,
    publisher_updated_at: null,
    publisher_clock_basis: null,
    checked_at: null,
    check_status: "unknown",
    acquired_at: null,
    acquisition_status: "unknown",
    manual_refresh: null,
    serving: {
      status: "unknown",
      at: null,
      basis: null,
      fallback_valid: false,
      max_age_days: null,
    },
    evidence: [],
    acquisition_receipts: [],
    runs: [],
  };
}

function applyAcquisition(target, input, kind) {
  const at = validAt(input.observed_at);
  if (!at) return;
  const clockKind = input.clock_kind || "acquisition";
  if (!target.checked_at || Date.parse(at) >= Date.parse(target.checked_at)) {
    target.checked_at = at;
    target.check_status = input.status || "succeeded";
  }
  if (clockKind === "acquisition" && (!target.acquired_at || Date.parse(at) >= Date.parse(target.acquired_at))) {
    target.acquisition_status = input.status || "succeeded";
    target.acquired_at = target.acquisition_status === "succeeded" ? at : target.acquired_at;
    if (input.publisher_updated_at) {
      target.publisher_updated_at = validAt(input.publisher_updated_at);
      target.publisher_clock_basis = input.publisher_clock_basis || "publisher_receipt";
    }
  } else if (target.acquisition_status === "unknown") {
    // Preserve the established health evaluator's check-success semantics while
    // keeping the actual acquired_at clock separate for the watchdog.
    target.acquisition_status = input.status || "succeeded";
  }
  target.evidence.push(evidenceItem(kind, input.path, at, input.status || "succeeded"));
  const receipt = normalizedReceipt(input, target.source_id, input.path, clockKind);
  target.acquisition_receipts.push(receipt);
  target.runs.push({
    adapter: input.adapter || kind,
    run_id: input.run_id || null,
    at,
    status: input.status || "succeeded",
    receipt_ref: input.path || null,
    exact_error: input.exact_error ? redactCredentialValues(input.exact_error) : null,
  });
}

function sortedRuns(items) {
  const seen = new Set();
  return items
    .sort((left, right) => (
      Date.parse(right.at) - Date.parse(left.at)
      || String(left.adapter).localeCompare(String(right.adapter))
      || String(left.run_id).localeCompare(String(right.run_id))
      || String(left.receipt_ref).localeCompare(String(right.receipt_ref))
    ))
    .filter((item) => {
      const key = stableText(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function cadenceDays(contract) {
  const explicit = Number(
    contract?.freshness_contract?.acquisition_cadence_days
    ?? contract?.acquisition_cadence_days,
  );
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const text = String(contract?.acquisition_cadence || contract?.publisher_cadence || "").toLowerCase();
  if (/daily|each day|every day/.test(text)) return 1;
  if (/weekly|each week|every week/.test(text)) return 7;
  const every = text.match(/every\s+(\d+)\s+days?/);
  if (every) return Number(every[1]);
  return null;
}

function missingRunId(sourceId, at) {
  return `missing:${sourceId}:${at.slice(0, 16).replace(/:/g, "-")}`;
}

/**
 * Daily scheduler liveness is deliberately independent from source cadence.
 * A source can be weekly and still require the daily monitor heartbeat to
 * prove that its next acquisition is intentionally not due.
 */
export function evaluateFreshnessWatchdog(contract, observation = {}, options = {}) {
  const now = validAt(options.now);
  if (!now) throw new Error("freshness watchdog requires a valid now timestamp");
  const heartbeat = options.schedulerHeartbeat || null;
  const heartbeatAt = validAt(heartbeat?.observed_at);
  const heartbeatAgeDays = heartbeatAt ? (Date.parse(now) - Date.parse(heartbeatAt)) / 86_400_000 : Infinity;
  const reasons = [];
  if (!heartbeatAt || heartbeatAgeDays > (Number(options.expectedSchedulerSlots) || 2)) {
    reasons.push("monitor-missing");
  }

  const dueDays = cadenceDays(contract);
  const acquiredAt = validAt(observation?.acquired_at);
  const acquisitionAgeDays = acquiredAt ? (Date.parse(now) - Date.parse(acquiredAt)) / 86_400_000 : Infinity;
  if (dueDays != null && acquisitionAgeDays > dueDays) reasons.push("acquisition-missing");

  const status = reasons.length ? "STALE" : "CURRENT";
  const missingReceipts = reasons.map((reason) => ({
    schema: ACQUISITION_RECEIPT_SCHEMA,
    source_contract_id: contract.id,
    observed_at: now,
    status: reason === "monitor-missing" ? "failed" : "held",
    run_id: missingRunId(contract.id, now),
    publisher_clock_basis: null,
    publisher_updated_at: null,
    event_kind: reason === "monitor-missing" ? "scheduler-heartbeat" : "acquisition-cadence",
    state: reason,
  }));
  return {
    status,
    reason_codes: reasons,
    source_contract_id: contract.id,
    observed_at: now,
    scheduler_heartbeat: {
      observed_at: heartbeatAt,
      status: heartbeatAt ? (heartbeat?.status || "succeeded") : "monitor-missing",
      run_id: heartbeat?.run_id || null,
      age_days: Number.isFinite(heartbeatAgeDays) ? heartbeatAgeDays : null,
      expected_slots: Number(options.expectedSchedulerSlots) || 2,
    },
    acquisition: {
      observed_at: acquiredAt,
      cadence_days: dueDays,
      age_days: Number.isFinite(acquisitionAgeDays) ? acquisitionAgeDays : null,
    },
    receipts: missingReceipts,
  };
}

function applyServing(target, input) {
  const at = validAt(input.at);
  if (!at) return;
  if (!target.serving.at || Date.parse(at) >= Date.parse(target.serving.at)) {
    target.serving = {
      status: input.status || "current",
      at,
      basis: input.basis || "warehouse_serve_receipt",
      fallback_valid: Boolean(input.fallback_valid),
      max_age_days: Number.isFinite(Number(input.max_age_days)) ? Number(input.max_age_days) : null,
    };
  }
  target.evidence.push(evidenceItem("serving-receipt", input.path, at, input.status || "current"));
}

export function validateSourceHealthProjection(registry, projection) {
  const errors = [];
  const contractIds = new Set();
  for (const contract of registry?.contracts || []) {
    if (contractIds.has(contract.id)) errors.push(`${contract.id}: duplicate source contract id`);
    contractIds.add(contract.id);
  }
  const observationIds = new Set();
  for (const row of projection?.observations || []) {
    const id = row?.source_id || "(missing source_id)";
    if (observationIds.has(id)) errors.push(`${id}: duplicate source health observation`);
    observationIds.add(id);
    if (!contractIds.has(id)) errors.push(`${id}: source health observation has no canonical contract`);
    if (row?.health?.status && !HEALTH_STATUSES.includes(row.health.status)) {
      errors.push(`${id}: invalid health status ${row.health.status}`);
    }
    if (row?.freshness_watchdog && row.freshness_watchdog.source_contract_id !== id) {
      errors.push(`${id}: freshness watchdog source_contract_id does not match observation`);
    }
    for (const receipt of row?.operator?.acquisition_receipts || []) {
      for (const error of validateAcquisitionReceipt(receipt, { sourceIds: contractIds })) {
        errors.push(`${id}: ${error}`);
      }
    }
  }
  return errors.sort();
}

export function buildSourceHealthObservations(registry, inputs = {}) {
  const contracts = [...(registry?.contracts || [])].sort((left, right) => left.id.localeCompare(right.id));
  const duplicateErrors = validateSourceHealthProjection(registry, { observations: [] });
  if (duplicateErrors.length) throw new Error(duplicateErrors.join("\n"));
  const byId = new Map(contracts.map((contract) => [contract.id, baseObservation(contract)]));

  const acquisitions = [
    ...(inputs.warehouseReceipts || []).map((row) => ({ ...row, evidence_kind: "warehouse-acquisition-receipt" })),
    ...(inputs.scheduleObservations || []).map((row) => ({ ...row, evidence_kind: "external-schedule-receipt" })),
  ];
  const statusOrder = { unknown: 0, succeeded: 1, partial: 2, held: 3, failed: 4 };
  acquisitions.sort((left, right) => (
    (Date.parse(validAt(left.observed_at) || "") || 0)
      - (Date.parse(validAt(right.observed_at) || "") || 0)
    || String(left.source_id).localeCompare(String(right.source_id))
    || (statusOrder[left.status] || 0) - (statusOrder[right.status] || 0)
    || String(left.evidence_kind).localeCompare(String(right.evidence_kind))
    || String(left.path).localeCompare(String(right.path))
  ));
  for (const input of acquisitions) {
    const target = byId.get(input.source_id);
    if (!target) throw new Error(`${input.source_id}: source health receipt has no canonical contract`);
    applyAcquisition(target, input, input.evidence_kind);
  }
  for (const input of [...(inputs.serveObservations || [])].sort((a, b) => String(a.source_id).localeCompare(String(b.source_id)))) {
    const target = byId.get(input.source_id);
    if (!target) throw new Error(`${input.source_id}: serving receipt has no canonical contract`);
    applyServing(target, input);
  }

  const allDates = [
    inputs.asOf,
    ...acquisitions.flatMap((row) => [row.observed_at, row.publisher_updated_at]),
    ...(inputs.serveObservations || []).map((row) => row.at),
    ...((inputs.coverageCensus?.sources || []).flatMap((row) => [
      row?.live_observation?.measured_at,
      row?.live_observation?.latest_ingested_at,
    ])),
  ];
  const asOf = validAt(inputs.asOf) || newestAt(allDates);
  if (!asOf) throw new Error("source health projection has no valid evaluation timestamp");
  const schedulerHeartbeat = [...(inputs.schedulerHeartbeats || [])]
    .filter((row) => validAt(row?.observed_at))
    .sort((left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at))[0]
    // Fixture callers historically supplied only per-source schedule rows. A
    // successful check is still a heartbeat, even before the explicit heartbeat
    // field is available from the external runner.
    || acquisitions
      .filter((row) => row.clock_kind === "check" || row.evidence_kind === "external-schedule-receipt")
      .sort((left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at))[0]
      || null;
  const coverage = coverageByContract(registry, inputs.coverageCensus);

  const observations = contracts.map((contract) => {
    const normalized = byId.get(contract.id);
    if (["failed", "held"].includes(normalized.acquisition_status) && normalized.serving.status === "current") {
      normalized.serving.status = "fallback";
      normalized.serving.fallback_valid = true;
    }
    normalized.evidence = sortedEvidence(normalized.evidence);
    normalized.acquisition_receipts = normalized.acquisition_receipts
      .sort((left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at));
    normalized.runs = sortedRuns(normalized.runs);
    const health = evaluateSourceHealth(contract, normalized, { now: asOf });
    const watchdog = evaluateFreshnessWatchdog(contract, normalized, {
      now: asOf,
      schedulerHeartbeat,
      expectedSchedulerSlots: inputs.expectedSchedulerSlots || 2,
    });
    const row = {
      source_id: contract.id,
      contract_fingerprint: fingerprint(contract),
      health,
      relationship_coverage: coverage.get(contract.id) || normalizeRelationshipCoverage(),
      evidence: normalized.evidence,
      freshness_watchdog: watchdog,
    };
    if (normalized.runs.length || normalized.acquisition_receipts.length || watchdog) {
      row.operator = {
        ...(normalized.runs.length ? { runs: normalized.runs } : {}),
        ...(normalized.acquisition_receipts.length ? { acquisition_receipts: normalized.acquisition_receipts } : {}),
        clocks: {
          checked: normalizeClock(normalized.checked_at, "checked_at"),
          acquired: normalizeClock(normalized.acquired_at, "acquired_at"),
          scheduler_heartbeat: normalizeClock(schedulerHeartbeat?.observed_at, "scheduler_heartbeat"),
        },
      };
    }
    return row;
  });

  const projection = {
    schema: "cityscroll.source_health_observations.v1",
    generated_at: asOf,
    contract_count: contracts.length,
    observations,
  };
  const errors = validateSourceHealthProjection(registry, projection);
  if (errors.length) throw new Error(errors.join("\n"));
  return projection;
}

function warehouseReceipts(root, registry) {
  const directory = join(root, "warehouse/receipts/proof");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      let payload;
      try { payload = readJson(path); } catch { return []; }
      const sourceIds = receiptSourceIds(payload);
      const observedAt = observationDate(payload);
      if (!sourceIds.length || !observedAt) return [];
      const failed = payload?.status === "failed" || payload?.ok === false || payload?.passes === false;
      return sourceIds.map((sourceId) => {
        const publisherUpdatedAt = publisherDate(payload, observedAt, sourceId, registry);
        return {
          source_id: sourceId,
          observed_at: observedAt,
          publisher_updated_at: publisherUpdatedAt,
          publisher_clock_basis: publisherUpdatedAt ? "warehouse_source_summary" : null,
          status: failed ? "failed" : "succeeded",
          path: relative(root, path),
          adapter: "warehouse-acquisition-receipt",
          run_id: payload?.run_id || payload?.receipt_id || null,
          exact_error: failed
            ? redactCredentialValues(payload?.exact_error || payload?.error || payload?.message || "warehouse receipt reported failure")
            : null,
        };
      });
    });
}

function geographyReceipts(root) {
  const directory = join(root, "data/geography/receipts");
  if (!existsSync(directory)) return [];
  const rows = [];
  for (const layerEntry of readdirSync(directory, { withFileTypes: true })) {
    if (!layerEntry.isDirectory()) continue;
    const layerDirectory = join(directory, layerEntry.name);
    for (const name of readdirSync(layerDirectory).filter((value) => value.endsWith(".json")).sort()) {
      const path = join(layerDirectory, name);
      let payload;
      try { payload = readJson(path); } catch { continue; }
      const sourceId = payload?.source?.contract_id;
      const observedAt = validAt(payload?.acquired_at);
      if (!sourceId || !observedAt) continue;
      const accepted = Number(payload?.admission?.accepted_feature_count) || 0;
      rows.push({
        source_id: sourceId,
        observed_at: observedAt,
        publisher_updated_at: validAt(payload?.source?.publisher_updated_at),
        publisher_clock_basis: payload?.source?.publisher_updated_at ? "geography_source_receipt" : null,
        status: accepted > 0 ? "succeeded" : "failed",
        path: relative(root, path),
        adapter: "civic-geography-acquisition-receipt",
        run_id: `${payload.type || layerEntry.name}:${payload.boundary_vintage || name.replace(/\.json$/, "")}`,
        exact_error: accepted > 0 ? null : "geography receipt contains no accepted features",
      });
    }
  }
  return rows;
}

function serveObservations(root, registry) {
  const rows = [];
  const seenPaths = new Set();
  for (const contract of registry.contracts || []) {
    const serveContractId = contract?.freshness_contract?.serve_contract_id;
    const declaredPath = contract?.warehouse_snapshot?.artifact;
    const pathName = serveContractId ? SERVE_ARTIFACTS[serveContractId] : declaredPath;
    if (!pathName || seenPaths.has(`${contract.id}:${pathName}`)) continue;
    seenPaths.add(`${contract.id}:${pathName}`);
    const path = join(root, pathName);
    if (!existsSync(path)) continue;
    let payload;
    try { payload = readJson(path); } catch { continue; }
    const at = validAt(
      payload?.materialized_at
      || payload?.generated_at
      || payload?.observed_at
      || payload?.pulled_at,
    );
    if (!at) continue;
    const serveContract = serveContractId ? SERVE_LOOKUP_CONTRACTS[serveContractId] : null;
    if (serveContractId && !serveContract) {
      throw new Error(`${contract.id}: unknown serve contract ${serveContractId}`);
    }
    const findings = serveContract ? servePublishFindings(payload, serveContract, { now: at }) : [];
    rows.push({
      source_id: contract.id,
      at,
      status: findings.length ? "unavailable" : "current",
      fallback_valid: false,
      max_age_days: serveContract?.max_age_days || contract?.freshness_contract?.serving_max_age_days || null,
      path: pathName,
      basis: serveContract ? `serve_contract:${serveContract.id}` : "warehouse_materialization",
    });
  }
  return rows;
}

function additionalServeObservations(root, registry) {
  const contractIds = new Set((registry.contracts || []).map((contract) => contract.id));
  const rows = [];
  for (const lookup of ADDITIONAL_SERVE_LOOKUPS) {
    const path = join(root, lookup.path);
    if (!existsSync(path)) continue;
    let payload;
    try { payload = readJson(path); } catch { continue; }
    for (const sourceId of lookup.sourceIds(payload)) {
      const at = validAt(lookup.at(payload, sourceId));
      if (!at) continue;
      if (!contractIds.has(sourceId)) {
        throw new Error(`${sourceId}: serving receipt has no canonical contract`);
      }
      const contract = (registry.contracts || []).find((row) => row.id === sourceId);
      rows.push({
        source_id: sourceId,
        at,
        status: "current",
        fallback_valid: false,
        max_age_days: contract?.freshness_contract?.serving_max_age_days || null,
        path: lookup.path,
        basis: "warehouse_materialization",
      });
    }
  }
  return rows;
}

export function aboExternalAwardContractIds(registry) {
  const ids = [];
  for (const contract of registry?.contracts || []) {
    if (ABO_DATASET_CONTRACTS[contract.dataset_id] === contract.id) ids.push(contract.id);
  }
  return ids;
}

export function workerExternalAwardServeIsLive(root) {
  const workerPath = join(root, "worker/src/external_award.mjs");
  const entryPath = join(root, "worker/src/worker.mjs");
  if (!existsSync(workerPath) || !existsSync(entryPath)) return false;
  const worker = readFileSync(workerPath, "utf8");
  const entry = readFileSync(entryPath, "utf8");
  return worker.includes("export async function refreshAboAwards")
    && worker.includes("award:meta:last_refresh")
    && entry.includes("/externalaward")
    && entry.includes("refreshAboAwards");
}

function aboKvRefreshReceipt(root) {
  const path = join(root, "warehouse/receipts/proof/abo_kv_refresh_latest.json");
  if (!existsSync(path)) return null;
  try { return { path: relative(root, path), payload: readJson(path) }; } catch { return null; }
}

export function aboExternalAwardObservations(root, registry) {
  if (!workerExternalAwardServeIsLive(root)) return { acquisitions: [], serving: [] };
  const sourceIds = aboExternalAwardContractIds(registry);
  if (!sourceIds.length) return { acquisitions: [], serving: [] };
  const receipt = aboKvRefreshReceipt(root);
  const observedAt = validAt(
    receipt?.payload?.last_refresh
    || receipt?.payload?.observed_at
    || receipt?.payload?.refreshed_at,
  );
  const publisherAt = validAt(receipt?.payload?.publisher_updated_at || receipt?.payload?.refreshed);
  if (!observedAt) return { acquisitions: [], serving: [] };
  const path = receipt?.path || "worker/src/external_award.mjs";
  const acquisitions = sourceIds.map((sourceId) => ({
    source_id: sourceId,
    observed_at: observedAt,
    publisher_updated_at: publisherAt,
    publisher_clock_basis: publisherAt ? "publisher_receipt" : null,
    status: "succeeded",
    path,
    adapter: "worker-externalaward-refresh",
    run_id: receipt?.payload?.run_id || "award:meta:last_refresh",
    exact_error: null,
  }));
  const serving = sourceIds.map((sourceId) => ({
    source_id: sourceId,
    at: observedAt,
    status: "current",
    fallback_valid: false,
    max_age_days: registry.contracts.find((row) => row.id === sourceId)?.freshness_contract?.serving_max_age_days || null,
    path,
    basis: "worker_kv_externalaward",
  }));
  return { acquisitions, serving };
}

export function runtimeServedSourceIds(root, registry) {
  const ids = new Set();
  if (workerExternalAwardServeIsLive(root)) {
    for (const id of aboExternalAwardContractIds(registry)) ids.add(id);
  }
  for (const contract of registry?.contracts || []) {
    if (contract.status === "disabled") continue;
    if (contract.health_policy?.public_visibility !== "public") continue;
    if (["edge-materialized", "live-only", "inline-at-build"].includes(contract.delivery_tier)) {
      ids.add(contract.id);
    }
  }
  return ids;
}

export function sourceIdsWithAcquisitionOrServeEvidence(inputs = {}) {
  const ids = new Set();
  for (const row of inputs.warehouseReceipts || []) {
    if (row?.source_id && validAt(row.observed_at)) ids.add(row.source_id);
  }
  for (const row of inputs.serveObservations || []) {
    if (row?.source_id && validAt(row.at)) ids.add(row.source_id);
  }
  for (const row of inputs.scheduleObservations || []) {
    if (row?.source_id && validAt(row.observed_at)) ids.add(row.source_id);
  }
  return ids;
}

export function externalScheduleObservations(events = []) {
  const rows = [];
  for (const event of events) {
    const result = event?.result || event;
    const observedAt = validAt(result?.observed_at || event?.observed_at);
    if (!observedAt) continue;
    const runId = event?.run_key || result?.run_key || event?.event_id || null;
    for (const id of result?.healthy || []) {
      rows.push({
        source_id: id,
        observed_at: observedAt,
        status: "succeeded",
        path: event?.path || null,
        adapter: "source-contracts-live",
        run_id: runId,
        exact_error: null,
      });
    }
    for (const failure of result?.failures || []) {
      if (!failure?.id) continue;
      rows.push({
        source_id: failure.id,
        observed_at: observedAt,
        status: "failed",
        path: event?.path || null,
        adapter: "source-contracts-live",
        run_id: runId,
        exact_error: redactCredentialValues(failure.detail || "source contract check failed"),
      });
    }
  }
  return rows;
}

/** Normalize the external probe's per-source result into the same receipt shape
 * used by acquisitions. The legacy array projection above remains available to
 * callers that only need the old check rows. */
export function externalScheduleReceiptRows(events = []) {
  const rows = [];
  for (const event of events) {
    const result = event?.result || event;
    const observedAt = validAt(result?.observed_at || event?.observed_at);
    if (!observedAt) continue;
    const runKey = event?.run_key || result?.run_key || event?.event_id || `source-contracts-live:${observedAt}`;
    const explicit = Array.isArray(result?.receipts) ? result.receipts : [];
    if (explicit.length) {
      for (const receipt of explicit) {
        const normalized = {
          ...receipt,
          schema: receipt?.schema || ACQUISITION_RECEIPT_SCHEMA,
          source_contract_id: receipt?.source_contract_id,
          observed_at: receipt?.observed_at || observedAt,
          run_id: receipt?.run_id || runKey,
          publisher_clock_basis: Object.hasOwn(receipt || {}, "publisher_clock_basis")
            ? receipt.publisher_clock_basis : null,
          publisher_updated_at: Object.hasOwn(receipt || {}, "publisher_updated_at")
            ? receipt.publisher_updated_at : null,
          clock_kind: "check",
          path: event?.path || null,
          adapter: "source-contracts-live",
        };
        assertAcquisitionReceipt(normalized);
        rows.push(normalized);
      }
      continue;
    }
    for (const id of result?.healthy || []) {
      rows.push(normalizedReceipt({
        observed_at: observedAt,
        status: "succeeded",
        run_id: `${runKey}:${id}`,
      }, id, event?.path, "check"));
    }
    for (const failure of result?.failures || []) {
      if (!failure?.id) continue;
      rows.push({ ...normalizedReceipt({
        observed_at: observedAt,
        status: "failed",
        run_id: `${runKey}:${failure.id}`,
      }, failure.id, event?.path, "check"), exact_error: redactCredentialValues(failure.detail || "source contract check failed") });
    }
  }
  return rows;
}

export function externalScheduleHeartbeats(events = []) {
  return events
    .map((event) => {
      const result = event?.result || event;
      const observedAt = validAt(result?.scheduler_heartbeat?.observed_at || result?.observed_at || event?.observed_at);
      if (!observedAt) return null;
      const runId = result?.scheduler_heartbeat?.run_id
        || event?.run_key
        || result?.run_key
        || event?.event_id
        || `source-contracts-live:${observedAt}`;
      return {
        source_contract_id: "source-contracts-live",
        observed_at: observedAt,
        status: result?.scheduler_heartbeat?.status || "succeeded",
        run_id: runId,
        publisher_clock_basis: null,
        publisher_updated_at: null,
        path: event?.path || null,
        adapter: "source-contracts-live",
      };
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at));
}

function externalScheduleEvents(root, stateDir) {
  if (!stateDir) return [];
  const outboxDir = join(stateDir, "outbox");
  if (existsSync(outboxDir)) {
    const events = readdirSync(outboxDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .flatMap((name) => {
        const path = join(outboxDir, name);
        try {
          const event = readJson(path);
          return event?.job_id === "source-contracts-live"
            ? [{ ...event, path: relative(root, path) }]
            : [];
        } catch {
          return [];
        }
      });
    if (events.length) return events;
  }
  const directory = join(stateDir, "results/source-contracts-live");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      try { return [{ ...readJson(path), path: relative(root, path) }]; } catch { return []; }
    });
}

export function loadSourceHealthInputs(root, registry, options = {}) {
  const coveragePath = join(root, "entity_resolution/source_coverage.json");
  const events = externalScheduleEvents(root, options.externalScheduleStateDir);
  const aboRuntime = aboExternalAwardObservations(root, registry);
  return {
    warehouseReceipts: [
      ...warehouseReceipts(root, registry),
      ...geographyReceipts(root),
      ...aboRuntime.acquisitions,
    ],
    serveObservations: [
      ...serveObservations(root, registry),
      ...additionalServeObservations(root, registry),
      ...aboRuntime.serving,
    ],
    scheduleObservations: externalScheduleReceiptRows(events),
    schedulerHeartbeats: externalScheduleHeartbeats(events),
    runtimeServedSourceIds: [...runtimeServedSourceIds(root, registry)],
    coverageCensus: existsSync(coveragePath) ? readJson(coveragePath) : null,
  };
}

export function sourceHealthProjectionText(projection) {
  return `${JSON.stringify(projection, null, 2)}\n`;
}
