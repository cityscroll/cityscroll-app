import registry from "./data/public_body_calendar_contracts.json" with { type: "json" };

export const PUBLIC_BODY_CALENDAR_SOURCE_SYSTEM = "public_body_calendar";
export const PUBLIC_BODY_CALENDAR_REGISTRY_SCHEMA = "cityscroll.public_body_calendar_contract_registry.v1";
export const PUBLIC_BODY_CALENDAR_INPUT_SCHEMA = "cityscroll.public_body_calendar_input.v1";
export const PUBLIC_BODY_CALENDAR_HEALTH_STATES = Object.freeze([
  "fresh-empty",
  "fresh",
  "stale",
  "failed",
  "unobserved",
]);
export const PUBLIC_BODY_CALENDAR_TEMPORAL_BASES = Object.freeze([
  "explicit_instance",
  "published_recurrence",
]);

const registryContracts = Array.isArray(registry?.contracts) ? registry.contracts : [];
export const PUBLIC_BODY_CALENDAR_CONTRACT_REGISTRY = registry;
export const PUBLIC_BODY_CALENDAR_CONTRACTS = Object.freeze(registryContracts);
export const PUBLIC_BODY_CALENDAR_CONTRACT_IDS = Object.freeze(registryContracts.map((contract) => contract.id));

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function positiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function officialUrl(value) {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function contractById(id, contracts = PUBLIC_BODY_CALENDAR_CONTRACTS) {
  return contracts.find((contract) => contract?.id === id) || null;
}

export function validatePublicBodyCalendarRegistry(value = PUBLIC_BODY_CALENDAR_CONTRACT_REGISTRY) {
  const errors = [];
  if (value?.schema !== PUBLIC_BODY_CALENDAR_REGISTRY_SCHEMA) errors.push("schema is missing or unsupported");
  if (value?.family !== PUBLIC_BODY_CALENDAR_SOURCE_SYSTEM) errors.push("family must be public_body_calendar");
  if (value?.version !== 1) errors.push("version must be 1");
  if (!Array.isArray(value?.contracts)) {
    errors.push("contracts must be an array");
    return errors;
  }
  const ids = new Set();
  for (const contract of value.contracts) {
    const label = contract?.id || "(missing id)";
    if (ids.has(contract?.id)) errors.push(`${label}: duplicate id`);
    ids.add(contract?.id);
    for (const field of ["id", "source_contract_id", "institution_ref", "name", "official_source_url", "format", "temporal_basis", "schedule_basis"]) {
      if (!text(contract?.[field])) errors.push(`${label}: missing ${field}`);
    }
    if (contract?.source_contract_id !== contract?.id) errors.push(`${label}: source_contract_id must equal id`);
    if (!officialUrl(contract?.official_source_url)) errors.push(`${label}: official_source_url must be an http(s) URL`);
    if (!PUBLIC_BODY_CALENDAR_TEMPORAL_BASES.includes(contract?.temporal_basis)) {
      errors.push(`${label}: unsupported temporal_basis`);
    }
    if (!positiveNumber(contract?.cadence?.minimum_observation_hours)) errors.push(`${label}: cadence.minimum_observation_hours is required`);
    if (!positiveNumber(contract?.cadence?.max_stale_hours)) errors.push(`${label}: cadence.max_stale_hours is required`);
    if (!positiveNumber(contract?.freshness?.max_age_hours)) errors.push(`${label}: freshness.max_age_hours is required`);
    if (contract?.cadence?.max_stale_hours !== contract?.freshness?.max_age_hours) {
      errors.push(`${label}: cadence and freshness stale limits must agree`);
    }
    for (const state of PUBLIC_BODY_CALENDAR_HEALTH_STATES) {
      if (!contract?.health_states?.includes(state)) errors.push(`${label}: health_states missing ${state}`);
    }
  }
  const expected = new Set(["nycps_pep", "ccrb_board", "brooklyn_borough_board", "brooklyn_bp_ulurp", "hplus_h_cab"]);
  if (ids.size !== expected.size || [...ids].some((id) => !expected.has(id))) {
    errors.push("registry must contain exactly the five precommissioned contracts");
  }
  return errors;
}

export function publicBodyCalendarContract(sourceContractId, contracts = PUBLIC_BODY_CALENDAR_CONTRACTS) {
  const id = text(sourceContractId);
  return id ? contractById(id, contracts) : null;
}

export function publicBodyCalendarIdentity({ source_contract_id, publisher_identifier, publisher_event_id, publisher_key } = {}) {
  const contractId = text(source_contract_id);
  const publisherId = text(publisher_identifier || publisher_event_id || publisher_key);
  if (!contractId || !publisherId) return null;
  return `meeting:${PUBLIC_BODY_CALENDAR_SOURCE_SYSTEM}:${contractId}:${publisherId}`;
}

export function normalizePublicBodyCalendarInput(value = {}, { contracts = PUBLIC_BODY_CALENDAR_CONTRACTS } = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sourceContractId = text(input.source_contract_id);
  const contract = contractById(sourceContractId, contracts);
  if (!contract) throw new TypeError(`unsupported public body calendar source_contract_id: ${sourceContractId || "(missing)"}`);
  const publisherIdentifier = text(input.publisher_identifier || input.publisher_event_id || input.publisher_key || input.event_id);
  if (!publisherIdentifier) throw new TypeError("public body calendar publisher identifier is required");
  const sourceUrl = officialUrl(input.source_url || input.official_source_url || input.record_url);
  if (!sourceUrl) throw new TypeError("public body calendar source_url must be an http(s) URL");
  const receipt = input.source_receipt || input.observed_receipt || null;
  if (!receipt || typeof receipt !== "object") throw new TypeError("public body calendar source_receipt is required");
  const temporalBasis = text(input.temporal_basis) || contract.temporal_basis;
  if (!PUBLIC_BODY_CALENDAR_TEMPORAL_BASES.includes(temporalBasis)) {
    throw new TypeError(`unsupported public body calendar temporal_basis: ${temporalBasis}`);
  }
  return {
    ...input,
    schema: PUBLIC_BODY_CALENDAR_INPUT_SCHEMA,
    source_system: PUBLIC_BODY_CALENDAR_SOURCE_SYSTEM,
    source_contract_id: sourceContractId,
    publisher_identifier: publisherIdentifier,
    source_url: sourceUrl,
    source_receipt: receipt,
    temporal_basis: temporalBasis,
    schedule_basis: text(input.schedule_basis) || contract.schedule_basis,
    institution_ref: text(input.institution_ref) || contract.institution_ref,
    official_source_url: officialUrl(input.official_source_url) || contract.official_source_url,
  };
}

export function publicBodyCalendarIdentityCollisions(records = []) {
  const byIdentity = new Map();
  for (const record of records) {
    const identity = publicBodyCalendarIdentity(record);
    if (!identity) continue;
    const bucket = byIdentity.get(identity) || [];
    bucket.push(record);
    byIdentity.set(identity, bucket);
  }
  return [...byIdentity.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .map(([identity, recordsForIdentity]) => ({ identity, records: recordsForIdentity }));
}

export function assertNoPublicBodyCalendarIdentityCollisions(records = []) {
  const collisions = publicBodyCalendarIdentityCollisions(records);
  if (collisions.length) {
    throw new TypeError(`public body calendar identity collision: ${collisions.map((row) => row.identity).join(", ")}`);
  }
  return records;
}

function observationFor(observations, contractId) {
  if (Array.isArray(observations)) {
    return observations.find((observation) => (observation?.source_contract_id || observation?.id) === contractId) || null;
  }
  return observations?.[contractId] || null;
}

export function publicBodyCalendarContractStatus(contract, observation, now = new Date().toISOString()) {
  const sourceContractId = text(contract?.source_contract_id || contract?.id);
  if (!sourceContractId) throw new TypeError("source contract id is required");
  if (!observation) return { source_contract_id: sourceContractId, status: "unobserved", row_count: null, observed_at: null };
  if (observation.status === "failed" || observation.fetch_status === "failed" || observation.ok === false) {
    return { source_contract_id: sourceContractId, status: "failed", row_count: null, observed_at: text(observation.observed_at || observation.checked_at) };
  }
  const observedAt = Date.parse(String(observation.observed_at || observation.checked_at || ""));
  if (!Number.isFinite(observedAt)) return { source_contract_id: sourceContractId, status: "unobserved", row_count: null, observed_at: null };
  const current = Date.parse(String(now));
  const maxAge = Number(contract?.freshness?.max_age_hours || contract?.cadence?.max_stale_hours || 0) * 60 * 60 * 1000;
  if (!Number.isFinite(current) || current - observedAt > maxAge) {
    return { source_contract_id: sourceContractId, status: "stale", row_count: Number(observation.row_count || 0), observed_at: new Date(observedAt).toISOString() };
  }
  const rowCount = Number(observation.row_count ?? observation.rows?.length ?? observation.records?.length ?? 0);
  return { source_contract_id: sourceContractId, status: rowCount === 0 ? "fresh-empty" : "fresh", row_count: rowCount, observed_at: new Date(observedAt).toISOString() };
}

export function buildPublicBodyCalendarCoverage({ observations = [], now = new Date().toISOString(), contracts = PUBLIC_BODY_CALENDAR_CONTRACTS } = {}) {
  const rows = contracts.map((contract) => publicBodyCalendarContractStatus(
    contract,
    observationFor(observations, contract.id),
    now,
  ));
  return {
    family: PUBLIC_BODY_CALENDAR_SOURCE_SYSTEM,
    checked_at: now,
    contracts: rows,
  };
}
