/**
 * Observation-fed canonical procurement object.
 *
 * PASSPort and Checkbook source_records construct objects from publisher-stable
 * identifiers. Contract ids are strong cross-source keys. PIN/EPIN may attach a
 * stage only when it identifies at most one contract; a PIN shared by multiple
 * contracts is deliberately ambiguous. City Record can add stage evidence and
 * compatibility links to an already-constructed object, but never constructs
 * one or changes its identity. PASSPort-only objects may carry a Checkbook
 * corroboration sidecar; that lookup is evidence only and never a constructor.
 */

import { attachCheckbookPassportCorroboration } from "./checkbook_passport_corroboration.mjs";

export const PROCUREMENT_OBJECT_SCHEMA = "cityscroll.procurement_object.v1";
export const PROCUREMENT_IDENTITY_EDGE_SCHEMA = "cityscroll.procurement_identity_edge.v1";
export const PROCUREMENT_CROSS_SOURCE_JOIN_SCHEMA = "cityscroll.procurement_cross_source_join.v1";
export const PROCUREMENT_IDENTITY_GATE_MIN_STABLE_RATE = 0.95;

export const PROCUREMENT_CONSTRUCTOR_SOURCES = Object.freeze([
  "passport_public_contracts",
  "passport_public_rfx",
  "checkbook_contracts",
  "checkbook_spending",
]);

const CITY_RECORD_SOURCES = new Set([
  "city_record",
  "city_record_procurement",
  "crol",
]);

const STAGE_ORDER = Object.freeze([
  "solicitation",
  "intent_to_negotiate",
  "vendor_list",
  "intent_to_award",
  "award",
  "pending",
  "registered",
  "payment",
  "contract",
  "unknown",
]);

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function exactKey(value) {
  return text(value)?.toUpperCase().replace(/[^A-Z0-9]/g, "") || null;
}

export function procurementObservationSnapshot(record) {
  for (const value of [record?.normalized_snapshot, record?.raw_snapshot, record?.snapshot]) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // An unreadable payload cannot contribute derived identity keys. Its
      // exact publisher source id may still be audited independently.
    }
  }
  return {};
}

const snapshot = procurementObservationSnapshot;

function sourceSystem(record) {
  return text(record?.source_system)?.toLowerCase() || null;
}

function sourceId(record) {
  return text(record?.source_system_id || record?.source_id);
}

export function procurementObservationRef(record) {
  const system = sourceSystem(record);
  const id = sourceId(record);
  return system && id ? `${system}:${id}` : null;
}

const observationRef = procurementObservationRef;

function hasStableSourceId(record) {
  const id = sourceId(record);
  if (!id) return false;
  return !/(?:^|:)no-(?:contract|document|publisher|record)-id(?:$|:)/i.test(id)
    && !/(?:^|:)unknown(?:$|:)/i.test(id);
}

function identityKeys(record, row = snapshot(record)) {
  const system = sourceSystem(record);
  let contractId = null;
  let epin = null;
  let publisherId = null;

  if (system === "passport_public_contracts") {
    contractId = exactKey(row.contract_id || row.contractId);
    epin = exactKey(row.epin_norm || row.epin || row.pin);
    publisherId = exactKey(row.ctr_id || row.contract_id || row.epin);
  } else if (system === "passport_public_rfx") {
    epin = exactKey(row.epin_norm || row.epin || row.pin);
    publisherId = exactKey(row.rfp_id || row.rfx_id || row.epin);
  } else if (system === "checkbook_contracts") {
    contractId = exactKey(row.id || row.contract_id || row.contractId || row.prime_contract_id);
    epin = exactKey(row.pin || row.epin);
    publisherId = contractId;
  } else if (system === "checkbook_spending") {
    contractId = exactKey(row.contractId || row.contract_id || row.prime_contract_id);
    publisherId = exactKey(row.documentId || row.document_id || row.id || row.spendingId || row.transactionId);
  } else if (CITY_RECORD_SOURCES.has(system)) {
    epin = exactKey(row.pin || row.epin);
    publisherId = exactKey(row.request_id || sourceId(record));
  }

  return { contract_id: contractId, epin, publisher_id: publisherId };
}

function stageFor(record, row = snapshot(record)) {
  const system = sourceSystem(record);
  if (system === "passport_public_rfx") return "solicitation";
  if (system === "checkbook_spending") return "payment";
  if (system === "passport_public_contracts" || system === "checkbook_contracts") {
    const status = text(row.status)?.toLowerCase();
    if (status?.includes("pending")) return "pending";
    if (status?.includes("register") || row.registration_date || row.registered) return "registered";
    return "contract";
  }
  if (CITY_RECORD_SOURCES.has(system)) {
    const type = text(row.type_of_notice_description || row.type_of_notice || row.stage)?.toLowerCase() || "";
    if (type.includes("intent to negotiate")) return "intent_to_negotiate";
    if (type.includes("vendor list")) return "vendor_list";
    if (type.includes("intent to award")) return "intent_to_award";
    if (type.includes("solicitation")) return "solicitation";
    if (type.includes("award")) return "award";
  }
  return "unknown";
}

function latestSourceRecords(records) {
  const byRef = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== "object") continue;
    const ref = observationRef(record);
    if (!ref) continue;
    const prior = byRef.get(ref);
    if (!prior || String(record.ingested_at || "") >= String(prior.ingested_at || "")) {
      byRef.set(ref, record);
    }
  }
  return [...byRef.values()];
}

function constructorRows(records) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => PROCUREMENT_CONSTRUCTOR_SOURCES.includes(sourceSystem(record)));
}

/**
 * Gate construction on publisher-stable source ids and exact-only joins.
 * Empty input is valid: source availability belongs to the read-model envelope.
 */
export function auditProcurementIdentityGate(sourceRecords = [], options = {}) {
  const selected = constructorRows(sourceRecords);
  const stable = selected.filter(hasStableSourceId);
  const acceptedJoins = Array.isArray(options.acceptedJoins) ? options.acceptedJoins : [];
  const exactJoins = acceptedJoins.filter((join) =>
    join?.status === "accepted"
    && ["exact_contract_id", "exact_epin"].includes(join?.basis)
    && text(join?.matched_value));
  const stableRate = selected.length ? stable.length / selected.length : 1;
  const exactPrecision = acceptedJoins.length ? exactJoins.length / acceptedJoins.length : 1;
  return {
    schema: "cityscroll.procurement_identity_audit.v1",
    selected_source_rows: selected.length,
    stable_source_id_rows: stable.length,
    stable_source_id_rate: stableRate,
    minimum_stable_source_id_rate: PROCUREMENT_IDENTITY_GATE_MIN_STABLE_RATE,
    accepted_exact_joins: exactJoins.length,
    accepted_join_rows: acceptedJoins.length,
    exact_join_precision: exactPrecision,
    required_exact_join_precision: 1,
    ok: stableRate >= PROCUREMENT_IDENTITY_GATE_MIN_STABLE_RATE && exactPrecision === 1,
  };
}

function componentFor(record, basis, matchedValue) {
  return {
    records: [record],
    basis,
    matched_value: matchedValue,
    contract_ids: new Set(),
    epins: new Set(),
  };
}

function addRecord(component, record) {
  if (!component.records.includes(record)) component.records.push(record);
  const keys = identityKeys(record);
  if (keys.contract_id) component.contract_ids.add(keys.contract_id);
  if (keys.epin) component.epins.add(keys.epin);
}

function procurementId(component) {
  if (component.basis === "exact_publisher_source_id") {
    const first = component.records.slice().sort((a, b) =>
      String(observationRef(a)).localeCompare(String(observationRef(b))))[0];
    return `procurement:source:${sourceSystem(first)}:${sourceId(first)}`;
  }
  const contracts = [...component.contract_ids].sort();
  if (contracts.length === 1) return `procurement:contract:${contracts[0]}`;
  const epins = [...component.epins].sort();
  if (!contracts.length && epins.length === 1) return `procurement:epin:${epins[0]}`;
  const first = component.records.slice().sort((a, b) =>
    String(observationRef(a)).localeCompare(String(observationRef(b))))[0];
  return `procurement:source:${sourceSystem(first)}:${sourceId(first)}`;
}

function exactComponents(records) {
  const components = [];
  const byContract = new Map();
  const contractRows = [];
  const epinOnlyRows = [];

  for (const record of records) {
    const keys = identityKeys(record);
    if (keys.contract_id) contractRows.push(record);
    else epinOnlyRows.push(record);
  }

  for (const record of contractRows) {
    const keys = identityKeys(record);
    let component = byContract.get(keys.contract_id);
    if (!component) {
      component = componentFor(record, "exact_contract_id", keys.contract_id);
      components.push(component);
      byContract.set(keys.contract_id, component);
    }
    addRecord(component, record);
  }

  const contractsByEpin = new Map();
  for (const component of components) {
    for (const epin of component.epins) {
      if (!contractsByEpin.has(epin)) contractsByEpin.set(epin, new Set());
      contractsByEpin.get(epin).add(component);
    }
  }

  const epinOnlyComponents = new Map();
  for (const record of epinOnlyRows) {
    const keys = identityKeys(record);
    const candidates = keys.epin ? [...(contractsByEpin.get(keys.epin) || [])] : [];
    if (candidates.length === 1) {
      addRecord(candidates[0], record);
      continue;
    }
    if (keys.epin && candidates.length === 0) {
      let component = epinOnlyComponents.get(keys.epin);
      if (!component) {
        component = componentFor(record, "exact_epin", keys.epin);
        components.push(component);
        epinOnlyComponents.set(keys.epin, component);
      }
      addRecord(component, record);
      continue;
    }
    const ref = observationRef(record);
    const component = componentFor(record, "exact_publisher_source_id", ref);
    addRecord(component, record);
    components.push(component);
  }

  return components;
}

function identityEdge(record, component, id) {
  const keys = identityKeys(record);
  let basis = component.basis;
  let matchedValue = component.matched_value;
  if (component.basis === "exact_publisher_source_id") {
    basis = "exact_publisher_source_id";
    matchedValue = observationRef(record);
  } else if (component.contract_ids.has(keys.contract_id)) {
    basis = "exact_contract_id";
    matchedValue = keys.contract_id;
  } else if (keys.epin && component.epins.has(keys.epin)) {
    basis = "exact_epin";
    matchedValue = keys.epin;
  } else {
    basis = "exact_publisher_source_id";
    matchedValue = observationRef(record);
  }
  return {
    schema: PROCUREMENT_IDENTITY_EDGE_SCHEMA,
    status: "accepted",
    source_observation_ref: observationRef(record),
    procurement_id: id,
    basis,
    matched_value: matchedValue,
  };
}

function intersect(left, right) {
  const rightSet = new Set(right.filter(Boolean));
  return left.filter((value) => value && rightSet.has(value));
}

function crossSourceJoins(components) {
  const joins = [];
  for (const component of components) {
    const id = procurementId(component);
    for (let leftIndex = 0; leftIndex < component.records.length; leftIndex += 1) {
      const left = component.records[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < component.records.length; rightIndex += 1) {
        const right = component.records[rightIndex];
        if (sourceSystem(left) === sourceSystem(right)) continue;
        const leftKeys = identityKeys(left);
        const rightKeys = identityKeys(right);
        const contractIds = intersect([leftKeys.contract_id], [rightKeys.contract_id]);
        const epins = intersect([leftKeys.epin], [rightKeys.epin]);
        const basis = contractIds.length ? "exact_contract_id" : epins.length ? "exact_epin" : null;
        const matchedValue = contractIds[0] || epins[0] || null;
        if (!basis || !matchedValue) continue;
        joins.push({
          schema: PROCUREMENT_CROSS_SOURCE_JOIN_SCHEMA,
          status: "accepted",
          left_source_observation_ref: observationRef(left),
          right_source_observation_ref: observationRef(right),
          procurement_id: id,
          basis,
          matched_value: matchedValue,
        });
      }
    }
  }
  return joins.sort((left, right) =>
    left.left_source_observation_ref.localeCompare(right.left_source_observation_ref)
    || left.right_source_observation_ref.localeCompare(right.right_source_observation_ref));
}

function sortedStages(stageRefs) {
  return [...stageRefs.entries()]
    .map(([stage, refs]) => ({ stage, source_observation_refs: [...refs].sort() }))
    .sort((left, right) => STAGE_ORDER.indexOf(left.stage) - STAGE_ORDER.indexOf(right.stage)
      || left.stage.localeCompare(right.stage));
}

function cityRecordHref(record) {
  const row = snapshot(record);
  const requestId = text(row.request_id || sourceId(record));
  return requestId ? `/notices/${encodeURIComponent(requestId)}` : null;
}

function createObject(component, edges) {
  const id = procurementId(component);
  const stageRefs = new Map();
  for (const record of component.records) {
    const stage = stageFor(record);
    if (!stageRefs.has(stage)) stageRefs.set(stage, new Set());
    stageRefs.get(stage).add(observationRef(record));
  }
  const objectEdges = edges.filter((edge) => edge.procurement_id === id);
  return {
    object_type: "procurement",
    schema: PROCUREMENT_OBJECT_SCHEMA,
    procurement_id: id,
    canonical_id: id,
    source_observation_refs: objectEdges.map((edge) => edge.source_observation_ref).sort(),
    stages: sortedStages(stageRefs),
    identity_keys: {
      contract_ids: [...component.contract_ids].sort(),
      epins: [...component.epins].sort(),
    },
    identity_edges: objectEdges,
    lifecycle: null,
    compatibility: {
      canonical_href: procurementCanonicalHref(id),
      city_record_notice_hrefs: [],
    },
  };
}

function objectCandidatesForKeys(objects, keys) {
  const byContract = keys.contract_id
    ? objects.filter((object) => object.identity_keys.contract_ids.includes(keys.contract_id)) : [];
  if (byContract.length) return byContract;
  return keys.epin
    ? objects.filter((object) => object.identity_keys.epins.includes(keys.epin)) : [];
}

function addStageRef(object, stage, ref) {
  if (!ref) return;
  if (!object.source_observation_refs.includes(ref)) {
    object.source_observation_refs = [...object.source_observation_refs, ref].sort();
  }
  const existing = object.stages.find((entry) => entry.stage === stage);
  if (existing) {
    if (!existing.source_observation_refs.includes(ref)) {
      existing.source_observation_refs = [...existing.source_observation_refs, ref].sort();
    }
  } else {
    object.stages = sortedStages(new Map([
      ...object.stages.map((entry) => [entry.stage, new Set(entry.source_observation_refs)]),
      [stage, new Set([ref])],
    ]));
  }
}

function attachCityRecordObservations(objects, cityRecords) {
  for (const record of cityRecords) {
    if (!hasStableSourceId(record)) continue;
    const candidates = objectCandidatesForKeys(objects, identityKeys(record));
    if (candidates.length !== 1) continue;
    const object = candidates[0];
    addStageRef(object, stageFor(record), observationRef(record));
    const href = cityRecordHref(record);
    if (href && !object.compatibility.city_record_notice_hrefs.includes(href)) {
      object.compatibility.city_record_notice_hrefs.push(href);
      object.compatibility.city_record_notice_hrefs.sort();
    }
  }
}

function lifecycleIdentity(lifecycle) {
  const contractIds = new Set();
  for (const entry of Array.isArray(lifecycle?.timeline) ? lifecycle.timeline : []) {
    const detail = entry?.detail || {};
    const id = exactKey(detail.contract_id || detail.contractId || detail.prime_contract_id);
    if (id) contractIds.add(id);
  }
  return {
    contract_ids: [...contractIds],
    epin: exactKey(lifecycle?.pin || lifecycle?.epin),
  };
}

function lifecycleCandidates(objects, lifecycle) {
  const identity = lifecycleIdentity(lifecycle);
  const byContract = objects.filter((object) =>
    identity.contract_ids.some((id) => object.identity_keys.contract_ids.includes(id)));
  if (byContract.length) return byContract;
  return identity.epin
    ? objects.filter((object) => object.identity_keys.epins.includes(identity.epin)) : [];
}

function attachLifecycles(objects, lifecycles) {
  for (const lifecycle of Array.isArray(lifecycles) ? lifecycles : []) {
    if (!lifecycle || typeof lifecycle !== "object") continue;
    const candidates = lifecycleCandidates(objects, lifecycle);
    if (candidates.length !== 1) continue;
    const object = candidates[0];
    if (object.lifecycle) {
      object.lifecycles = [...(object.lifecycles || [object.lifecycle]), lifecycle];
    } else {
      object.lifecycle = lifecycle;
    }
    for (const entry of Array.isArray(lifecycle.timeline) ? lifecycle.timeline : []) {
      if (entry?.status !== "matched" || entry?.source !== "city-record") continue;
      const requestId = text(entry?.detail?.request_id);
      if (!requestId) continue;
      const ref = `city_record:${requestId}`;
      addStageRef(object, text(entry.stage) || "unknown", ref);
      const href = `/notices/${encodeURIComponent(requestId)}`;
      if (!object.compatibility.city_record_notice_hrefs.includes(href)) {
        object.compatibility.city_record_notice_hrefs.push(href);
        object.compatibility.city_record_notice_hrefs.sort();
      }
    }
  }
}

/** Build canonical objects exclusively from accepted exact observation edges. */
export function buildProcurementObjects({
  sourceRecords = [],
  lifecycleRows = [],
  checkbookLookupRows = null,
  includeUnknownCheckbookCorroboration = false,
} = {}) {
  const gate = auditProcurementIdentityGate(sourceRecords);
  if (!gate.ok) {
    throw new Error(
      `procurement identity audit gate failed: stable=${gate.stable_source_id_rate} exact=${gate.exact_join_precision}`,
    );
  }

  const latest = latestSourceRecords(sourceRecords);
  const constructors = constructorRows(latest).filter(hasStableSourceId);
  const components = exactComponents(constructors);
  const edges = [];
  for (const component of components) {
    const id = procurementId(component);
    for (const record of component.records) edges.push(identityEdge(record, component, id));
  }
  const crossSourceIdentityJoins = crossSourceJoins(components);
  const exactGate = auditProcurementIdentityGate(sourceRecords, {
    acceptedJoins: crossSourceIdentityJoins,
  });
  if (!exactGate.ok) throw new Error("procurement identity audit gate failed: non-exact accepted join");

  const objects = components.map((component) => createObject(component, edges));
  attachCityRecordObservations(
    objects,
    latest.filter((record) => CITY_RECORD_SOURCES.has(sourceSystem(record))),
  );
  attachLifecycles(objects, lifecycleRows);
  attachCheckbookPassportCorroboration(objects, {
    sourceRecords: latest,
    checkbookLookupRows,
    includeUnknown: includeUnknownCheckbookCorroboration,
  });
  objects.sort((left, right) => left.procurement_id.localeCompare(right.procurement_id));
  edges.sort((left, right) => left.source_observation_ref.localeCompare(right.source_observation_ref));

  return {
    schema: "cityscroll.procurement_object_collection.v1",
    identity_gate: exactGate,
    objects,
    identity_edges: edges,
    cross_source_identity_joins: crossSourceIdentityJoins,
  };
}

export function procurementCanonicalHref(recordOrId) {
  const id = typeof recordOrId === "object" ? recordOrId?.procurement_id : recordOrId;
  return id ? `/procurements/${encodeURIComponent(String(id))}` : null;
}

export function resolveProcurementRoute(value, objects = [], _options = {}) {
  let url;
  try {
    url = new URL(String(value || ""), "https://cityscroll.org");
  } catch {
    return null;
  }
  const match = url.pathname.match(/^\/procurements\/([^/?#]+)\/?$/);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  return (Array.isArray(objects) ? objects : []).find((object) => object?.procurement_id === id) || null;
}

export const PROCUREMENT_SOURCE_SYSTEMS = Object.freeze([
  ...PROCUREMENT_CONSTRUCTOR_SOURCES,
  "city_record",
]);
