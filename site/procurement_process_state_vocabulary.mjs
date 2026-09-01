/**
 * The single procurement process-state vocabulary.
 *
 * This module is deliberately dependency-free so the route serializer, the
 * resident query predicate, the Following watch schema, and the observed-event
 * projection can all share one closed list of publisher-observed states instead
 * of maintaining parallel copies. Legacy procurement stages remain a separate
 * concern owned by procurement_object_contract.mjs.
 */

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

/**
 * Known publisher-observed states. `unknown` is deliberately excluded: an
 * unobserved or unmapped publisher value stays unknown and never becomes a
 * collection predicate or a watch target.
 */
export const KNOWN_PROCUREMENT_PROCESS_STATES = Object.freeze(
  PROCUREMENT_PROCESS_STATES.filter((state) => state !== "unknown"),
);

export const PROCUREMENT_PROCESS_STATE_ORDER = Object.freeze(Object.fromEntries(
  PROCUREMENT_PROCESS_STATES.map((state, index) => [state, index]),
));

export const PROCUREMENT_PROCESS_STATE_LABELS = Object.freeze({
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

/** True only for an exact known state in the canonical process vocabulary. */
export function isKnownProcurementProcessState(value) {
  const state = String(value ?? "").trim();
  return Boolean(state) && KNOWN_PROCUREMENT_PROCESS_STATES.includes(state);
}

/** Canonical process order rank; unranked values sort after every known state. */
export function procurementProcessStateRank(state) {
  return PROCUREMENT_PROCESS_STATE_ORDER[String(state ?? "").trim()] ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Known source-backed states observed for one object, in canonical process
 * order. An event without a retained source observation, or carrying an
 * unmapped publisher value, contributes nothing.
 */
export function procurementProcessStates(events = []) {
  const states = (Array.isArray(events) ? events : [])
    .filter((event) => String(event?.source_observation_ref ?? "").trim()
      && isKnownProcurementProcessState(event?.state))
    .map((event) => String(event.state).trim());
  return [...new Set(states)]
    .sort((left, right) => procurementProcessStateRank(left) - procurementProcessStateRank(right));
}
