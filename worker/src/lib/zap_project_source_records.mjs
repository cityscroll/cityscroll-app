// Immutable ZAP Open Data project observations for entity-graph replay.
// Public Land and graph readers keep using their existing materializations;
// this shadow path only retains publisher rows under exact project identities.

import {
  computeSourceRecordHash,
  SOURCE_RECORD_INSERT_SQL,
  sourceRecordDualWriteEnabled,
} from "./source_records.mjs";

export const ZAP_PROJECT_SOURCE_RECORD_DUAL_WRITE_FLAG =
  "ZAP_PROJECT_SOURCE_RECORD_DUAL_WRITE";
export const ZAP_PROJECTS_SOURCE_SYSTEM = "zap-projects";
export const ZAP_PROJECT_SOURCE_RECORD_BATCH = 40;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/** Publisher-native project identity; this matches graph edge source_record_id suffixes. */
export function zapProjectSourceSystemId(row) {
  const id = clean(row?.project_id);
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(id) ? id : null;
}

/** Remove transport/graph metadata so raw_snapshot remains publisher data only. */
export function zapProjectRawSnapshot(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const {
    lookup_path: _lookupPath,
    source_system: _sourceSystem,
    source_system_id: _sourceSystemId,
    source_url: _sourceUrl,
    observed_at: _observedAt,
    ...publisher
  } = row;
  return publisher;
}

/**
 * Admit only a real identity-bearing Open Data row. A project-id-only shell is
 * the request fallback after source failure, not publisher evidence.
 */
export function normalizeZapProjectObservation(row, { observedAt } = {}) {
  const raw = zapProjectRawSnapshot(row);
  const source_system_id = zapProjectSourceSystemId(raw);
  if (!raw || !source_system_id || !clean(raw.project_name)) return null;
  const observed_at = clean(observedAt || row?.observed_at) || null;
  return {
    ...raw,
    project_id: source_system_id,
    source_system: ZAP_PROJECTS_SOURCE_SYSTEM,
    source_system_id,
    source_url:
      `https://zap.planning.nyc.gov/projects/${encodeURIComponent(source_system_id)}`,
    observed_at,
  };
}

/** Fail-soft, append-only dual-write of verified ZAP project rows. */
export async function dualWriteZapProjectObservations(env, rows = [], ingestedAt) {
  if (!sourceRecordDualWriteEnabled(env, ZAP_PROJECT_SOURCE_RECORD_DUAL_WRITE_FLAG)) {
    return { written: 0, skipped: "flag-off", failed: false, rejected: 0 };
  }
  if (!env?.DB) {
    return { written: 0, skipped: "no-db", failed: false, rejected: 0 };
  }

  const at = clean(ingestedAt) || new Date().toISOString();
  const admitted = [];
  let rejected = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const normalized = normalizeZapProjectObservation(row, { observedAt: at });
    const raw = zapProjectRawSnapshot(row);
    if (!normalized || !raw) {
      rejected += 1;
      continue;
    }
    admitted.push({ raw, normalized });
  }
  if (!admitted.length) {
    return { written: 0, skipped: "empty", failed: false, rejected };
  }

  let written = 0;
  try {
    const insert = env.DB.prepare(SOURCE_RECORD_INSERT_SQL);
    for (let index = 0; index < admitted.length; index += ZAP_PROJECT_SOURCE_RECORD_BATCH) {
      const chunk = admitted.slice(index, index + ZAP_PROJECT_SOURCE_RECORD_BATCH);
      const statements = await Promise.all(chunk.map(async ({ raw, normalized }) =>
        insert.bind(
          ZAP_PROJECTS_SOURCE_SYSTEM,
          normalized.source_system_id,
          await computeSourceRecordHash(raw),
          JSON.stringify(raw),
          JSON.stringify(normalized),
          at,
        )));
      await env.DB.batch(statements);
      written += chunk.length;
    }
    return { written, skipped: null, failed: false, rejected };
  } catch (error) {
    const message = String(error?.message || error || "batch-failed");
    console.error(
      "ZAP project source_records dual-write failed:",
      `written_before_fail=${written}`,
      message,
    );
    return { written, skipped: null, failed: true, rejected, error: message };
  }
}
