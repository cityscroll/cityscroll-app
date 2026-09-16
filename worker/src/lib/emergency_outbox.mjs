const CLAIM_TTL_MS = 60 * 1000;
const IDEMPOTENCY_MS = 24 * 60 * 60 * 1000;

const SELECT = `SELECT signature, payload_json, state, claim_token, claim_expires_at,
  first_attempted_at, last_attempted_at, retry_until, attempt_count, resolved_at,
  provider_id, error_reason FROM ops_emergency_deliveries WHERE signature = ?`;
const LIST = `SELECT signature, payload_json, state, claim_token, claim_expires_at,
  first_attempted_at, last_attempted_at, retry_until, attempt_count, resolved_at,
  provider_id, error_reason FROM ops_emergency_deliveries
  ORDER BY last_attempted_at DESC, signature ASC LIMIT ?`;

function token() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function changes(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

async function run(db, sql, params) {
  return db.prepare(sql).bind(...params).run();
}

async function read(db, signature) {
  return db.prepare(SELECT).bind(signature).first();
}

function parsed(row) {
  if (!row) return null;
  let payload = null;
  try { payload = JSON.parse(row.payload_json); } catch {}
  if (!payload?.subject || !payload?.text || !payload?.evidence) return null;
  return {
    signature: row.signature,
    payload,
    state: row.state,
    claim_token: row.claim_token || null,
    claim_expires_at: row.claim_expires_at || null,
    attempted_at: row.first_attempted_at,
    last_attempt_at: row.last_attempted_at,
    retry_until: row.retry_until,
    attempt_count: Number(row.attempt_count) || 1,
    resolved_at: row.resolved_at || null,
    provider_id: row.provider_id || null,
    error_reason: row.error_reason || null,
  };
}

export function emergencyDeliveryProjection(row) {
  const delivery = parsed(row);
  if (!delivery) return null;
  return {
    state: delivery.state,
    idempotency_key: delivery.signature,
    attempted_at: delivery.attempted_at,
    last_attempt_at: delivery.last_attempt_at,
    retry_until: delivery.retry_until,
    attempt_count: delivery.attempt_count,
    subject: delivery.payload.subject,
    text: delivery.payload.text,
    evidence: delivery.payload.evidence,
    resolved_at: delivery.resolved_at,
    provider_id: delivery.provider_id,
    error_reason: delivery.error_reason,
  };
}

function alertProjection(delivery, prior = null) {
  const acceptedAt = delivery.state === "accepted" ? delivery.resolved_at : null;
  return {
    ...(prior || {}),
    schema: prior?.schema || "cityscroll.ops-alert-signature.v1",
    signature: delivery.idempotency_key,
    guard: prior?.guard || "production-emergency",
    stage: prior?.stage || "unknown",
    findings: Array.isArray(prior?.findings) ? prior.findings : [],
    first_seen: prior?.first_seen || delivery.attempted_at,
    last_seen: prior?.last_seen || delivery.last_attempt_at,
    count: Number(prior?.count) || delivery.attempt_count,
    sent_at: acceptedAt || prior?.sent_at || null,
    emergency_sent_at: acceptedAt || prior?.emergency_sent_at || null,
    confirmed_emergency: delivery.evidence,
    emergency_delivery: delivery,
    delivery_finding: delivery.state === "accepted" ? null : {
      observed_at: delivery.last_attempt_at,
      reason: delivery.error_reason || (delivery.state === "in-flight" ? "delivery-in-flight" : `delivery-${delivery.state}`),
    },
  };
}

function observationTime(item) {
  const values = [item?.last_seen, item?.emergency_delivery?.last_attempt_at, item?.emergency_delivery?.resolved_at]
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : Number.NEGATIVE_INFINITY;
}

function newestFirst(left, right) {
  const time = observationTime(right) - observationTime(left);
  if (time) return time;
  return String(left?.signature || "").localeCompare(String(right?.signature || ""));
}

export async function projectEmergencyAlertHistory(db, history, { limit = 50 } = {}) {
  const base = history && typeof history === "object" ? history : { schema: "cityscroll.ops-alert-history.v1", items: [] };
  const existing = Array.isArray(base.items) ? base.items : [];
  if (!db?.prepare) {
    return { ...base, items: existing.slice(0, limit), emergency_delivery_authority: { status: "unavailable", reason: "db-unavailable" } };
  }
  try {
    const cap = Math.max(1, limit);
    const result = await db.prepare(LIST).bind(cap + 1).all();
    const rows = Array.isArray(result?.results) ? result.results : [];
    const bySignature = new Map(existing.map((item) => [item?.signature, item]));
    const exactRows = await Promise.all([...bySignature.keys()].filter(Boolean).slice(0, cap).map((signature) => read(db, signature)));
    const authoritativeRows = new Map();
    for (const row of [...rows.slice(0, cap), ...exactRows.filter(Boolean)]) authoritativeRows.set(row.signature, row);
    const emergency = [...authoritativeRows.values()].map((row) => emergencyDeliveryProjection(row)).filter(Boolean);
    const mergedEmergency = emergency.map((delivery) => alertProjection(delivery, bySignature.get(delivery.idempotency_key)));
    const emergencySignatures = new Set(mergedEmergency.map((item) => item.signature));
    const combined = [...mergedEmergency, ...existing.filter((item) => !emergencySignatures.has(item?.signature))].sort(newestFirst);
    const items = combined.slice(0, cap);
    return {
      ...base,
      items,
      emergency_delivery_authority: {
        status: "available",
        source: "d1",
        authoritative_count: emergency.length,
        truncated: rows.length > cap || combined.length > cap,
      },
    };
  } catch (error) {
    return {
      ...base,
      items: existing.slice(0, limit),
      emergency_delivery_authority: { status: "unavailable", reason: "db-read-failed" },
    };
  }
}

export async function claimEmergencyDelivery(db, { signature, payload, now = new Date(), attemptedAt = null, retryUntil = null } = {}) {
  if (!db?.prepare) return { ok: false, reason: "emergency-outbox-unavailable", owned: false, row: null };
  const claimToken = token();
  const at = now.toISOString();
  const firstAt = attemptedAt || at;
  const until = retryUntil || new Date(now.getTime() + IDEMPOTENCY_MS).toISOString();
  const expires = new Date(now.getTime() + CLAIM_TTL_MS).toISOString();
  const payloadJson = JSON.stringify(payload);
  try {
    let result = await run(db, `INSERT INTO ops_emergency_deliveries
      (signature, payload_json, state, claim_token, claim_expires_at, first_attempted_at,
       last_attempted_at, retry_until, attempt_count)
      VALUES (?, ?, 'in-flight', ?, ?, ?, ?, ?, 1)
      ON CONFLICT(signature) DO NOTHING`,
    [signature, payloadJson, claimToken, expires, firstAt, at, until]);
    let owned = changes(result) > 0;
    let existing = owned ? null : await read(db, signature);
    if (!owned && existing?.state === "rejected") {
      const existingUntil = Date.parse(existing.retry_until || "");
      const nextUntil = Number.isFinite(existingUntil) && existingUntil >= now.getTime() ? existing.retry_until : until;
      const nextFirst = nextUntil === existing.retry_until ? existing.first_attempted_at : at;
      result = await run(db, `UPDATE ops_emergency_deliveries
        SET payload_json = ?, state = 'in-flight', claim_token = ?, claim_expires_at = ?,
            first_attempted_at = ?, last_attempted_at = ?, retry_until = ?,
            attempt_count = attempt_count + 1, resolved_at = NULL, provider_id = NULL, error_reason = NULL
        WHERE signature = ? AND state = 'rejected'`,
      [payloadJson, claimToken, expires, nextFirst, at, nextUntil, signature]);
      owned = changes(result) > 0;
    } else if (!owned && existing && ["in-flight", "indeterminate"].includes(existing.state)
      && Date.parse(existing.retry_until || "") >= now.getTime()
      && (existing.state === "indeterminate" || Date.parse(existing.claim_expires_at || "") <= now.getTime())) {
      result = await run(db, `UPDATE ops_emergency_deliveries
        SET state = 'in-flight', claim_token = ?, claim_expires_at = ?, last_attempted_at = ?,
            attempt_count = attempt_count + 1, resolved_at = NULL, error_reason = NULL
        WHERE signature = ? AND state = ? AND payload_json = ? AND retry_until >= ?
          AND (state = 'indeterminate' OR claim_expires_at <= ?)`,
      [claimToken, expires, at, signature, existing.state, existing.payload_json, at, at]);
      owned = changes(result) > 0;
    }
    const row = await read(db, signature);
    return { ok: Boolean(row), reason: row ? null : "emergency-outbox-read-failed", owned: owned && row?.claim_token === claimToken, claimToken, row };
  } catch (error) {
    return { ok: false, reason: "emergency-outbox-unavailable", detail: String(error?.message || error), owned: false, row: null };
  }
}

export async function completeEmergencyDelivery(db, { signature, claimToken, state, now = new Date(), providerId = null, errorReason = null } = {}) {
  if (!db?.prepare || !["accepted", "indeterminate", "rejected"].includes(state)) return { ok: false, row: null };
  const at = now.toISOString();
  await run(db, `UPDATE ops_emergency_deliveries
    SET state = ?, claim_token = NULL, claim_expires_at = NULL, resolved_at = ?,
        provider_id = ?, error_reason = ?
    WHERE signature = ? AND state = 'in-flight' AND claim_token = ?`,
  [state, state === "indeterminate" ? null : at, providerId, errorReason, signature, claimToken]);
  const row = await read(db, signature);
  return { ok: Boolean(row), row };
}
