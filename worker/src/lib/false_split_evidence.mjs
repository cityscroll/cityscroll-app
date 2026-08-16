// Append-only evidence events for the authenticated false-split review desk.
// A disposition records human judgment; it never mutates entity links or source snapshots.

export const FALSE_SPLIT_EVIDENCE_VERSION = "false_split_evidence_v1";
export const FALSE_SPLIT_DECISIONS = new Set(["same", "different", "defer"]);

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function dispositionInput(body = {}) {
  const pairId = clean(body.pair_id);
  const actor = clean(body.actor);
  const decision = clean(body.decision).toLowerCase();
  const note = clean(body.note).slice(0, 2000);
  const sessionId = clean(body.review_session || body.session_id).slice(0, 120);
  if (!pairId) return { error: "pair-required" };
  if (!actor || actor.length > 120) return { error: "actor-required" };
  if (!FALSE_SPLIT_DECISIONS.has(decision)) return { error: "invalid-decision" };
  return { pairId, actor, decision, note, sessionId };
}

export function evidenceSnapshot(pair) {
  return {
    evidence_version: FALSE_SPLIT_EVIDENCE_VERSION,
    pair_id: pair.id,
    matcher_version: pair.matcher_version,
    method: pair.method,
    left: pair.left,
    right: pair.right,
    evidence: pair.evidence,
    observed_at: pair.observed_at,
  };
}

/** Build the authoritative disposition row without writing it. */
export function buildFalseSplitDisposition(pair, input, opts = {}) {
  const parsed = dispositionInput(input);
  if (parsed.error) return parsed;
  if (!pair || pair.id !== parsed.pairId) return { error: "pair-not-found" };
  const createdAt = opts.now || new Date().toISOString();
  const eventId = opts.id || crypto.randomUUID();
  const snapshot = evidenceSnapshot(pair);
  snapshot.review_session = parsed.sessionId || null;
  return {
    id: eventId,
    pair_id: pair.id,
    left_record_id: pair.left.source_record_id,
    right_record_id: pair.right.source_record_id,
    actor: parsed.actor,
    decision: parsed.decision,
    note: parsed.note,
    review_session: parsed.sessionId || null,
    evidence_version: FALSE_SPLIT_EVIDENCE_VERSION,
    evidence_json: JSON.stringify(snapshot),
    created_at: createdAt,
  };
}

/** Prepare the insert so a higher-level command can include it in one D1 batch. */
export function falseSplitDispositionInsert(db, event) {
  return db.prepare(
    `INSERT INTO false_split_disposition_event
       (id, pair_id, left_record_id, right_record_id, actor, decision, note,
        evidence_version, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    event.id,
    event.pair_id,
    event.left_record_id,
    event.right_record_id,
    event.actor,
    event.decision,
    event.note || null,
    event.evidence_version,
    event.evidence_json,
    event.created_at,
  );
}

export function publicFalseSplitDisposition(event) {
  let reviewSession = event.review_session;
  if (reviewSession === undefined) {
    try { reviewSession = JSON.parse(event.evidence_json || "{}").review_session || null; } catch { reviewSession = null; }
  }
  return {
    id: event.id,
    pair_id: event.pair_id,
    actor: event.actor,
    decision: event.decision,
    note: event.note,
    review_session: reviewSession,
    evidence_version: event.evidence_version,
    created_at: event.created_at,
  };
}

export async function appendFalseSplitDisposition(db, pair, input, opts = {}) {
  const event = buildFalseSplitDisposition(pair, input, opts);
  if (event.error) return event;
  await falseSplitDispositionInsert(db, event).run();
  return publicFalseSplitDisposition(event);
}

export async function readFalseSplitDispositions(db, pairIds = []) {
  const ids = [...new Set(pairIds.map(clean).filter(Boolean))];
  if (!db || !ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.prepare(
    `SELECT id, pair_id, left_record_id, right_record_id, actor, decision, note,
            evidence_version, evidence_json, created_at
       FROM false_split_disposition_event
      WHERE pair_id IN (${placeholders})
      ORDER BY created_at ASC, rowid ASC`,
  ).bind(...ids).all();
  return result?.results || [];
}
