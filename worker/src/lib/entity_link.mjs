// Entity-link dual-write (er-07): resolution_run + entity_link schema helpers
// and an opt-in shadow writer for exact-stem auto cases only.
//
// Public APIs do not read these tables. Enable writes with env
// ENTITY_LINK_DUAL_WRITE === "true". Flag off (default) is a no-op.
//
// Decision vocabulary and column names follow
// docs/adr/entity-resolution-taxonomy.md and migration 0009_entity_link.sql.

import {
  VENDOR_STEM_METHOD,
  VENDOR_STEM_VERSION,
  vendorStem,
} from "./normalize.mjs";

/** Env flag — must be the string "true" (case-insensitive) to enable writes. */
export const ENTITY_LINK_DUAL_WRITE_FLAG = "ENTITY_LINK_DUAL_WRITE";

/** Decision enum values (ADR). Shadow writer only emits auto_link. */
export const DECISION = Object.freeze({
  AUTO_LINK: "auto_link",
  SEPARATE: "separate",
  REVIEW: "review",
  NEVER_AUTO: "never_auto",
});

/** Required columns on resolution_run (migration contract). */
export const RESOLUTION_RUN_COLUMNS = Object.freeze([
  "id",
  "method",
  "matcher_version",
  "config_hash",
  "entity_type",
  "scope_note",
  "started_at",
  "finished_at",
  "metrics_json",
  "status",
]);

/** Required columns on entity_link (migration contract). */
export const ENTITY_LINK_COLUMNS = Object.freeze([
  "id",
  "source_record_id",
  "canonical_entity_id",
  "decision",
  "confidence",
  "method",
  "matcher_version",
  "evidence_json",
  "resolution_run_id",
  "review_status",
  "created_at",
]);

/** Required columns on canonical_entity (link target). */
export const CANONICAL_ENTITY_COLUMNS = Object.freeze([
  "id",
  "entity_type",
  "display_name",
  "attrs_json",
  "created_at",
  "updated_at",
]);

/** Exact-stem auto confidence: method policy allows auto when stem is non-empty. */
export const EXACT_STEM_AUTO_CONFIDENCE = 1;

export function entityLinkDualWriteEnabled(env) {
  return String(env?.[ENTITY_LINK_DUAL_WRITE_FLAG] || "").toLowerCase() === "true";
}

/**
 * Deterministic canonical id for a vendor stem (link-not-merge handle).
 * Empty stem → null (not auto-linkable).
 */
export function canonicalVendorIdForStem(stem) {
  const s = String(stem || "").trim();
  if (!s) return null;
  return `vendor:stem:${s}`;
}

/**
 * Build an exact-stem auto-link case, or null when the observation is not
 * eligible (empty stem / blank name). Does not write.
 */
export function buildExactStemAutoCase(observation) {
  const sourceRecordId = String(observation?.source_record_id || "").trim();
  const vendorName = observation?.vendor_name;
  if (!sourceRecordId) return null;
  const stem = vendorStem(vendorName);
  if (!stem) return null;
  const canonicalId = canonicalVendorIdForStem(stem);
  const display = String(vendorName || "").replace(/\s+/g, " ").trim() || stem;
  return {
    source_record_id: sourceRecordId,
    canonical_entity_id: canonicalId,
    decision: DECISION.AUTO_LINK,
    confidence: EXACT_STEM_AUTO_CONFIDENCE,
    method: VENDOR_STEM_METHOD,
    matcher_version: VENDOR_STEM_VERSION,
    entity_type: "vendor",
    display_name: display,
    stem,
    evidence: {
      match: "exact_stem",
      stem,
      vendor_name: display,
      method: VENDOR_STEM_METHOD,
      matcher_version: VENDOR_STEM_VERSION,
    },
  };
}

function opaqueId(prefix, parts) {
  const raw = parts.map((p) => String(p ?? "")).join("|");
  // FNV-1a 32-bit — stable, no crypto dependency in pure unit paths.
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return `${prefix}_${hex}_${raw.length.toString(16)}`;
}

/**
 * Idempotent CREATE TABLE IF NOT EXISTS for the three er-07 tables.
 * Production deploys apply migration 0009; this is the runtime safety net
 * for the shadow writer when a deploy skipped migrations.
 */
export async function ensureEntityLinkSchema(env) {
  if (!env?.DB) return { ok: false, reason: "no-db" };
  // Run sequentially so CREATE INDEX prepare cannot race ahead of its table
  // (real SQLite validates table existence at prepare time; D1 batch is fine
  // either way, but sequential is the portable safety net).
  const statements = [
    `CREATE TABLE IF NOT EXISTS resolution_run (
        id               TEXT PRIMARY KEY,
        method           TEXT NOT NULL,
        matcher_version  TEXT NOT NULL,
        config_hash      TEXT,
        entity_type      TEXT,
        scope_note       TEXT,
        started_at       TEXT NOT NULL,
        finished_at      TEXT,
        metrics_json     TEXT,
        status           TEXT NOT NULL DEFAULT 'running'
      )`,
    `CREATE TABLE IF NOT EXISTS canonical_entity (
        id               TEXT PRIMARY KEY,
        entity_type      TEXT NOT NULL,
        display_name     TEXT NOT NULL,
        attrs_json       TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      )`,
    "CREATE INDEX IF NOT EXISTS idx_canonical_entity_type ON canonical_entity(entity_type)",
    `CREATE TABLE IF NOT EXISTS entity_link (
        id                  TEXT PRIMARY KEY,
        source_record_id    TEXT NOT NULL,
        canonical_entity_id TEXT,
        decision            TEXT NOT NULL,
        confidence          REAL,
        method              TEXT NOT NULL,
        matcher_version     TEXT NOT NULL,
        evidence_json       TEXT,
        resolution_run_id   TEXT REFERENCES resolution_run(id),
        review_status       TEXT,
        created_at          TEXT NOT NULL,
        UNIQUE (source_record_id, method, matcher_version, decision, canonical_entity_id)
      )`,
    "CREATE INDEX IF NOT EXISTS idx_entity_link_canonical ON entity_link(canonical_entity_id)",
    "CREATE INDEX IF NOT EXISTS idx_entity_link_decision ON entity_link(decision)",
    "CREATE INDEX IF NOT EXISTS idx_entity_link_run ON entity_link(resolution_run_id)",
    "CREATE INDEX IF NOT EXISTS idx_entity_link_source ON entity_link(source_record_id)",
  ];
  for (const sql of statements) {
    await env.DB.prepare(sql).run();
  }
  return { ok: true };
}

/**
 * Shadow-write exact-stem auto_link rows only.
 * Flag off / missing DB → no-op { skipped }.
 * Never writes separate/review/never_auto; never invents links for empty stems.
 *
 * @param {object} env - Worker env (DB + optional ENTITY_LINK_DUAL_WRITE)
 * @param {Array<{source_record_id: string, vendor_name: string}>} observations
 * @param {{ scope_note?: string, config_hash?: string, now?: string }} [opts]
 * @returns {Promise<object>} run metrics
 */
export async function shadowWriteExactStemAutoLinks(env, observations, opts = {}) {
  if (!entityLinkDualWriteEnabled(env)) {
    return { skipped: "flag-off", written: 0, considered: 0 };
  }
  if (!env?.DB) {
    return { skipped: "no-db", written: 0, considered: 0 };
  }

  const list = Array.isArray(observations) ? observations : [];
  const cases = [];
  for (const obs of list) {
    const c = buildExactStemAutoCase(obs);
    if (c) cases.push(c);
  }

  const startedAt = opts.now || new Date().toISOString();
  const runId = opaqueId("run", [
    VENDOR_STEM_METHOD,
    VENDOR_STEM_VERSION,
    startedAt,
    cases.length,
    opts.scope_note || "",
  ]);

  await ensureEntityLinkSchema(env);

  const metrics = {
    considered: list.length,
    eligible: cases.length,
    written: 0,
    method: VENDOR_STEM_METHOD,
    matcher_version: VENDOR_STEM_VERSION,
  };

  await env.DB.prepare(
    `INSERT OR IGNORE INTO resolution_run
       (id, method, matcher_version, config_hash, entity_type, scope_note,
        started_at, finished_at, metrics_json, status)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      runId,
      VENDOR_STEM_METHOD,
      VENDOR_STEM_VERSION,
      opts.config_hash || null,
      "vendor",
      opts.scope_note || "exact-stem auto shadow",
      startedAt,
      null,
      JSON.stringify(metrics),
      "running",
    )
    .run();

  const stmts = [];
  for (const c of cases) {
    const now = startedAt;
    const linkId = opaqueId("link", [
      c.source_record_id,
      c.method,
      c.matcher_version,
      c.decision,
      c.canonical_entity_id,
    ]);
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO canonical_entity
           (id, entity_type, display_name, attrs_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      ).bind(
        c.canonical_entity_id,
        c.entity_type,
        c.display_name,
        JSON.stringify({ stem: c.stem }),
        now,
        now,
      ),
    );
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO entity_link
           (id, source_record_id, canonical_entity_id, decision, confidence,
            method, matcher_version, evidence_json, resolution_run_id,
            review_status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        linkId,
        c.source_record_id,
        c.canonical_entity_id,
        c.decision,
        c.confidence,
        c.method,
        c.matcher_version,
        JSON.stringify(c.evidence),
        runId,
        null,
        now,
      ),
    );
  }

  if (stmts.length) {
    try {
      await env.DB.batch(stmts);
      metrics.written = cases.length;
    } catch {
      // Shadow path must never break the caller (same fail-soft posture as er-02).
      metrics.written = 0;
      metrics.error = "batch-failed";
    }
  }

  const finishedAt = opts.now || new Date().toISOString();
  try {
    await env.DB.prepare(
      `UPDATE resolution_run
          SET finished_at = ?, metrics_json = ?, status = ?
        WHERE id = ?`,
    )
      .bind(
        finishedAt,
        JSON.stringify(metrics),
        metrics.error ? "failed" : "completed",
        runId,
      )
      .run();
  } catch {
    // ignore status update failures
  }

  return {
    run_id: runId,
    written: metrics.written,
    considered: metrics.considered,
    eligible: metrics.eligible,
    method: VENDOR_STEM_METHOD,
    matcher_version: VENDOR_STEM_VERSION,
    error: metrics.error || null,
  };
}
