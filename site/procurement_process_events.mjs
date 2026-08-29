/**
 * Source-backed procedural state for procurement observations.
 *
 * This is an additive projection. Legacy procurement stages remain owned by
 * procurement_object_contract.mjs while this contract preserves the literal
 * publisher status and its source observation for lifecycle consumers.
 */

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

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
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

/** Build one event from one retained PASSPort RFx observation. */
export function passportRfxProcessEvent({ procurementId, observation, observations = [] } = {}) {
  const sourceObservationRef = text(observation?.source_observation_ref);
  const row = observation?.snapshot && typeof observation.snapshot === "object"
    ? observation.snapshot : {};
  if (!text(procurementId) || !sourceObservationRef) return null;
  const normalized = normalizePassportRfxState(row.rfx_status);
  const event = {
    schema: PROCUREMENT_PROCESS_EVENT_SCHEMA,
    version: PROCUREMENT_PROCESS_EVENT_VERSION,
    procurement_id: text(procurementId),
    event_id: `${text(procurementId)}:${sourceObservationRef}:rfx-status`,
    state: normalized.state,
    publisher_state: normalized.publisher_state,
    state_basis: normalized.state_basis,
    effective_at: effectiveAt(row),
    source_system: "passport_public_rfx",
    source_observation_ref: sourceObservationRef,
    deadline: publisherDate(row.due_date),
    ...(sourceReceiptRef(observation) ? { source_receipt_ref: sourceReceiptRef(observation) } : {}),
    metadata: {
      ...(normalized.metadata || {}),
      publisher_field: "rfx_status",
      ...(row.rfp_id ? { publisher_identifier: text(row.rfp_id) } : {}),
      ...(sourceReceiptRef(observation) ? { source_receipt_ref: sourceReceiptRef(observation) } : {}),
    },
  };
  if (normalized.state === "selection_made") {
    const vendorRef = rfxVendorRef(observation, observations);
    if (vendorRef) event.vendor_ref = vendorRef;
  }
  return event;
}

/** Project all retained PASSPort RFx observations attached to one object. */
export function procurementProcessEvents(object = {}, observations = []) {
  const refs = new Set(Array.isArray(object.source_observation_refs) ? object.source_observation_refs : []);
  const objectObservations = (Array.isArray(observations) ? observations : [])
    .filter((observation) => refs.has(observation?.source_observation_ref));
  return objectObservations
    .filter((observation) => observation?.source_system === "passport_public_rfx")
    .map((observation) => passportRfxProcessEvent({
      procurementId: object.procurement_id,
      observation,
      observations: objectObservations,
    }))
    .filter(Boolean)
    .sort((left, right) => (
      String(left.effective_at || "9999-99-99").localeCompare(String(right.effective_at || "9999-99-99"))
      || left.source_observation_ref.localeCompare(right.source_observation_ref)
    ));
}

export function processEventLabel(event = {}) {
  if (event.state === "open") return "Open";
  if (event.state === "evaluation") return "Evaluation · responses no longer accepted";
  if (event.state === "selection_made") return "Selection made";
  if (event.state === "planned") return "Planned";
  if (event.state === "closed") return "Closed";
  return event.state === "unknown" ? "Unknown publisher state" : text(event.state);
}

/** Minimal resident-facing rendering for the RFx state projection. */
export function renderProcurementProcessEvents(events = []) {
  const rows = (Array.isArray(events) ? events : [])
    .map((event) => {
      const label = processEventLabel(event);
      if (!label) return "";
      const observed = event.effective_at ? ` · Observed ${event.effective_at}` : "";
      const deadline = event.deadline ? ` · Due ${event.deadline}` : "";
      return `<li><strong>${label}</strong>${observed}${deadline}</li>`;
    })
    .filter(Boolean);
  return rows.length
    ? `<ol class="node-fact-list procurement-process-events">${rows.join("")}</ol>`
    : "";
}
