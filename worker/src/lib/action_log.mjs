// Append-only product action data. This is deliberately separate from aggregate
// usage analytics and from the operational watch log: rows preserve a public
// object/method lineage, but never an actor, email, IP, cookie, or session id.

export const ACTION_LOG_SCHEMA_VERSION = "cityscroll.action.v1";

export const ACTION_TYPES = Object.freeze([
  "pins_saved",
  "watch_confirmed",
  "watch_updated",
  "watch_paused",
  "watch_resumed",
  "watch_removed",
  "review_decision",
]);

export const OBJECT_TYPES = Object.freeze(["pin_store", "watch", "entity_pair"]);

export const ACTION_LOG_COLUMNS = Object.freeze([
  "id",
  "schema_version",
  "action_type",
  "object_type",
  "object_id",
  "ts",
  "method",
  "method_version",
  "metadata_json",
]);

const ACTION_SET = new Set(ACTION_TYPES);
const OBJECT_SET = new Set(OBJECT_TYPES);
const SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const OBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const LENSES = new Set(["money", "people", "land", "property", "rules", "meetings", "entity", "award"]);
const SOURCES = new Set(["confirm", "pins", "prefs", "unsubscribe", "review_desk"]);
const FREQUENCIES = new Set(["daily", "weekly"]);
const DECISIONS = new Set(["same", "different", "unresolved"]);

/** Map desk disposition labels onto the privacy-safe action-log decision enum. */
export function actionLogDecisionFromDisposition(decision) {
  const clean = String(decision || "").trim().toLowerCase();
  if (clean === "same" || clean === "different") return clean;
  // Desk "defer" is an opened-but-undecided judgment, not a gold label.
  if (clean === "defer" || clean === "unresolved") return "unresolved";
  return undefined;
}

/**
 * Build a review_decision action-log input from a false-split disposition event.
 * Never accepts actor, note, email, or free text — those stay on the desk evidence table.
 */
export function reviewActionFromDisposition(disposition, opts = {}) {
  if (!disposition || typeof disposition !== "object") return null;
  const decision = actionLogDecisionFromDisposition(disposition.decision);
  if (!decision) return null;
  const pairId = String(disposition.pair_id || disposition.object_id || "").trim();
  if (!pairId || !OBJECT_ID.test(pairId) || pairId.includes("@") || looksLikeNetworkAddress(pairId)) {
    return null;
  }
  return {
    action_type: "review_decision",
    object: { type: "entity_pair", id: pairId },
    method: {
      name: String(opts.methodName || "false_split_desk").trim().toLowerCase() || "false_split_desk",
      version: String(opts.methodVersion || "v1").trim().toLowerCase() || "v1",
    },
    metadata: {
      source: "review_desk",
      decision,
    },
    ts: disposition.created_at || disposition.ts || undefined,
    id: disposition.id || undefined,
  };
}

function enumValue(value, allowed) {
  const clean = String(value || "").trim().toLowerCase();
  return allowed.has(clean) ? clean : undefined;
}

function boundedCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 10000 ? number : undefined;
}

function looksLikeNetworkAddress(value) {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return true;
  return /^(?:[0-9a-f]{0,4}:){2,}[0-9a-f:.]{0,39}$/i.test(value);
}

// Fixed keys only. Keeping arbitrary metadata out is the privacy boundary: a
// future caller cannot accidentally add an address, email, IP, or free text.
export function normalizeActionMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const clean = {};
  const lens = enumValue(value.lens, LENSES);
  const source = enumValue(value.source, SOURCES);
  const freq = enumValue(value.freq, FREQUENCIES);
  const decision = enumValue(value.decision, DECISIONS);
  const itemCount = boundedCount(value.item_count);
  const investigationCount = boundedCount(value.investigation_count);
  if (lens) clean.lens = lens;
  if (source) clean.source = source;
  if (freq) clean.freq = freq;
  if (decision) clean.decision = decision;
  if (typeof value.merge === "boolean") clean.merge = value.merge;
  if (itemCount !== undefined) clean.item_count = itemCount;
  if (investigationCount !== undefined) clean.investigation_count = investigationCount;
  return Object.keys(clean).length ? clean : undefined;
}

export function normalizeActionEvent(input, opts = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const actionType = String(input.action_type || "").trim().toLowerCase();
  const objectType = String(input.object?.type || "").trim().toLowerCase();
  const rawObjectId = input.object?.id == null ? "" : String(input.object.id).trim();
  const method = String(input.method?.name || "").trim().toLowerCase();
  const methodVersion = String(input.method?.version || "").trim().toLowerCase();
  if (!ACTION_SET.has(actionType) || !OBJECT_SET.has(objectType)) return null;
  if (!SLUG_PATTERN.test(method) || !SLUG_PATTERN.test(methodVersion)) return null;
  if (rawObjectId && (
    !OBJECT_ID.test(rawObjectId)
    || rawObjectId.includes("@")
    || looksLikeNetworkAddress(rawObjectId)
  )) return null;

  const ts = String(input.ts || opts.now || new Date().toISOString());
  if (!Number.isFinite(Date.parse(ts))) return null;
  const id = String(opts.id || input.id || crypto.randomUUID());
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)) return null;

  const event = {
    id,
    schema_version: ACTION_LOG_SCHEMA_VERSION,
    action_type: actionType,
    object_type: objectType,
    object_id: rawObjectId || null,
    ts: new Date(ts).toISOString(),
    method,
    method_version: methodVersion,
  };
  const metadata = normalizeActionMetadata(input.metadata);
  if (metadata) event.metadata = metadata;
  return event;
}

/** Fail-soft append: action logging must never block the product mutation. */
export async function appendActionLog(env, input, opts = {}) {
  if (!env?.DB) return false;
  const event = normalizeActionEvent(input, opts);
  if (!event) return false;
  try {
    await env.DB.prepare(
      `INSERT INTO action_log
         (id, schema_version, action_type, object_type, object_id, ts, method, method_version, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      event.id,
      event.schema_version,
      event.action_type,
      event.object_type,
      event.object_id,
      event.ts,
      event.method,
      event.method_version,
      event.metadata ? JSON.stringify(event.metadata) : null,
    ).run();
    return true;
  } catch {
    return false;
  }
}
