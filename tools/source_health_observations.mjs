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
  ]);
}

function publisherDate(payload) {
  return newestAt([
    payload?.publisher_updated_at,
    payload?.source_summary?.publisher_updated_at,
    payload?.source_summary?.start_date_max,
    payload?.rows_updated_at,
  ]);
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
    runs: [],
  };
}

function applyAcquisition(target, input, kind) {
  const at = validAt(input.observed_at);
  if (!at) return;
  if (!target.checked_at || Date.parse(at) >= Date.parse(target.checked_at)) {
    target.checked_at = at;
    target.acquisition_status = input.status || "succeeded";
    target.acquired_at = target.acquisition_status === "succeeded" ? at : target.acquired_at;
    if (input.publisher_updated_at) {
      target.publisher_updated_at = validAt(input.publisher_updated_at);
      target.publisher_clock_basis = input.publisher_clock_basis || "publisher_receipt";
    }
  }
  target.evidence.push(evidenceItem(kind, input.path, at, input.status || "succeeded"));
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
  const coverage = coverageByContract(registry, inputs.coverageCensus);

  const observations = contracts.map((contract) => {
    const normalized = byId.get(contract.id);
    if (["failed", "held"].includes(normalized.acquisition_status) && normalized.serving.status === "current") {
      normalized.serving.status = "fallback";
      normalized.serving.fallback_valid = true;
    }
    normalized.evidence = sortedEvidence(normalized.evidence);
    normalized.runs = sortedRuns(normalized.runs);
    const health = evaluateSourceHealth(contract, normalized, { now: asOf });
    const row = {
      source_id: contract.id,
      contract_fingerprint: fingerprint(contract),
      health,
      relationship_coverage: coverage.get(contract.id) || normalizeRelationshipCoverage(),
      evidence: normalized.evidence,
    };
    if (normalized.runs.length) row.operator = { runs: normalized.runs };
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

function warehouseReceipts(root) {
  const directory = join(root, "warehouse/receipts/proof");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      let payload;
      try { payload = readJson(path); } catch { return []; }
      const sourceId = payload?.source_contract_id;
      const observedAt = observationDate(payload);
      if (!sourceId || !observedAt) return [];
      const failed = payload?.status === "failed" || payload?.ok === false || payload?.passes === false;
      return [{
        source_id: sourceId,
        observed_at: observedAt,
        publisher_updated_at: publisherDate(payload),
        publisher_clock_basis: publisherDate(payload) ? "warehouse_source_summary" : null,
        status: failed ? "failed" : "succeeded",
        path: relative(root, path),
        adapter: "warehouse-acquisition-receipt",
        run_id: payload?.run_id || payload?.receipt_id || null,
        exact_error: failed
          ? redactCredentialValues(payload?.exact_error || payload?.error || payload?.message || "warehouse receipt reported failure")
          : null,
      }];
    });
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
    const at = validAt(payload?.materialized_at || payload?.generated_at);
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
  return {
    warehouseReceipts: warehouseReceipts(root),
    serveObservations: serveObservations(root, registry),
    scheduleObservations: externalScheduleObservations(events),
    coverageCensus: existsSync(coveragePath) ? readJson(coveragePath) : null,
  };
}

export function sourceHealthProjectionText(projection) {
  return `${JSON.stringify(projection, null, 2)}\n`;
}
