/**
 * Vendor pursuit-decision state (procurement-pursuit-decision, Card "PPD-06").
 *
 * A vendor who has already reviewed an opportunity can record the judgment
 * they reached -- under review, pursuing, passed, or a partnering candidate
 * -- with an optional structured reason and a short note, so a returning
 * vendor never re-derives a decision they already made. This is the vendor's
 * own strategic judgment: it is recorded for that vendor alone, it is never a
 * published fact, it is never a signal about the procurement, and it never
 * ranks, scores, or filters anything beyond the recording vendor's own view.
 *
 * Storage follows the same private, per-browser, no-server-round-trip
 * convention already established by search_recent_history.mjs: a caller
 * hands in a Storage-like `store` (getItem/setItem), records round-trip
 * through a schema-checked JSON envelope, and a blocked, missing, or
 * malformed store degrades to "nothing recorded" rather than a broken page.
 * Two different `store` instances are two different vendors' scopes -- this
 * module never shares state across them and never reaches for a shared or
 * server-side store of its own.
 *
 * `matter_ref` reuses the exact identity buildProcurementAlertAtom() and
 * buildPursuitSnapshot() already resolve a row to (procurement_id, or
 * request_id when no procurement object exists yet) -- no second identity
 * scheme for the same matter.
 *
 * Negative rule: never infer a decision the vendor did not record, never
 * expose one vendor's recorded state to another, and never let a recorded
 * decision affect the order, count, or membership of any list. This module
 * exports no ranking, scoring, sorting, or filtering function.
 */

export const PROCUREMENT_PURSUIT_STATE_SCHEMA = "cityscroll.procurement_pursuit_state.v1";
export const PURSUIT_STATE_STORAGE_KEY = "crol_procurement_pursuit_state_v1";

/** Bounded per-vendor retention -- generous relative to search history's ten,
 * since a vendor may be tracking many opportunities at once, but still finite
 * so a browser store can never grow without limit. */
export const PURSUIT_STATE_RECORD_LIMIT = 300;

/** The closed decision set (rule 1). Nothing outside this list is a decision
 * this module will record. */
export const PURSUIT_DECISIONS = Object.freeze([
  "under_review",
  "pursuing",
  "passed",
  "partnering_candidate",
]);

/** The closed, optional structured-reason vocabulary (rule 2). */
export const PURSUIT_REASON_CODES = Object.freeze([
  "capability_fit",
  "capacity",
  "timing",
  "amount",
  "certification",
  "relationship",
  "other",
]);

/** The one provenance token every pursuit-state record carries -- the same
 * house convention procurement_preference_set.mjs's own "user-supplied"
 * token follows, and deliberately never procurement_pursuit_snapshot.mjs's
 * own underscore-spelled PURSUIT_FIELD_STATUS.USER_PROVIDED. */
export const PURSUIT_STATE_PROVENANCE_LABEL = "user-supplied";

/**
 * The registers a pursuit-state value can be presented in, and the two it
 * must never be folded into. A renderer that reuses PUBLISHED_FACT or
 * PROCUREMENT_SIGNAL for a pursuit-state value has broken rule 5 of this
 * card, whatever wording it uses.
 */
export const PURSUIT_STATE_REGISTER = Object.freeze({
  PERSONAL: "personal-state",
  PUBLISHED_FACT: "published-fact",
  PROCUREMENT_SIGNAL: "procurement-signal",
});

/** True only for this module's own provenance token. */
export function isPursuitStateProvenanceLabel(label) {
  return label === PURSUIT_STATE_PROVENANCE_LABEL;
}

/** True only for this module's own personal-state register token. */
export function isPersonalStateRegisterLabel(label) {
  return label === PURSUIT_STATE_REGISTER.PERSONAL;
}

export function isKnownPursuitDecision(value) {
  return PURSUIT_DECISIONS.includes(value);
}

export function isKnownPursuitReasonCode(value) {
  return PURSUIT_REASON_CODES.includes(value);
}

const MAX_NOTE_LENGTH = 500;
const MAX_MATTER_REF_LENGTH = 200;

function cleanText(value, max) {
  const s = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unknownKey(candidate, allowed) {
  return Object.keys(candidate).some((key) => !allowed.includes(key));
}

/**
 * The matter identity this module keys on, read the same way the alert atom
 * and pursuit snapshot already resolve a row's identity -- procurement_id
 * first, then request_id -- so a decision recorded against a row lines up
 * with that same row wherever it later resurfaces. A caller-supplied
 * `matter_ref` field (when a caller already resolved one) always wins.
 */
export function matterRefFromRow(row = {}) {
  const r = row || {};
  return cleanText(r.matter_ref, MAX_MATTER_REF_LENGTH)
    || cleanText(r.procurement_id, MAX_MATTER_REF_LENGTH)
    || cleanText(r.request_id, MAX_MATTER_REF_LENGTH)
    || null;
}

/** The browser store, or null when the browser refuses to hand one over --
 * fails soft exactly as search_recent_history.mjs's own default storage
 * getter does. */
export function defaultPursuitStateStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readStoredValue(store) {
  try {
    return store?.getItem?.(PURSUIT_STATE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

const RECORD_KEYS = Object.freeze(["matter_ref", "decision", "reason_code", "note", "recorded_at", "provenance"]);

/**
 * Validate one record already sitting in storage against the exact same
 * closed vocabularies a fresh write is held to (normalizeStoredRecord is the
 * read-side twin of recordPursuitDecision's write-side validation) -- a
 * hand-edited or legacy store can never resurface a decision, reason, or
 * provenance value outside what this module itself could ever have written.
 */
function normalizeStoredRecord(candidate) {
  if (!plainObject(candidate)) return null;
  if (unknownKey(candidate, RECORD_KEYS)) return null;
  const matterRef = cleanText(candidate.matter_ref, MAX_MATTER_REF_LENGTH);
  if (!matterRef) return null;
  if (!isKnownPursuitDecision(candidate.decision)) return null;
  if (!isPursuitStateProvenanceLabel(candidate.provenance)) return null;
  const recordedAt = cleanText(candidate.recorded_at, 40);
  if (!recordedAt || Number.isNaN(Date.parse(recordedAt))) return null;
  const reasonCode = isKnownPursuitReasonCode(candidate.reason_code) ? candidate.reason_code : null;
  const note = candidate.note == null ? null : cleanText(candidate.note, MAX_NOTE_LENGTH);
  return {
    matter_ref: matterRef,
    decision: candidate.decision,
    reason_code: reasonCode,
    note,
    recorded_at: recordedAt,
    provenance: PURSUIT_STATE_PROVENANCE_LABEL,
  };
}

function readAllRecords(store) {
  const raw = readStoredValue(store);
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!plainObject(parsed) || parsed.schema !== PROCUREMENT_PURSUIT_STATE_SCHEMA || !Array.isArray(parsed.records)) {
    return [];
  }
  const valid = [];
  for (const candidate of parsed.records) {
    const record = normalizeStoredRecord(candidate);
    if (record) valid.push(record);
  }
  return valid;
}

function writeAllRecords(store, records) {
  try {
    store.setItem(
      PURSUIT_STATE_STORAGE_KEY,
      JSON.stringify({
        schema: PROCUREMENT_PURSUIT_STATE_SCHEMA,
        records: records.slice(0, PURSUIT_STATE_RECORD_LIMIT),
      }),
    );
    return true;
  } catch {
    // A missing, blocked, or full store loses the record, not the page.
    return false;
  }
}

/**
 * Record (or overwrite) the vendor's own pursuit decision for one matter.
 * Rejects -- returns null, storage left unchanged -- when `matter_ref` is
 * empty or `decision` is not one of PURSUIT_DECISIONS; there is no partial
 * decision to preserve for a closed-vocabulary field with no valid value. An
 * unrecognized `reason_code` is dropped to null rather than failing the whole
 * write, since the decision itself is still real. `provenance` is always
 * forced to this module's own token regardless of what the caller passed, so
 * a caller can never mislabel a record as something else's fact.
 *
 * Always overwrites any prior record for the same matter_ref: a vendor's most
 * recent judgment about a matter replaces their last one rather than
 * accumulating a history (rule: "overwrites the vendor's prior record").
 */
export function recordPursuitDecision(store, record = {}, { now = new Date() } = {}) {
  const r = record || {};
  const matterRef = cleanText(r.matter_ref, MAX_MATTER_REF_LENGTH);
  if (!matterRef || !isKnownPursuitDecision(r.decision)) return null;

  let recordedAt;
  try {
    recordedAt = new Date(r.recorded_at ?? now).toISOString();
  } catch {
    return null;
  }
  if (Number.isNaN(Date.parse(recordedAt))) return null;

  const stored = {
    matter_ref: matterRef,
    decision: r.decision,
    reason_code: isKnownPursuitReasonCode(r.reason_code) ? r.reason_code : null,
    note: r.note == null ? null : cleanText(r.note, MAX_NOTE_LENGTH),
    recorded_at: recordedAt,
    provenance: PURSUIT_STATE_PROVENANCE_LABEL,
  };

  const existing = readAllRecords(store).filter((entry) => entry.matter_ref !== matterRef);
  const next = [stored, ...existing].slice(0, PURSUIT_STATE_RECORD_LIMIT);
  return writeAllRecords(store, next) ? stored : null;
}

/**
 * The vendor's own recorded decision for one matter, or null when they never
 * recorded one -- never inferred, never defaulted to a decision.
 */
export function pursuitStateFor(store, matterRef) {
  const key = cleanText(matterRef, MAX_MATTER_REF_LENGTH);
  if (!key) return null;
  return readAllRecords(store).find((entry) => entry.matter_ref === key) || null;
}

/** Forget one matter's recorded decision immediately. Returns the resulting
 * record list. */
export function clearPursuitDecision(store, matterRef) {
  const key = cleanText(matterRef, MAX_MATTER_REF_LENGTH);
  if (!key) return readAllRecords(store);
  const next = readAllRecords(store).filter((entry) => entry.matter_ref !== key);
  return writeAllRecords(store, next) ? next : readAllRecords(store);
}

const DECISION_LABEL = Object.freeze({
  under_review: "Under review",
  pursuing: "Pursuing",
  passed: "Passed",
  partnering_candidate: "Partnering candidate",
});

const REASON_LABEL = Object.freeze({
  capability_fit: "capability fit",
  capacity: "capacity",
  timing: "timing",
  amount: "amount",
  certification: "certification",
  relationship: "relationship",
  other: "other",
});

/**
 * Readable wording for a resurfacing matter -- always framed as the vendor's
 * own note ("You marked this..."), never as a published fact or a signal
 * about the procurement. Returns null for anything that is not a genuine
 * record this module could have produced (an unknown decision, or a
 * provenance token that is not this module's own) -- a renderer can trust a
 * non-null result without re-validating it.
 */
export function pursuitBadge(record) {
  if (!record || !isKnownPursuitDecision(record.decision) || !isPursuitStateProvenanceLabel(record.provenance)) {
    return null;
  }
  const decisionLabel = DECISION_LABEL[record.decision];
  const reasonLabel = record.reason_code ? REASON_LABEL[record.reason_code] : null;
  const wording = reasonLabel
    ? `You marked this ${decisionLabel.toLowerCase()} (${reasonLabel}).`
    : `You marked this ${decisionLabel.toLowerCase()}.`;
  return {
    schema: PROCUREMENT_PURSUIT_STATE_SCHEMA,
    register: PURSUIT_STATE_REGISTER.PERSONAL,
    provenance: PURSUIT_STATE_PROVENANCE_LABEL,
    decision: record.decision,
    label: decisionLabel,
    reason_code: record.reason_code || null,
    reason_label: reasonLabel,
    note: record.note || null,
    recorded_at: record.recorded_at || null,
    text: wording,
  };
}

/**
 * Decorate rows with the vendor's own recorded pursuit state, for a later
 * alert or listing surface to resurface (rule 3 / A3). Every row keeps its
 * original position and count -- this performs no ranking, scoring, or
 * filtering. A row whose matter identity does not resolve, or that carries no
 * recorded decision, is returned as the exact same reference (not even a
 * `pursuit_state` key is added), so a caller can never mistake "key absent"
 * for a signal and this function can never be mistaken for one that reorders
 * or drops rows.
 */
export function resurfacePursuitState(rows, store) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    const matterRef = matterRefFromRow(row);
    if (!matterRef) return row;
    const badge = pursuitBadge(pursuitStateFor(store, matterRef));
    if (!badge) return row;
    return { ...row, pursuit_state: badge };
  });
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

/**
 * Render one badge as a self-contained inline note. Callers embed this next
 * to a resurfacing row or alert item -- never inside a published-fact or
 * match-reason list (the same separation procurement_pursuit_snapshot.mjs's
 * own preference-reasons block keeps from its match-reasons block). Returns
 * "" for a null badge so a caller can splice this in unconditionally.
 */
export function renderPursuitStateNoteHtml(badge) {
  if (!badge) return "";
  return `<p class="pursuit-state-note" data-pursuit-state-register="${esc(badge.register)}" data-pursuit-state-provenance="${esc(badge.provenance)}" data-pursuit-state-decision="${esc(badge.decision)}">${esc(badge.text)}</p>`;
}
