/**
 * Reader-facing projection for accepted, exact cross-source evidence.
 *
 * This module deliberately does not match records. It consumes accepted graph
 * joins and retained observations, then keeps each publisher's assertion and
 * provenance beside the comparison result.
 */

import {
  publicProvenanceProjection,
} from "../entity_resolution/provenance_graph.mjs";
import {
  CURATION_PROVISIONAL_STATE,
  projectCurationVerdictState,
} from "../entity_resolution/review/curation_verdicts.mjs";
import { residentOfficialSource } from "./provenance_disclosure.mjs";
import { contractIdKey, pinKey } from "./pin_sibling_grouping.mjs";

export const CROSS_SOURCE_EVIDENCE_RECEIPT_SCHEMA =
  "cityscroll.cross_source_evidence_receipt.v1";
export const CROSS_SOURCE_EVIDENCE_RECEIPT_VERSION = 1;

/** Compact same-record labels. Weaker relations never receive these names. */
export const COMPACT_SOURCE_LABELS = Object.freeze({
  checkbook_contracts: "Checkbook",
  checkbook_spending: "Checkbook",
  passport_public_contracts: "PASSPort",
  passport_public_rfx: "PASSPort",
  "ocp-recent-awards": "OCP",
  "ocp-recent-contract-awards": "OCP",
  ocp_awards: "OCP",
});

export const CROSS_SOURCE_RELATION = Object.freeze({
  exact: Object.freeze({ id: "exact", label: "same record" }),
  related_instrument: Object.freeze({ id: "related_instrument", label: "related instrument" }),
  rejected: Object.freeze({ id: "rejected", label: "rejected" }),
  ambiguous: Object.freeze({ id: "ambiguous", label: "ambiguous" }),
  unknown: Object.freeze({ id: "unknown", label: "unknown" }),
  fuzzy: Object.freeze({ id: "fuzzy", label: "fuzzy" }),
  untested: Object.freeze({ id: "untested", label: "untested" }),
});

const BLOCKED_RELATION_STATUSES = new Set([
  "related_instrument",
  "needs_review",
  "needs-review",
  "rejected",
  "ambiguous",
  "unknown",
  "fuzzy",
  "untested",
  "different",
  "no_edge",
  "no-edge",
]);
const WEAKER_JOIN_BASIS = new Set([
  "related_instrument",
  "pin_family",
  "vendor_amount_date",
  "title_similarity",
  "fuzzy",
  "fuzzy_name",
]);
const CURATION_BLOCKS_SAME_RECORD = new Set([
  CURATION_PROVISIONAL_STATE.REVIEW,
  CURATION_PROVISIONAL_STATE.REJECT_WITHHELD,
  CURATION_PROVISIONAL_STATE.ACCEPT_WITHHELD,
]);

const EXACT_JOIN_BASIS = new Map([
  ["exact_contract_id", "Exact contract ID"],
  ["contract_id_exact", "Exact contract ID"],
  ["exact_epin", "Exact PIN / EPIN"],
  ["pin_epin_exact", "Exact PIN / EPIN"],
  ["exact_request_id", "Exact request ID"],
  ["request_id", "Exact request ID"],
  ["exact_board_date_publisher_identifier", "Exact board, date, and publisher identifier"],
]);

export const CROSS_SOURCE_EVIDENCE_SOURCE_LABELS = Object.freeze({
  city_record: "City Record",
  passport_public_contracts: "PASSPort Public contracts",
  passport_public_rfx: "PASSPort Public solicitations",
  checkbook_contracts: "Checkbook NYC",
  checkbook_spending: "Checkbook NYC spending",
  checkbook_nycha_contracts: "Checkbook NYCHA",
  "ocp-recent-awards": "Recent Contract Awards (OCP)",
  "ocp-recent-contract-awards": "Recent Contract Awards (OCP)",
  ocp_awards: "Recent Contract Awards (OCP)",
  abo: "NYS Authorities Budget Office",
  nys_abo_awards: "NYS Authorities Budget Office",
  community_board: "Community board calendar",
  nys_contract_reporter: "NYS Contract Reporter",
  mta_current_opportunities: "MTA current opportunities",
  mta_bid_results: "MTA bid results",
  mta_annual_contracts: "MTA annual contracts",
  mta_cd_awards: "MTA Construction & Development awards",
});
const SOURCE_LABELS = CROSS_SOURCE_EVIDENCE_SOURCE_LABELS;

const SOURCE_HREFS = Object.freeze({
  "ocp-recent-awards": "https://data.cityofnewyork.us/d/qyyg-4tf5",
  "ocp-recent-contract-awards": "https://data.cityofnewyork.us/d/qyyg-4tf5",
  ocp_awards: "https://data.cityofnewyork.us/d/qyyg-4tf5",
});

const FACT_DEFINITIONS = Object.freeze([
  {
    key: "contract_id",
    label: "Contract ID",
    fields: ["contract_id", "contractId", "id", "prime_contract_id"],
    normalize: (value) => contractIdKey(exactText(value) || "") || null,
    display: (value) => exactText(value),
  },
  {
    key: "pin",
    label: "PIN / EPIN",
    fields: ["epin", "epin_norm", "pin", "prime_contract_pin"],
    normalize: (value) => pinKey(exactText(value) || "") || null,
    display: (value) => exactText(value),
  },
  {
    key: "title",
    label: "Title",
    fields: ["title", "short_title", "description", "procurement_description"],
    normalize: (value) => looseText(value)?.toLowerCase() || null,
    display: (value) => looseText(value),
  },
  {
    key: "vendor",
    label: "Vendor",
    fields: ["vendor", "vendor_name", "prime_vendor", "payee_name"],
    normalize: (value) => looseText(value)?.toLowerCase() || null,
    display: (value) => looseText(value),
  },
  {
    key: "amount",
    label: "Amount",
    fields: ["award_amount", "contract_amount", "current_amount", "current", "amount", "check_amount"],
    normalize: (value) => amount(value),
    display: (value) => {
      const parsed = amount(value);
      return parsed == null ? null : `$${parsed.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    },
  },
  {
    key: "date",
    label: "Date",
    fields: ["start_date", "registration_date", "registered", "date", "award_date", "issue_date"],
    normalize: (value) => dateOnly(value),
    display: (value) => dateOnly(value),
  },
  {
    key: "status",
    label: "Status",
    fields: ["status"],
    normalize: (value) => looseText(value)?.toLowerCase() || null,
    display: (value) => looseText(value),
  },
]);

function looseText(value) {
  const raw = String(value ?? "");
  // Markup stripping is only meaningful when a tag is present. Skipping the
  // scan for the common tag-free case keeps this hot helper cheap without
  // changing its result.
  const stripped = raw.includes("<") ? raw.replace(/<[^>]*>/g, " ") : raw;
  const result = stripped.replace(/\s+/g, " ").trim();
  return result || null;
}

function exactText(value) {
  return looseText(value);
}

function amount(value) {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnly(value) {
  const text = looseText(value);
  return text ? text.slice(0, 10) : null;
}

function snapshotOf(observation) {
  if (observation?.snapshot && typeof observation.snapshot === "object") return observation.snapshot;
  for (const value of [observation?.normalized_snapshot, observation?.raw_snapshot]) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // An unreadable snapshot cannot contribute a source assertion.
    }
  }
  return {};
}

function sourceSystem(observation) {
  return looseText(observation?.source_system)?.toLowerCase() || null;
}

function observationRef(observation) {
  return looseText(observation?.source_observation_ref)
    || (sourceSystem(observation) && looseText(observation?.source_system_id || observation?.source_id)
      ? `${sourceSystem(observation)}:${looseText(observation.source_system_id || observation.source_id)}`
      : null);
}

export function compactSourceName(system, fallback = null) {
  const key = looseText(system)?.toLowerCase();
  return COMPACT_SOURCE_LABELS[key] || fallback || SOURCE_LABELS[key] || key || "Source";
}

export function relationForJoin(join = {}) {
  const identity = looseText(join?.identity_class || join?.relation)?.toLowerCase();
  const status = looseText(join?.status)?.toLowerCase();
  const basis = looseText(join?.basis || join?.join_method || join?.join_key)?.toLowerCase();
  if (identity === "related_instrument" || status === "related_instrument"
      || basis === "related_instrument" || basis === "pin_family") {
    return CROSS_SOURCE_RELATION.related_instrument;
  }
  if (identity === "rejected" || status === "rejected" || status === "different") {
    return CROSS_SOURCE_RELATION.rejected;
  }
  if (identity === "ambiguous" || status === "ambiguous") return CROSS_SOURCE_RELATION.ambiguous;
  if (identity === "unknown" || status === "unknown") return CROSS_SOURCE_RELATION.unknown;
  if (identity === "needs_review" || identity === "needs-review" || identity === "untested"
      || status === "needs_review" || status === "untested"
      || identity === "no_edge" || identity === "no-edge") {
    return CROSS_SOURCE_RELATION.untested;
  }
  if (!status && !basis && !identity) return CROSS_SOURCE_RELATION.untested;
  if (WEAKER_JOIN_BASIS.has(basis) || status === "fuzzy") return CROSS_SOURCE_RELATION.fuzzy;
  if (EXACT_JOIN_BASIS.has(basis)
      && (status === "accepted" || status === "corroborated" || status === "matched" || status === "same_contract")) {
    return CROSS_SOURCE_RELATION.exact;
  }
  if (EXACT_JOIN_BASIS.has(basis) && !status) return CROSS_SOURCE_RELATION.untested;
  if (basis && !EXACT_JOIN_BASIS.has(basis)) return CROSS_SOURCE_RELATION.fuzzy;
  return CROSS_SOURCE_RELATION.untested;
}

function acceptedJoin(join) {
  return relationForJoin(join).id === CROSS_SOURCE_RELATION.exact.id
    && !BLOCKED_RELATION_STATUSES.has(looseText(join?.identity_class)?.toLowerCase())
    && !BLOCKED_RELATION_STATUSES.has(looseText(join?.status)?.toLowerCase());
}

function curationBlocksSameRecord(join, curationReceipts) {
  if (!Array.isArray(curationReceipts) || !curationReceipts.length) return false;
  const targetId = looseText(join?.curation_target_id || join?.pair_id || join?.decision_target_id);
  if (!targetId) return false;
  const state = projectCurationVerdictState(curationReceipts, targetId);
  if (state.state === "not_yet_observed") return false;
  if (CURATION_BLOCKS_SAME_RECORD.has(state.state)) return true;
  const active = curationReceipts.find((receipt) => receipt?.id === state.active_receipt_id);
  return looseText(active?.reversible_effect?.gold_candidate?.label)?.toLowerCase() === "different";
}

function provenanceBlocksSameRecord(join, provenanceGraph) {
  const assertionId = looseText(join?.assertion_id);
  if (!provenanceGraph || !assertionId) return false;
  let projection;
  try {
    projection = publicProvenanceProjection(provenanceGraph, assertionId);
  } catch {
    return true;
  }
  const warrant = looseText(projection?.assertion?.warrant_class)?.toLowerCase();
  if (warrant === "probabilistic" || warrant === "not_yet_classified") return true;
  if (warrant === "reviewed" && projection?.publication?.active === false) return true;
  return false;
}

function provenanceForJoin(join, provenanceGraph) {
  const assertionId = looseText(join?.assertion_id);
  if (!provenanceGraph || !assertionId) return null;
  try {
    return publicProvenanceProjection(provenanceGraph, assertionId);
  } catch {
    return null;
  }
}

function exactCorroborationJoin(object) {
  const receipt = object?.checkbook_corroboration;
  if (!receipt || typeof receipt !== "object") return null;
  const status = looseText(receipt.status)?.toLowerCase();
  const identity = looseText(receipt.identity_class)?.toLowerCase();
  const basis = looseText(receipt.join_method)?.toLowerCase();
  if (status !== "corroborated" || identity !== "same_contract" || !EXACT_JOIN_BASIS.has(basis)) {
    return null;
  }
  return { receipt, basis };
}

function lookupContractKey(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function prepareJoin(join, provenanceGraph, curationReceipts) {
  if (!acceptedJoin(join)) return null;
  if (curationBlocksSameRecord(join, curationReceipts)) return null;
  if (provenanceBlocksSameRecord(join, provenanceGraph)) return null;
  return {
    ...join,
    basis: looseText(join.basis || join.join_method || join.join_key)?.toLowerCase(),
    relation: CROSS_SOURCE_RELATION.exact,
    provenance: provenanceForJoin(join, provenanceGraph),
    refs: joinRefs(join),
  };
}

/**
 * Precompute every model-wide projection buildCrossSourceEvidenceReceipt would
 * otherwise recompute for each object: the observation index, the source-system
 * census, the Checkbook lookup index, and the accepted-join preparation. The
 * per-object work then scales with that object's own observations and joins
 * instead of with the whole read model.
 *
 * An index must be built from the same observations, joins, lookup rows,
 * provenance graph, and curation receipts the receipts are then built with.
 */
export function buildCrossSourceEvidenceIndex({
  observations = [],
  acceptedJoins = [],
  checkbookLookupRows = null,
  provenanceGraph = null,
  curationReceipts = [],
} = {}) {
  const rows = Array.isArray(observations) ? observations : [];
  const byRef = new Map();
  const systems = new Set();
  let passport = null;
  for (const observation of rows) {
    const ref = observationRef(observation);
    // Later observations win on a repeated ref, matching the single-pass Map
    // construction this index replaces.
    if (ref) byRef.set(ref, observation);
    const system = sourceSystem(observation);
    if (system) systems.add(system);
    if (!passport && system === "passport_public_contracts") passport = observation;
  }

  const lookupByContractKey = new Map();
  for (const row of Array.isArray(checkbookLookupRows) ? checkbookLookupRows : []) {
    const id = looseText(row?.contract_id || row?.id || row?.prime_contract_id);
    if (!id) continue;
    const key = lookupContractKey(id);
    // First match wins, matching the linear find this index replaces.
    if (!lookupByContractKey.has(key)) lookupByContractKey.set(key, row);
  }

  const prepared = [];
  const byProcurementId = new Map();
  const unscoped = [];
  for (const join of Array.isArray(acceptedJoins) ? acceptedJoins : []) {
    const ready = prepareJoin(join, provenanceGraph, curationReceipts);
    if (!ready) continue;
    const entry = { position: prepared.length, join: ready };
    prepared.push(entry);
    if (!join?.procurement_id) unscoped.push(entry);
    else {
      const bucket = byProcurementId.get(join.procurement_id);
      if (bucket) bucket.push(entry);
      else byProcurementId.set(join.procurement_id, [entry]);
    }
  }

  return {
    byRef,
    systems,
    passport,
    passportRef: observationRef(passport),
    lookupByContractKey,
    prepared,
    /** Accepted joins visible to one object, in the original join order. */
    joinsFor(objectId) {
      if (!objectId) return prepared.map((entry) => entry.join);
      const scoped = byProcurementId.get(objectId) || [];
      if (!unscoped.length) return scoped.map((entry) => entry.join);
      if (!scoped.length) return unscoped.map((entry) => entry.join);
      const merged = [];
      let left = 0;
      let right = 0;
      while (left < unscoped.length || right < scoped.length) {
        const takeLeft = right >= scoped.length
          || (left < unscoped.length && unscoped[left].position < scoped[right].position);
        merged.push(takeLeft ? unscoped[left++].join : scoped[right++].join);
      }
      return merged;
    },
  };
}

/**
 * Project already-classified exact Checkbook corroboration into the receipt
 * without constructing a procurement object or minting a route.
 */
function exactCorroborationAttachment(object, index, generatedAt = null) {
  const classified = exactCorroborationJoin(object);
  if (!classified) return null;
  if (index.systems.has("checkbook_contracts")) return null;
  const passport = index.passport;
  const passportRef = index.passportRef;
  if (!passportRef) return null;
  const { receipt, basis } = classified;
  const nativeId = looseText(receipt.checkbook_contract_id) || "checkbook-corroboration";
  const checkbookRef = `checkbook_contracts:${nativeId}`;
  const lookup = index.lookupByContractKey.get(lookupContractKey(nativeId));
  const checkbook = {
    source_system: "checkbook_contracts",
    source_system_id: nativeId,
    source_observation_ref: checkbookRef,
    ingested_at: generatedAt || looseText(object?.generated_at) || looseText(passport?.ingested_at),
    coverage: "available",
    source_url: `https://www.checkbooknyc.com/smart_search/citywide?search_term=${encodeURIComponent(nativeId)}`,
    snapshot: {
      id: receipt.checkbook_contract_id,
      contract_id: receipt.checkbook_contract_id,
      pin: lookup?.pin || lookup?.prime_contract_pin || receipt.checkbook_pin,
      title: lookup?.title,
      vendor: lookup?.vendor || lookup?.prime_vendor,
      current: lookup?.current ?? lookup?.current_amount ?? receipt.checkbook_amount,
      registered: lookup?.registered || lookup?.registration_date || receipt.checkbook_registered || receipt.registered,
      status: lookup?.status,
    },
  };
  return {
    ref: checkbookRef,
    observation: checkbook,
    join: {
      status: "accepted",
      basis,
      matched_value: looseText(receipt.passport_contract_id || receipt.passport_pin),
      procurement_id: looseText(object?.procurement_id || object?.object_ref),
      left_source_observation_ref: passportRef,
      right_source_observation_ref: checkbookRef,
      evidence_only: true,
      overwrites_canonical: false,
      assertion_id: receipt.assertion_id,
      pair_id: receipt.pair_id || receipt.curation_target_id,
    },
  };
}

function claimLayerForFact(definition, assertions, agrees) {
  const asserted = assertions.filter((assertion) => assertion.assertion != null);
  if (agrees) {
    return Object.freeze({
      version: "claim_layer_v1",
      fact: definition.key,
      label: definition.label,
      assertions: asserted.map((assertion) => ({
        classification: "source_assertion",
        source_system: assertion.source_system,
        source_field: assertion.field,
        value: assertion.assertion,
        source_system_id: assertion.source_native_id,
        source_url: assertion.source_href,
        recorded_at: assertion.provenance?.as_of || null,
      })),
      interpretation: {
        classification: "cityscroll_interpretation",
        status: "agree",
        resolution: "agrees",
        summary: `Sources agree on ${definition.label.toLowerCase()}.`,
        comparison_values: asserted.map((assertion) => assertion.assertion),
      },
      derived_conclusion: null,
    });
  }
  const label = definition.label.toLowerCase();
  return Object.freeze({
    version: "claim_layer_v1",
    fact: definition.key,
    label: definition.label,
    assertions: asserted.map((assertion) => ({
      classification: "source_assertion",
      source_system: assertion.source_system,
      source_field: assertion.field,
      value: assertion.assertion,
      source_system_id: assertion.source_native_id,
      source_url: assertion.source_href,
      recorded_at: assertion.provenance?.as_of || null,
    })),
    interpretation: {
      classification: "cityscroll_interpretation",
      status: "conflict",
      resolution: "unresolved",
      summary: `CityScroll interpretation: different ${label} values. Resolution unresolved (no derived conclusion).`,
      comparison_values: asserted.map((assertion) => assertion.assertion),
    },
    derived_conclusion: null,
  });
}

function joinRefs(join) {
  return [
    join?.left_source_observation_ref,
    join?.right_source_observation_ref,
    ...(Array.isArray(join?.source_observation_refs) ? join.source_observation_refs : []),
  ].map((value) => looseText(value)).filter(Boolean);
}

function sourceHref(system, observation, snapshot) {
  const explicit = snapshot.source_url || snapshot.source_href || observation?.source_url;
  if (explicit) {
    const official = residentOfficialSource({
      sourceSystem: system,
      sourceRecordId: observation?.source_system_id || observation?.source_id,
      sourceHref: explicit,
      label: SOURCE_LABELS[system],
    });
    if (official) return official;
  }
  if (SOURCE_HREFS[system]) {
    return { href: SOURCE_HREFS[system], label: SOURCE_LABELS[system] };
  }
  return residentOfficialSource({
    sourceSystem: system,
    sourceRecordId: observation?.source_system_id || observation?.source_id,
    label: SOURCE_LABELS[system],
  });
}

function sourceNativeId(observation, snapshot) {
  return looseText(
    observation?.source_system_id
      || observation?.source_id
      || snapshot.source_record_id
      || snapshot.request_id
      || snapshot.contract_id
      || snapshot.contractId
      || snapshot.id,
  );
}

function valueFor(definition, snapshot) {
  for (const field of definition.fields) {
    const value = definition.display(snapshot?.[field]);
    if (value != null) return { value, field };
  }
  return { value: null, field: null };
}

function coverageFor(system, observation, sourceStatus) {
  const coverage = looseText(observation?.coverage || observation?.coverage_status)
    || looseText(sourceStatus?.[system]?.status)
    || "available";
  const labels = {
    available: "Available in the materialized snapshot",
    partial: "Partial source coverage",
    stale: "Stale source snapshot",
    unavailable: "Source unavailable",
  };
  return { coverage, coverage_label: labels[coverage] || coverage };
}

function sourceProjection(observation, sourceStatus, generatedAt, methods) {
  const system = sourceSystem(observation);
  const snapshot = snapshotOf(observation);
  const official = sourceHref(system, observation, snapshot);
  const nativeId = sourceNativeId(observation, snapshot);
  const coverage = coverageFor(system, observation, sourceStatus);
  const asOf = looseText(
    snapshot.as_of || snapshot.source_as_of || observation?.as_of || observation?.observed_at
      || observation?.ingested_at || sourceStatus?.[system]?.generated_at || generatedAt,
  );
  return {
    source_system: system,
    source_name: SOURCE_LABELS[system] || system || "Source",
    source_native_id: nativeId,
    source_href: official?.href || null,
    source_label: official?.label || SOURCE_LABELS[system] || "Official source",
    accepted_join_methods: [...methods].map((method) => ({
      id: method,
      label: EXACT_JOIN_BASIS.get(method),
    })),
    coverage: coverage.coverage,
    coverage_label: coverage.coverage_label,
    as_of: asOf,
    snapshot,
  };
}

/**
 * Build a bounded receipt from accepted exact joins. No join candidates are
 * inferred here, and non-exact states cannot be promoted by this projection.
 */
export function buildCrossSourceEvidenceReceipt({
  object = {},
  observations = [],
  acceptedJoins = [],
  sourceStatus = {},
  generatedAt = null,
  factDefinitions = FACT_DEFINITIONS,
  corroboration = null,
  checkbookLookupRows = null,
  provenanceGraph = null,
  curationReceipts = [],
  index = null,
} = {}) {
  const evidenceIndex = index || buildCrossSourceEvidenceIndex({
    observations,
    acceptedJoins,
    checkbookLookupRows,
    provenanceGraph,
    curationReceipts,
  });
  const objectId = looseText(object?.procurement_id || object?.object_ref || object?.subject_ref);
  const objectWithCorroboration = object?.checkbook_corroboration || corroboration
    ? { ...object, checkbook_corroboration: object?.checkbook_corroboration || corroboration }
    : object;
  const attachment = exactCorroborationAttachment(objectWithCorroboration, evidenceIndex, generatedAt);
  // The corroboration observation is appended after the shared ones, so it wins
  // its own ref exactly as the per-object Map construction used to.
  const observationFor = (ref) => (attachment && ref === attachment.ref
    ? attachment.observation
    : evidenceIndex.byRef.get(ref));
  const hasRef = (ref) => (attachment && ref === attachment.ref) || evidenceIndex.byRef.has(ref);
  const scopedJoins = evidenceIndex.joinsFor(objectId);
  const attachedJoin = attachment
    ? prepareJoin(attachment.join, provenanceGraph, curationReceipts)
    : null;
  const candidateJoins = attachedJoin
    && (!objectId || !attachment.join.procurement_id || attachment.join.procurement_id === objectId)
    ? [...scopedJoins, attachedJoin]
    : scopedJoins;
  const joins = candidateJoins
    .filter((join) => join.refs.length >= 2 && join.refs.every(hasRef));
  if (!joins.length) return null;

  const joinedRefs = new Set(joins.flatMap((join) => join.refs));
  const methodsByRef = new Map();
  for (const join of joins) {
    for (const ref of join.refs) {
      if (!methodsByRef.has(ref)) methodsByRef.set(ref, new Set());
      methodsByRef.get(ref).add(join.basis);
    }
  }
  const sourceRows = [...joinedRefs]
    .map((ref) => sourceProjection(observationFor(ref), sourceStatus, generatedAt, methodsByRef.get(ref)))
    .filter((source) => source.source_system);
  if (new Set(sourceRows.map((source) => source.source_system)).size < 2) return null;

  const facts = [];
  for (const definition of Array.isArray(factDefinitions) ? factDefinitions : []) {
    const assertions = sourceRows.map((source) => {
      const found = valueFor(definition, source.snapshot);
      return {
        source_system: source.source_system,
        source_name: source.source_name,
        source_native_id: source.source_native_id,
        source_href: source.source_href,
        source_label: source.source_label,
        assertion: found.value,
        assertion_label: found.value == null ? "Not published by this source" : found.value,
        field: found.field,
        provenance: {
          source_system: source.source_system,
          source_record_id: source.source_native_id,
          source_url: source.source_href,
          coverage: source.coverage,
          coverage_label: source.coverage_label,
          as_of: source.as_of,
        },
      };
    });
    const asserted = assertions.filter((assertion) => assertion.assertion != null);
    if (asserted.length < 2) continue;
    const normalized = asserted.map((assertion) => definition.normalize(assertion.assertion));
    const agrees = normalized.every((value) => value != null && value === normalized[0]);
    facts.push({
      key: definition.key,
      label: definition.label,
      status: agrees ? "agrees" : "disagrees",
      assertions,
      claim_layer: claimLayerForFact(definition, assertions, agrees),
    });
  }

  const uniqueJoins = [...new Map(joins.map((join) => [
    `${join.refs.slice().sort().join("\0")}\0${join.basis}`,
    {
      status: "accepted",
      basis: join.basis,
      basis_label: EXACT_JOIN_BASIS.get(join.basis),
      relation: CROSS_SOURCE_RELATION.exact.id,
      relation_label: CROSS_SOURCE_RELATION.exact.label,
      matched_value: looseText(join.matched_value),
      evidence_only: join.evidence_only === true,
      overwrites_canonical: false,
      source_observation_refs: join.refs.slice().sort(),
    },
  ])).values()];
  const fieldScopeBySource = new Map(sourceRows.map((source) => [source.source_system, new Set()]));
  for (const fact of facts) {
    for (const assertion of fact.assertions) {
      if (assertion.field && fieldScopeBySource.has(assertion.source_system)) {
        fieldScopeBySource.get(assertion.source_system).add(assertion.field);
      }
    }
  }
  const constructorSystems = new Set((Array.isArray(object?.source_observation_refs)
    ? object.source_observation_refs
    : []).map((ref) => looseText(ref)?.split(":")[0]?.toLowerCase()).filter(Boolean));
  const sourceOutput = sourceRows.map(({ snapshot: _snapshot, ...source }) => ({
    ...source,
    compact_source_name: compactSourceName(source.source_system, source.source_name),
    field_scope: [...(fieldScopeBySource.get(source.source_system) || [])].sort(),
    constructor: constructorSystems.has(source.source_system),
  }));
  const corroborating = constructorSystems.size
    ? sourceOutput.filter((source) => !source.constructor)
    : sourceOutput.slice(1);
  const uniqueAlso = [...new Set((corroborating.length ? corroborating : sourceOutput.slice(1))
    .map((source) => source.compact_source_name)
    .filter(Boolean))];
  return Object.freeze({
    schema: CROSS_SOURCE_EVIDENCE_RECEIPT_SCHEMA,
    version: CROSS_SOURCE_EVIDENCE_RECEIPT_VERSION,
    status: facts.some((fact) => fact.status === "disagrees") ? "disagreement" : "corroborated",
    object_ref: objectId,
    relation: CROSS_SOURCE_RELATION.exact.id,
    relation_label: CROSS_SOURCE_RELATION.exact.label,
    also_recorded_in: Object.freeze(uniqueAlso),
    overwrites_canonical: false,
    sources: Object.freeze(sourceOutput),
    joins: Object.freeze(uniqueJoins),
    facts: Object.freeze(facts),
    generated_at: generatedAt,
  });
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function sourceLink(source) {
  const id = source.source_native_id ? ` <code>${esc(source.source_native_id)}</code>` : "";
  return source.source_href
    ? `<a class="cross-source-evidence-source-link" href="${esc(source.source_href)}" target="_blank" rel="noopener noreferrer">${esc(source.source_name)}<span aria-hidden="true">↗</span></a>${id}`
    : `${esc(source.source_name)}${id}`;
}

function assertionBasis(assertion) {
  return [
    assertion.field ? `publisher field: ${assertion.field}` : null,
    assertion.provenance?.as_of ? `as of ${assertion.provenance.as_of}` : null,
  ].filter(Boolean).join(" · ");
}

function compactAgreementHtml(facts) {
  const agrees = (Array.isArray(facts) ? facts : []).filter((fact) => fact.status === "agrees");
  if (!agrees.length) return "";
  const items = agrees.map((fact) => {
    const values = fact.assertions
      .filter((assertion) => assertion.assertion != null)
      .map((assertion) => `<span data-claim="source_assertion" data-source-system="${esc(assertion.source_system)}"><strong>${esc(assertion.source_name)}</strong> ${esc(assertion.assertion)}</span>`)
      .join(" · ");
    return `<p class="cross-source-evidence-agreement" data-fact-key="${esc(fact.key)}">${esc(fact.label)} — ${values}</p>`;
  }).join("");
  return `<div class="cross-source-evidence-agreements">${items}</div>`;
}

function disagreementHtml(fact) {
  const assertionItems = fact.assertions
    .filter((assertion) => assertion.assertion != null)
    .map((assertion) => {
      const basis = assertionBasis(assertion);
      const coverage = assertion.provenance?.coverage_label || null;
      const metadata = [coverage, basis].filter(Boolean).join(" · ");
      return `<li class="cross-source-evidence-assertion" data-source-system="${esc(assertion.source_system)}" data-claim="source_assertion"><div><strong>${esc(assertion.source_name)}</strong> <span class="cross-source-evidence-assertion-value">${esc(assertion.assertion)}</span> <span class="cross-source-evidence-assertion-kind">source assertion</span></div><div class="cross-source-evidence-provenance">${sourceLink(assertion)}${metadata ? ` · ${esc(metadata)}` : ""}</div></li>`;
    }).join("");
  const summary = fact.claim_layer?.interpretation?.summary
    || `CityScroll interpretation: different ${String(fact.label || "field").toLowerCase()} values. Resolution unresolved (no derived conclusion).`;
  return `<article class="cross-source-evidence-fact cross-source-evidence-fact-disagrees" data-fact-key="${esc(fact.key)}" data-claim-layer="claim_layer_v1"><h3>${esc(fact.label)} <span class="cross-source-evidence-state">Sources disagree</span></h3><ul>${assertionItems}</ul><p class="cross-source-evidence-honesty" data-claim="cityscroll_interpretation">${esc(summary)}</p></article>`;
}

/** Render the receipt without creating a request-time source lookup. */
export function renderCrossSourceEvidenceReceipt(receipt) {
  if (!receipt || !Array.isArray(receipt.sources) || receipt.sources.length < 2) return "";
  if (receipt.relation && receipt.relation !== CROSS_SOURCE_RELATION.exact.id) return "";
  const also = (Array.isArray(receipt.also_recorded_in) && receipt.also_recorded_in.length
    ? receipt.also_recorded_in
    : receipt.sources.slice(1).map((source) => compactSourceName(source.source_system, source.compact_source_name || source.source_name)))
    .filter(Boolean);
  if (!also.length) return "";
  const sourceNames = also.join(" and ");
  const methods = [...new Set((receipt.joins || []).map((join) => join.basis_label).filter(Boolean))].join("; ");
  const sourceCards = receipt.sources.map((source) => {
    const compact = compactSourceName(source.source_system, source.compact_source_name || source.source_name);
    return `<li class="cross-source-evidence-source" data-compact-source="${esc(compact)}" data-relation="exact"><strong>${sourceLink(source)}</strong><span>${esc(source.coverage_label || source.coverage || "Coverage not stated")}</span><span>${source.as_of ? `As of ${esc(source.as_of)}` : "As-of date not published"}</span><span>Accepted join: ${esc((source.accepted_join_methods || []).map((method) => method.label).join("; ") || methods || "Exact identifier")}</span><span>Fields in receipt: ${esc((source.field_scope || []).join(", ") || "Not published")}</span></li>`;
  }).join("");
  const disagrees = (Array.isArray(receipt.facts) ? receipt.facts : []).filter((fact) => fact.status === "disagrees");
  const agrees = (Array.isArray(receipt.facts) ? receipt.facts : []).filter((fact) => fact.status === "agrees");
  const factsHtml = `${compactAgreementHtml(agrees)}${disagrees.map(disagreementHtml).join("")}`;
  const lead = disagrees.length
    ? `<strong>Also recorded in ${esc(sourceNames)}</strong>. These records share an accepted exact identifier. Where publishers differ, each source assertion stays visible and the comparison stays unresolved.`
    : `<strong>Also recorded in ${esc(sourceNames)}</strong>. These records share an accepted exact identifier; each publisher keeps its own values.`;
  return `<section class="node-section node-card cross-source-evidence-receipt" data-cross-source-evidence-receipt="1" data-receipt-status="${esc(receipt.status)}" data-relation="exact" aria-labelledby="cross-source-evidence-heading"><h2 id="cross-source-evidence-heading">Cross-source evidence</h2><p class="cross-source-evidence-lead">${lead}</p><ul class="cross-source-evidence-sources">${sourceCards}</ul><div class="cross-source-evidence-facts">${factsHtml}</div></section>`;
}

export const crossSourceEvidenceReceiptFacts = FACT_DEFINITIONS;
