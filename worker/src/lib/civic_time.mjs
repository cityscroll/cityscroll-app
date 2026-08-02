/**
 * Civic-time event envelope — pure library seam.
 *
 * Clocks: valid (event), published, observed, processed — never invent one from another.
 * See docs/adr/civic-time-event-contract.md and docs/digest-time-ontology.md.
 *
 * Hashing uses a pure SHA-256 (not node:crypto) so the Worker deploys without
 * nodejs_compat. Digests match Web Crypto / node:crypto SHA-256 hex output.
 */

export const CIVIC_TIME_MATERIALIZER = "civic_time_fixture_v1";
export const CIVIC_TIME_MATERIALIZER_VERSION = "1.0.0";
export const CIVIC_TIME_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Pure SHA-256 (sync) — Workers runtime has no node:crypto without compat flag.
// crypto.subtle.digest is async; this pure lib must stay sync for mapCivicEvent.
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(n, x) {
  return (x >>> n) | (x << (32 - n));
}

/** @param {string} text @returns {string} lowercase hex SHA-256 */
function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  // padded length: message + 0x80 + zeros + 8-byte length, multiple of 64
  let padLen = bytes.length + 1 + 8;
  const rem = padLen % 64;
  if (rem !== 0) padLen += 64 - rem;
  const padded = new Uint8Array(padLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // big-endian 64-bit bit length in last 8 bytes (we only need low 32 for short strings)
  const view = new DataView(padded.buffer);
  // high 32 bits of bit length (always 0 for inputs < 512 MiB)
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let i = 0; i < padLen; i += 64) {
    for (let j = 0; j < 16; j++) {
      w[j] = view.getUint32(i + j * 4, false);
    }
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(7, w[j - 15]) ^ rotr(18, w[j - 15]) ^ (w[j - 15] >>> 3);
      const s1 = rotr(17, w[j - 2]) ^ rotr(19, w[j - 2]) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[j] + w[j]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return [...out].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bounded event-kind registry (closed list for this card). */
export const EVENT_KIND_REGISTRY = Object.freeze({
  // Money / procurement
  "procurement.notice_published": {
    lens: "money",
    description: "City Record procurement notice publication",
  },
  "procurement.solicitation_opened": {
    lens: "money",
    description: "PASSPort RFx release / solicitation open for responses",
  },
  "procurement.solicitation_addenda": {
    lens: "money",
    description: "PASSPort RFx addendum or package revision (only when a publisher date exists)",
  },
  "procurement.solicitation_due": {
    lens: "money",
    description: "PASSPort RFx response due date",
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
  // PASSPort RFx production spine (open → addenda → due; award reuses notice/registered)
  rfx_opened: "procurement.solicitation_opened",
  rfx_addenda: "procurement.solicitation_addenda",
  rfx_due: "procurement.solicitation_due",
});

/** Event kinds emitted from matched PASSPort RFx detail (solicitation production spine). */
export const RFX_PRODUCTION_EVENT_KINDS = Object.freeze([
  "procurement.solicitation_opened",
  "procurement.solicitation_addenda",
  "procurement.solicitation_due",
]);

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
  return sha256Hex(JSON.stringify(canonical));
}

/**
 * Stable event id from subject + kind + source revision (not from processing time).
 */
export function makeEventId({ subject_ref, event_kind, source_revision }) {
  const raw = `${subject_ref}|${event_kind}|${source_revision}`;
  const digest = sha256Hex(raw).slice(0, 24);
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
  // Checkbook / PASSPort often emit US slash dates, optionally with a clock:
  // "07/22/2024", "7/28/2026 9:00:00 AM".
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
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

  // Prefer first-class matter spines (agenda→matter→action→vote→attachment)
  // when present; fall back to nested agenda_items for older fixtures.
  const spines = Array.isArray(record.spines) && record.spines.length
    ? record.spines
    : null;

  if (spines) {
    for (const spine of spines) {
      const itemId = spine.agenda_item_id || spine.matter_id || "item";
      const actionStage = (spine.stages || []).find((s) => s.kind === "action");
      const voteStage = (spine.stages || []).find((s) => s.kind === "vote");
      const actionName = actionStage?.action_name || null;
      if (actionStage?.matched && actionName) {
        out.push(
          mapCivicEvent(
            {
              event_kind: "meetings.agenda_item_action",
              subject_ref,
              source_record_ref: `legistar:EventItems/${itemId}`,
              source_revision: `legistar:item:${itemId}:action:${actionName}`,
              source_field: "EventItemActionName",
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
      }
      const votes = voteStage?.votes || [];
      if (voteStage?.matched && votes.length) {
        out.push(
          mapCivicEvent(
            {
              event_kind: "meetings.roll_call_vote",
              subject_ref,
              source_record_ref: `legistar:EventItems/${itemId}/Votes`,
              source_revision: `legistar:item:${itemId}:votes:n${votes.length}`,
              source_field: "Votes",
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
      }
    }
    return out;
  }

  for (const item of record.agenda_items || []) {
    const itemId = item.agenda_item_id || item.event_item_id || item.id || item.title || "item";
    // Action lives on the matter card in the production assembly shape;
    // older civic-time fixtures put it on the agenda item itself.
    const matterAction = (item.matters || []).map((m) => m.outcome || m.passed || m.status).find(Boolean);
    const actionName = item.action_name || item.action || item.status || matterAction || null;
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
 * Resolve matched PASSPort RFx detail from a lifecycle payload.
 * Prefer root rfx_detail; fall back to the solicitation stage rfx block.
 * @returns {{ detail: object, join_method: string|null } | null}
 */
export function matchedRfxDetail(lifecycle) {
  if (!lifecycle || typeof lifecycle !== "object") return null;
  const root = lifecycle.rfx_detail;
  if (root && root.status === "matched" && root.detail && typeof root.detail === "object") {
    return { detail: root.detail, join_method: root.join_method || null };
  }
  const timeline = Array.isArray(lifecycle.timeline) ? lifecycle.timeline : [];
  for (const entry of timeline) {
    if (!entry || entry.stage !== "solicitation") continue;
    const rfx = entry.rfx;
    if (rfx && rfx.status === "matched" && rfx.detail && typeof rfx.detail === "object") {
      return { detail: rfx.detail, join_method: rfx.join_method || entry.detail?.rfx_join_method || null };
    }
    if (entry.detail?.rfx && typeof entry.detail.rfx === "object") {
      return {
        detail: entry.detail.rfx,
        join_method: entry.detail.rfx_join_method || null,
      };
    }
  }
  return null;
}

/**
 * Map matched PASSPort RFx fields into solicitation production civic-time events.
 *
 * Publisher clocks only (never invent):
 *   release_date → procurement.solicitation_opened (valid_at)
 *   due_date     → procurement.solicitation_due (valid_at)
 *   addenda_*    → procurement.solicitation_addenda when a date field is present
 *
 * public_rfx_data publishes no addenda date columns — addenda stays registered but
 * unemitted until a publisher field exists. Award on the chain reuses City Record
 * notice_published / award_registered from the main money adapter.
 *
 * @param {object} lifecycle
 * @param {object} [noticeRow]
 * @param {object} [meta]
 * @returns {object[]}
 */
export function mapPassportRfxToCivic(lifecycle, noticeRow = null, meta = {}) {
  const notice = noticeRow || {};
  const noticeId = notice.request_id || lifecycle?.request_id || null;
  const observed_at = meta.observed_at ?? null;
  const processed_at = meta.processed_at ?? null;
  const run_id = meta.run_id ?? "money-lifecycle";
  const matched = matchedRfxDetail(lifecycle);
  if (!matched) return [];

  const detail = matched.detail;
  const epin = detail.epin || detail.epin_norm || null;
  const rfpId = detail.rfp_id || null;
  const sourceKey = epin || rfpId || noticeId;
  if (!sourceKey) return [];

  const subject_ref = noticeId
    ? `notice:${noticeId}`
    : epin
      ? `pin:${epin}`
      : null;
  if (!subject_ref) return [];

  const source_record_ref = `passport-rfx:${sourceKey}`;
  const out = [];

  const releaseDate = dayStamp(detail.release_date);
  if (releaseDate) {
    out.push(
      mapCivicEvent(
        {
          event_kind: "procurement.solicitation_opened",
          subject_ref,
          source_record_ref,
          source_revision: `rfx:${sourceKey}:release:${releaseDate}`,
          source_field: "release_date",
          valid_at: releaseDate,
          published_at: releaseDate,
          observed_at,
          processed_at,
          status: detail.rfx_status || "opened",
          confidence: "high",
          require_valid: false,
        },
        { run_id, processed_at },
      ),
    );
  }

  // Addenda: only when an explicit publisher date is present on the joined row.
  // public_rfx_data has no addenda columns today — this path stays dark until one ships.
  const addendaRaw =
    detail.addenda_date ||
    detail.addendum_date ||
    detail.last_addenda_date ||
    detail.amendment_date ||
    null;
  const addendaDate = dayStamp(addendaRaw);
  if (addendaDate) {
    out.push(
      mapCivicEvent(
        {
          event_kind: "procurement.solicitation_addenda",
          subject_ref,
          source_record_ref,
          source_revision: `rfx:${sourceKey}:addenda:${addendaDate}`,
          source_field: "addenda_date",
          valid_at: addendaDate,
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
  }

  const dueDate = dayStamp(detail.due_date);
  if (dueDate) {
    out.push(
      mapCivicEvent(
        {
          event_kind: "procurement.solicitation_due",
          subject_ref,
          source_record_ref,
          source_revision: `rfx:${sourceKey}:due:${dueDate}`,
          source_field: "due_date",
          valid_at: dueDate,
          published_at: null,
          observed_at,
          processed_at,
          status: detail.rfx_status || "due",
          confidence: "high",
          require_valid: false,
        },
        { run_id, processed_at },
      ),
    );
  }

  return out;
}

/**
 * Map an assembled contract lifecycle (Checkbook + optional PASSPort) into
 * civic-time envelopes for Money event-kinds.
 *
 * Stage → kind:
 *   solicitation | award (matched) → procurement.notice_published
 *   registered (matched)           → procurement.award_registered
 *   payment (matched, honest state)→ procurement.payment
 *   matched PASSPort RFx detail    → solicitation_opened / addenda / due
 *
 * Unmatched / ambiguous / unknown / not_applicable / passed stages emit nothing.
 * payment_state "unavailable" never invents a $0 payment event.
 * RFx addenda never invents a date when public_rfx_data omits addenda columns.
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

  // Solicitation production spine from PASSPort RFx (open → addenda → due).
  // Award continues to come from City Record / registration stages above.
  for (const ev of mapPassportRfxToCivic(lifecycle, noticeRow, meta)) {
    out.push(ev);
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
    "procurement.solicitation_opened": 0,
    "procurement.solicitation_addenda": 0,
    "procurement.solicitation_due": 0,
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

/**
 * Coverage metric for the PASSPort RFx solicitation production spine.
 *
 * rfx_spine_adapter_coverage =
 *   lifecycles_with_matched_RFx_that_emit_≥1_RFx_production_event
 *   / lifecycles_with_matched_RFx
 *
 * RFx production kinds: solicitation_opened, solicitation_addenda, solicitation_due.
 * Baseline before this adapter is 0 (RFx detail was UI-only).
 *
 * @param {Array<{ lifecycle: object, notice?: object, meta?: object }>} pairs
 * @returns {{
 *   coverage: number,
 *   with_rfx: number,
 *   with_rfx_events: number,
 *   open_due_pair_rate: number,
 *   with_open_and_due: number,
 *   with_open_and_due_dates: number,
 *   kinds: object,
 *   gaps: { addenda_not_published: number }
 * }}
 */
export function rfxSpineAdapterCoverage(pairs = []) {
  let with_rfx = 0;
  let with_rfx_events = 0;
  let with_open_and_due_dates = 0;
  let with_open_and_due = 0;
  let addenda_not_published = 0;
  const kinds = {
    "procurement.solicitation_opened": 0,
    "procurement.solicitation_addenda": 0,
    "procurement.solicitation_due": 0,
  };
  const rfxKindSet = new Set(RFX_PRODUCTION_EVENT_KINDS);

  for (const pair of pairs) {
    const lifecycle = pair?.lifecycle;
    const matched = matchedRfxDetail(lifecycle);
    if (!matched) continue;
    with_rfx += 1;

    const detail = matched.detail;
    const hasOpenDate = Boolean(dayStamp(detail.release_date));
    const hasDueDate = Boolean(dayStamp(detail.due_date));
    if (hasOpenDate && hasDueDate) with_open_and_due_dates += 1;

    // Public dump has no addenda date — count as class-(b) gap when RFx is matched.
    const hasAddendaDate = Boolean(
      dayStamp(
        detail.addenda_date ||
          detail.addendum_date ||
          detail.last_addenda_date ||
          detail.amendment_date ||
          null,
      ),
    );
    if (!hasAddendaDate) addenda_not_published += 1;

    const events = mapPassportRfxToCivic(lifecycle, pair.notice || null, pair.meta || {});
    const rfxEvents = events.filter((e) => rfxKindSet.has(e.event_kind));
    if (rfxEvents.length >= 1) with_rfx_events += 1;

    let hasOpen = false;
    let hasDue = false;
    for (const e of rfxEvents) {
      if (Object.prototype.hasOwnProperty.call(kinds, e.event_kind)) {
        kinds[e.event_kind] += 1;
      }
      if (e.event_kind === "procurement.solicitation_opened") hasOpen = true;
      if (e.event_kind === "procurement.solicitation_due") hasDue = true;
    }
    if (hasOpen && hasDue) with_open_and_due += 1;
  }

  return {
    coverage: with_rfx === 0 ? 0 : with_rfx_events / with_rfx,
    with_rfx,
    with_rfx_events,
    open_due_pair_rate:
      with_open_and_due_dates === 0 ? 0 : with_open_and_due / with_open_and_due_dates,
    with_open_and_due,
    with_open_and_due_dates,
    kinds,
    gaps: { addenda_not_published },
  };
}

/**
 * Four civic clock families for completeness scoring.
 * "event" is filled when any valid clock is present (valid_at or range).
 */
export const TEMPORAL_CLOCK_FAMILIES = Object.freeze([
  "event",
  "publication",
  "observed",
  "processed",
]);

/**
 * Product spines → source-contract ids that feed their civic-time adapters.
 * Used to join temporal completeness to source health so gaps are actionable.
 */
export const SPINE_SOURCE_CONTRACTS = Object.freeze({
  money: Object.freeze([
    "city-record",
    "checkbook-contracts",
    "checkbook-spending",
    "passport-public-contracts",
    "passport-public-rfx",
    "ocp-recent-contract-awards",
  ]),
  rules: Object.freeze(["city-record", "nyc-rules-rss"]),
  land: Object.freeze(["city-record", "zap-api-outcomes", "zap-projects"]),
  meetings: Object.freeze([
    "city-record",
    "nyc-council-legistar",
    "city-council-meetings-open-data",
  ]),
});

/** Map source_record_ref prefix → source-contract id (best-effort). */
export const SOURCE_RECORD_PREFIX_TO_CONTRACT = Object.freeze({
  "city-record": "city-record",
  checkbook: "checkbook-contracts",
  "checkbook-spending": "checkbook-spending",
  "checkbook-contracts": "checkbook-contracts",
  passport: "passport-public-contracts",
  "passport-rfx": "passport-public-rfx",
  legistar: "nyc-council-legistar",
  "zap-api": "zap-api-outcomes",
  "nyc-rules": "nyc-rules-rss",
  ocp: "ocp-recent-contract-awards",
});

function clockValuePresent(value) {
  return value != null && value !== "";
}

/**
 * Per-event presence of the four clock families.
 * @returns {{ event: boolean, publication: boolean, observed: boolean, processed: boolean }}
 */
export function eventClockPresence(event) {
  if (!event || typeof event !== "object") {
    return { event: false, publication: false, observed: false, processed: false };
  }
  const hasEvent =
    clockValuePresent(event.valid_at) ||
    clockValuePresent(event.valid_from) ||
    clockValuePresent(event.valid_to);
  return {
    event: hasEvent,
    publication: clockValuePresent(event.published_at),
    observed: clockValuePresent(event.observed_at),
    processed: clockValuePresent(event.processed_at),
  };
}

/**
 * Fraction of the four clock families present on one event (0..1).
 */
export function eventTemporalCompleteness(event) {
  const presence = eventClockPresence(event);
  let filled = 0;
  for (const clock of TEMPORAL_CLOCK_FAMILIES) {
    if (presence[clock]) filled += 1;
  }
  return filled / TEMPORAL_CLOCK_FAMILIES.length;
}

export function spineForEventKind(event_kind) {
  const meta = EVENT_KIND_REGISTRY[event_kind];
  return meta?.lens ?? null;
}

/**
 * Best-effort source-contract id from source_record_ref ("prefix:rest").
 */
export function contractIdFromSourceRecordRef(source_record_ref) {
  if (source_record_ref == null || source_record_ref === "") return null;
  const raw = String(source_record_ref);
  const colon = raw.indexOf(":");
  const prefix = colon === -1 ? raw : raw.slice(0, colon);
  if (Object.prototype.hasOwnProperty.call(SOURCE_RECORD_PREFIX_TO_CONTRACT, prefix)) {
    return SOURCE_RECORD_PREFIX_TO_CONTRACT[prefix];
  }
  return prefix || null;
}

function emptyClockCounts() {
  return { event: 0, publication: 0, observed: 0, processed: 0 };
}

function ratesFromCounts(counts, total) {
  const rates = {};
  for (const clock of TEMPORAL_CLOCK_FAMILIES) {
    rates[clock] = total === 0 ? 0 : counts[clock] / total;
  }
  return rates;
}

function normalizeSourceHealth(sourceHealth) {
  /** @type {Map<string, object>} */
  const byId = new Map();
  if (!sourceHealth) return byId;
  if (Array.isArray(sourceHealth)) {
    for (const row of sourceHealth) {
      if (row && row.id) byId.set(String(row.id), row);
    }
    return byId;
  }
  if (typeof sourceHealth === "object") {
    for (const [id, row] of Object.entries(sourceHealth)) {
      if (row && typeof row === "object") {
        byId.set(id, { id, ...row });
      } else {
        byId.set(id, { id, status: row });
      }
    }
  }
  return byId;
}

function sourceHealthStatus(row) {
  if (!row) return "unknown";
  const status = row.status != null ? String(row.status) : null;
  if (status === "disabled") return "disabled";
  if (status === "live" || status === "build-time" || status === "manual") {
    if (row.fetch_status === "error" || row.fetch_status === "unavailable") return "unhealthy";
    if (row.stale === true) return "stale";
    return "live";
  }
  if (row.fetch_status === "error" || row.fetch_status === "unavailable") return "unhealthy";
  if (status) return status;
  return "unknown";
}

/**
 * Classify why a clock gap is actionable given joined source health.
 * - adapter_gap: live sources feed the spine but the clock is missing → map more fields
 * - source_disabled: every known source for the spine is disabled
 * - source_unhealthy: sources are failing/stale
 * - source_unknown: no source-health rows joined
 */
export function classifyTemporalGap({ fill_rate, source_rows = [] }) {
  if (fill_rate >= 1) return null;
  if (!source_rows.length) {
    return {
      kind: "source_unknown",
      action: "Attach source-contract health for this spine so the gap is attributable.",
    };
  }
  const statuses = source_rows.map((r) => sourceHealthStatus(r));
  if (statuses.every((s) => s === "disabled")) {
    return {
      kind: "source_disabled",
      action: "Source contracts for this spine are disabled — completeness cannot improve until a live feed is restored or an alternate source is joined.",
    };
  }
  if (statuses.some((s) => s === "unhealthy" || s === "stale")) {
    return {
      kind: "source_unhealthy",
      action: "Upstream source health is degraded — restore fetch success before treating missing clocks as adapter debt.",
    };
  }
  if (statuses.some((s) => s === "live")) {
    return {
      kind: "adapter_gap",
      action: "Live sources feed this spine but the clock is absent on some events — extend the spine adapter to map the publisher field when present.",
    };
  }
  return {
    kind: "source_unknown",
    action: "Source-health status is unrecognized; inspect the source-contract rows for this spine.",
  };
}

/**
 * Temporal completeness scorecard.
 *
 * Named headline metric: **temporal_completeness_rate**
 *   = mean over events of (filled_clock_families / 4)
 * where clock families are event (valid_at|range), publication, observed, processed.
 *
 * Also reports per-spine and per-clock fill rates, and joins optional source_health
 * so incomplete clocks are labeled adapter_gap vs source_disabled / unhealthy.
 *
 * @param {object[]} events - civic-time envelopes (or fixture-mapped events)
 * @param {object} [opts]
 * @param {object|object[]} [opts.source_health] - source-contract rows (id + status [+ fetch_status/stale])
 * @param {number} [opts.gap_threshold=1] - report gap when fill_rate < threshold (default: any miss)
 * @returns {object} scorecard
 */
export function temporalCompletenessScorecard(events = [], opts = {}) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === "object") : [];
  const healthById = normalizeSourceHealth(opts.source_health);
  const gapThreshold =
    typeof opts.gap_threshold === "number" && Number.isFinite(opts.gap_threshold)
      ? opts.gap_threshold
      : 1;

  const overallCounts = emptyClockCounts();
  let completenessSum = 0;
  /** @type {Record<string, { event_count: number, counts: object, kinds: Record<string, number> }>} */
  const bySpine = {};

  for (const event of list) {
    const presence = eventClockPresence(event);
    completenessSum += eventTemporalCompleteness(event);
    for (const clock of TEMPORAL_CLOCK_FAMILIES) {
      if (presence[clock]) overallCounts[clock] += 1;
    }

    const spine = spineForEventKind(event.event_kind) || "unknown";
    if (!bySpine[spine]) {
      bySpine[spine] = { event_count: 0, counts: emptyClockCounts(), kinds: {} };
    }
    const bucket = bySpine[spine];
    bucket.event_count += 1;
    for (const clock of TEMPORAL_CLOCK_FAMILIES) {
      if (presence[clock]) bucket.counts[clock] += 1;
    }
    const kind = event.event_kind || "unknown";
    bucket.kinds[kind] = (bucket.kinds[kind] || 0) + 1;
  }

  const event_count = list.length;
  const temporal_completeness_rate = event_count === 0 ? 0 : completenessSum / event_count;
  const clock_fill_rates = ratesFromCounts(overallCounts, event_count);

  const spines = {};
  const gaps = [];

  for (const spine of Object.keys(bySpine).sort()) {
    const bucket = bySpine[spine];
    const rates = ratesFromCounts(bucket.counts, bucket.event_count);
    const contractIds = SPINE_SOURCE_CONTRACTS[spine] || [];
    const source_rows = contractIds.map((id) => {
      const row = healthById.get(id);
      if (row) {
        return {
          id,
          status: row.status ?? null,
          fetch_status: row.fetch_status ?? null,
          stale: row.stale === true,
          health: sourceHealthStatus(row),
        };
      }
      return { id, status: null, fetch_status: null, stale: false, health: "unknown" };
    });
    const live_source_count = source_rows.filter((r) => r.health === "live").length;
    const disabled_source_count = source_rows.filter((r) => r.health === "disabled").length;

    spines[spine] = {
      event_count: bucket.event_count,
      temporal_completeness_rate:
        bucket.event_count === 0
          ? 0
          : TEMPORAL_CLOCK_FAMILIES.reduce((sum, c) => sum + rates[c], 0) /
            TEMPORAL_CLOCK_FAMILIES.length,
      clock_fill_rates: rates,
      clock_fill_counts: { ...bucket.counts },
      kinds: { ...bucket.kinds },
      source_contracts: contractIds.slice(),
      source_health: source_rows,
      live_source_count,
      disabled_source_count,
    };

    for (const clock of TEMPORAL_CLOCK_FAMILIES) {
      const fill_rate = rates[clock];
      if (fill_rate < gapThreshold) {
        const classification = classifyTemporalGap({ fill_rate, source_rows });
        gaps.push({
          spine,
          clock,
          fill_rate,
          filled: bucket.counts[clock],
          event_count: bucket.event_count,
          kind: classification?.kind ?? "adapter_gap",
          action: classification?.action ?? null,
          source_health: source_rows,
        });
      }
    }
  }

  // Prefer adapter_gap first (actionable in-repo), then unhealthy, disabled, unknown.
  const kindOrder = { adapter_gap: 0, source_unhealthy: 1, source_stale: 1, source_disabled: 2, source_unknown: 3 };
  gaps.sort((a, b) => {
    const ko = (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9);
    if (ko !== 0) return ko;
    if (a.fill_rate !== b.fill_rate) return a.fill_rate - b.fill_rate;
    return `${a.spine}:${a.clock}`.localeCompare(`${b.spine}:${b.clock}`);
  });

  return {
    metric: "temporal_completeness_rate",
    schema_version: 1,
    event_count,
    temporal_completeness_rate,
    clock_fill_rates,
    clock_fill_counts: { ...overallCounts },
    spines,
    gaps,
    gap_count: gaps.length,
    // Convenience: share of events with every clock family present (stricter than the mean).
    full_clock_rate:
      event_count === 0
        ? 0
        : list.filter((e) => eventTemporalCompleteness(e) === 1).length / event_count,
  };
}

/**
 * Build a minimal source_health map from source_contracts.json `contracts` array.
 * Pure; ignores contracts outside SPINE_SOURCE_CONTRACTS.
 */
export function sourceHealthFromContracts(contracts = []) {
  const wanted = new Set();
  for (const ids of Object.values(SPINE_SOURCE_CONTRACTS)) {
    for (const id of ids) wanted.add(id);
  }
  const out = {};
  for (const c of contracts) {
    if (!c || !c.id || !wanted.has(c.id)) continue;
    out[c.id] = {
      id: c.id,
      status: c.status ?? null,
      kind: c.kind ?? null,
      max_stale_days: c.max_stale_days ?? null,
    };
  }
  return out;
}
