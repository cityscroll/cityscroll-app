/**
 * PIR-5 prospective shadow mode.
 *
 * Shadow mode is a measurement mode, not a product surface. It replays a
 * retained stream of newly arriving observations in two ordered phases:
 *
 *   1. The assertion phase sees source observations only. Each arriving
 *      meeting or document span is sealed at its own publication clock, run
 *      through the PIR-1 extractor and the PIR-2 ontology, and recorded as an
 *      open internal intent with a provisional identity and conservative
 *      occurrence/timing claims.
 *   2. The resolution phase is the only phase that observes later solicitation
 *      evidence. It reuses the landed PIR-3 realization matcher and records a
 *      resolution or review outcome beside the earlier assertion. The earlier
 *      assertion is fingerprinted before resolution and re-checked after it, so
 *      a later realization can never become a feature of the earlier candidate.
 *
 * Nothing here publishes. The artifact is internal-only: no route, search
 * result, follow target, notification, or resident-facing claim is produced.
 * There is no network access and no CityMeetings runtime dependency; citation
 * URLs are retained strings, never fetched.
 */

import { createHash } from "node:crypto";
import {
  EXTRACTION_VERSION,
  containsRfpBaseline,
  extractSource,
} from "./procurement_intent_extractor.mjs";
import {
  REALIZATION_MATCHER_VERSION,
  matchHistoricalIntent,
} from "./procurement_intent_realization_matcher.mjs";
import {
  HINDSIGHT_FIELDS,
  sealHistoricalSource,
} from "./procurement_intent_corpus.mjs";
import {
  PROSPECTIVE_PREDICTION_VERSION,
  buildProspectiveProcess,
} from "../../ontology/procurement_intent.mjs";

export const SHADOW_ARRIVALS_SCHEMA = "cityscroll.procurement_intent_radar.shadow_arrivals.v0";
export const SHADOW_MODE_SCHEMA = "cityscroll.procurement_intent_radar.shadow_mode.v1";
export const SHADOW_MODE_VERSION = "pir-shadow-mode.v1";
export const SHADOW_VISIBILITY = "internal_only";

/** An arrival later than this many days after publication is a stale arrival. */
export const STALE_ARRIVAL_DAYS = 30;
/** Days past a stated window before an unrealized intent stops being open. */
export const RESOLUTION_GRACE_DAYS = 60;

export const INTENT_STATES = Object.freeze([
  "open",
  "resolved",
  "ambiguous",
  "unmatched",
  "superseded",
]);

export const ARRIVAL_DISPOSITIONS = Object.freeze([
  "opened_intent",
  "duplicate_replay",
  "insufficient_evidence",
  "abstained",
  "resolution_observation",
  "malformed",
]);

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;

function isoDay(value) {
  const day = String(value ?? "").trim();
  if (!ISO_DAY.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}

function daysBetween(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
}

function addDays(day, days) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Stable key ordering so a replayed stream hashes and serializes identically. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const key of Object.keys(value).sort()) next[key] = canonicalize(value[key]);
  return next;
}

export function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function citationRows(source) {
  return (Array.isArray(source?.citations) ? source.citations : [])
    .filter((citation) => citation && typeof citation === "object" && String(citation.url || "").trim())
    .map((citation) => ({
      label: String(citation.label || "").trim() || null,
      url: String(citation.url).trim(),
      authority: String(citation.authority || "").trim() || null,
    }));
}

/**
 * Source receipts an arriving observation must carry before an intent may be
 * opened. A missing span or citation is recorded, never quietly dropped.
 */
export function sourceEvidenceGaps(source) {
  const gaps = [];
  if (!String(source?.source_record_id || "").trim()) gaps.push("missing_source_record_id");
  if (!String(source?.source_event_id || "").trim()) gaps.push("missing_source_event_id");
  if (!isoDay(source?.observed_at)) gaps.push("missing_publication_timestamp");
  if (!String(source?.source_span_text || "").trim()) gaps.push("missing_source_span");
  if (!citationRows(source).length) gaps.push("missing_source_citation");
  return gaps;
}

export function assertArrivalStream(stream) {
  if (!stream || typeof stream !== "object") throw new TypeError("arrival stream must be an object");
  if (stream.schema !== SHADOW_ARRIVALS_SCHEMA) {
    throw new TypeError(`arrival stream schema must be ${SHADOW_ARRIVALS_SCHEMA}`);
  }
  if (!isoDay(stream.as_of)) throw new TypeError("arrival stream as_of must be an ISO date");
  if (!Array.isArray(stream.arrivals)) throw new TypeError("arrival stream must contain arrivals");
  const seen = new Set();
  for (const arrival of stream.arrivals) {
    const id = String(arrival?.arrival_id || "").trim();
    if (!id) throw new TypeError("every arrival needs an arrival_id");
    if (seen.has(id)) throw new TypeError(`duplicate arrival_id ${id}`);
    seen.add(id);
    if (!isoDay(arrival?.arrived_at)) throw new TypeError(`arrival ${id} needs an ISO arrived_at`);
  }
  return stream;
}

/** Order arrivals by the observer clock so replay is independent of file order. */
export function orderedArrivals(stream) {
  return [...stream.arrivals].sort((a, b) => a.arrived_at.localeCompare(b.arrived_at)
    || String(a.arrival_id).localeCompare(String(b.arrival_id)));
}

/**
 * Split the stream into the two phase inputs. The assertion phase is only ever
 * handed the source projection, so later solicitation rows are structurally
 * out of reach rather than merely unused.
 */
export function partitionArrivals(stream) {
  const sourceArrivals = [];
  const solicitationArrivals = [];
  const malformed = [];
  for (const arrival of orderedArrivals(stream)) {
    if (arrival.arrival_kind === "source_observation" && arrival.source && typeof arrival.source === "object") {
      sourceArrivals.push({
        arrival_id: arrival.arrival_id,
        arrived_at: arrival.arrived_at,
        replay_of: arrival.replay_of ? String(arrival.replay_of) : null,
        source: clone(arrival.source),
      });
    } else if (arrival.arrival_kind === "solicitation_observation" && arrival.solicitation && typeof arrival.solicitation === "object") {
      solicitationArrivals.push({
        arrival_id: arrival.arrival_id,
        arrived_at: arrival.arrived_at,
        solicitation: clone(arrival.solicitation),
      });
    } else {
      malformed.push({
        arrival_id: arrival.arrival_id,
        arrived_at: arrival.arrived_at,
        disposition: "malformed",
        reasons: ["unknown_arrival_kind_or_missing_payload"],
      });
    }
  }
  return { sourceArrivals, solicitationArrivals, malformed };
}

function freshnessRow(observedAt, arrivedAt) {
  const lag = observedAt && arrivedAt ? daysBetween(observedAt, arrivedAt) : null;
  return {
    published_at: observedAt,
    arrived_at: arrivedAt,
    arrival_lag_days: lag,
    stale_arrival: lag == null ? null : lag > STALE_ARRIVAL_DAYS,
    stale_threshold_days: STALE_ARRIVAL_DAYS,
  };
}

function claimRow(prediction, claim) {
  if (!prediction) {
    return {
      claim,
      status: "abstained",
      abstention_reason: "no_stated_timing_window_in_source",
      predicted_window: null,
      probability: null,
    };
  }
  return {
    claim,
    status: prediction.status,
    abstention_reason: null,
    predicted_window: clone(prediction.predicted_window),
    // The ontology's neutral placeholder. It is not a calibrated public score.
    probability: prediction.probability,
    probability_basis: "uncalibrated_neutral_placeholder",
  };
}

/** Later-observation identifiers and free text that can never be source-derived. */
export const LATER_IDENTITY_FIELDS = Object.freeze([
  "epin",
  "source_system_id",
  "title",
  "vendor",
  "vendor_name",
  "citation_url",
]);

function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/**
 * A hindsight field name carrying a real value is leakage. The same name held
 * open as an explicit null or empty array is the ontology declaring an unknown,
 * which is the contract PIR-2 requires rather than a violation of it.
 */
export function populatedHindsightFindings(value, path = "") {
  const findings = [];
  if (!value || typeof value !== "object") return findings;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (HINDSIGHT_FIELDS.includes(key) && !isEmptyValue(child)) {
      findings.push({ type: "populated_hindsight_field", path: childPath, field: key });
    }
    findings.push(...populatedHindsightFindings(child, childPath));
  }
  return findings;
}

/**
 * Scan an assertion-time projection for any value that could only have come
 * from a later observation. A finding here is a hard failure, not a caveat.
 *
 * Only identity and free-text registers are substring-scanned. Later clocks
 * are guarded structurally instead: sealing strips published_at and every
 * other hindsight field before extraction, and a populated hindsight field is
 * flagged by name wherever it appears. A date substring scan would report a
 * benign same-day coincidence between a later publication and the assertion's
 * own clocks or source-stated windows as leakage, which is unsound in a
 * document that legitimately contains dates.
 */
export function shadowLeakageFindings(projection, solicitations = []) {
  const findings = populatedHindsightFindings(projection);
  const serialized = JSON.stringify(projection);
  const retainedSpan = String(projection?.source_evidence?.source_span_text || "");
  for (const row of solicitations) {
    const solicitation = row?.solicitation || row || {};
    for (const field of LATER_IDENTITY_FIELDS) {
      const value = String(solicitation[field] ?? "").trim();
      if (!value || retainedSpan.includes(value)) continue;
      if (serialized.includes(value)) findings.push({ type: "future_value_in_assertion", field, value });
    }
  }
  return findings;
}

function assertionProjection({ arrival, sealed, extracted, process }) {
  const intent = process.stated_intent;
  return {
    intent_id: `pir-shadow-intent:${fingerprint({ sealed })}`.slice(0, 64),
    process_ref: process.process_ref,
    assertion_id: intent.assertion_id,
    arrival_id: arrival.arrival_id,
    asserted_at: intent.observed_at,
    arrived_at: arrival.arrived_at,
    source_evidence: {
      source_record_id: sealed.source_record_id,
      source_event_id: sealed.source_event_id,
      source_type: sealed.source_type,
      source_title: sealed.source_title,
      span_text_status: sealed.span_text_status || "unknown",
      source_span_text: sealed.source_span_text,
      speaker: clone(sealed.speaker) || null,
      citations: citationRows(sealed),
    },
    stated_intent: {
      responsible_agency_ref: intent.responsible_agency_ref,
      action_kind: intent.action_kind,
      object_text: intent.object_text,
      procurement_type: intent.procurement_type,
      program_refs: clone(intent.program_refs),
      quantity_assertions: clone(intent.quantity_assertions),
      money_assertions: clone(intent.money_assertions),
      geography_refs: clone(intent.geography_refs),
      population_terms: clone(intent.population_terms),
      expected_window: clone(intent.expected_window),
      modality: intent.modality,
      conditions: clone(intent.conditions),
      extraction_method: intent.extraction_method,
      extraction_version: intent.extraction_version,
      extraction_confidence: intent.extraction_confidence,
    },
    provisional_identity: clone(process.procurement_identity),
    claims: {
      occurrence: claimRow(process.predictions.occurrence, "occurrence"),
      timing: claimRow(process.predictions.timing, "timing"),
    },
    edges: clone(process.edges),
    unknowns: clone(process.unknowns),
    controls: {
      contains_rfp_baseline: containsRfpBaseline(sealed.source_span_text),
      extractor_status: extracted.status,
    },
  };
}

/**
 * Phase one. Only source observations are visible here; a solicitation payload
 * reaching this function is a contract violation, not a silent no-op.
 */
export function runAssertionPhase(sourceArrivals = []) {
  const intents = [];
  const arrivalLog = [];
  const byContentKey = new Map();
  for (const arrival of sourceArrivals) {
    if (arrival?.solicitation) throw new TypeError("assertion phase must not receive solicitation observations");
    const sealed = sealHistoricalSource(arrival.source);
    const contentKey = fingerprint(sealed);
    const gaps = sourceEvidenceGaps(sealed);
    const base = {
      arrival_id: arrival.arrival_id,
      arrived_at: arrival.arrived_at,
      published_at: isoDay(sealed.observed_at),
      content_key: contentKey,
      declared_replay_of: arrival.replay_of || null,
    };

    if (byContentKey.has(contentKey)) {
      const first = byContentKey.get(contentKey);
      const freshness = freshnessRow(base.published_at, arrival.arrived_at);
      arrivalLog.push({
        ...base,
        disposition: "duplicate_replay",
        reasons: ["identical_sealed_source_already_observed"],
        first_arrival_id: first.arrival.arrival_id,
        intent_id: first.intent_id,
        assertion_rewritten: false,
        freshness,
      });
      continue;
    }

    if (gaps.length) {
      arrivalLog.push({
        ...base,
        disposition: "insufficient_evidence",
        reasons: gaps,
        intent_id: null,
        freshness: freshnessRow(base.published_at, arrival.arrived_at),
      });
      continue;
    }

    const extracted = extractSource(sealed);
    if (!extracted.assertion) {
      arrivalLog.push({
        ...base,
        disposition: "abstained",
        reasons: clone(extracted.candidate.rejection_reasons),
        intent_id: null,
        contains_rfp_baseline: containsRfpBaseline(sealed.source_span_text),
        freshness: freshnessRow(base.published_at, arrival.arrived_at),
      });
      continue;
    }

    const process = buildProspectiveProcess({ source: sealed, assertion: extracted.assertion });
    const assertion = assertionProjection({ arrival, sealed, extracted, process });
    const intent = {
      intent_id: assertion.intent_id,
      process_ref: assertion.process_ref,
      content_key: contentKey,
      assertion,
      assertion_fingerprint: fingerprint(assertion),
      freshness: freshnessRow(assertion.asserted_at, arrival.arrived_at),
    };
    byContentKey.set(contentKey, { arrival, intent_id: intent.intent_id });
    intents.push(intent);
    arrivalLog.push({
      ...base,
      disposition: "opened_intent",
      reasons: [],
      intent_id: intent.intent_id,
      freshness: intent.freshness,
    });
  }
  return { intents, arrivalLog };
}

/**
 * Later arrivals for the same provisional subject supersede earlier ones. The
 * earlier assertion is retained verbatim; only its live status changes.
 */
export function applySupersession(intents = []) {
  const byProcess = new Map();
  for (const intent of intents) {
    const rows = byProcess.get(intent.process_ref) || [];
    rows.push(intent);
    byProcess.set(intent.process_ref, rows);
  }
  for (const rows of byProcess.values()) {
    const ordered = [...rows].sort((a, b) => a.assertion.asserted_at.localeCompare(b.assertion.asserted_at)
      || a.assertion.arrived_at.localeCompare(b.assertion.arrived_at)
      || a.assertion.arrival_id.localeCompare(b.assertion.arrival_id));
    ordered.forEach((intent, index) => {
      const next = ordered[index + 1] || null;
      const previous = ordered[index - 1] || null;
      intent.supersession = {
        superseded: Boolean(next),
        superseded_by: next ? next.intent_id : null,
        superseded_by_arrival_id: next ? next.assertion.arrival_id : null,
        supersedes: previous ? previous.intent_id : null,
        basis: next || previous ? "same_provisional_subject_ref_later_source_arrival" : null,
      };
    });
  }
  return intents;
}

function realizationRow(arrival) {
  const solicitation = arrival.solicitation;
  return {
    source_system: solicitation.source_system,
    source_system_id: solicitation.source_system_id || solicitation.epin || null,
    epin: solicitation.epin || null,
    published_at: solicitation.published_at,
    agency: solicitation.agency,
    title: solicitation.title,
    procurement_method: solicitation.procurement_method || null,
    citation_url: solicitation.citation_url || null,
  };
}

function candidateRow(candidate, arrivalByRef) {
  const arrival = arrivalByRef.get(candidate.realization_ref) || null;
  return {
    realization_ref: candidate.realization_ref,
    observed_in_arrival_id: arrival ? arrival.arrival_id : null,
    observed_at: arrival ? arrival.arrived_at : null,
    published_at: candidate.published_at,
    title: candidate.realization.title,
    source_system: candidate.realization.source_system,
    citation_url: candidate.realization.citation_url,
    decision: candidate.features.decision,
    match_confidence: candidate.features.match_confidence,
    score: candidate.features.score,
    evidence: clone(candidate.features.evidence),
  };
}

export const PROSPECTIVE_OCCURRENCE_STATES = Object.freeze([
  "realized",
  "review_required",
  "not_observed_yet",
  "not_observed_in_stated_window",
]);

export const PROSPECTIVE_TIMING_STATES = Object.freeze([
  "hit",
  "miss",
  "not_scored",
  "review_required",
  "not_observed_yet",
  "not_observed_in_stated_window",
]);

/**
 * Read the matcher outcome under the prospective information boundary. An open
 * intent has not failed to be realized; it has simply not been observed yet.
 * Occurrence and timing stay separate registers throughout.
 */
function prospectiveOutcome(match, state) {
  if (state === "resolved") {
    return {
      occurrence: "realized",
      timing: match.outcome.timing,
      lead_days: match.outcome.lead_days,
      cardinality: clone(match.outcome.cardinality),
    };
  }
  const pending = state === "ambiguous"
    ? "review_required"
    : state === "unmatched" ? "not_observed_in_stated_window" : "not_observed_yet";
  return {
    occurrence: pending,
    timing: pending,
    lead_days: null,
    cardinality: clone(match.outcome.cardinality),
  };
}

function resolutionState(match, intent, asOf) {
  if (match.realized_by.length) return "resolved";
  if (match.candidates.length) return "ambiguous";
  const latest = intent.assertion.stated_intent.expected_window?.latest || null;
  if (latest && asOf > addDays(latest, RESOLUTION_GRACE_DAYS)) return "unmatched";
  return "open";
}

/**
 * Phase two. This is the only place solicitation evidence is read. Visibility
 * is bounded by the as-of arrival clock alone; the matcher's own
 * publication-clock horizon keeps anything published before the intent was
 * asserted from resolving it, so a lagged source arrival can still resolve
 * against a solicitation that happened to arrive earlier.
 */
export function runResolutionPhase(intents = [], solicitationArrivals = [], { asOf } = {}) {
  const cutoff = isoDay(asOf);
  if (!cutoff) throw new TypeError("resolution phase needs an ISO as_of clock");
  return intents.map((intent) => {
    const before = intent.assertion_fingerprint;
    const visible = solicitationArrivals.filter((arrival) => arrival.arrived_at <= cutoff);
    const arrivalByRef = new Map();
    const realizations = visible.map((arrival) => {
      const row = realizationRow(arrival);
      // Mirror the matcher's realization_ref derivation so the observing
      // arrival can be named beside each candidate it produced.
      arrivalByRef.set(`procurement:${String(row.source_system).toLowerCase()}:${row.source_system_id}`, arrival);
      return row;
    });
    const match = matchHistoricalIntent({
      process_ref: intent.process_ref,
      stated_intent: {
        ...intent.assertion.stated_intent,
        assertion_id: intent.assertion.assertion_id,
        source_record_id: intent.assertion.source_evidence.source_record_id,
        source_event_id: intent.assertion.source_evidence.source_event_id,
        observed_at: intent.assertion.asserted_at,
      },
    }, realizations);
    const state = resolutionState(match, intent, cutoff);
    const acceptedRefs = new Set(match.realized_by.map((edge) => edge.to));
    const decidingArrival = match.candidates
      .filter((candidate) => acceptedRefs.has(candidate.realization_ref))
      .map((candidate) => arrivalByRef.get(candidate.realization_ref))
      .filter(Boolean)
      .sort((a, b) => a.arrived_at.localeCompare(b.arrived_at))[0] || null;
    const resolution = {
      resolution_state: state,
      observed_solicitation_arrivals: visible.length,
      arrival_clock_cutoff: cutoff,
      matcher_version: match.matcher_version,
      horizon: clone(match.horizon),
      candidates: match.candidates.map((candidate) => candidateRow(candidate, arrivalByRef)),
      review_candidates: match.review_candidates.map((candidate) => candidate.realization_ref),
      accepted_edges: match.realized_by.map((edge) => ({
        relation: edge.relation,
        from: edge.from,
        to: edge.to,
        status: edge.status,
        basis: edge.basis,
        match_confidence: edge.match_confidence,
        published_publicly: false,
      })),
      // The landed matcher contract, recorded verbatim for traceability.
      matcher_outcome: {
        status: match.outcome.status,
        occurrence: match.outcome.occurrence,
        timing: match.outcome.timing,
        lead_days: match.outcome.lead_days,
        match_confidence: match.outcome.match_confidence,
        cardinality: clone(match.outcome.cardinality),
      },
      // The prospective reading of that outcome. The matcher reports "unmatched"
      // whenever no candidate exists; under prospective observation that is two
      // different facts, and collapsing them would overstate a negative result.
      prospective_outcome: prospectiveOutcome(match, state),
      review_required: state === "ambiguous",
      resolution_recorded_at: decidingArrival ? decidingArrival.arrived_at : null,
      resolved_by_arrival_id: decidingArrival ? decidingArrival.arrival_id : null,
      assertion_rewritten: false,
    };
    // A later realization must never become a feature of the earlier candidate.
    const after = fingerprint(intent.assertion);
    if (after !== before) {
      throw new Error(`resolution rewrote the assertion for ${intent.intent_id}`);
    }
    return {
      ...intent,
      state: intent.supersession?.superseded ? "superseded" : state,
      resolution,
      assertion_immutable: true,
    };
  });
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = typeof key === "function" ? key(row) : row[key];
    counts[value] = (counts[value] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function zeroed(keys, counts) {
  return Object.fromEntries(keys.map((key) => [key, counts[key] || 0]));
}

/** Replay the retained stream and return the internal-only shadow artifact. */
export function runShadowMode(stream, { streamSha256 = null, streamArtifact = null } = {}) {
  assertArrivalStream(stream);
  const asOf = stream.as_of;
  const { sourceArrivals, solicitationArrivals, malformed } = partitionArrivals(stream);
  const { intents, arrivalLog } = runAssertionPhase(sourceArrivals);
  applySupersession(intents);

  const leakage = intents.flatMap((intent) => shadowLeakageFindings(intent.assertion, solicitationArrivals)
    .map((finding) => ({ intent_id: intent.intent_id, ...finding })));
  if (leakage.length) {
    throw new Error(`shadow mode assertion phase leaked later solicitation evidence: ${JSON.stringify(leakage)}`);
  }

  const resolved = runResolutionPhase(intents, solicitationArrivals, { asOf });
  const solicitationLog = solicitationArrivals.map((arrival) => ({
    arrival_id: arrival.arrival_id,
    arrived_at: arrival.arrived_at,
    published_at: arrival.solicitation.published_at,
    disposition: "resolution_observation",
    freshness: freshnessRow(isoDay(arrival.solicitation.published_at), arrival.arrived_at),
    observed_only_in_resolution_phase: true,
  }));

  const openIntents = resolved.filter((intent) => intent.state === "open");
  const staleArrivals = [...arrivalLog, ...solicitationLog]
    .filter((row) => row.freshness?.stale_arrival === true);
  const duplicates = arrivalLog.filter((row) => row.disposition === "duplicate_replay");
  const abstentions = arrivalLog.filter((row) => row.disposition === "abstained");
  const insufficient = arrivalLog.filter((row) => row.disposition === "insufficient_evidence");
  const superseded = resolved.filter((intent) => intent.supersession.superseded);
  const oneToMany = resolved.filter((intent) => intent.resolution.matcher_outcome.cardinality.relation === "one_to_many");
  const timingClaims = resolved.filter((intent) => intent.assertion.claims.timing.status !== "abstained");

  return {
    schema: SHADOW_MODE_SCHEMA,
    shadow_mode_version: SHADOW_MODE_VERSION,
    visibility: SHADOW_VISIBILITY,
    as_of: asOf,
    observation_window: clone(stream.observation_window) || null,
    input_coverage: {
      stream_artifact: streamArtifact,
      stream_schema: stream.schema,
      stream_version: stream.stream_version || null,
      stream_sha256: streamSha256,
      recurrent_corpus_claim: false,
      arrivals: stream.arrivals.length,
      source_observations: sourceArrivals.length,
      solicitation_observations: solicitationArrivals.length,
      malformed_arrivals: malformed.length,
      role: stream.provenance?.role || null,
      limitation: "The arrival stream is a bounded, retained fixture stream. It is not a recurrent estimate of arriving Council material and cannot authorize promotion.",
    },
    protocol: {
      kind: "two_phase_prospective_observation",
      assertion_phase: {
        inputs: ["arriving source span", "source metadata", "source citations", "publication clock", "arrival clock"],
        sealed_fields: [...HINDSIGHT_FIELDS],
        solicitation_evidence_visible: false,
      },
      resolution_phase: {
        inputs: ["solicitation observations that arrived by the as-of clock, matched only inside the publication-clock horizon that starts at each intent's assertion"],
        rewrites_earlier_assertion: false,
        matcher: "warehouse/lib/procurement_intent_realization_matcher.mjs",
      },
      excluded_from_assertion_inputs: [
        "future EPIN/PIN",
        "solicitation title",
        "vendor",
        "later coverage",
        "future naming features",
        "future publication clock",
      ],
      evaluator_versions: {
        extractor: EXTRACTION_VERSION,
        prospective_ontology: PROSPECTIVE_PREDICTION_VERSION,
        realization_matcher: REALIZATION_MATCHER_VERSION,
        shadow_mode: SHADOW_MODE_VERSION,
      },
      runtime_dependencies: {
        network_access: false,
        citymeetings_runtime_dependency: false,
        reproducible_from_retained_inputs: true,
        note: "Citation URLs are retained strings. Shadow mode never fetches them and reads no live service.",
      },
    },
    intents: resolved.map((intent) => ({
      intent_id: intent.intent_id,
      process_ref: intent.process_ref,
      state: intent.state,
      resolution_state: intent.resolution.resolution_state,
      content_key: intent.content_key,
      assertion_fingerprint: intent.assertion_fingerprint,
      assertion_immutable: intent.assertion_immutable,
      freshness: intent.freshness,
      supersession: intent.supersession,
      assertion: intent.assertion,
      resolution: intent.resolution,
      published_publicly: false,
    })),
    arrivals: [...arrivalLog, ...solicitationLog]
      .sort((a, b) => a.arrived_at.localeCompare(b.arrived_at) || a.arrival_id.localeCompare(b.arrival_id)),
    malformed_arrivals: malformed,
    metrics: {
      intent_states: {
        value_type: "measured",
        denominator: resolved.length,
        ...zeroed(INTENT_STATES, countBy(resolved, "state")),
      },
      resolution_states: {
        value_type: "measured",
        denominator: resolved.length,
        ...zeroed(["open", "resolved", "ambiguous", "unmatched"], countBy(resolved, (row) => row.resolution.resolution_state)),
      },
      arrival_dispositions: {
        value_type: "measured",
        denominator: stream.arrivals.length,
        ...zeroed(ARRIVAL_DISPOSITIONS, countBy([...arrivalLog, ...solicitationLog, ...malformed], "disposition")),
      },
      occurrence: {
        value_type: "measured",
        cutoff: "per-intent publication clock",
        denominator: resolved.length,
        ...zeroed(PROSPECTIVE_OCCURRENCE_STATES, countBy(resolved, (row) => row.resolution.prospective_outcome.occurrence)),
      },
      timing: {
        value_type: "measured",
        cutoff: "agency-stated expected window",
        denominator: resolved.length,
        claims_made: timingClaims.length,
        claims_abstained: resolved.length - timingClaims.length,
        ...zeroed(PROSPECTIVE_TIMING_STATES, countBy(resolved, (row) => row.resolution.prospective_outcome.timing)),
      },
      abstention: {
        value_type: "measured",
        denominator: sourceArrivals.length,
        extraction_abstentions: abstentions.length,
        insufficient_source_evidence: insufficient.length,
        timing_claim_abstentions: resolved.length - timingClaims.length,
        review_required: resolved.filter((intent) => intent.resolution.review_required).length,
      },
      freshness: {
        value_type: "measured",
        denominator: [...arrivalLog, ...solicitationLog].length,
        stale_threshold_days: STALE_ARRIVAL_DAYS,
        stale_arrivals: staleArrivals.length,
        stale_arrival_ids: staleArrivals.map((row) => row.arrival_id).sort(),
        maximum_arrival_lag_days: [...arrivalLog, ...solicitationLog]
          .map((row) => row.freshness?.arrival_lag_days)
          .filter((value) => Number.isFinite(value))
          .reduce((max, value) => Math.max(max, value), 0),
      },
      idempotency: {
        value_type: "measured",
        denominator: sourceArrivals.length,
        duplicate_replays: duplicates.length,
        duplicate_arrival_ids: duplicates.map((row) => row.arrival_id).sort(),
        assertions_rewritten_by_replay: 0,
      },
      supersession: {
        value_type: "measured",
        denominator: resolved.length,
        superseded_intents: superseded.length,
        superseded_intent_ids: superseded.map((intent) => intent.intent_id).sort(),
        superseded_assertions_retained: superseded.length,
      },
      realization_cardinality: {
        value_type: "measured",
        denominator: resolved.length,
        ...zeroed(["none", "one_to_one", "one_to_many"], countBy(resolved, (row) => row.resolution.matcher_outcome.cardinality.relation)),
        one_to_many_intent_ids: oneToMany.map((intent) => intent.intent_id).sort(),
      },
    },
    temporal_integrity: {
      value_type: "measured",
      leakage_failures: [],
      tolerated_failures: 0,
      assertion_phase_saw_solicitations: false,
      assertions_rewritten_after_resolution: 0,
      passed: true,
    },
    publication_boundary: {
      visibility: SHADOW_VISIBILITY,
      public_routes: [],
      public_search_documents: 0,
      public_follow_targets: 0,
      notifications_emitted: 0,
      resident_facing_claims: 0,
      public_realized_edges: 0,
      internal_realized_edges: resolved.reduce((sum, intent) => sum + intent.resolution.accepted_edges.length, 0),
      open_internal_intents: openIntents.length,
      authorization: "none; PIR-6 public surfaces remain paused and this card does not authorize them",
    },
    promotion: {
      status: "withheld",
      product_promotion_allowed: false,
      gates: {
        public_exposure: {
          observed_public_surfaces: 0,
          threshold: 0,
          passed: true,
        },
        temporal_integrity: {
          observed_failures: 0,
          threshold: 0,
          passed: true,
        },
        recurrent_arrival_corpus: {
          observed_source_observations: sourceArrivals.length,
          threshold: "a recurrent retained arrival corpus",
          passed: false,
        },
      },
      reason: "Shadow mode is a bounded prospective observation on a retained fixture stream. It measures prospective behavior; it does not establish recurrence and does not authorize any public surface.",
    },
  };
}
