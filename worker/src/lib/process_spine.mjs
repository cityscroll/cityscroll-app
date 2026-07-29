const CONFIDENCE = new Set(["confirmed", "review", "unmatched"]);
const REQUIRED = [
  "process_id",
  "project_id",
  "event_id",
  "event_type",
  "source_system",
  "source_key",
  "observed_at",
  "effective_at",
  "actor",
  "amount",
  "parent_event_id",
  "supersedes_event_id",
  "content_hash",
  "join"
];

export const PROCESS_SPINE_SCHEMA_VERSION = "1.0.0";

export function canonicalId(kind, nativeKey) {
  const normalized = String(nativeKey || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new TypeError(`${kind} key is required`);
  return `${kind}:${normalized}`;
}

export function eventId(sourceSystem, sourceKey) {
  return canonicalId("event", `${sourceSystem}:${sourceKey}`);
}

export function validateProcessEvent(event) {
  const missing = REQUIRED.filter((field) => !Object.prototype.hasOwnProperty.call(event, field));
  if (missing.length) throw new TypeError(`process event missing: ${missing.join(", ")}`);
  if (!event.source_key || !event.source_system) throw new TypeError("native source identity is required");
  if (!/^[a-f0-9]{64}$/.test(event.content_hash)) throw new TypeError("content_hash must be sha256");
  if (!CONFIDENCE.has(event.join?.confidence)) throw new TypeError("unknown join confidence");
  if (event.source_system === "nyscr" && event.join.confidence === "confirmed") {
    throw new TypeError("NYSCR metadata candidates require human review");
  }
  return event;
}

export function indexProcessSpine(bundle) {
  const byProcess = new Map();
  const bySource = new Map();
  for (const event of bundle.events || []) {
    validateProcessEvent(event);
    const processEvents = byProcess.get(event.process_id) || [];
    processEvents.push(event);
    byProcess.set(event.process_id, processEvents);
    if (bySource.has(event.source_key)) throw new TypeError(`duplicate source key: ${event.source_key}`);
    bySource.set(event.source_key, event);
  }
  for (const events of byProcess.values()) {
    events.sort((a, b) => a.effective_at.localeCompare(b.effective_at) || a.event_id.localeCompare(b.event_id));
  }
  return { byProcess, bySource };
}

export function processEnvelope(sourceEvent, contentHash, pointers = {}) {
  const event = {
    process_id: canonicalId("process", sourceEvent.process_key),
    project_id: canonicalId("project", sourceEvent.project_key),
    event_id: eventId(sourceEvent.source_system, sourceEvent.source_key),
    event_type: sourceEvent.event_type,
    source_system: sourceEvent.source_system,
    source_key: sourceEvent.source_key,
    observed_at: sourceEvent.observed_at,
    effective_at: sourceEvent.effective_at,
    actor: sourceEvent.actor,
    amount: sourceEvent.amount,
    parent_event_id: pointers.parent_event_id || null,
    supersedes_event_id: pointers.supersedes_event_id || null,
    content_hash: contentHash,
    join: sourceEvent.join,
    source_url: sourceEvent.source_url
  };
  return validateProcessEvent(event);
}
