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
  "checkbook_nycha_contracts",
  "checkbook_spending",
  "nys_contract_reporter",
  "mta_current_opportunities",
  "mta_bid_results",
  "mta_annual_contracts",
  "mta_cd_awards",
]);

const CITY_RECORD_SOURCES = new Set([
  "city_record",
  "city_record_procurement",
  "crol",
]);

const NATIVE_PROCUREMENT_SOURCES = new Set([
  "nys_contract_reporter",
  "mta_current_opportunities",
  "mta_bid_results",
]);

const STAGE_ORDER = Object.freeze([
  "solicitation",
  "bid_opening_result",
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

function isNativeProcurementObject(object) {
  return (object?.source_observation_refs || []).some((ref) =>
    NATIVE_PROCUREMENT_SOURCES.has(String(ref).split(":")[0]));
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
  let contractReporterNumber = null;
  let solicitationId = null;
  let eventId = null;

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
  } else if (system === "checkbook_nycha_contracts") {
    contractId = exactKey(row.id || row.contract_id || row.contractId);
    epin = exactKey(row.pin || row.epin);
    publisherId = contractId;
  } else if (system === "checkbook_spending") {
    contractId = exactKey(row.contractId || row.contract_id || row.prime_contract_id);
    publisherId = exactKey(row.documentId || row.document_id || row.id || row.spendingId || row.transactionId);
  } else if (system === "mta_annual_contracts") {
    contractId = exactKey(row.transaction_number || row.contract_id || row.contract_number);
    publisherId = contractId;
  } else if (system === "mta_cd_awards") {
    contractId = exactKey(row.contract_number || row.contract_id || row.transaction_number);
    publisherId = contractId;
  } else if (CITY_RECORD_SOURCES.has(system)) {
    epin = exactKey(row.pin || row.epin);
    publisherId = exactKey(row.request_id || sourceId(record));
  } else if (["nys_contract_reporter", "mta_current_opportunities", "mta_bid_results"].includes(system)) {
    contractReporterNumber = exactKey(row.contract_reporter_number || row.cr_number || row.cr_number_norm);
    solicitationId = exactKey(row.solicitation_id || row.solicitation_number || row.auction_id || row.auc_id);
    eventId = exactKey(row.event_id || row.event_number || row.event || row.solicitation_id || row.solicitation_number || row.auction_id || row.auc_id);
    publisherId = exactKey(row.source_record_id || sourceId(record));
  }

  return {
    contract_id: contractId,
    epin,
    publisher_id: publisherId,
    contract_reporter_number: contractReporterNumber,
    solicitation_id: solicitationId,
    event_id: eventId,
    native: [
      ["contract_reporter_number", contractReporterNumber],
      ["solicitation_id", solicitationId],
      ["event_id", eventId],
    ].filter(([, value]) => value).map(([field, value]) => ({ field, value })),
  };
}

function stageFor(record, row = snapshot(record)) {
  const system = sourceSystem(record);
  if (["nys_contract_reporter", "mta_current_opportunities", "mta_bid_results"].includes(system)) {
    const observationType = text(row.observation_type || row.publication_stage)?.toLowerCase();
    if (observationType === "bid_opening_result" || observationType === "bid_result") return "bid_opening_result";
    if (observationType === "award") return "award";
    if (observationType === "opportunity" || observationType === "solicitation") return "solicitation";
  }
  if (system === "passport_public_rfx") return "solicitation";
  if (system === "checkbook_spending") return "payment";
  if (system === "passport_public_contracts" || system === "checkbook_contracts" || system === "checkbook_nycha_contracts") {
    const status = text(row.status)?.toLowerCase();
    if (status?.includes("pending")) return "pending";
    if (status?.includes("register") || row.registration_date || row.registered) return "registered";
    return "contract";
  }
  if (system === "mta_cd_awards") return "award";
  if (system === "mta_annual_contracts") return "contract";
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
    && [
      "exact_contract_id", "exact_epin", "exact_contract_reporter_number",
      "exact_solicitation_id", "exact_event_id",
    ].includes(join?.basis)
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
    native_keys: new Map(),
    publisher_institution_ids: new Set(),
    procuring_institution_ids: new Set(),
    source_agency_labels: new Set(),
  };
}

function addRecord(component, record) {
  if (!component.records.includes(record)) component.records.push(record);
  const keys = identityKeys(record);
  if (keys.contract_id) component.contract_ids.add(keys.contract_id);
  if (keys.epin) component.epins.add(keys.epin);
  for (const { field, value } of keys.native) {
    if (!component.native_keys.has(field)) component.native_keys.set(field, new Set());
    component.native_keys.get(field).add(value);
  }
  const row = snapshot(record);
  if (row.publisher_institution_id) component.publisher_institution_ids.add(String(row.publisher_institution_id));
  if (row.procuring_institution_id) component.procuring_institution_ids.add(String(row.procuring_institution_id));
  if (row.source_agency_label) component.source_agency_labels.add(String(row.source_agency_label));
}

function nativeBasis(field) {
  return `exact_${field}`;
}

function mergeComponents(target, source, components) {
  for (const record of source.records) addRecord(target, record);
  const index = components.indexOf(source);
  if (index >= 0) components.splice(index, 1);
}

function procurementId(component) {
  const nativeFields = ["solicitation_id", "event_id", "contract_reporter_number"];
  for (const field of nativeFields) {
    const values = [...(component.native_keys.get(field) || [])].sort();
    if (values.length === 1) return `procurement:${field.replaceAll("_id", "")}:${values[0]}`;
  }
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
  const byNative = new Map();
  const nativeRows = [];
  const byContract = new Map();
  const contractRows = [];
  const epinOnlyRows = [];

  for (const record of records) {
    const keys = identityKeys(record);
    if (keys.native.length) nativeRows.push(record);
    else if (keys.contract_id) contractRows.push(record);
    else epinOnlyRows.push(record);
  }

  for (const record of nativeRows) {
    const keys = identityKeys(record);
    const candidates = [...new Set(keys.native.flatMap(({ field, value }) => byNative.get(`${field}:${value}`) || []))];
    let component = candidates[0];
    if (!component) {
      const first = keys.native[0];
      component = componentFor(record, nativeBasis(first.field), first.value);
      components.push(component);
    }
    for (const candidate of candidates.slice(1)) mergeComponents(component, candidate, components);
    addRecord(component, record);
    for (const { field, value } of keys.native) byNative.set(`${field}:${value}`, component);
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
  const native = identityKeys(record).native.find(({ field, value }) => (
    component.native_keys.get(field)?.has(value)
  ));
  if (native) {
    basis = nativeBasis(native.field);
    matchedValue = native.value;
  } else if (component.basis === "exact_publisher_source_id") {
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
        const native = leftKeys.native.find(({ field, value }) => rightKeys.native.some((right) => (
          right.field === field && right.value === value
        )));
        const basis = native ? nativeBasis(native.field)
          : contractIds.length ? "exact_contract_id" : epins.length ? "exact_epin" : null;
        const matchedValue = native?.value || contractIds[0] || epins[0] || null;
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
  const identity = {
    contract_ids: [...component.contract_ids].sort(),
    epins: [...component.epins].sort(),
  };
  const nativeIdentity = {
    contract_reporter_numbers: [...(component.native_keys.get("contract_reporter_number") || [])].sort(),
    solicitation_ids: [...(component.native_keys.get("solicitation_id") || [])].sort(),
    event_ids: [...(component.native_keys.get("event_id") || [])].sort(),
  };
  if (Object.values(nativeIdentity).some((values) => values.length)) Object.assign(identity, nativeIdentity);
  return {
    object_type: "procurement",
    schema: PROCUREMENT_OBJECT_SCHEMA,
    procurement_id: id,
    canonical_id: id,
    source_observation_refs: objectEdges.map((edge) => edge.source_observation_ref).sort(),
    stages: sortedStages(stageRefs),
    identity_keys: identity,
    institution_keys: {
      publisher_institution_ids: [...component.publisher_institution_ids].sort(),
      procuring_institution_ids: [...component.procuring_institution_ids].sort(),
      source_agency_labels: [...component.source_agency_labels].sort(),
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
  const native = keys.native.flatMap(({ field, value }) => objects.filter((object) => (
    object.identity_keys[`${field.replace("_number", "_numbers").replace(/_id$/, "_ids")}`]?.includes(value)
  )));
  if (native.length) return [...new Set(native)];
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
  objects.sort((left, right) => Number(isNativeProcurementObject(left)) - Number(isNativeProcurementObject(right))
    || left.procurement_id.localeCompare(right.procurement_id));
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
