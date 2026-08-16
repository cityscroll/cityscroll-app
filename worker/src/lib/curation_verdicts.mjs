// D1 storage seam for append-only entity-resolution gold-candidate verdicts.
// This module is receipt-only by construction; operative links are produced by
// a later versioned policy run, never by a desk decision.

import {
  CURATION_VERDICT_SCHEMA_VERSION,
  buildCurationVerdictReceipt,
} from "../../../entity_resolution/review/curation_verdicts.mjs";

export const CURATION_VERDICT_COLUMNS = Object.freeze([
  "id",
  "schema_version",
  "actor",
  "decision",
  "target_kind",
  "target_id",
  "target_json",
  "evidence_refs_json",
  "model_version",
  "rule_version",
  "review_policy_json",
  "effect_json",
  "reverses_receipt_id",
  "created_at",
]);

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function curationVerdictFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    schema_version: row.schema_version,
    actor: row.actor,
    decision: row.decision,
    target: parseJson(row.target_json, { kind: row.target_kind, id: row.target_id }),
    evidence_refs: parseJson(row.evidence_refs_json, []),
    model_version: row.model_version,
    rule_version: row.rule_version,
    timestamp: row.created_at,
    reverses_receipt_id: row.reverses_receipt_id || null,
    review_policy: parseJson(row.review_policy_json, {}),
    reversible_effect: parseJson(row.effect_json, {}),
  };
}

/** Prepare the receipt insert so an authoritative command can batch it atomically. */
export function curationVerdictInsert(db, receipt) {
  return db.prepare(
    `INSERT INTO curation_verdict_receipt
       (id, schema_version, actor, decision, target_kind, target_id, target_json,
        evidence_refs_json, model_version, rule_version, review_policy_json,
        effect_json, reverses_receipt_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    receipt.id,
    receipt.schema_version,
    receipt.actor,
    receipt.decision,
    receipt.target.kind,
    receipt.target.id,
    JSON.stringify(receipt.target),
    JSON.stringify(receipt.evidence_refs),
    receipt.model_version,
    receipt.rule_version,
    JSON.stringify(receipt.review_policy),
    JSON.stringify(receipt.reversible_effect),
    receipt.reverses_receipt_id,
    receipt.timestamp,
  );
}

/** Append one verdict receipt. No entity-link writer is reachable from this seam. */
export async function appendCurationVerdict(db, input, opts = {}) {
  if (!db) return { error: "no-store" };
  const receipt = buildCurationVerdictReceipt(input, {
    id: opts.id || input?.id || crypto.randomUUID(),
    now: opts.now,
  });
  if (receipt.error) return receipt;

  await curationVerdictInsert(db, receipt).run();
  return receipt;
}

/** Read the backstage receipt history for exact target IDs only. */
export async function readCurationVerdicts(db, targetIds = []) {
  const ids = [...new Set((Array.isArray(targetIds) ? targetIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  if (!db || !ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.prepare(
    `SELECT ${CURATION_VERDICT_COLUMNS.join(", ")}
       FROM curation_verdict_receipt
      WHERE schema_version = ? AND target_id IN (${placeholders})
      ORDER BY created_at ASC, rowid ASC`,
  ).bind(CURATION_VERDICT_SCHEMA_VERSION, ...ids).all();
  return (result?.results || []).map(curationVerdictFromRow).filter(Boolean);
}
