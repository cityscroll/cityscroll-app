import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SOURCE_VINTAGE_STATUS_SCHEMA = "cityscroll.source_vintage_status.v1";
export const SOURCE_VINTAGE_STATUSES = Object.freeze([
  "current",
  "ingestion-stale",
  "source-vintage-stale",
  "unknown",
]);

const VERIFIED_STATES = new Set(["verified"]);
const PERMITTED_RELATIONS = new Set([
  "same-measure-newer",
  "newer-official-context",
  "alternate-format",
]);
const CONTEXT_ONLY_RELATION = "newer-official-context";

function validInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value.trim())) return null;
  const text = value.trim();
  const epoch = Date.parse(
    /T/.test(text) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? `${text}Z` : text,
  );
  if (!Number.isFinite(epoch) || new Date(epoch).getUTCFullYear() <= 1970) return null;
  return new Date(epoch).toISOString();
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sortedStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()))].sort();
}

function sourceIds(source, contract) {
  return new Set([
    ...sortedStrings(source?.alternate_source_ids),
    ...sortedStrings(contract?.alternate_source_ids),
  ]);
}

function alternateId(alternate) {
  return alternate?.alternate_id || alternate?.source_id || alternate?.id || null;
}

function alternateRecords(registry) {
  if (Array.isArray(registry)) return registry;
  if (Array.isArray(registry?.alternates)) return registry.alternates;
  if (registry && typeof registry === "object") {
    return Object.entries(registry).map(([id, value]) => ({ alternate_id: id, ...value }));
  }
  return [];
}

function frontier(value) {
  const coverage = value?.observed_coverage || value?.frontier || value || {};
  const fiscalYear = Number(coverage.max_fiscal_year);
  const date = validInstant(coverage.max_date || coverage.max_date_at);
  const hasFiscalYear = Number.isInteger(fiscalYear) && fiscalYear >= 1900 && fiscalYear <= 2200;
  if (hasFiscalYear && date) return { kind: null, value: null, basis: "ambiguous_frontier" };
  if (hasFiscalYear) return { kind: "fiscal_year", value: fiscalYear, basis: coverage.basis || null };
  if (date) return { kind: "date", value: date, basis: coverage.basis || null };
  return { kind: null, value: null, basis: null };
}

function frontierKnown(value) {
  return Boolean(value?.kind && value?.value !== null);
}

function compareFrontiers(left, right) {
  if (!frontierKnown(left) || !frontierKnown(right) || left.kind !== right.kind) return null;
  if (left.kind === "date") return Date.parse(right.value) > Date.parse(left.value);
  return right.value > left.value;
}

function frontierSortValue(value) {
  return value.kind === "date" ? Date.parse(value.value) : value.value;
}

function healthState(source, healthObservation, options) {
  const retrieval = source?.cityscroll_retrieval;
  const status = retrieval?.status;
  const health = healthObservation?.health || healthObservation || null;
  const healthStatus = health?.status || null;
  const reasons = new Set(Array.isArray(health?.reason_codes) ? health.reason_codes : []);
  const staleReasons = [];

  if (!retrieval || !["succeeded"].includes(status)) {
    staleReasons.push(status ? `retrieval-${status}` : "retrieval-missing");
  }
  if (["Delayed", "Limited-coverage"].includes(healthStatus)) staleReasons.push("health-cadence-breached");
  if (reasons.has("acquisition-clock-stale")) staleReasons.push("acquisition-clock-stale");
  if (reasons.has("acquisition-failed") || reasons.has("acquisition-held")) staleReasons.push("acquisition-failed");
  if (reasons.has("acquisition-status-unknown") || reasons.has("observation-missing")) staleReasons.push("retrieval-missing");

  const asOf = validInstant(options?.asOf);
  const retrievedAt = validInstant(retrieval?.retrieved_at);
  const tolerance = finiteNonNegative(
    source?.expected_lag_tolerance_days ?? options?.expected_lag_tolerance_days,
  );
  if (asOf && retrievedAt && tolerance !== null) {
    const ageDays = (Date.parse(asOf) - Date.parse(retrievedAt)) / 86_400_000;
    if (ageDays > tolerance) staleReasons.push("retrieval-lag-breached");
  }

  return {
    stale: staleReasons.length > 0,
    status: healthStatus || (status === "succeeded" ? "Healthy" : "Source-unavailable"),
    reason_codes: [...new Set(staleReasons)].sort(),
    retrieved_at: retrievedAt,
    tolerance_days: tolerance,
  };
}

function verifiedNewerAlternates(source, contract, registry, observedFrontier) {
  const allowedIds = sourceIds(source, contract);
  const records = alternateRecords(registry);
  return records
    .filter((alternate) => {
      const id = alternateId(alternate);
      const relation = alternate?.relation || alternate?.semantic_relation;
      const state = alternate?.verification_state || alternate?.verification_status;
      if (!id || !allowedIds.has(id) || !VERIFIED_STATES.has(state) || !PERMITTED_RELATIONS.has(relation)) return false;
      if (!alternate.publisher && !alternate.publisher_name) return false;
      if (typeof (alternate.semantic_scope || "") !== "string" || !alternate.semantic_scope.trim()) return false;
      if (!alternate.url && !alternate.artifact_url) return false;
      if (!validInstant(alternate.evidence_at || alternate.evidence_timestamp || alternate.observed_at)) return false;
      const alternateFrontier = frontier(alternate);
      return compareFrontiers(observedFrontier, alternateFrontier) === true;
    })
    .map((alternate) => {
      const id = alternateId(alternate);
      const relation = alternate.relation || alternate.semantic_relation;
      return {
        alternate_source_id: id,
        relation,
        frontier: frontier(alternate),
        replacement_eligible: relation !== CONTEXT_ONLY_RELATION,
      };
    })
    .sort((left, right) => (
      frontierSortValue(right.frontier) - frontierSortValue(left.frontier)
      || left.alternate_source_id.localeCompare(right.alternate_source_id)
    ));
}

/**
 * Classify semantic freshness without using wall-clock age as a proxy for a
 * coverage frontier. Retrieval/cadence health wins first; only a verified,
 * owned, newer alternate can produce source-vintage-stale.
 */
export function classifySourceVintage({
  contract = null,
  source = null,
  observation = null,
  healthObservation = null,
  alternateRegistry = null,
  alternates = null,
  asOf = null,
} = {}) {
  const vintage = source || observation || {};
  const health = healthState(vintage, healthObservation, { asOf });
  const observedFrontier = frontier(vintage);
  const newerAlternates = verifiedNewerAlternates(
    vintage,
    contract,
    alternateRegistry || alternates,
    observedFrontier,
  );
  const semanticCurrent = !health.stale && frontierKnown(observedFrontier)
    ? newerAlternates.length === 0
    : null;
  let status = "unknown";
  if (health.stale) status = "ingestion-stale";
  else if (!frontierKnown(observedFrontier)) status = "unknown";
  else if (newerAlternates.length) status = "source-vintage-stale";
  else status = "current";

  return {
    source_id: vintage.source_id || contract?.id || null,
    status,
    vintage_status: status,
    ingestion_stale: health.stale,
    ingestion_status: health.status,
    ingestion_health: {
      status: health.status,
      stale: health.stale,
      reason_codes: health.reason_codes,
    },
    semantic_current: semanticCurrent,
    observed_frontier: observedFrontier,
    newer_alternate_source_ids: newerAlternates.map((alternate) => alternate.alternate_source_id),
    alternate_source_id: newerAlternates[0]?.alternate_source_id || null,
    replacement_source_ids: newerAlternates
      .filter((alternate) => alternate.replacement_eligible)
      .map((alternate) => alternate.alternate_source_id),
    alternates: newerAlternates,
    ingestion_reason_codes: health.reason_codes,
    reason_codes: status === "unknown"
      ? [frontierKnown(observedFrontier) ? "no-verified-newer-alternate" : "frontier-unknown"]
      : status === "ingestion-stale"
        ? health.reason_codes
        : status === "source-vintage-stale"
          ? ["verified-newer-alternate"]
          : [],
    retrieval: {
      retrieved_at: health.retrieved_at,
      expected_lag_tolerance_days: health.tolerance_days,
    },
  };
}

export function buildSourceVintageStatusProjection({
  registry = null,
  vintageObservations = null,
  healthObservations = null,
  alternateRegistry = null,
  alternates = null,
  asOf = null,
} = {}) {
  const contracts = [...(registry?.contracts || [])].sort((left, right) => left.id.localeCompare(right.id));
  const vintageById = new Map((vintageObservations?.observations || []).map((row) => [row.source_id, row]));
  const healthById = new Map((healthObservations?.observations || []).map((row) => [row.source_id, row]));
  const evaluationAt = asOf || vintageObservations?.generated_at || healthObservations?.generated_at || null;
  const observations = contracts.map((contract) => classifySourceVintage({
    contract,
    source: vintageById.get(contract.id) || null,
    healthObservation: healthById.get(contract.id) || null,
    alternateRegistry,
    alternates,
    asOf: evaluationAt,
  }));
  return {
    schema: SOURCE_VINTAGE_STATUS_SCHEMA,
    generated_at: validInstant(evaluationAt),
    contract_count: contracts.length,
    observations,
  };
}

export function validateSourceVintageStatusProjection(registry, projection) {
  const errors = [];
  const contracts = Array.isArray(registry?.contracts) ? registry.contracts : [];
  const ids = new Set(contracts.map((contract) => contract.id));
  if (projection?.schema !== SOURCE_VINTAGE_STATUS_SCHEMA) errors.push("schema must be cityscroll.source_vintage_status.v1");
  if (projection?.contract_count !== contracts.length) errors.push("contract_count must match canonical source contracts");
  const seen = new Set();
  for (const row of projection?.observations || []) {
    if (!ids.has(row?.source_id)) errors.push(`${row?.source_id || "<missing>"}: source has no canonical contract`);
    if (seen.has(row?.source_id)) errors.push(`${row.source_id}: duplicate source vintage status`);
    seen.add(row?.source_id);
    if (!SOURCE_VINTAGE_STATUSES.includes(row?.status)) errors.push(`${row?.source_id}: invalid status`);
    if (typeof row?.ingestion_stale !== "boolean") errors.push(`${row?.source_id}: ingestion_stale must be boolean`);
    if (row?.semantic_current !== null && typeof row?.semantic_current !== "boolean") {
      errors.push(`${row?.source_id}: semantic_current must be boolean or null`);
    }
  }
  for (const id of ids) if (!seen.has(id)) errors.push(`${id}: missing source vintage status`);
  return errors.sort();
}

export function sourceVintageStatusProjectionText(projection) {
  return `${JSON.stringify(projection, null, 2)}\n`;
}

export function loadSourceVintageStatusInputs(root, options = {}) {
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));
  return {
    registry: options.registry || read(join(root, "site/data/source_contracts.json")),
    vintageObservations: options.vintageObservations || read(join(root, "site/data/source_vintage_observations.json")),
    healthObservations: options.healthObservations || read(join(root, "site/data/source_health_observations.json")),
    alternateRegistry: options.alternateRegistry || null,
    asOf: options.asOf || null,
  };
}
