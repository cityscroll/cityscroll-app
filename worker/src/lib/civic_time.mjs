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
  "land.zap_disposition": {
    lens: "land",
    description: "ZAP land-use disposition / vote outcome",
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

/** Map product spine event_type / kind → registry id. Unknown kinds fail closed. */
export const SPINE_KIND_ALIASES = Object.freeze({
  // Rules deriveRuleEvents
  proposal_published: "rules.proposal_published",
  public_hearing: "rules.public_hearing",
  comment_close: "rules.comment_close",
  adoption: "rules.adoption",
  effective: "rules.effective",
  // Land buildLandEventSpine
  zap_milestone: "land.zap_milestone",
  city_record_notice_published: "land.city_record_notice",
  city_record_hearing: "land.city_record_hearing",
  zap_disposition: "land.zap_disposition",
  // Money / contract lifecycle stages (assembleLifecycle timeline)
  solicitation: "procurement.notice_published",
  award: "procurement.notice_published",
  registered: "procurement.award_registered",
  payment: "procurement.payment",
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
 * Does not rewrite assertion subject_ref values. Optional doc.subject_links are not
 * folded into envelopes — load them with linksFromCivicFixtureDoc from subject_registry.
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

// ---------------------------------------------------------------------------
// Product-spine adapters (read-only mapping; no production writer)
// ---------------------------------------------------------------------------

function dayStamp(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Checkbook / PASSPort often emit US slash dates (e.g. 07/22/2024).
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const mm = mdy[1].padStart(2, "0");
    const dd = mdy[2].padStart(2, "0");
    return `${mdy[3]}-${mm}-${dd}`;
  }
  return s;
}

/**
 * Map `deriveRuleEvents` output into civic-time envelopes.
 * Does not invent publication from processing; adoption keeps published_at only.
 *
 * @param {object} rule - normalized NYC Rules item (needs request_id or url)
 * @param {object[]} ruleEvents - from deriveRuleEvents(rule)
 * @param {object} [meta]
 */
export function mapRuleSpineToCivic(rule, ruleEvents = [], meta = {}) {
  const noticeId = rule?.request_id || rule?.city_record?.request_id || null;
  const subject_ref = noticeId
    ? `notice:${noticeId}`
    : `rules:${rule?.guid || rule?.url || "unknown"}`;
  const source_record_ref = rule?.guid
    ? `nyc-rules:guid:${rule.guid}`
    : `nyc-rules:url:${rule?.url || "unknown"}`;
  const observed_at = meta.observed_at ?? null;
  const processed_at = meta.processed_at ?? null;
  const run_id = meta.run_id ?? "rules-spine";
  const pub = rule?.pub_date || rule?.adoption_published_at || null;

  return (ruleEvents || []).map((ev) => {
    const event_kind = SPINE_KIND_ALIASES[ev.event_type];
    if (!event_kind) {
      throw new TypeError(`unknown rules spine event_type: ${ev.event_type}`);
    }
    const revisionBase = `${ev.event_type}:${ev.valid_at || ev.published_at || "none"}:${ev.source_field || ""}`;
    return mapCivicEvent(
      {
        event_kind,
        subject_ref,
        source_record_ref,
        source_revision: `rules:${revisionBase}`,
        source_field: ev.source_field || null,
        valid_at: ev.valid_at ?? null,
        published_at: ev.published_at ?? (ev.event_type === "proposal_published" ? pub : pub),
        observed_at,
        processed_at,
        status: ev.status ?? null,
        require_valid: false,
      },
      { run_id, processed_at },
    );
  });
}

/**
 * Map `buildLandEventSpine` events into civic-time envelopes.
 *
 * @param {object} spine - { events: [...] }
 * @param {object} [meta] - project_id, observed_at, processed_at, run_id
 */
export function mapLandSpineToCivic(spine, meta = {}) {
  const projectId = meta.project_id || spine?.project_id || "unknown";
  const subject_ref = `project:${projectId}`;
  const observed_at = meta.observed_at ?? null;
  const processed_at = meta.processed_at ?? null;
  const run_id = meta.run_id ?? "land-spine";

  return (spine?.events || []).map((ev) => {
    const event_kind = SPINE_KIND_ALIASES[ev.kind];
    if (!event_kind) {
      throw new TypeError(`unknown land spine kind: ${ev.kind}`);
    }
    const valid_at = dayStamp(ev.time?.value);
    const isPublication =
      ev.kind === "city_record_notice_published" || ev.time?.basis === "publication_date";
    return mapCivicEvent(
      {
        event_kind,
        subject_ref,
        source_record_ref: `${ev.source?.id || "land"}:${ev.id || ev.kind}`,
        source_revision: `land:${ev.id || ev.kind}:${valid_at || "none"}`,
        source_field: ev.time?.basis || null,
        valid_at: isPublication ? null : valid_at,
        published_at: isPublication ? valid_at : null,
        observed_at,
        processed_at,
        status: ev.status ?? null,
        require_valid: false,
      },
      { run_id, processed_at },
    );
  });
}

/**
 * Map one meeting-outcomes matched record into civic-time envelopes.
 *
 * @param {object} record - matched notice + council_event + agenda_items
 * @param {object} [meta]
 */
export function mapMeetingRecordToCivic(record, meta = {}) {
  const eventId = record?.council_event?.event_id;
  if (!eventId) return [];
  const subject_ref = `legistar-event:${eventId}`;
  const observed_at = meta.observed_at ?? null;
  const processed_at = meta.processed_at ?? null;
  const run_id = meta.run_id ?? "meetings-spine";
  const noticePub = record?.notice?.start_date || null;
  const out = [];

  const start = record.council_event.start_time || record.council_event.event_date || null;
  out.push(
    mapCivicEvent(
      {
        event_kind: "meetings.council_event",
        subject_ref,
        source_record_ref: `legistar:Events/${eventId}`,
        source_revision: `legistar:${eventId}:event:${dayStamp(start) || "none"}`,
        source_field: "EventDate",
        valid_at: dayStamp(start),
        published_at: noticePub,
        observed_at,
        processed_at,
        status: "occurred",
        require_valid: false,
      },
      { run_id, processed_at },
    ),
  );

  for (const item of record.agenda_items || []) {
    const itemId = item.event_item_id || item.id || item.title || "item";
    const actionName = item.action_name || item.action || item.status || null;
    if (actionName) {
      out.push(
        mapCivicEvent(
          {
            event_kind: "meetings.agenda_item_action",
            subject_ref,
            source_record_ref: `legistar:EventItems/${itemId}`,
            source_revision: `legistar:item:${itemId}:action:${actionName}`,
            source_field: "EventItemActionName",
            valid_at: dayStamp(item.action_date || start),
            published_at: noticePub,
            observed_at,
            processed_at,
            status: "occurred",
            require_valid: false,
          },
          { run_id, processed_at },
        ),
      );
    }
    const votes = item.matters?.flatMap((m) => m.votes || []) || item.votes || [];
    if (votes.length) {
      out.push(
        mapCivicEvent(
          {
            event_kind: "meetings.roll_call_vote",
            subject_ref,
            source_record_ref: `legistar:EventItems/${itemId}/Votes`,
            source_revision: `legistar:item:${itemId}:votes:n${votes.length}`,
            source_field: "Votes",
            valid_at: dayStamp(item.action_date || start),
            published_at: noticePub,
            observed_at,
            processed_at,
            status: "occurred",
            require_valid: false,
          },
          { run_id, processed_at },
        ),
      );
    }
  }
  return out;
}

/**
 * Label clocks on a digest temporal_action (alert path). Does not invent clocks.
 * Event time = valid; publication_at = publication; recorded_at = observation.
 */
export function clocksFromTemporalAction(action) {
  if (!action || typeof action !== "object") return [];
  return clockTable({
    valid_at: action.event_at ?? null,
    published_at: action.publication_at ?? null,
    observed_at: action.recorded_at ?? null,
    processed_at: null,
  });
}

// ---------------------------------------------------------------------------
// Money / contract lifecycle adapter (production emitter path)
// ---------------------------------------------------------------------------

const MONEY_PAYMENT_EMIT_STATES = new Set(["paid", "from_registered", "verified_zero"]);

/**
 * Map an assembled contract lifecycle (Checkbook + optional PASSPort) into
 * civic-time envelopes for Money event-kinds.
 *
 * Stage → kind:
 *   solicitation | award (matched) → procurement.notice_published
 *   registered (matched)           → procurement.award_registered
 *   payment (matched, honest state)→ procurement.payment
 *
 * Unmatched / ambiguous / unknown / not_applicable / passed stages emit nothing.
 * payment_state "unavailable" never invents a $0 payment event.
 *
 * @param {object} lifecycle - assembleLifecycle / getOrCompute result body
 * @param {object} [noticeRow] - City Record notice row (request_id, start_date, …)
 * @param {object} [meta] - observed_at, processed_at, run_id
 * @returns {object[]} civic-time envelopes
 */
export function mapMoneyLifecycleToCivic(lifecycle, noticeRow = null, meta = {}) {
  const notice = noticeRow || {};
  const noticeId = notice.request_id || lifecycle?.request_id || null;
  const observed_at = meta.observed_at ?? null;
  const processed_at = meta.processed_at ?? null;
  const run_id = meta.run_id ?? "money-lifecycle";
  const timeline = Array.isArray(lifecycle?.timeline) ? lifecycle.timeline : [];
  const out = [];

  const registeredEntry = timeline.find(
    (e) => e && e.stage === "registered" && e.status === "matched" && e.detail?.contract_id,
  );
  const contractIdFromReg = registeredEntry?.detail?.contract_id
    ? String(registeredEntry.detail.contract_id)
    : null;
  const regDateFallback = dayStamp(
    registeredEntry?.detail?.registration_date || registeredEntry?.date || null,
  );

  for (const entry of timeline) {
    if (!entry || entry.status !== "matched") continue;
    const stage = entry.stage;

    if (stage === "solicitation" || stage === "award") {
      const rid = entry.detail?.request_id || noticeId;
      if (!rid) continue;
      const pubDate = dayStamp(entry.date || entry.source_timestamp || notice.start_date);
      if (!pubDate) continue; // publication-only event needs a publication clock
      out.push(
        mapCivicEvent(
          {
            event_kind: "procurement.notice_published",
            subject_ref: `notice:${rid}`,
            source_record_ref: `${entry.source || "city-record"}:${rid}`,
            source_revision: `cr:${rid}:${stage}:start_date:${pubDate}`,
            source_field: "start_date",
            published_at: pubDate,
            valid_at: null,
            observed_at,
            processed_at,
            status: "occurred",
            require_valid: false,
          },
          { run_id, processed_at },
        ),
      );
      continue;
    }

    if (stage === "registered") {
      const contractId = entry.detail?.contract_id;
      if (!contractId) continue;
      const regDate = dayStamp(entry.detail?.registration_date || entry.date || entry.source_timestamp);
      if (!regDate) continue;
      out.push(
        mapCivicEvent(
          {
            event_kind: "procurement.award_registered",
            subject_ref: `contract:${contractId}`,
            source_record_ref: `${entry.source || "checkbook-contracts"}:${contractId}`,
            source_revision: `cb:${contractId}:reg:${regDate}`,
            source_field: "registration_date",
            valid_at: regDate,
            published_at: null,
            observed_at,
            processed_at,
            status: "occurred",
            confidence: "high",
            require_valid: false,
          },
          { run_id, processed_at },
        ),
      );
      continue;
    }

    if (stage === "payment") {
      const detail = entry.detail || {};
      const state = detail.payment_state;
      // Never invent a payment assertion from an unavailable feed.
      if (!MONEY_PAYMENT_EMIT_STATES.has(state)) continue;
      const contractId = contractIdFromReg || detail.contract_id || null;
      const subject_ref = contractId
        ? `contract:${contractId}`
        : noticeId
          ? `notice:${noticeId}`
          : null;
      if (!subject_ref) continue;
      const payDate = dayStamp(
        detail.latest_payment_date || entry.date || entry.source_timestamp || regDateFallback,
      );
      // paid needs a publisher payment date when possible; fall back to registration day
      // so from_registered / verified_zero still emit a clock-honest envelope.
      if (!payDate) continue;
      const sourceKey = contractId || noticeId || "payment";
      out.push(
        mapCivicEvent(
          {
            event_kind: "procurement.payment",
            subject_ref,
            source_record_ref: `${entry.source || "checkbook-spending"}:${sourceKey}`,
            source_revision: `pay:${sourceKey}:${state}:${payDate}:${detail.total_spent ?? "na"}`,
            source_field: state === "paid" ? "issue_date" : "spent_to_date",
            valid_at: payDate,
            published_at: null,
            observed_at,
            processed_at,
            status: state,
            confidence: state === "paid" ? "high" : "medium",
            require_valid: false,
          },
          { run_id, processed_at },
        ),
      );
    }
  }

  return out;
}

/**
 * Attach civic_events to a lifecycle payload for the production /contract-lifecycle path.
 * Pure; does not invent observation clocks.
 */
export function attachMoneyCivicEvents(lifecycle, noticeRow = null, meta = {}) {
  if (!lifecycle || typeof lifecycle !== "object") return lifecycle;
  const civic_events = mapMoneyLifecycleToCivic(lifecycle, noticeRow, meta);
  return { ...lifecycle, civic_events };
}

/**
 * Coverage metric: share of procurement lifecycles that emit ≥1 Money civic event.
 *
 * money_spine_adapter_coverage = notices_with_≥1_money_civic_event
 *                              / procurement_notices_with_lifecycle
 *
 * @param {Array<{ lifecycle: object, notice?: object }>} pairs
 * @returns {{ coverage: number, with_events: number, with_lifecycle: number, kinds: object }}
 */
export function moneySpineAdapterCoverage(pairs = []) {
  let with_lifecycle = 0;
  let with_events = 0;
  const kinds = {
    "procurement.notice_published": 0,
    "procurement.award_registered": 0,
    "procurement.payment": 0,
  };
  for (const pair of pairs) {
    const lifecycle = pair?.lifecycle;
    if (!lifecycle || !Array.isArray(lifecycle.timeline) || lifecycle.timeline.length === 0) {
      continue;
    }
    with_lifecycle += 1;
    const events = mapMoneyLifecycleToCivic(lifecycle, pair.notice || null, pair.meta || {});
    if (events.length >= 1) with_events += 1;
    for (const e of events) {
      if (Object.prototype.hasOwnProperty.call(kinds, e.event_kind)) {
        kinds[e.event_kind] += 1;
      }
    }
  }
  return {
    coverage: with_lifecycle === 0 ? 0 : with_events / with_lifecycle,
    with_events,
    with_lifecycle,
    kinds,
  };
}
