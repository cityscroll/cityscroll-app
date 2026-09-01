/**
 * Following transitions over the canonical observed-event procurement projection.
 *
 * This module adds no watch vocabulary of its own. It reuses the process states
 * already published by procurement_process_events.mjs and the same
 * `{ rows, markSeenIds }` reconciliation shape the property disposition watch
 * uses, so a transition is delivered exactly once per retained source
 * observation. Nothing here reads a clock: a transition exists only when a
 * later source-backed observation records a further state. A deadline passing,
 * a record disappearing, or a display string changing is never a transition.
 */

import {
  isKnownProcurementProcessState,
  procurementProcessStateRank,
} from "./procurement_process_state_vocabulary.mjs";

export const PROCUREMENT_PROCESS_WATCH_SCHEMA = "cityscroll.procurement_process_watch.v1";

/** Bounded per-object retention. A procurement observes far fewer known states. */
export const PROCUREMENT_PROCESS_WATCH_EVENT_LIMIT = 24;

function text(value, max = 320) {
  const result = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return result || null;
}

function day(value) {
  const raw = text(value, 40);
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function compareEvents(left, right) {
  return String(left.effective_at || "9999-99-99").localeCompare(String(right.effective_at || "9999-99-99"))
    || (procurementProcessStateRank(left.state) - procurementProcessStateRank(right.state))
    || String(left.event_id || "").localeCompare(String(right.event_id || ""));
}

/**
 * Bounded, delivery-safe copy of one object's known source-backed events.
 * An event without a retained source observation, or carrying an unknown
 * publisher state, is dropped rather than guessed at.
 */
export function compactProcurementProcessEvents(events = []) {
  const compact = (Array.isArray(events) ? events : [])
    .filter((event) => isKnownProcurementProcessState(event?.state) && text(event?.source_observation_ref))
    .map((event) => {
      const state = text(event.state, 80);
      const sourceObservationRef = text(event.source_observation_ref);
      // Compaction is idempotent: a row read back from the digest snapshot already
      // carries the flattened receipt fields, so accept either shape.
      const evidenceHref = text(event.evidence_href, 600) || text(event?.metadata?.evidence_href, 600);
      const sourceReceiptRef = text(event.source_receipt_ref, 320)
        || text(event?.metadata?.source_receipt_ref, 320);
      const publisherState = text(event.publisher_state, 240);
      return {
        event_id: text(event.event_id, 640)
          || `${text(event.procurement_id) || "procurement"}:${sourceObservationRef}:${state}`,
        state,
        effective_at: day(event.effective_at),
        source_system: text(event.source_system, 120),
        source_observation_ref: sourceObservationRef,
        ...(sourceReceiptRef ? { source_receipt_ref: sourceReceiptRef } : {}),
        ...(publisherState ? { publisher_state: publisherState } : {}),
        ...(evidenceHref ? { evidence_href: evidenceHref } : {}),
      };
    });
  const byId = new Map(compact.map((event) => [event.event_id, event]));
  return [...byId.values()].sort(compareEvents).slice(0, PROCUREMENT_PROCESS_WATCH_EVENT_LIMIT);
}

/** Durable "this object was already at this state" marker. */
export function procurementProcessObservedKey(procurementId, state) {
  return `procurement-process:${encodeURIComponent(String(procurementId ?? ""))}:observed:${String(state ?? "")}`;
}

/** Stable deduplication identity for one delivered transition. */
export function procurementProcessTransitionKey(procurementId, from, to, eventId) {
  return [
    "procurement-process",
    encodeURIComponent(String(procurementId ?? "")),
    "transition",
    `${String(from ?? "")}>${String(to ?? "")}`,
    encodeURIComponent(String(eventId ?? "")),
  ].join(":");
}

function observedStates(events) {
  return [...new Set(events.map((event) => event.state))]
    .sort((left, right) => procurementProcessStateRank(left) - procurementProcessStateRank(right));
}

function latestEventForState(events, state) {
  return [...events].reverse().find((event) => event.state === state) || null;
}

/**
 * Decorate procurement rows with the one transition each retained observation
 * warrants. Rows are never dropped: this is an additive decoration on the
 * existing delivery rows, and a row with no advancing observation is returned
 * unchanged.
 */
export function evaluateProcurementProcessWatch(rows = [], seenInput = new Set()) {
  const seen = new Set(seenInput || []);
  const output = [];
  const markSeenIds = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const procurementId = text(row?.procurement_id, 320);
    const events = compactProcurementProcessEvents(row?.process_events);
    if (!procurementId || !events.length) {
      output.push(row);
      continue;
    }
    const states = observedStates(events);
    const priorStates = states.filter((state) => seen.has(procurementProcessObservedKey(procurementId, state)));
    const priorState = priorStates.at(-1) || null;
    // The current state is the furthest known state the sources actually record,
    // and its event is the latest retained observation carrying that state. A
    // backdated publisher record therefore cannot masquerade as an advance.
    const currentState = states.at(-1);
    const currentEvent = latestEventForState(events, currentState);
    for (const state of states) {
      const key = procurementProcessObservedKey(procurementId, state);
      if (seen.has(key)) continue;
      seen.add(key);
      markSeenIds.push(key);
    }
    let transition = null;
    const advances = Boolean(priorState)
      && procurementProcessStateRank(currentState) > procurementProcessStateRank(priorState);
    if (advances) {
      const priorEvent = latestEventForState(events, priorState);
      const outOfOrder = Boolean(priorEvent?.effective_at)
        && Boolean(currentEvent.effective_at)
        && currentEvent.effective_at < priorEvent.effective_at;
      const transitionKey = procurementProcessTransitionKey(
        procurementId,
        priorState,
        currentState,
        currentEvent.event_id,
      );
      if (!outOfOrder && !seen.has(transitionKey)) {
        seen.add(transitionKey);
        markSeenIds.push(transitionKey);
        transition = {
          transition_key: transitionKey,
          from: {
            state: priorState,
            ...(priorEvent?.effective_at ? { effective_at: priorEvent.effective_at } : {}),
          },
          to: { state: currentState },
          event: currentEvent,
        };
      }
    }
    output.push({
      ...row,
      procurement_process_watch: {
        schema: PROCUREMENT_PROCESS_WATCH_SCHEMA,
        procurement_id: procurementId,
        observed_states: states,
        current_state: currentState,
        transition,
      },
    });
  }
  return { rows: output, markSeenIds: [...new Set(markSeenIds)] };
}
