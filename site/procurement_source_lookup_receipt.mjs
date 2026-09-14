/**
 * Build-time exact-key lookup evidence for one procurement object.
 *
 * This projection is evidence only. It never participates in object identity
 * construction and is deliberately small enough to travel with one object.
 */

export const PROCUREMENT_SOURCE_LOOKUP_RECEIPT_SCHEMA =
  "cityscroll.procurement_source_lookup_receipt.v1";
export const PROCUREMENT_SOURCE_LOOKUP_RECEIPT_VERSION = 1;

export const PROCUREMENT_LOOKUP_SOURCES = Object.freeze([
  "city_record",
  "passport_public_contracts",
  "passport_public_rfx",
  "checkbook_contracts",
  "checkbook_spending",
  "nys_abo_awards",
]);

const STATES = new Set(["corroborated", "checked-no-match", "ambiguous", "unavailable", "stale", "not-checked"]);

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

export function lookupKey(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase() || null;
}

function snapshotOf(row) {
  if (row?.snapshot && typeof row.snapshot === "object") return row.snapshot;
  for (const value of [row?.normalized_snapshot, row?.raw_snapshot]) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* an unreadable source row cannot match */ }
  }
  return {};
}

function sourceRef(row) {
  return text(row?.source_observation_ref)
    || (text(row?.source_system) && text(row?.source_system_id || row?.source_id)
      ? `${text(row.source_system).toLowerCase()}:${text(row.source_system_id || row.source_id)}`
      : null);
}

function sourceSystem(row) {
  return text(row?.source_system)?.toLowerCase() || null;
}

function keysForObject(object, observations, index = null) {
  const contract = new Set((object?.identity_keys?.contract_ids || []).map(lookupKey).filter(Boolean));
  const epin = new Set((object?.identity_keys?.epins || []).map(lookupKey).filter(Boolean));
  const rfx = new Set((object?.identity_keys?.solicitation_ids || []).map(lookupKey).filter(Boolean));
  const refs = new Set(object?.source_observation_refs || []);
  const tiedRows = refs.length && index?.byRef
    ? refs.map((ref) => index.byRef.get(ref)).filter(Boolean)
    : observations;
  for (const row of tiedRows) {
    if (!refs.has(sourceRef(row))) continue;
    const snapshot = snapshotOf(row);
    for (const value of [snapshot.contract_id, snapshot.contractId, snapshot.id, snapshot.prime_contract_id]) {
      const key = lookupKey(value); if (key) contract.add(key);
    }
    for (const value of [snapshot.epin, snapshot.epin_norm, snapshot.pin, snapshot.prime_contract_pin]) {
      const key = lookupKey(value); if (key) epin.add(key);
    }
    for (const value of [snapshot.rfp_id, snapshot.rfx_id, snapshot.solicitation_id, snapshot.solicitation_number]) {
      const key = lookupKey(value); if (key) rfx.add(key);
    }
  }
  return { contract: [...contract].sort(), epin: [...epin].sort(), rfx: [...rfx].sort() };
}

function materializationStatus(materializations, system, observations = []) {
  const alias = system === "checkbook_contracts" ? "analytics_registered_contracts"
    : system === "checkbook_spending" ? "analytics_payments" : system;
  const value = materializations?.[system] || materializations?.[alias];
  if (!value) return {
    status: observations.some((row) => sourceSystem(row) === system) ? "available" : "unavailable",
    vintage: null,
    asOf: null,
  };
  const status = text(typeof value === "string" ? value : value.status)?.toLowerCase();
  const normalized = ["available", "partial", "stale", "unavailable"].includes(status) ? status : "available";
  return {
    status: normalized,
    vintage: text(typeof value === "object" ? (value.snapshot_vintage || value.snapshot_date || value.generated_at) : null),
    asOf: text(typeof value === "object" ? (value.lookup_as_of || value.as_of || value.generated_at) : null),
  };
}

function rowsFor(materializations, system) {
  const alias = system === "checkbook_contracts" ? "analytics_registered_contracts"
    : system === "checkbook_spending" ? "analytics_payments" : system;
  const value = materializations?.[system] || materializations?.[alias];
  return Array.isArray(value) ? value : (Array.isArray(value?.rows) ? value.rows : []);
}

function sourceObservationRows(observations, system) {
  return observations.filter((row) => sourceSystem(row) === system);
}

function buildLookupIndex(observations, materializations) {
  const byRef = new Map();
  const bySystemKey = new Map();
  const analyticalBySystemKey = new Map();
  const add = (map, system, key, row) => {
    if (!key) return;
    const bucketKey = `${system}:${key}`;
    const bucket = map.get(bucketKey);
    if (bucket) bucket.push(row); else map.set(bucketKey, [row]);
  };
  for (const row of observations) {
    const ref = sourceRef(row);
    if (ref) byRef.set(ref, row);
    const system = sourceSystem(row);
    const keys = rowKeys(row, system);
    add(bySystemKey, system, keys.contract, row);
    add(bySystemKey, system, keys.epin, row);
    add(bySystemKey, system, keys.rfx, row);
  }
  for (const system of ["checkbook_contracts", "checkbook_spending"]) {
    for (const row of rowsFor(materializations, system)) {
      const keys = rowKeys(row, system);
      add(analyticalBySystemKey, system, keys.contract, row);
      add(analyticalBySystemKey, system, keys.epin, row);
    }
  }
  return { byRef, bySystemKey, analyticalBySystemKey };
}

function rowKeys(row, system) {
  const snapshot = snapshotOf(row);
  const contract = lookupKey(snapshot.contract_id || snapshot.contractId || snapshot.id || snapshot.prime_contract_id || row?.prime_contract_id);
  const epin = lookupKey(snapshot.epin || snapshot.epin_norm || snapshot.pin || snapshot.prime_contract_pin || row?.pin);
  const rfx = lookupKey(snapshot.rfp_id || snapshot.rfx_id || snapshot.solicitation_id || snapshot.solicitation_number);
  const document = lookupKey(snapshot.documentId || snapshot.document_id || snapshot.transactionId || snapshot.spendingId || row?.document_id);
  return { contract, epin, rfx, document, system };
}

function isAboApplicable(object, observations) {
  const refs = Array.isArray(object?.source_observation_refs) ? object.source_observation_refs : [];
  const tied = refs.length ? observations.filter((row) => refs.includes(sourceRef(row))) : observations;
  const systems = new Set(tied.map(sourceSystem));
  if (systems.has("nys_abo_awards")) return true;
  const scope = `${object?.authority_scope || ""} ${object?.typed_authority || ""} ${object?.source_scope || ""} ${tied.map((row) => {
    const snapshot = snapshotOf(row);
    return `${snapshot.agency || ""} ${snapshot.agency_name || ""}`;
  }).join(" ")}`.toLowerCase();
  if (/\b(nys|new york state|authority|abo)\b/.test(scope)) return true;
  // A named NYC agency is enough to establish that the state-authority source
  // is outside this object's typed source scope. An object without an agency
  // declaration remains applicable rather than being silently narrowed.
  if (/\b(department|mayor|city of new york|nyc|dhs|housing authority)\b/.test(scope)) return false;
  return true;
}

function receiptForSource({ system, object, observations, materializations, lookupAsOf, index }) {
  const keys = keysForObject(object, observations, index);
  const materialized = materializationStatus(materializations, system, observations);
  const applicable = system !== "nys_abo_awards" || isAboApplicable(object, observations);
  const queriedKeys = system === "passport_public_rfx"
    ? [...new Set([...keys.epin, ...keys.rfx])].sort()
    : system === "checkbook_spending" ? [...keys.contract].sort() : [...new Set([...keys.contract, ...keys.epin])].sort();
  const base = {
    source_system: system,
    applicability: applicable ? "applicable" : "not-applicable",
    state: applicable ? "not-checked" : "not-applicable",
    queried_keys: queriedKeys,
    matched_source_observation_refs: [],
    matched_analytical_row_refs: [],
    basis: null,
    snapshot_vintage: materialized.vintage,
  };
  if (!applicable) return base;
  if (["unavailable", "stale"].includes(materialized.status)) {
    return { ...base, state: materialized.status, basis: `materialization_${materialized.status}` };
  }
  if (!queriedKeys.length) return base;

  const candidates = new Map();
  const sourceKeys = system === "passport_public_rfx" ? [...keys.epin, ...keys.rfx]
    : system === "checkbook_spending" ? keys.contract : [...keys.contract, ...keys.epin];
  for (const key of sourceKeys) for (const row of (index.bySystemKey.get(`${system}:${key}`) || [])) {
    const ref = sourceRef(row); if (ref) candidates.set(ref, row);
  }
  const matches = [...candidates.keys()];
  const analytical = [];
  const analyticalCandidates = new Map();
  for (const key of (system === "checkbook_spending" ? keys.contract : [...keys.contract, ...keys.epin])) {
    for (const row of (index.analyticalBySystemKey.get(`${system}:${key}`) || [])) analyticalCandidates.set(row, row);
  }
  for (const row of analyticalCandidates.values()) {
    const id = text(row.prime_contract_id || row.contract_id || row.contractId || row.document_id || row.documentId);
    if (id) analytical.push(`${system}:row:${id}`);
  }
  const refs = [...new Set(matches)].sort();
  const analyticalRefs = [...new Set(analytical)].sort();
  const candidateCount = refs.length + analyticalRefs.length;
  const state = candidateCount > 1 ? "ambiguous" : candidateCount === 1 ? "corroborated" : "checked-no-match";
  const basis = system === "checkbook_contracts"
    ? (keys.contract.length ? "exact_prime_contract_id" : "exact_pin")
    : system === "checkbook_spending" ? "exact_prime_contract_document_relationship"
      : system === "passport_public_rfx" ? "exact_epin_or_rfx_id" : "exact_retained_observation_key";
  const result = {
    ...base,
    state,
    matched_source_observation_refs: refs,
    matched_analytical_row_refs: analyticalRefs,
    basis,
  };
  if (materialized.status === "available" || materialized.status === "partial") {
    result.lookup_as_of = text(materialized.asOf || lookupAsOf);
  }
  return result;
}

export function buildProcurementSourceLookupReceipt({
  object = {}, observations = [], materializations = {}, generatedAt = null, lookupAsOf = generatedAt, index = null,
} = {}) {
  const safeObservations = Array.isArray(observations) ? observations : [];
  const lookupIndex = index || buildLookupIndex(safeObservations, materializations);
  const sources = PROCUREMENT_LOOKUP_SOURCES.map((system) => receiptForSource({
    system, object, observations: safeObservations, materializations, lookupAsOf, index: lookupIndex,
  }));
  return Object.freeze({
    schema: PROCUREMENT_SOURCE_LOOKUP_RECEIPT_SCHEMA,
    version: PROCUREMENT_SOURCE_LOOKUP_RECEIPT_VERSION,
    procurement_id: text(object.procurement_id),
    generated_at: text(generatedAt),
    sources: Object.freeze(sources),
  });
}

export function buildProcurementSourceLookupProjection({ objects = [], observations = [], materializations = {}, generatedAt = null, lookupAsOf = generatedAt } = {}) {
  const safeObservations = Array.isArray(observations) ? observations : [];
  const index = buildLookupIndex(safeObservations, materializations);
  const rows = (Array.isArray(objects) ? objects : []).map((object) => buildProcurementSourceLookupReceipt({ object, observations: safeObservations, materializations, generatedAt, lookupAsOf, index }));
  const counts = Object.fromEntries([...STATES, "not-applicable"].map((state) => [state, 0]));
  let duplicateKeyCount = 0;
  let missingKeyCount = 0;
  for (const receipt of rows) for (const source of receipt.sources) {
    const countState = source.applicability === "not-applicable" ? "not-applicable" : source.state;
    counts[countState] = (counts[countState] || 0) + 1;
    duplicateKeyCount += source.state === "ambiguous" ? source.matched_source_observation_refs.length + source.matched_analytical_row_refs.length : 0;
    missingKeyCount += source.applicability === "applicable" && !source.queried_keys.length ? 1 : 0;
  }
  return { schema: PROCUREMENT_SOURCE_LOOKUP_RECEIPT_SCHEMA, version: PROCUREMENT_SOURCE_LOOKUP_RECEIPT_VERSION, generated_at: text(generatedAt), rows, counts, duplicate_key_count: duplicateKeyCount, missing_key_count: missingKeyCount };
}
