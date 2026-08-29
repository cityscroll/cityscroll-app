/**
 * Source-backed procedural state for procurement observations.
 *
 * This is an additive projection. Legacy procurement stages remain owned by
 * procurement_object_contract.mjs while this contract preserves the literal
 * publisher status and its source observation for lifecycle consumers.
 */

import { officialSourceLink } from "./affordance_grammar.mjs";
import { passportPublicOfficialSource } from "../worker/src/lib/passport_parse.mjs";
import { isPassportPendingStatus, isPassportRegisteredStatus } from "../worker/src/lib/passport_join.mjs";

export const PROCUREMENT_PROCESS_EVENT_SCHEMA = "cityscroll.procurement_process_event.v1";
export const PROCUREMENT_PROCESS_EVENT_VERSION = 1;

export const PROCUREMENT_PROCESS_STATES = Object.freeze([
  "planned",
  "open",
  "responses_closed",
  "evaluation",
  "selection_made",
  "intent_to_negotiate",
  "intent_to_award",
  "award",
  "contract_in_progress",
  "pending_registration",
  "registered",
  "payment",
  "closed",
  "vendor_list",
  "unknown",
]);

export const PASSPORT_RFX_STATE_MAP = Object.freeze({
  planned: "planned",
  released: "open",
  "responses received": "evaluation",
  "selections made": "selection_made",
  closed: "closed",
});

const PROCESS_STATE_ORDER = Object.freeze(Object.fromEntries(
  PROCUREMENT_PROCESS_STATES.map((state, index) => [state, index]),
));

const SOURCE_LABELS = Object.freeze({
  city_record: "City Record",
  city_record_procurement: "City Record",
  crol: "City Record",
  passport_public_rfx: "PASSPort Public solicitations",
  passport_public_contracts: "PASSPort Public contracts",
  checkbook_contracts: "Checkbook NYC",
  checkbook_nycha_contracts: "Checkbook NYC",
  checkbook_spending: "Checkbook NYC spending",
});

const CHECKBOOK_SMART_SEARCH = "https://www.checkbooknyc.com/smart_search/citywide";
const CITY_RECORD_SOURCES = new Set(["city_record", "city_record_procurement", "crol"]);
const CONTRACT_SOURCES = new Set([
  "passport_public_contracts",
  "checkbook_contracts",
  "checkbook_nycha_contracts",
]);

const PROCESS_EVENT_LABELS = Object.freeze({
  planned: "Planned",
  open: "Open",
  responses_closed: "Responses closed",
  evaluation: "Evaluation · responses no longer accepted",
  selection_made: "Selection made",
  intent_to_negotiate: "Intent to negotiate",
  intent_to_award: "Intent to award",
  award: "Award",
  contract_in_progress: "Contract in progress",
  pending_registration: "Pending registration",
  registered: "Registered",
  payment: "Payment",
  closed: "Closed",
  vendor_list: "Vendor list",
  unknown: "Unknown publisher state",
});

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

/** Normalize a publisher date without deriving one from another clock. */
export function publisherDate(value) {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}(?:$|T|\s)/.test(raw)) return raw.slice(0, 10);
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:$|\s)/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  return null;
}

/**
 * Map a PASSPort literal while retaining the original publisher value.
 * Unknown and absent values are intentionally not assigned a lifecycle state.
 */
export function normalizePassportRfxState(value) {
  const raw = value == null ? null : String(value);
  const literal = raw && raw.trim() ? raw : null;
  const state = literal ? PASSPORT_RFX_STATE_MAP[literal.trim().toLowerCase()] || "unknown" : "unknown";
  return {
    state,
    publisher_state: literal,
    state_basis: literal ? "explicit" : "deterministic_projection",
    ...(literal ? {} : {
      metadata: {
        derivation_rule: "missing_publisher_status_to_unknown",
      },
    }),
  };
}

function rfxVendorRef(observation, observations) {
  const rfxRef = observation?.source_observation_ref;
  const values = (Array.isArray(observations) ? observations : [])
    .filter((candidate) => candidate?.source_observation_ref !== rfxRef)
    .map((candidate) => candidate?.snapshot || {})
    .map((row) => row.vendor_ref || row.vendor_id || row.vendor_name || row.vendor || row.prime_vendor || null)
    .map(text)
    .filter(Boolean);
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : null;
}

function effectiveAt(row) {
  return publisherDate(
    row?.effective_at
      || row?.status_date
      || row?.rfx_status_date
      || row?.release_date,
  );
}

function sourceReceiptRef(observation) {
  return text(observation?.source_receipt_ref || observation?.content_hash);
}

function snapshotRow(observation) {
  return observation?.snapshot && typeof observation.snapshot === "object" ? observation.snapshot : {};
}

function withReceipt(event, observation, metadata = {}) {
  const receipt = sourceReceiptRef(observation);
  return {
    ...event,
    ...(receipt ? { source_receipt_ref: receipt } : {}),
    metadata: {
      ...metadata,
      ...(receipt ? { source_receipt_ref: receipt } : {}),
    },
  };
}

function cityRecordState(row) {
  const type = text(row.type_of_notice_description || row.type_of_notice || row.stage);
  if (!type) return null;
  const lower = type.toLowerCase();
  if (lower.includes("intent to negotiate")) return { state: "intent_to_negotiate", publisher_state: type };
  if (lower.includes("vendor list")) return { state: "vendor_list", publisher_state: type };
  if (lower.includes("intent to award")) return { state: "intent_to_award", publisher_state: type };
  if (lower.includes("solicitation")) return null;
  if (lower.includes("award")) return { state: "award", publisher_state: type };
  return null;
}

function contractState(row, sourceSystem) {
  const status = text(row.status);
  if (sourceSystem === "passport_public_contracts") {
    if (isPassportPendingStatus(status)) {
      return { state: "pending_registration", publisher_state: status, publisher_field: "status" };
    }
    if (isPassportRegisteredStatus(status) || status?.toLowerCase().includes("register") || row.registration_date) {
      return {
        state: "registered",
        publisher_state: status || (row.registration_date ? "Registered" : null),
        publisher_field: status ? "status" : "registration_date",
      };
    }
    if (status) return { state: "contract_in_progress", publisher_state: status, publisher_field: "status" };
    return null;
  }
  const lower = status?.toLowerCase() || "";
  if (lower.includes("pending")) {
    return { state: "pending_registration", publisher_state: status, publisher_field: "status" };
  }
  if (lower.includes("register") || row.registered || row.registration_date) {
    return {
      state: "registered",
      publisher_state: status || "registered",
      publisher_field: status ? "status" : "registered",
    };
  }
  return null;
}

function evidenceFor(observation, row) {
  const system = text(observation?.source_system)?.toLowerCase();
  if (CITY_RECORD_SOURCES.has(system)) {
    const requestId = text(row.request_id);
    return requestId
      ? { evidence_href: `/notices/${encodeURIComponent(requestId)}`, evidence_label: "City Record notice" }
      : {};
  }
  if (system === "passport_public_rfx") {
    const source = passportPublicOfficialSource("rfx", row);
    return source?.href ? { evidence_href: source.href, evidence_label: source.label } : {};
  }
  if (system === "passport_public_contracts") {
    const source = passportPublicOfficialSource("contract", row);
    return source?.href ? { evidence_href: source.href, evidence_label: source.label } : {};
  }
  if (system === "checkbook_contracts" || system === "checkbook_nycha_contracts" || system === "checkbook_spending") {
    const term = text(row.id || row.contract_id || row.contractId || row.prime_contract_id || row.vendor || row.payee_name);
    const href = text(row.official_url || row.source_url)
      || (term ? `${CHECKBOOK_SMART_SEARCH}?search_term=${encodeURIComponent(term)}` : null);
    return href ? { evidence_href: href, evidence_label: "Checkbook NYC" } : {};
  }
  return {};
}

function baseEvent({ procurementId, observation, state, publisherState, stateBasis, effectiveAtValue, deadline, kind, extraMetadata = {} }) {
  const sourceObservationRef = text(observation?.source_observation_ref);
  const system = text(observation?.source_system)?.toLowerCase();
  const row = snapshotRow(observation);
  if (!text(procurementId) || !sourceObservationRef || !state || !system) return null;
  return withReceipt({
    schema: PROCUREMENT_PROCESS_EVENT_SCHEMA,
    version: PROCUREMENT_PROCESS_EVENT_VERSION,
    procurement_id: text(procurementId),
    event_id: `${text(procurementId)}:${sourceObservationRef}:${kind}`,
    state,
    publisher_state: publisherState,
    state_basis: stateBasis,
    effective_at: effectiveAtValue,
    source_system: system,
    source_observation_ref: sourceObservationRef,
    ...(deadline ? { deadline } : {}),
  }, observation, {
    publisher_field: extraMetadata.publisher_field,
    ...(extraMetadata.publisher_identifier ? { publisher_identifier: extraMetadata.publisher_identifier } : {}),
    ...evidenceFor(observation, row),
    ...extraMetadata,
  });
}

/** Build one event from one retained PASSPort RFx observation. */
export function passportRfxProcessEvent({ procurementId, observation, observations = [] } = {}) {
  const row = snapshotRow(observation);
  const normalized = normalizePassportRfxState(row.rfx_status);
  const event = baseEvent({
    procurementId,
    observation,
    state: normalized.state,
    publisherState: normalized.publisher_state,
    stateBasis: normalized.state_basis,
    effectiveAtValue: effectiveAt(row),
    deadline: publisherDate(row.due_date),
    kind: "rfx-status",
    extraMetadata: {
      ...(normalized.metadata || {}),
      publisher_field: "rfx_status",
      ...(row.rfp_id ? { publisher_identifier: text(row.rfp_id) } : {}),
    },
  });
  if (!event) return null;
  if (normalized.state === "selection_made") {
    const vendorRef = rfxVendorRef(observation, observations);
    if (vendorRef) event.vendor_ref = vendorRef;
  }
  return event;
}

export function cityRecordProcessEvent({ procurementId, observation } = {}) {
  const row = snapshotRow(observation);
  const mapped = cityRecordState(row);
  if (!mapped) return null;
  return baseEvent({
    procurementId,
    observation,
    state: mapped.state,
    publisherState: mapped.publisher_state,
    stateBasis: "explicit",
    effectiveAtValue: publisherDate(row.start_date || row.event_date || row.publication_date),
    kind: mapped.state,
    extraMetadata: {
      publisher_field: "type_of_notice_description",
      ...(row.request_id ? { publisher_identifier: text(row.request_id) } : {}),
    },
  });
}

export function contractProcessEvent({ procurementId, observation } = {}) {
  const row = snapshotRow(observation);
  const system = text(observation?.source_system)?.toLowerCase();
  const mapped = contractState(row, system);
  if (!mapped) return null;
  const effectiveAtValue = mapped.state === "registered"
    ? publisherDate(row.registration_date || row.registered || row.status_date || row.received)
    : publisherDate(row.status_date || row.start_date || row.start || row.received);
  return baseEvent({
    procurementId,
    observation,
    state: mapped.state,
    publisherState: mapped.publisher_state,
    stateBasis: "explicit",
    effectiveAtValue,
    kind: mapped.state,
    extraMetadata: {
      publisher_field: mapped.publisher_field,
      ...(text(row.contract_id || row.ctr_id || row.id) ? {
        publisher_identifier: text(row.contract_id || row.ctr_id || row.id),
      } : {}),
    },
  });
}

export function paymentProcessEvent({ procurementId, observation } = {}) {
  const row = snapshotRow(observation);
  return baseEvent({
    procurementId,
    observation,
    state: "payment",
    publisherState: text(row.document_id || row.check_amount || row.issue_date) || "payment",
    stateBasis: "explicit",
    effectiveAtValue: publisherDate(row.issue_date || row.check_date || row.date || row.effective_at),
    kind: "payment",
    extraMetadata: {
      publisher_field: "issue_date",
      ...(text(row.document_id || row.documentId) ? { publisher_identifier: text(row.document_id || row.documentId) } : {}),
    },
  });
}

function processEventFromObservation({ procurementId, observation, observations }) {
  const system = text(observation?.source_system)?.toLowerCase();
  if (system === "passport_public_rfx") {
    return passportRfxProcessEvent({ procurementId, observation, observations });
  }
  if (CITY_RECORD_SOURCES.has(system)) return cityRecordProcessEvent({ procurementId, observation });
  if (CONTRACT_SOURCES.has(system)) return contractProcessEvent({ procurementId, observation });
  if (system === "checkbook_spending") return paymentProcessEvent({ procurementId, observation });
  return null;
}

function compareProcessEvents(left, right) {
  return String(left.effective_at || "9999-99-99").localeCompare(String(right.effective_at || "9999-99-99"))
    || ((PROCESS_STATE_ORDER[left.state] ?? 99) - (PROCESS_STATE_ORDER[right.state] ?? 99))
    || String(left.source_observation_ref || "").localeCompare(String(right.source_observation_ref || ""));
}

/** Project retained observations attached to one object into ordered process events. */
export function procurementProcessEvents(object = {}, observations = []) {
  const refs = new Set(Array.isArray(object.source_observation_refs) ? object.source_observation_refs : []);
  const objectObservations = (Array.isArray(observations) ? observations : [])
    .filter((observation) => refs.has(observation?.source_observation_ref));
  const byId = new Map();
  for (const observation of objectObservations) {
    const event = processEventFromObservation({
      procurementId: object.procurement_id,
      observation,
      observations: objectObservations,
    });
    if (!event?.event_id || byId.has(event.event_id)) continue;
    byId.set(event.event_id, event);
  }
  return [...byId.values()].sort(compareProcessEvents);
}

export function processEventLabel(event = {}) {
  if (PROCESS_EVENT_LABELS[event.state]) return PROCESS_EVENT_LABELS[event.state];
  return event.state === "unknown" ? "Unknown publisher state" : text(event.state);
}

function sourceLabel(event = {}) {
  return SOURCE_LABELS[event.source_system] || null;
}

function evidenceLink(event = {}) {
  const href = text(event.metadata?.evidence_href);
  const label = text(event.metadata?.evidence_label);
  if (!href || !label) return "";
  if (href.startsWith("/")) {
    return `<p><a href="${esc(href)}">${esc(label)}</a></p>`;
  }
  return `<p>${officialSourceLink({ href, label })}</p>`;
}

function eventEvidence(event = {}) {
  const source = sourceLabel(event);
  const publisher = text(event.publisher_state);
  const parts = [
    source ? `<p>${esc(source)}</p>` : "",
    publisher ? `<p>Publisher status: ${esc(publisher)}</p>` : "",
    evidenceLink(event),
  ].filter(Boolean);
  if (!parts.length) return "";
  return `<details><summary>Source record</summary>${parts.join("")}</details>`;
}

/** Compact chronological strip of observed events for the canonical document. */
export function renderProcurementProcessEvents(events = []) {
  const rows = (Array.isArray(events) ? events : [])
    .map((event) => {
      const label = processEventLabel(event);
      if (!label) return "";
      const observed = event.effective_at
        ? ` · Observed <time datetime="${esc(event.effective_at)}">${esc(event.effective_at)}</time>`
        : "";
      const deadline = event.deadline ? ` · Due ${esc(event.deadline)}` : "";
      return `<li data-process-state="${esc(event.state)}"><strong>${esc(label)}</strong>${observed}${deadline}${eventEvidence(event)}</li>`;
    })
    .filter(Boolean);
  return rows.length
    ? `<ol class="node-fact-list procurement-process-events">${rows.join("")}</ol>`
    : "";
}
