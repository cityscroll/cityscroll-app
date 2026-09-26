/**
 * Admission-gated lifecycle panels for meeting and procurement detail.
 *
 * Meeting detail can show “What officials said may happen next.” Procurement
 * detail can show “First public signal,” “Advance signal: N days,” and a
 * realized or overdue status. Both keep source fact, CityScroll interpretation,
 * and later observation as separate registers.
 *
 * Nothing renders unless the signal admission predicates pass. Held signals
 * return null so the ordinary meeting or procurement page stays usable. Overdue
 * claims require a complete observation search; incomplete coverage never
 * invents absence.
 *
 * These panels reuse the existing prospective-process, realization-matcher,
 * civic-time event kind, prediction contract, and watch-continuity evidence
 * seams. They do not create a standalone dashboard.
 */

import { realizationRefFor } from "../warehouse/lib/procurement_intent_realization_matcher.mjs";
import { SHADOW_MODE_SCHEMA } from "../warehouse/lib/procurement_intent_shadow.mjs";
import {
  PROCUREMENT_INTENT_EVIDENCE_STATES,
  parseProvisionalSubjectRef,
} from "./procurement_intent_watch_continuity.mjs";
import { predictionBand } from "../worker/src/lib/prediction_contract.mjs";

export { PROCUREMENT_INTENT_EVIDENCE_STATES };

export const PROCUREMENT_INTENT_PUBLIC_SURFACE_SCHEMA =
  "cityscroll.procurement_intent_public_surface.v1";
export const PROCUREMENT_INTENT_PUBLIC_AUTHORIZATION_SCHEMA =
  "cityscroll.procurement_intent_public_authorization.v1";
/** Same schema the shadow-mode aggregate already publishes; imported to avoid a second literal. */
export const PROCUREMENT_INTENT_PRODUCTION_OBSERVATION_SCHEMA = SHADOW_MODE_SCHEMA;

/** Resident path a production observation receipt must occupy when present. */
export const PROCUREMENT_INTENT_PRODUCTION_AGGREGATE_PATH =
  "docs/evidence/procurement-intent-radar/shadow-mode-production-aggregate.json";

export const PROCUREMENT_INTENT_PUBLIC_SURFACE_KIND = Object.freeze({
  MEETING: "meeting_intent_lifecycle",
  PROCUREMENT: "procurement_intent_lifecycle",
});

export const PROCUREMENT_INTENT_LIFECYCLE_STATUS = Object.freeze({
  AWAITING_PUBLICATION: "awaiting_publication",
  REALIZED: "realized",
  OVERDUE: "overdue",
  OBSERVATION_INCOMPLETE: "observation_incomplete",
});

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const PIPELINE_STATUS_COPY = /\b(shadow|internal_only|promotion|pipeline|held|withheld|fixture stream)\b/iu;

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])),
  );
}

function text(value, max = 320) {
  const result = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
  return result || null;
}

function day(value) {
  const raw = text(value, 40);
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/u);
  return match && ISO_DAY.test(match[1]) ? match[1] : null;
}

function dayDifference(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function formatLongDay(value) {
  const d = day(value);
  if (!d) return null;
  const [year, month, dayNum] = d.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, dayNum)));
}

/**
 * Normalize the publication-authorization receipt that gates every panel.
 * Fixture-only shadow aggregates never satisfy this shape on their own: the
 * caller must attest retained production observations separately.
 */
export function normalizePublicSurfaceAuthorization(authorization = null) {
  if (!authorization || typeof authorization !== "object") return null;
  const productPromotionAllowed = authorization.product_promotion_allowed === true;
  const retainedProductionPresent =
    authorization.retained_production_observations_present === true
    || authorization.retained_data_present === true;
  const resolvedCount = Number(authorization.resolved_production_observation_count);
  return freeze({
    schema: PROCUREMENT_INTENT_PUBLIC_AUTHORIZATION_SCHEMA,
    product_promotion_allowed: productPromotionAllowed,
    retained_production_observations_present: retainedProductionPresent,
    resolved_production_observation_count: Number.isFinite(resolvedCount) ? resolvedCount : 0,
    publication_authorized_at: day(authorization.publication_authorized_at),
    source_path: text(authorization.source_path, 600),
    reason: text(authorization.reason, 600),
  });
}

/** True only when promotion is allowed and retained production observations exist. */
export function publicSurfaceAuthorizationAdmitted(authorization) {
  const normalized = normalizePublicSurfaceAuthorization(authorization);
  if (!normalized) return false;
  return (
    normalized.product_promotion_allowed
    && normalized.retained_production_observations_present
    && normalized.resolved_production_observation_count >= 1
  );
}

function acceptedRealizations(match, observations = []) {
  const lookup = new Map();
  for (const row of Array.isArray(observations) ? observations : []) {
    const ref = realizationRefFor(row);
    if (ref && !lookup.has(ref)) lookup.set(ref, row);
  }
  return (Array.isArray(match?.realized_by) ? match.realized_by : [])
    .filter((edge) => edge && edge.status === "accepted" && text(edge.to, 320))
    .map((edge) => {
      const observation = lookup.get(edge.to) || null;
      const publishedAt = day(observation?.published_at);
      return {
        realization_ref: edge.to,
        epin: text(observation?.epin, 40),
        pin: text(observation?.pin, 40),
        published_at: publishedAt,
        title: text(observation?.title, 500),
        source_system: text(observation?.source_system, 120),
        citation_url: text(observation?.citation_url || observation?.source_url, 600),
        match_confidence: text(edge.match_confidence, 60),
        basis: text(edge.basis, 120),
      };
    })
    .sort((left, right) => left.realization_ref.localeCompare(right.realization_ref));
}

function observationCoverage(coverage = null) {
  if (!coverage || typeof coverage !== "object") {
    return {
      searched: false,
      window_closed: false,
      complete: false,
      sources_checked: [],
      reason: "observation_coverage_absent",
    };
  }
  const sources = Array.isArray(coverage.sources_checked)
    ? coverage.sources_checked.map((row) => text(row, 120)).filter(Boolean).sort()
    : [];
  return {
    searched: coverage.searched === true,
    window_closed: coverage.window_closed === true,
    complete: coverage.complete === true,
    sources_checked: sources,
    reason: text(coverage.reason, 200),
  };
}

function sourceFactFromProcess(process = {}) {
  const sourceRecord = process.source_record || {};
  const intent = process.stated_intent || {};
  const citation = Array.isArray(sourceRecord.citations) ? sourceRecord.citations[0] : null;
  return freeze({
    evidence_state: "source_fact",
    source_record_ref: text(sourceRecord.source_record_ref || intent.source_record_id, 320),
    source_event_id: text(sourceRecord.source_event_id || intent.source_event_id, 320),
    observed_at: day(sourceRecord.observed_at || intent.observed_at),
    speaker: text(sourceRecord.speaker?.display_name, 200),
    speaker_role: text(sourceRecord.speaker?.role, 200),
    source_title: text(sourceRecord.source_title, 500),
    span_text: text(sourceRecord.source_span_text || intent.source_span, 1_000),
    citation_url: text(citation?.url, 600),
  });
}

function interpretationFromProcess(process = {}, realizations = []) {
  const intent = process.stated_intent || {};
  const subject = parseProvisionalSubjectRef(process.process_ref);
  return freeze({
    evidence_state: "cityscroll_interpretation",
    provisional_subject_ref: subject?.ref || null,
    object_text: text(intent.object_text, 500),
    procurement_type: text(intent.procurement_type, 80),
    responsible_agency_ref: text(intent.responsible_agency_ref, 200),
    stated_window: intent.expected_window
      ? {
        earliest: day(intent.expected_window.earliest),
        latest: day(intent.expected_window.latest),
        raw_text: text(intent.expected_window.raw_text, 240),
      }
      : null,
    identity_state: realizations.length ? "realized" : "prospective",
    cardinality: {
      intent_count: 1,
      realized_count: realizations.length,
      relation: realizations.length === 0
        ? "none"
        : realizations.length === 1
          ? "one_to_one"
          : "one_to_many",
    },
  });
}

function laterObservationRegister(realizations = []) {
  if (!realizations.length) {
    return freeze({
      evidence_state: "later_observation",
      status: "not_yet_observed",
      realizations: [],
    });
  }
  return freeze({
    evidence_state: "later_observation",
    status: "observed",
    realizations: realizations.map((row) => ({
      realization_ref: row.realization_ref,
      epin: row.epin,
      pin: row.pin,
      published_at: row.published_at,
      title: row.title,
      source_system: row.source_system,
      citation_url: row.citation_url,
    })),
  });
}

function earliestPublishedAt(realizations) {
  const days = realizations.map((row) => row.published_at).filter(Boolean).sort();
  return days[0] || null;
}

function advanceLeadDays(assertedAt, realizations) {
  const published = earliestPublishedAt(realizations);
  if (!assertedAt || !published) return null;
  return dayDifference(assertedAt, published);
}

/**
 * Decide whether a single signal may appear on a public detail page.
 *
 * Hold reasons are machine tokens for tests and receipts. Default resident copy
 * never surfaces them.
 */
export function evaluateIntentSignalAdmission({
  authorization = null,
  process = null,
  match = null,
  observations = [],
  observation_coverage: coverageInput = null,
  now = null,
} = {}) {
  const holdReasons = [];
  const auth = normalizePublicSurfaceAuthorization(authorization);
  if (!publicSurfaceAuthorizationAdmitted(auth)) {
    holdReasons.push("publication_authorization_held");
  }

  const subject = parseProvisionalSubjectRef(process?.process_ref);
  if (!subject) holdReasons.push("missing_provisional_subject");

  const fact = process ? sourceFactFromProcess(process) : null;
  if (!fact?.span_text || !fact?.observed_at || !fact?.source_event_id) {
    holdReasons.push("missing_source_evidence");
  }

  const realizations = acceptedRealizations(match, observations);
  const coverage = observationCoverage(coverageInput);
  const statedLatest = day(process?.stated_intent?.expected_window?.latest);
  const today = day(now);

  let lifecycleStatus = PROCUREMENT_INTENT_LIFECYCLE_STATUS.AWAITING_PUBLICATION;
  if (realizations.length) {
    lifecycleStatus = PROCUREMENT_INTENT_LIFECYCLE_STATUS.REALIZED;
  } else if (!coverage.complete || !coverage.searched) {
    lifecycleStatus = PROCUREMENT_INTENT_LIFECYCLE_STATUS.OBSERVATION_INCOMPLETE;
    if (statedLatest && today && statedLatest < today) {
      // Window passed on the calendar, but the observation search is incomplete,
      // so overdue remains suppressed.
      holdReasons.push("overdue_suppressed_incomplete_observations");
    }
  } else if (coverage.window_closed && statedLatest && today && statedLatest < today) {
    lifecycleStatus = PROCUREMENT_INTENT_LIFECYCLE_STATUS.OVERDUE;
  } else if (process?.predictions?.timing) {
    try {
      const band = predictionBand(process.predictions.timing, {
        now: today ? `${today}T00:00:00.000Z` : undefined,
      });
      if (band === "overdue" && coverage.complete && coverage.searched && coverage.window_closed) {
        lifecycleStatus = PROCUREMENT_INTENT_LIFECYCLE_STATUS.OVERDUE;
      }
    } catch {
      // Prediction seams stay optional; a malformed open claim never admits overdue.
    }
  }

  // Overdue is itself an admission predicate: incomplete observation coverage
  // can never produce an overdue public claim.
  if (
    lifecycleStatus === PROCUREMENT_INTENT_LIFECYCLE_STATUS.OVERDUE
    && (!coverage.complete || !coverage.searched || !coverage.window_closed)
  ) {
    lifecycleStatus = PROCUREMENT_INTENT_LIFECYCLE_STATUS.OBSERVATION_INCOMPLETE;
    holdReasons.push("overdue_suppressed_incomplete_observations");
  }

  const uniqueHolds = [...new Set(holdReasons)].sort();
  // overdue_suppressed is informational when the rest of the signal is admitted
  // and the lifecycle stays non-overdue.
  const blockingHolds = uniqueHolds.filter((reason) => reason !== "overdue_suppressed_incomplete_observations");
  const signalAdmitted = blockingHolds.length === 0 && Boolean(subject) && Boolean(fact?.span_text);

  return freeze({
    admitted: signalAdmitted,
    hold_reasons: uniqueHolds,
    lifecycle_status: signalAdmitted
      ? lifecycleStatus
      : null,
    authorization: auth,
    observation_coverage: coverage,
    realization_count: realizations.length,
  });
}

function evidenceBundle(process, realizations) {
  return freeze({
    source_fact: sourceFactFromProcess(process),
    cityscroll_interpretation: interpretationFromProcess(process, realizations),
    later_observation: laterObservationRegister(realizations),
    evidence_states: [...PROCUREMENT_INTENT_EVIDENCE_STATES],
  });
}

function receiptCopy(fact) {
  const when = formatLongDay(fact.observed_at) || fact.observed_at;
  const who = fact.speaker
    ? `${fact.speaker}${fact.speaker_role ? `, ${fact.speaker_role}` : ""}`
    : null;
  return [when, who, "source"].filter(Boolean).join(" · ");
}

function interpretationCopy(reading) {
  const objectText = reading.object_text || "a prospective procurement";
  return `We think this refers to: ${objectText}.`;
}

function sourceFactCopy(fact) {
  const who = fact.speaker || "An official";
  return `${who} said: “${fact.span_text}”`;
}

function laterObservationCopy(observation, lifecycleStatus) {
  if (observation.status === "observed" && observation.realizations?.length) {
    return observation.realizations.map((row) => {
      const identity = row.epin || row.pin || row.realization_ref;
      const published = formatLongDay(row.published_at) || row.published_at;
      return `${row.source_system || "Publisher"} published: ${identity}${published ? ` on ${published}` : ""}.`;
    }).join(" ");
  }
  if (lifecycleStatus === PROCUREMENT_INTENT_LIFECYCLE_STATUS.OVERDUE) {
    return "No matching solicitation has been observed after a complete search through the stated window.";
  }
  if (lifecycleStatus === PROCUREMENT_INTENT_LIFECYCLE_STATUS.OBSERVATION_INCOMPLETE) {
    return "Later publication has not been fully searched yet.";
  }
  return "No published solicitation observed yet.";
}

function statusLabel(lifecycleStatus, advanceDays) {
  if (lifecycleStatus === PROCUREMENT_INTENT_LIFECYCLE_STATUS.REALIZED) {
    return Number.isInteger(advanceDays) && advanceDays >= 0
      ? `Solicitation published · Advance signal: ${advanceDays} days`
      : "Solicitation published";
  }
  if (lifecycleStatus === PROCUREMENT_INTENT_LIFECYCLE_STATUS.OVERDUE) {
    return "Overdue relative to the stated window";
  }
  if (lifecycleStatus === PROCUREMENT_INTENT_LIFECYCLE_STATUS.OBSERVATION_INCOMPLETE) {
    return "Awaiting publication";
  }
  return "Awaiting publication";
}

/**
 * Project the meeting-detail lifecycle panel, or null when the signal is held.
 */
export function projectMeetingIntentSurface({
  process = null,
  match = null,
  observations = [],
  authorization = null,
  observation_coverage = null,
  now = null,
} = {}) {
  const admission = evaluateIntentSignalAdmission({
    authorization,
    process,
    match,
    observations,
    observation_coverage,
    now,
  });
  if (!admission.admitted) {
    return freeze({
      schema: PROCUREMENT_INTENT_PUBLIC_SURFACE_SCHEMA,
      kind: PROCUREMENT_INTENT_PUBLIC_SURFACE_KIND.MEETING,
      admission,
      view: null,
    });
  }

  const realizations = acceptedRealizations(match, observations);
  const evidence = evidenceBundle(process, realizations);
  const advanceDays = advanceLeadDays(evidence.source_fact.observed_at, realizations);
  const view = freeze({
    schema: PROCUREMENT_INTENT_PUBLIC_SURFACE_SCHEMA,
    kind: PROCUREMENT_INTENT_PUBLIC_SURFACE_KIND.MEETING,
    heading: "What officials said may happen next",
    process_ref: process.process_ref,
    lifecycle_status: admission.lifecycle_status,
    status_label: statusLabel(admission.lifecycle_status, advanceDays),
    source_fact_copy: sourceFactCopy(evidence.source_fact),
    interpretation_copy: interpretationCopy(evidence.cityscroll_interpretation),
    later_observation_copy: laterObservationCopy(evidence.later_observation, admission.lifecycle_status),
    receipt_copy: receiptCopy(evidence.source_fact),
    advance_signal_days: advanceDays,
    stated_window_raw: evidence.cityscroll_interpretation.stated_window?.raw_text || null,
    evidence,
    realizations,
  });
  return freeze({
    schema: PROCUREMENT_INTENT_PUBLIC_SURFACE_SCHEMA,
    kind: PROCUREMENT_INTENT_PUBLIC_SURFACE_KIND.MEETING,
    admission,
    view,
  });
}

/**
 * Project the procurement-detail lifecycle panel, or null when held.
 */
export function projectProcurementIntentSurface({
  process = null,
  match = null,
  observations = [],
  authorization = null,
  observation_coverage = null,
  now = null,
} = {}) {
  const admission = evaluateIntentSignalAdmission({
    authorization,
    process,
    match,
    observations,
    observation_coverage,
    now,
  });
  if (!admission.admitted) {
    return freeze({
      schema: PROCUREMENT_INTENT_PUBLIC_SURFACE_SCHEMA,
      kind: PROCUREMENT_INTENT_PUBLIC_SURFACE_KIND.PROCUREMENT,
      admission,
      view: null,
    });
  }

  const realizations = acceptedRealizations(match, observations);
  const evidence = evidenceBundle(process, realizations);
  const advanceDays = advanceLeadDays(evidence.source_fact.observed_at, realizations);
  const firstSignalWhen = formatLongDay(evidence.source_fact.observed_at) || evidence.source_fact.observed_at;
  const view = freeze({
    schema: PROCUREMENT_INTENT_PUBLIC_SURFACE_SCHEMA,
    kind: PROCUREMENT_INTENT_PUBLIC_SURFACE_KIND.PROCUREMENT,
    heading: "First public signal",
    process_ref: process.process_ref,
    lifecycle_status: admission.lifecycle_status,
    first_public_signal_label: firstSignalWhen
      ? `First public signal · ${firstSignalWhen}`
      : "First public signal",
    advance_signal_label: Number.isInteger(advanceDays) && advanceDays >= 0
      ? `Advance signal: ${advanceDays} days`
      : null,
    advance_signal_days: advanceDays,
    status_label: statusLabel(admission.lifecycle_status, advanceDays),
    source_fact_copy: sourceFactCopy(evidence.source_fact),
    interpretation_copy: interpretationCopy(evidence.cityscroll_interpretation),
    later_observation_copy: laterObservationCopy(evidence.later_observation, admission.lifecycle_status),
    receipt_copy: receiptCopy(evidence.source_fact),
    evidence,
    realizations,
  });
  return freeze({
    schema: PROCUREMENT_INTENT_PUBLIC_SURFACE_SCHEMA,
    kind: PROCUREMENT_INTENT_PUBLIC_SURFACE_KIND.PROCUREMENT,
    admission,
    view,
  });
}

function evidenceDl(view) {
  return `<dl class="procurement-intent-evidence">
  <div data-evidence-state="source_fact"><dt>Source fact</dt><dd>${esc(view.source_fact_copy)}</dd></div>
  <div data-evidence-state="cityscroll_interpretation"><dt>CityScroll interpretation</dt><dd>${esc(view.interpretation_copy)}</dd></div>
  <div data-evidence-state="later_observation"><dt>Later observation</dt><dd>${esc(view.later_observation_copy)}</dd></div>
</dl>`;
}

/**
 * Render the meeting panel. Empty string when the projection was held or
 * absent, so callers can splice unconditionally.
 */
export function renderMeetingIntentSurfaceHtml(projection, {
  headingId = "meeting-intent-lifecycle-heading",
} = {}) {
  const view = projection?.view;
  if (!view) return "";
  const windowLine = view.stated_window_raw
    ? `<p class="procurement-intent-window">Stated window: ${esc(view.stated_window_raw)}.</p>`
    : "";
  return `<section class="node-section civic-object-section meeting-section procurement-intent-lifecycle" data-procurement-intent-surface="meeting" data-lifecycle-status="${esc(view.lifecycle_status)}" aria-labelledby="${esc(headingId)}">
  <h2 id="${esc(headingId)}">${esc(view.heading)}</h2>
  <p class="procurement-intent-status" data-lifecycle-status="${esc(view.lifecycle_status)}">${esc(view.status_label)}</p>
  ${windowLine}
  ${evidenceDl(view)}
  <details class="procurement-intent-source-details"><summary>Source details</summary>
    <p>${esc(view.receipt_copy)}</p>
    <p data-evidence-state="source_fact">${esc(view.evidence.source_fact.span_text || "")}</p>
    <p data-evidence-state="cityscroll_interpretation">Grouped as ${esc(view.evidence.cityscroll_interpretation.provisional_subject_ref || "")}.</p>
  </details>
</section>`;
}

/**
 * Render the procurement panel. Empty string when held or absent.
 */
export function renderProcurementIntentSurfaceHtml(projection, {
  headingId = "procurement-intent-lifecycle-heading",
} = {}) {
  const view = projection?.view;
  if (!view) return "";
  const advance = view.advance_signal_label
    ? `<p class="procurement-intent-advance" data-advance-signal-days="${esc(String(view.advance_signal_days))}">${esc(view.advance_signal_label)}</p>`
    : "";
  const realizedList = view.realizations.length
    ? `<ul class="procurement-intent-realizations">${view.realizations.map((row) => {
      const identity = row.epin || row.pin || row.realization_ref;
      return `<li data-realization-ref="${esc(row.realization_ref)}">${esc(row.title || identity)}${identity ? ` · ${esc(identity)}` : ""}${row.published_at ? ` · <time datetime="${esc(row.published_at)}">${esc(formatLongDay(row.published_at) || row.published_at)}</time>` : ""}</li>`;
    }).join("")}</ul>`
    : "";
  return `<section class="node-section civic-object-section procurement-intent-lifecycle" data-procurement-intent-surface="procurement" data-lifecycle-status="${esc(view.lifecycle_status)}" aria-labelledby="${esc(headingId)}">
  <h2 id="${esc(headingId)}">${esc(view.heading)}</h2>
  <p class="procurement-intent-first-signal">${esc(view.first_public_signal_label)}</p>
  ${advance}
  <p class="procurement-intent-status" data-lifecycle-status="${esc(view.lifecycle_status)}">${esc(view.status_label)}</p>
  ${realizedList}
  ${evidenceDl(view)}
  <details class="procurement-intent-source-details"><summary>Source details</summary>
    <p>${esc(view.receipt_copy)}</p>
    <p data-evidence-state="source_fact">${esc(view.evidence.source_fact.span_text || "")}</p>
    <p data-evidence-state="cityscroll_interpretation">Grouped as ${esc(view.evidence.cityscroll_interpretation.provisional_subject_ref || "")}.</p>
  </details>
</section>`;
}

/** Guard used by tests: default panel copy must not leak pipeline status words. */
export function defaultCopyContainsPipelineStatus(html) {
  if (!html) return false;
  // Source-details disclosure may name provenance paths; default visible copy must not.
  const withoutDetails = String(html).replace(/<details[\s\S]*?<\/details>/giu, " ");
  return PIPELINE_STATUS_COPY.test(withoutDetails);
}

/**
 * Derive a public-authorization receipt from a shadow-mode aggregate.
 * Fixture streams and withheld promotion never admit.
 */
export function authorizationFromShadowAggregate(aggregate = null, {
  source_path: sourcePath = null,
  min_resolved: minResolved = 20,
} = {}) {
  if (!aggregate || typeof aggregate !== "object") {
    return normalizePublicSurfaceAuthorization({
      product_promotion_allowed: false,
      retained_production_observations_present: false,
      resolved_production_observation_count: 0,
      source_path: sourcePath,
      reason: "shadow_aggregate_absent",
    });
  }

  const promotionAllowed = aggregate.promotion?.product_promotion_allowed === true
    && aggregate.promotion?.status === "authorized";
  const role = text(aggregate.input_coverage?.role || aggregate.provenance?.role, 80);
  const recurrent = aggregate.input_coverage?.recurrent_corpus_claim === true
    || aggregate.promotion?.gates?.recurrent_arrival_corpus?.passed === true;
  const retainedProduction = role === "production_arrival_stream" && recurrent === true;
  const resolved = Array.isArray(aggregate.intents)
    ? aggregate.intents.filter((row) => row?.resolution_state === "resolved" || row?.state === "resolved").length
    : Number(aggregate.metrics?.intent_states?.resolved) || 0;

  return normalizePublicSurfaceAuthorization({
    product_promotion_allowed: promotionAllowed && retainedProduction && resolved >= minResolved,
    retained_production_observations_present: retainedProduction,
    resolved_production_observation_count: resolved,
    publication_authorized_at: day(aggregate.as_of),
    source_path: sourcePath || PROCUREMENT_INTENT_PRODUCTION_AGGREGATE_PATH,
    reason: promotionAllowed && retainedProduction && resolved >= minResolved
      ? "production_observations_authorized"
      : text(aggregate.promotion?.reason, 600) || "publication_authorization_held",
  });
}

/**
 * Read a production observation aggregate for the event gate.
 * Refuses fixture-only or absent served data; never invents promotion.
 */
export function readProductionShadowObservation(aggregate, {
  source_path: sourcePath = PROCUREMENT_INTENT_PRODUCTION_AGGREGATE_PATH,
  merge_commit: mergeCommit = null,
  min_resolved: minResolved = 20,
} = {}) {
  if (aggregate == null) {
    throw new Error(`production observation absent at ${sourcePath}`);
  }
  if (typeof aggregate !== "object") {
    throw new Error(`production observation at ${sourcePath} is not an object`);
  }
  if (aggregate.schema !== PROCUREMENT_INTENT_PRODUCTION_OBSERVATION_SCHEMA) {
    throw new Error(`production observation schema mismatch at ${sourcePath}`);
  }
  const role = text(aggregate.input_coverage?.role || aggregate.provenance?.role, 80);
  if (role === "test-fixtures" || aggregate.visibility === "internal_only" && aggregate.input_coverage?.recurrent_corpus_claim !== true) {
    throw new Error(`refusing fixture-only shadow aggregate at ${sourcePath}`);
  }
  if (!mergeCommit || !/^[0-9a-f]{40}$/iu.test(String(mergeCommit))) {
    throw new Error("production observation receipt requires a pinned merge commit sha");
  }

  const authorization = authorizationFromShadowAggregate(aggregate, {
    source_path: sourcePath,
    min_resolved: minResolved,
  });

  return freeze({
    schema: "cityscroll.procurement_intent_public_production_observation.v1",
    source_path: sourcePath,
    merge_commit: String(mergeCommit).toLowerCase(),
    as_of: day(aggregate.as_of),
    retained_data_present: authorization.retained_production_observations_present,
    resolved_production_observation_count: authorization.resolved_production_observation_count,
    product_promotion_allowed: authorization.product_promotion_allowed,
    authorization,
    observed_at: day(aggregate.as_of),
  });
}

/**
 * Match one signal to a meeting by source_event_id / meeting_id.
 * Returns null when no signal applies; never invents a join.
 */
export function selectMeetingIntentSignal(signals = [], meetingRecord = {}) {
  const eventId = text(meetingRecord.source_event_id || meetingRecord.meeting_id, 320);
  const meetingId = text(meetingRecord.meeting_id, 320);
  if (!eventId && !meetingId) return null;
  for (const signal of Array.isArray(signals) ? signals : []) {
    const process = signal?.process;
    const sourceEvent = text(process?.source_record?.source_event_id || process?.stated_intent?.source_event_id, 320);
    if (sourceEvent && (sourceEvent === eventId || sourceEvent === meetingId)) return signal;
  }
  return null;
}

/**
 * Match one signal to a procurement by accepted realization identity.
 */
export function selectProcurementIntentSignal(signals = [], procurementObject = {}) {
  const epin = text(procurementObject?.identity_keys?.epins?.[0], 40);
  const procurementId = text(procurementObject?.procurement_id, 320);
  if (!epin && !procurementId) return null;
  for (const signal of Array.isArray(signals) ? signals : []) {
    const realizations = acceptedRealizations(signal?.match, signal?.observations || []);
    for (const row of realizations) {
      if (epin && (row.epin === epin || row.pin === epin)) return signal;
      if (procurementId && row.realization_ref === procurementId) return signal;
      if (epin && row.realization_ref?.endsWith(`:${epin}`)) return signal;
    }
  }
  return null;
}

/**
 * Build the meeting panel from optional caller-supplied enrichment.
 * Absent enrichment returns "" so the meeting document stays unchanged.
 */
export function meetingIntentSurfaceHtmlFromOptions(options = {}, meetingRecord = {}) {
  const authorization = options.procurementIntentAuthorization || null;
  const signals = options.procurementIntentSignals || null;
  if (!authorization && !signals) return "";
  const signal = selectMeetingIntentSignal(signals, meetingRecord);
  if (!signal?.process) return "";
  const projection = projectMeetingIntentSurface({
    process: signal.process,
    match: signal.match || null,
    observations: signal.observations || [],
    authorization,
    observation_coverage: signal.observation_coverage || null,
    now: options.today || options.now || null,
  });
  return renderMeetingIntentSurfaceHtml(projection);
}

/**
 * Build the procurement panel from optional caller-supplied enrichment.
 */
export function procurementIntentSurfaceHtmlFromOptions(options = {}, procurementObject = {}) {
  const authorization = options.procurementIntentAuthorization || null;
  const signals = options.procurementIntentSignals || null;
  if (!authorization && !signals) return "";
  const signal = selectProcurementIntentSignal(signals, procurementObject)
    || (Array.isArray(signals) && signals.length === 1 ? signals[0] : null);
  if (!signal?.process) return "";
  const projection = projectProcurementIntentSurface({
    process: signal.process,
    match: signal.match || null,
    observations: signal.observations || [],
    authorization,
    observation_coverage: signal.observation_coverage || null,
    now: options.today || options.now || null,
  });
  return renderProcurementIntentSurfaceHtml(projection);
}
