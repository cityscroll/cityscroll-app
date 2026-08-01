/**
 * Civic-time event envelope — pure library seam.
 *
 * Clocks: valid (event), published, observed, processed — never invent one from another.
 * See docs/adr/civic-time-event-contract.md and docs/digest-time-ontology.md.
 */

import { createHash } from "node:crypto";

export const CIVIC_TIME_MATERIALIZER = "civic_time_fixture_v1";
export const CIVIC_TIME_MATERIALIZER_VERSION = "1.0.0";
export const CIVIC_TIME_SCHEMA_VERSION = 1;

/** Bounded event-kind registry (closed list for this card). */
export const EVENT_KIND_REGISTRY = Object.freeze({
  // Money / procurement
  "procurement.notice_published": {
    lens: "money",
    description: "City Record procurement notice publication",
  },
  "procurement.award_registered": {
    lens: "money",
    description: "Contract registration or award assertion",
  },
  "procurement.payment": {
    lens: "money",
    description: "Spending payment assertion",
  },
  // Rules
  "rules.proposal_published": {
    lens: "rules",
    description: "Proposed rule publication",
  },
  "rules.public_hearing": {
    lens: "rules",
    description: "Scheduled or held public hearing",
  },
  "rules.comment_close": {
    lens: "rules",
    description: "Comment period close (valid time)",
  },
  "rules.adoption": {
    lens: "rules",
    description: "Rule adoption publication",
  },
  "rules.effective": {
    lens: "rules",
    description: "Rule effective date",
  },
  // Land / ZAP
  "land.zap_milestone": {
    lens: "land",
    description: "ZAP project milestone",
  },
  "land.city_record_notice": {
    lens: "land",
    description: "City Record land-use notice publication",
  },
  "land.city_record_hearing": {
    lens: "land",
    description: "City Record land hearing event time",
  },
  // Meetings
  "meetings.council_event": {
    lens: "meetings",
    description: "Council calendar event",
  },
  "meetings.agenda_item_action": {
    lens: "meetings",
    description: "Agenda item official action",
  },
  "meetings.roll_call_vote": {
    lens: "meetings",
    description: "Roll-call vote on an agenda item",
  },
});

const ENVELOPE_REQUIRED = [
  "event_id",
  "subject_ref",
  "event_kind",
  "source_record_ref",
  "source_revision",
  "payload_hash",
  "materializer_name",
  "materializer_version",
  "run_id",
];

const CLOCK_FIELDS = ["valid_at", "valid_from", "valid_to", "published_at", "observed_at", "processed_at"];

export function isRegisteredEventKind(kind) {
  return Object.prototype.hasOwnProperty.call(EVENT_KIND_REGISTRY, kind);
}

export function listEventKinds(lens = null) {
  return Object.entries(EVENT_KIND_REGISTRY)
    .filter(([, meta]) => !lens || meta.lens === lens)
    .map(([id, meta]) => ({ id, ...meta }));
}

/**
 * Stable payload hash — excludes run_id and processed_at so re-runs with the same
 * source revision stay comparable. Includes all civic clocks and identity fields.
 */
export function hashPayload(parts) {
  const canonical = {
    subject_ref: parts.subject_ref ?? null,
    event_kind: parts.event_kind ?? null,
    valid_at: parts.valid_at ?? null,
    valid_from: parts.valid_from ?? null,
    valid_to: parts.valid_to ?? null,
    published_at: parts.published_at ?? null,
    observed_at: parts.observed_at ?? null,
    source_record_ref: parts.source_record_ref ?? null,
    source_revision: parts.source_revision ?? null,
    status: parts.status ?? null,
    confidence: parts.confidence ?? null,
    supersedes_event_id: parts.supersedes_event_id ?? null,
    source_field: parts.source_field ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Stable event id from subject + kind + source revision (not from processing time).
 */
export function makeEventId({ subject_ref, event_kind, source_revision }) {
  const raw = `${subject_ref}|${event_kind}|${source_revision}`;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 24);
  return `cte:${digest}`;
}

function assertNoInventedClocks(input, envelope) {
  // If the source omitted publication, the envelope must not invent it from processing.
  if (input.published_at == null && envelope.published_at != null) {
    throw new TypeError("mapper invented published_at without a source publication clock");
  }
  if (input.valid_at == null && input.valid_from == null && envelope.valid_at != null) {
    throw new TypeError("mapper invented valid_at without a source valid clock");
  }
  if (input.observed_at == null && envelope.observed_at != null && input.allow_observed_default !== true) {
    throw new TypeError("mapper invented observed_at without a source observation clock");
  }
}

/**
 * Map a source assertion into the civic-time envelope.
 * Unknown clocks stay null. Unknown event kinds fail closed.
 *
 * @param {object} input
 * @param {object} [opts]
 * @param {string} [opts.run_id]
 * @param {string} [opts.materializer_name]
 * @param {string} [opts.materializer_version]
 */
export function mapCivicEvent(input, opts = {}) {
  if (!input || typeof input !== "object") {
    throw new TypeError("mapCivicEvent requires an input object");
  }
  const event_kind = input.event_kind;
  if (!isRegisteredEventKind(event_kind)) {
    throw new TypeError(`unknown event_kind: ${event_kind}`);
  }
  if (!input.subject_ref) throw new TypeError("subject_ref is required");
  if (!input.source_record_ref) throw new TypeError("source_record_ref is required");
  if (!input.source_revision) throw new TypeError("source_revision is required");

  const hasValidAt = input.valid_at != null && input.valid_at !== "";
  const hasRange = input.valid_from != null || input.valid_to != null;
  if (!hasValidAt && !hasRange && input.require_valid !== false) {
    // Allow publication-only events (e.g. adoption with only published_at).
    if (input.published_at == null) {
      throw new TypeError("event needs valid_at/valid_from/valid_to or published_at");
    }
  }

  const run_id = opts.run_id ?? input.run_id ?? "fixture-run";
  const materializer_name = opts.materializer_name ?? input.materializer_name ?? CIVIC_TIME_MATERIALIZER;
  const materializer_version =
    opts.materializer_version ?? input.materializer_version ?? CIVIC_TIME_MATERIALIZER_VERSION;

  const base = {
    subject_ref: String(input.subject_ref),
    event_kind: String(event_kind),
    valid_at: hasValidAt ? String(input.valid_at) : null,
    valid_from: input.valid_from != null ? String(input.valid_from) : null,
    valid_to: input.valid_to != null ? String(input.valid_to) : null,
    published_at: input.published_at != null ? String(input.published_at) : null,
    observed_at: input.observed_at != null ? String(input.observed_at) : null,
    processed_at: input.processed_at != null ? String(input.processed_at) : null,
    source_record_ref: String(input.source_record_ref),
    source_revision: String(input.source_revision),
    status: input.status ?? null,
    confidence: input.confidence ?? null,
    supersedes_event_id: input.supersedes_event_id ?? null,
    source_field: input.source_field ?? null,
  };

  const event_id = input.event_id ?? makeEventId(base);
  const payload_hash = hashPayload(base);

  const envelope = {
    schema_version: CIVIC_TIME_SCHEMA_VERSION,
    event_id,
    ...base,
    payload_hash,
    materializer_name,
    materializer_version,
    run_id,
  };

  // processed_at is run metadata; allow it only when explicitly provided (or via opts).
  if (opts.processed_at != null && envelope.processed_at == null) {
    envelope.processed_at = String(opts.processed_at);
  }

  assertNoInventedClocks(input, envelope);
  validateEnvelope(envelope);
  return envelope;
}

export function validateEnvelope(event) {
  const missing = ENVELOPE_REQUIRED.filter((f) => event[f] == null || event[f] === "");
  if (missing.length) {
    throw new TypeError(`envelope missing: ${missing.join(", ")}`);
  }
  if (!isRegisteredEventKind(event.event_kind)) {
    throw new TypeError(`unknown event_kind: ${event.event_kind}`);
  }
  if (!/^[a-f0-9]{64}$/.test(event.payload_hash)) {
    throw new TypeError("payload_hash must be sha256 hex");
  }
  for (const clock of CLOCK_FIELDS) {
    if (event[clock] === undefined) {
      throw new TypeError(`envelope must name clock ${clock} (use null when unknown)`);
    }
  }
  return event;
}

/**
 * Map a fixture document (array of source assertions + optional prior events) to envelopes.
 */
export function mapFixtureDoc(doc, opts = {}) {
  const run_id = opts.run_id ?? doc.run_id ?? "fixture-run";
  const processed_at = opts.processed_at ?? doc.processed_at ?? null;
  const assertions = doc.assertions || [];
  return assertions.map((assertion) =>
    mapCivicEvent(
      { ...assertion, run_id, processed_at: assertion.processed_at ?? processed_at },
      { run_id, processed_at: assertion.processed_at ?? processed_at },
    ),
  );
}

/**
 * Semantic diff of two event sets keyed by (subject_ref, event_kind) for the
 * current civic fact, and by event_id for exact equality.
 *
 * @returns {{ added, changed, superseded, unchanged, schema_version }}
 */
export function semanticDiff(previousEvents = [], currentEvents = []) {
  const prevById = new Map(previousEvents.map((e) => [e.event_id, e]));
  const currById = new Map(currentEvents.map((e) => [e.event_id, e]));

  // Subject+kind key for the latest assertion of that civic fact.
  const projKey = (e) => `${e.subject_ref}\0${e.event_kind}`;
  const prevByProj = new Map();
  for (const e of previousEvents) {
    const k = projKey(e);
    // Prefer latest revision string for multi-rev fixtures (lexicographic is ok for hash revs).
    const existing = prevByProj.get(k);
    if (!existing || String(e.source_revision) > String(existing.source_revision)) {
      prevByProj.set(k, e);
    }
  }
  const currByProj = new Map();
  for (const e of currentEvents) {
    const k = projKey(e);
    const existing = currByProj.get(k);
    if (!existing || String(e.source_revision) > String(existing.source_revision)) {
      currByProj.set(k, e);
    }
  }

  const added = [];
  const changed = [];
  const superseded = [];
  const unchanged = [];

  for (const [key, curr] of currByProj) {
    const prev = prevByProj.get(key);
    if (!prev) {
      added.push(summarize(curr));
      continue;
    }
    if (prev.event_id === curr.event_id && prev.payload_hash === curr.payload_hash) {
      unchanged.push(summarize(curr));
      continue;
    }
    if (curr.supersedes_event_id === prev.event_id || prev.source_revision !== curr.source_revision) {
      superseded.push({
        previous: summarize(prev),
        current: summarize(curr),
      });
      continue;
    }
    changed.push({
      previous: summarize(prev),
      current: summarize(curr),
    });
  }

  // Facts only in the previous run that disappeared from the current run.
  for (const [key, prev] of prevByProj) {
    if (!currByProj.has(key)) {
      changed.push({
        previous: summarize(prev),
        current: null,
      });
    }
  }

  // Stable ordering for byte-stable CLI output
  const byId = (a, b) => String(a.event_id || a.current?.event_id || "").localeCompare(
    String(b.event_id || b.current?.event_id || ""),
  );
  added.sort(byId);
  unchanged.sort(byId);
  changed.sort((a, b) =>
    String(a.current?.event_id || a.previous?.event_id || "").localeCompare(
      String(b.current?.event_id || b.previous?.event_id || ""),
    ),
  );
  superseded.sort((a, b) =>
    String(a.current?.event_id || "").localeCompare(String(b.current?.event_id || "")),
  );

  return {
    schema_version: CIVIC_TIME_SCHEMA_VERSION,
    materializer: CIVIC_TIME_MATERIALIZER,
    counts: {
      added: added.length,
      changed: changed.length,
      superseded: superseded.length,
      unchanged: unchanged.length,
      previous: previousEvents.length,
      current: currentEvents.length,
    },
    added,
    changed,
    superseded,
    unchanged,
    // Retain id maps for tests without dumping full envelopes into check fixtures.
    _prev_ids: [...prevById.keys()].sort(),
    _curr_ids: [...currById.keys()].sort(),
  };
}

function summarize(event) {
  if (!event) return null;
  return {
    event_id: event.event_id,
    subject_ref: event.subject_ref,
    event_kind: event.event_kind,
    source_revision: event.source_revision,
    payload_hash: event.payload_hash,
    valid_at: event.valid_at,
    published_at: event.published_at,
    observed_at: event.observed_at,
    processed_at: event.processed_at,
    supersedes_event_id: event.supersedes_event_id ?? null,
  };
}

/** Public shape of a diff (no private _ fields). */
export function publicDiff(diff) {
  const { _prev_ids, _curr_ids, ...rest } = diff;
  return rest;
}

/**
 * Build clock annotation table for a fixture assertion (for tests / operator guide).
 * Each date field must declare which clock it belongs to.
 */
export function clockTable(assertion) {
  const rows = [];
  const push = (field, value, clock) => {
    if (value == null || value === "") return;
    rows.push({ field, value: String(value), clock });
  };
  push("valid_at", assertion.valid_at, "valid");
  push("valid_from", assertion.valid_from, "valid");
  push("valid_to", assertion.valid_to, "valid");
  push("published_at", assertion.published_at, "publication");
  push("observed_at", assertion.observed_at, "observation");
  push("processed_at", assertion.processed_at, "processing");
  return rows;
}
