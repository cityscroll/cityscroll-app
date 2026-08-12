// Immutable ULURP recommendation-PDF observations for entity-resolution replay.
// The public Land recommendation lookup remains the reader path; these rows are
// a shadow source_records stream keyed by the publisher's application number.

import {
  computeSourceRecordHash,
  SOURCE_RECORD_INSERT_SQL,
  sourceRecordDualWriteEnabled,
} from "./source_records.mjs";

export const ULURP_RECOMMENDATION_PDF_SOURCE_SYSTEM = "ulurp_recommendation_pdfs";
export const ULURP_RECOMMENDATION_PDF_SOURCE_RECORD_DUAL_WRITE_FLAG =
  "ULURP_RECOMMENDATION_PDF_SOURCE_RECORD_DUAL_WRITE";
export const ULURP_RECOMMENDATION_PDF_SOURCE_RECORD_BATCH = 40;

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const part = (value, fallback) => text(value) || fallback;

/** Stable publisher-row identity; no synthetic id is created when the key is absent. */
export function ulurpRecommendationPdfSourceSystemId(row = {}) {
  const application = text(row.ulurp_application_number);
  if (!application) return null;
  return `ulurp-pdf:${application}:${part(row.date, "no-date").slice(0, 10)}:${part(row.project, "no-project").slice(0, 120)}`;
}

export function normalizeUlurpRecommendationPdfRow(row) {
  if (!row || typeof row !== "object") return null;
  const application = text(row.ulurp_application_number);
  if (!application) return null;
  return {
    ulurp_application_number: application,
    pdf_download: text(row.pdf_download) || null,
    date: text(row.date) || null,
    project: text(row.project) || null,
    source_system: ULURP_RECOMMENDATION_PDF_SOURCE_SYSTEM,
    source_system_id: ulurpRecommendationPdfSourceSystemId(row),
  };
}

function writeStreamChunks(env, insert, rows, ingestedAt) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) {
    return Promise.resolve({
      source_system: ULURP_RECOMMENDATION_PDF_SOURCE_SYSTEM,
      written: 0,
      skipped: "empty",
      failed: false,
    });
  }
  return (async () => {
    let written = 0;
    try {
      for (let i = 0; i < list.length; i += ULURP_RECOMMENDATION_PDF_SOURCE_RECORD_BATCH) {
        const chunk = list.slice(i, i + ULURP_RECOMMENDATION_PDF_SOURCE_RECORD_BATCH);
        const statements = await Promise.all(chunk.map(async (row) => {
          const payload = { ...row };
          return insert.bind(
            ULURP_RECOMMENDATION_PDF_SOURCE_SYSTEM,
            row.source_system_id,
            await computeSourceRecordHash(payload),
            JSON.stringify(payload),
            JSON.stringify(payload),
            ingestedAt,
          );
        }));
        await env.DB.batch(statements);
        written += chunk.length;
      }
      return {
        source_system: ULURP_RECOMMENDATION_PDF_SOURCE_SYSTEM,
        written,
        skipped: null,
        failed: false,
      };
    } catch (error) {
      return {
        source_system: ULURP_RECOMMENDATION_PDF_SOURCE_SYSTEM,
        written,
        skipped: null,
        failed: true,
        error: String(error?.message || error || "batch-failed"),
      };
    }
  })();
}

/** Fail-soft D1 adapter; public Land reads never depend on this shadow stream. */
export async function dualWriteUlurpRecommendationPdfObservations(env, rows = [], ingestedAt) {
  if (!sourceRecordDualWriteEnabled(env, ULURP_RECOMMENDATION_PDF_SOURCE_RECORD_DUAL_WRITE_FLAG)) {
    return { written: 0, skipped: "flag-off", failed: false, streams: [] };
  }
  if (!env?.DB) return { written: 0, skipped: "no-db", failed: false, streams: [] };
  let insert;
  try {
    insert = env.DB.prepare(SOURCE_RECORD_INSERT_SQL);
  } catch {
    return { written: 0, skipped: "no-schema", failed: false, streams: [] };
  }
  const stream = await writeStreamChunks(env, insert, rows, ingestedAt || new Date().toISOString());
  return {
    written: stream.written,
    skipped: stream.skipped,
    failed: stream.failed,
    streams: [stream],
  };
}
