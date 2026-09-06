/**
 * Watch continuity across the procurement identity transition.
 *
 * A reader can follow a prospective procurement while it is still only a
 * statement in the record: at that point the object has a provisional subject
 * (`procurement-intent:<slug>`) and no publisher-native identity. When the
 * publisher later releases the solicitation, the accepted realization bridge
 * names the EPIN/PIN-bearing procurement. This module carries the reader's one
 * explicit watch across that transition.
 *
 * Rules the module exists to hold:
 *   - Following is explicit. Nothing here creates a watch as a side effect of a
 *     realization; a realization can only be applied to a watch that already
 *     exists because a reader asked for it.
 *   - Following is idempotent. Re-following the same subject returns the same
 *     watch key and the same lineage, never a second subscription.
 *   - The provisional subject is never replaced. Realized subjects are added
 *     beside it, so the early signal and the published record stay legible as
 *     two observations of one followed process.
 *   - A one-to-many realization keeps every accepted relationship. The module
 *     never selects one solicitation as "the" realization.
 *   - Source fact, CityScroll interpretation, and later observation stay three
 *     separate registers on every row this module hands the digest path.
 *
 * The module reads no clock: every entry point takes the caller's `now`, so a
 * replay produces byte-identical records.
 */

import { realizationRefFor } from "../warehouse/lib/procurement_intent_realization_matcher.mjs";

export const PROCUREMENT_INTENT_WATCH_SCHEMA = "cityscroll.procurement_intent_watch.v1";

/** Delivery stays gated until prospective data is promoted out of shadow mode. */
export const PROCUREMENT_INTENT_WATCH_DELIVERY_ENV = "PROCUREMENT_INTENT_WATCH_DELIVERY";

/** The only way a watch is created. Recorded on the watch so it stays auditable. */
export const PROCUREMENT_INTENT_FOLLOW_SOURCE = "explicit_reader_follow";

/** Separate evidence registers. A row never merges two of them into one claim. */
export const PROCUREMENT_INTENT_EVIDENCE_STATES = Object.freeze([
  "source_fact",
  "cityscroll_interpretation",
  "later_observation",
]);

export const PROCUREMENT_INTENT_UPDATE_KIND = Object.freeze({
  EARLY_SIGNAL: "early_signal",
  PUBLISHED: "published_identity",
});

const PROVISIONAL_SUBJECT_REF = /^procurement-intent:[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])));
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

/** True when the environment has enabled reader delivery for these watches. */
export function procurementIntentWatchDeliveryEnabled(env = {}) {
  const value = env?.[PROCUREMENT_INTENT_WATCH_DELIVERY_ENV];
  return value === true || value === "1" || value === "true";
}

/** Parse the provisional subject the PIR ontology mints. Unknown shapes fail closed. */
export function parseProvisionalSubjectRef(value) {
  const ref = text(value, 320);
  if (!ref || !PROVISIONAL_SUBJECT_REF.test(ref)) return null;
  return { ref, slug: ref.slice("procurement-intent:".length) };
}

/**
 * Deterministic watch identity. One reader following one provisional subject
 * has exactly one key, so a second follow can never mint a second watch.
 */
export function procurementIntentWatchKey(subscriberRef, processRef) {
  const subscriber = text(subscriberRef, 200);
  const subject = parseProvisionalSubjectRef(processRef);
  if (!subscriber || !subject) return null;
  return `procurement-intent-watch:${encodeURIComponent(subscriber)}:${subject.ref}`;
}

/** Stable per-update delivery identity, reused by the outbox deduplication policy. */
export function procurementIntentUpdateKey(watchKey, kind, subjectRef) {
  return [watchKey, "update", kind, subjectRef].filter(Boolean).join("::");
}

function cardinality(realizedCount) {
  return {
    intent_count: 1,
    realized_count: realizedCount,
    relation: realizedCount === 0 ? "none" : realizedCount === 1 ? "one_to_one" : "one_to_many",
  };
}

function lineage(provisionalRef, realizations) {
  const realized = [...new Set(realizations.map((row) => row.realization_ref))].sort();
  return {
    provisional_subject_ref: provisionalRef,
    realized_subject_refs: realized,
    // The provisional subject stays the watch's identity anchor even after the
    // publisher identity is known; "realized" describes what has been observed.
    identity_state: realized.length ? "realized" : "prospective",
    cardinality: cardinality(realized.length),
  };
}

function watchRecord({ key, subscriberRef, provisionalRef, status, follow, realizations, transitions }) {
  return freeze({
    schema: PROCUREMENT_INTENT_WATCH_SCHEMA,
    watch_key: key,
    subscriber_ref: subscriberRef,
    status,
    follow,
    subject_lineage: lineage(provisionalRef, realizations),
    realizations,
    transitions,
  });
}

function normalizeWatch(watch) {
  if (!watch || typeof watch !== "object") return null;
  const key = text(watch.watch_key, 640);
  const subject = parseProvisionalSubjectRef(watch.subject_lineage?.provisional_subject_ref);
  if (!key || !subject) return null;
  return {
    key,
    subscriberRef: text(watch.subscriber_ref, 200),
    provisionalRef: subject.ref,
    status: watch.status === "released" ? "released" : "active",
    follow: {
      source: PROCUREMENT_INTENT_FOLLOW_SOURCE,
      followed_at: text(watch.follow?.followed_at, 40),
      released_at: text(watch.follow?.released_at, 40),
    },
    realizations: Array.isArray(watch.realizations) ? watch.realizations.map((row) => ({ ...row })) : [],
    transitions: Array.isArray(watch.transitions) ? watch.transitions.map((row) => ({ ...row })) : [],
  };
}

/**
 * Record one reader's explicit follow of a prospective procurement.
 *
 * Idempotent by construction: an existing watch for the same reader and subject
 * is returned unchanged, keeping whatever realization lineage it has already
 * accumulated. A previously released watch is reactivated under the same key
 * rather than duplicated. This is the only constructor in the module.
 */
export function followProcurementIntent({
  watches = [],
  subscriber_ref: subscriberRef,
  process_ref: processRef,
  now,
} = {}) {
  const subscriber = text(subscriberRef, 200);
  const subject = parseProvisionalSubjectRef(processRef);
  const followedAt = text(now, 40);
  if (!subscriber) throw new TypeError("following a procurement intent requires a subscriber_ref");
  if (!subject) throw new TypeError("following a procurement intent requires a provisional subject ref");
  if (!followedAt) throw new TypeError("following a procurement intent requires an explicit now");

  const key = procurementIntentWatchKey(subscriber, subject.ref);
  const existing = (Array.isArray(watches) ? watches : [])
    .map(normalizeWatch)
    .find((row) => row && row.key === key);

  if (existing && existing.status === "active") {
    return { watch: watchRecord(existing), created: false, reason: "already_following" };
  }
  if (existing) {
    return {
      watch: watchRecord({
        ...existing,
        status: "active",
        follow: { ...existing.follow, followed_at: followedAt, released_at: null },
      }),
      created: false,
      reason: "refollowed",
    };
  }
  return {
    watch: watchRecord({
      key,
      subscriberRef: subscriber,
      provisionalRef: subject.ref,
      status: "active",
      follow: { source: PROCUREMENT_INTENT_FOLLOW_SOURCE, followed_at: followedAt, released_at: null },
      realizations: [],
      transitions: [],
    }),
    created: true,
    reason: "followed",
  };
}

/** Explicit unfollow. The lineage is retained so a later re-follow is not a new discovery. */
export function releaseProcurementIntentWatch(watch, { now } = {}) {
  const current = normalizeWatch(watch);
  const releasedAt = text(now, 40);
  if (!current) throw new TypeError("releasing requires a procurement intent watch");
  if (!releasedAt) throw new TypeError("releasing requires an explicit now");
  if (current.status === "released") return watchRecord(current);
  return watchRecord({
    ...current,
    status: "released",
    follow: { ...current.follow, released_at: releasedAt },
  });
}

function observationLookup(observations) {
  const lookup = new Map();
  for (const row of Array.isArray(observations) ? observations : []) {
    const ref = realizationRefFor(row);
    if (ref && !lookup.has(ref)) lookup.set(ref, row);
  }
  return lookup;
}

function realizationRow(edge, observation, { assertedAt, followedAt, recordedAt }) {
  const publishedAt = day(observation?.published_at);
  return {
    realization_ref: edge.to,
    // EPIN and PIN stay separate publisher values; neither is derived from the
    // other, and an absent one is recorded as absent.
    epin: text(observation?.epin, 40),
    pin: text(observation?.pin, 40),
    published_at: publishedAt,
    source_system: text(observation?.source_system, 120),
    title: text(observation?.title, 500),
    citation_url: text(observation?.citation_url || observation?.source_url, 600),
    href: text(observation?.href, 600),
    match_confidence: text(edge.match_confidence, 60),
    basis: text(edge.basis, 120),
    // Advance lead is arithmetic between two observed dates: the day the
    // statement was made and the day the publisher released the solicitation.
    advance_lead_days: assertedAt && publishedAt ? dayDifference(assertedAt, publishedAt) : null,
    // True when the reader followed a process that had already been published.
    published_before_follow: Boolean(publishedAt && followedAt && publishedAt < followedAt.slice(0, 10)),
    recorded_at: recordedAt,
  };
}

function acceptedEdges(match) {
  return (Array.isArray(match?.realized_by) ? match.realized_by : [])
    .filter((edge) => edge && edge.status === "accepted" && text(edge.to, 320))
    .map((edge) => ({
      to: text(edge.to, 320),
      basis: edge.basis,
      match_confidence: edge.match_confidence,
    }))
    .sort((left, right) => left.to.localeCompare(right.to));
}

/**
 * Carry the watch across the identity transition.
 *
 * Only accepted realization edges are read; review candidates and ambiguous
 * pairs are not identity. Every accepted edge is kept, so a one-to-many
 * realization ends with every relationship on the one watch. Re-applying the
 * same match is inert.
 */
export function applyRealizationToWatch(watch, {
  match,
  observations = [],
  asserted_at: assertedAt = null,
  now,
} = {}) {
  const current = normalizeWatch(watch);
  const recordedAt = text(now, 40);
  if (!current) throw new TypeError("applying a realization requires an existing explicit watch");
  if (!recordedAt) throw new TypeError("applying a realization requires an explicit now");
  if (match && text(match.process_ref, 320) && match.process_ref !== current.provisionalRef) {
    throw new TypeError("realization match is for a different provisional subject");
  }

  const observed = observationLookup(observations);
  const known = new Set(current.realizations.map((row) => row.realization_ref));
  const added = [];
  const realizations = [...current.realizations];
  const transitions = [...current.transitions];
  const statedAt = day(assertedAt);

  for (const edge of acceptedEdges(match)) {
    if (known.has(edge.to)) continue;
    known.add(edge.to);
    const row = realizationRow(edge, observed.get(edge.to) || null, {
      assertedAt: statedAt,
      followedAt: current.follow.followed_at,
      recordedAt,
    });
    realizations.push(row);
    added.push(edge.to);
    transitions.push({
      update_key: procurementIntentUpdateKey(current.key, PROCUREMENT_INTENT_UPDATE_KIND.PUBLISHED, edge.to),
      kind: PROCUREMENT_INTENT_UPDATE_KIND.PUBLISHED,
      from_subject_ref: current.provisionalRef,
      to_subject_ref: edge.to,
      basis: row.basis,
      match_confidence: row.match_confidence,
      recorded_at: recordedAt,
    });
  }

  realizations.sort((left, right) => left.realization_ref.localeCompare(right.realization_ref));
  transitions.sort((left, right) => left.update_key.localeCompare(right.update_key));
  return {
    watch: watchRecord({ ...current, realizations, transitions }),
    added,
    // The publisher identity is added beside the provisional subject; it never
    // replaces it, so the reader keeps the one watch they created.
    replaced_subject: false,
  };
}

function sourceFact(intent = {}, sourceRecord = {}) {
  const citation = Array.isArray(sourceRecord.citations) ? sourceRecord.citations[0] : null;
  return {
    evidence_state: "source_fact",
    source_record_ref: text(sourceRecord.source_record_ref || intent.source_record_id, 320),
    source_event_id: text(sourceRecord.source_event_id || intent.source_event_id, 320),
    observed_at: day(sourceRecord.observed_at || intent.observed_at),
    speaker: text(sourceRecord.speaker?.display_name, 200),
    speaker_role: text(sourceRecord.speaker?.role, 200),
    source_title: text(sourceRecord.source_title, 500),
    span_text: text(sourceRecord.source_span_text || intent.source_span, 1_000),
    span_text_status: text(sourceRecord.span_text_status, 40),
    citation_url: text(citation?.url, 600),
  };
}

function interpretation(watch, intent = {}) {
  return {
    evidence_state: "cityscroll_interpretation",
    provisional_subject_ref: watch.subject_lineage.provisional_subject_ref,
    identity_state: watch.subject_lineage.identity_state,
    cardinality: watch.subject_lineage.cardinality,
    responsible_agency_ref: text(intent.responsible_agency_ref, 200),
    object_text: text(intent.object_text, 500),
    procurement_type: text(intent.procurement_type, 80),
    stated_window: intent.expected_window
      ? {
        earliest: day(intent.expected_window.earliest),
        latest: day(intent.expected_window.latest),
        raw_text: text(intent.expected_window.raw_text, 240),
      }
      : null,
    extraction_method: text(intent.extraction_method, 120),
    extraction_version: text(intent.extraction_version, 80),
  };
}

function laterObservation(realization) {
  if (!realization) {
    return {
      evidence_state: "later_observation",
      // Not observed yet is a different fact from observed-and-absent; the
      // early-signal row never asserts the second.
      status: "not_yet_observed",
      realization_ref: null,
      epin: null,
      pin: null,
      published_at: null,
    };
  }
  return {
    evidence_state: "later_observation",
    status: "observed",
    realization_ref: realization.realization_ref,
    epin: realization.epin,
    pin: realization.pin,
    published_at: realization.published_at,
    source_system: realization.source_system,
    title: realization.title,
    citation_url: realization.citation_url,
    match_confidence: realization.match_confidence,
    basis: realization.basis,
  };
}

function earlySignalCopy(fact, reading) {
  const who = fact.speaker ? `${fact.speaker}${fact.speaker_role ? ` (${fact.speaker_role})` : ""}` : "The record";
  const what = reading.object_text || "a procurement";
  const when = fact.observed_at ? ` on ${fact.observed_at}` : "";
  return `${who} described ${what} as still to come${when}. Nothing is published yet.`;
}

function publishedCopy(observation, realization) {
  const title = observation.title || "A solicitation";
  const identity = observation.epin || observation.pin;
  const published = observation.published_at ? ` on ${observation.published_at}` : "";
  const lead = Number.isInteger(realization.advance_lead_days) && realization.advance_lead_days > 0
    ? ` That is ${realization.advance_lead_days} days after the statement you followed.`
    : "";
  return `${title}${identity ? ` (${identity})` : ""} was published${published}.${lead}`;
}

/**
 * Project the watch into digest rows.
 *
 * One early-signal row for the followed statement, then one row per realized
 * publisher identity. Each row keeps the three evidence registers apart, so the
 * digest can show what the source said, how CityScroll read it, and what was
 * later observed without collapsing them into a single assertion.
 */
export function procurementIntentWatchDigestRows(watch, {
  stated_intent: intent = {},
  source_record: sourceRecord = {},
} = {}) {
  const normalized = normalizeWatch(watch);
  if (!normalized || normalized.status !== "active") return [];
  const current = watchRecord(normalized);
  const fact = sourceFact(intent, sourceRecord);
  const reading = interpretation(current, intent);

  const rows = [{
    kind: PROCUREMENT_INTENT_UPDATE_KIND.EARLY_SIGNAL,
    subject_ref: current.subject_lineage.provisional_subject_ref,
    update_key: procurementIntentUpdateKey(
      current.watch_key,
      PROCUREMENT_INTENT_UPDATE_KIND.EARLY_SIGNAL,
      current.subject_lineage.provisional_subject_ref,
    ),
    start_date: fact.observed_at,
    short_title: earlySignalCopy(fact, reading),
    href: null,
    official_url: fact.citation_url,
    evidence: { source_fact: fact, cityscroll_interpretation: reading, later_observation: laterObservation(null) },
    realization: null,
  }];

  for (const realization of current.realizations) {
    const observation = laterObservation(realization);
    rows.push({
      kind: PROCUREMENT_INTENT_UPDATE_KIND.PUBLISHED,
      subject_ref: realization.realization_ref,
      update_key: procurementIntentUpdateKey(
        current.watch_key,
        PROCUREMENT_INTENT_UPDATE_KIND.PUBLISHED,
        realization.realization_ref,
      ),
      start_date: realization.published_at,
      short_title: publishedCopy(observation, realization),
      href: realization.href,
      official_url: realization.citation_url,
      evidence: { source_fact: fact, cityscroll_interpretation: reading, later_observation: observation },
      realization,
    });
  }

  return freeze(rows.map((row) => ({
    ...row,
    alert_id: row.update_key,
    procurement_intent_watch: {
      schema: PROCUREMENT_INTENT_WATCH_SCHEMA,
      watch_key: current.watch_key,
      update_key: row.update_key,
      kind: row.kind,
      subject_lineage: current.subject_lineage,
      follow_source: current.follow.source,
    },
  })));
}

/**
 * `{ rows, markSeenIds }` in the same shape the other watch families use, so a
 * delivered early signal is never re-sent when the publication arrives.
 */
export function evaluateProcurementIntentWatch(watch, {
  stated_intent: intent = {},
  source_record: sourceRecord = {},
  seen = new Set(),
  deliveryEnabled = false,
} = {}) {
  if (!deliveryEnabled) return { rows: [], markSeenIds: [] };
  const delivered = new Set(seen || []);
  const rows = procurementIntentWatchDigestRows(watch, { stated_intent: intent, source_record: sourceRecord })
    .filter((row) => !delivered.has(row.update_key));
  return { rows, markSeenIds: rows.map((row) => row.update_key) };
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

/**
 * Render one row with its three evidence registers labelled separately. The
 * interpretation register states how the statement was grouped; it carries no
 * probability, score, or forecast copy.
 */
export function renderProcurementIntentWatchUpdate(row) {
  if (!row?.update_key) return "";
  const fact = row.evidence?.source_fact || {};
  const reading = row.evidence?.cityscroll_interpretation || {};
  const observation = row.evidence?.later_observation || {};
  const identity = observation.epin || observation.pin;
  const observed = observation.status === "observed"
    ? `<dd>${esc(observation.title || observation.realization_ref)}${identity ? ` &mdash; ${esc(identity)}` : ""}${observation.published_at ? `, published ${esc(observation.published_at)}` : ""}</dd>`
    : "<dd>No published solicitation observed yet.</dd>";
  return `<article class="procurement-intent-watch-update" data-update-kind="${esc(row.kind)}" data-subject-ref="${esc(row.subject_ref)}">
    <p class="procurement-intent-watch-latest">${esc(row.short_title)}</p>
    <dl class="procurement-intent-watch-evidence">
      <div><dt>Source fact</dt><dd>${esc(fact.span_text || "")}${fact.observed_at ? ` (${esc(fact.observed_at)})` : ""}</dd></div>
      <div><dt>CityScroll interpretation</dt><dd>Followed as one prospective procurement: ${esc(reading.provisional_subject_ref || "")}.</dd></div>
      <div><dt>Later observation</dt>${observed}</div>
    </dl>
  </article>`;
}
