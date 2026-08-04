/**
 * T2 attachment structured tables — pure helpers (no I/O).
 *
 * Tables extracted from T1 document classes (docx native; pdf text-layer only).
 * Storage is JSON payloads at current corpus scale (see
 * docs/adr/attachment-tables-storage.md). T3 embeddings is a parallel lane —
 * this module only owns tabular structure + haystack cell text.
 */

import {
  classifyAttachmentForText,
  cleanExtractedText,
  MAX_EXTRACT_BYTES,
  MAX_DOCS_PER_RUN,
} from "./attachment_text.mjs";

export const ATTACHMENT_TABLES_SCHEMA = "cityscroll.attachment_tables.v1";
export const TABLE_PROVENANCE = "attachment-tables";
export const MAX_TABLES_PER_DOC = 25;
export const MAX_TABLE_ROWS = 200;
export const MAX_TABLE_COLS = 40;
export const MAX_CELL_CHARS = 500;
export { MAX_EXTRACT_BYTES, MAX_DOCS_PER_RUN };

/** Same eligibility gate as T1 (office classes only). */
export function classifyAttachmentForTables(attachment = {}) {
  return classifyAttachmentForText(attachment);
}

function cleanCell(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= MAX_CELL_CHARS) return text;
  return `${text.slice(0, MAX_CELL_CHARS - 1).trimEnd()}…`;
}

function cleanRow(row, colCount) {
  const cells = Array.isArray(row) ? row.map(cleanCell) : [];
  while (cells.length < colCount) cells.push("");
  return cells.slice(0, colCount);
}

/**
 * Normalize one extracted table into the public T2 shape.
 * Returns null when the table is empty or below the 2-column floor.
 */
export function normalizeExtractedTable(table = {}, index = 0) {
  if (!table || typeof table !== "object") return null;
  const rawHeaders = Array.isArray(table.headers) ? table.headers : [];
  const rawRows = Array.isArray(table.rows) ? table.rows : [];
  const colCount = Math.min(
    MAX_TABLE_COLS,
    Math.max(
      rawHeaders.length,
      ...rawRows.map((row) => (Array.isArray(row) ? row.length : 0)),
      0,
    ),
  );
  if (colCount < 2) return null;
  const headers = cleanRow(rawHeaders, colCount);
  const rows = rawRows
    .slice(0, MAX_TABLE_ROWS)
    .map((row) => cleanRow(row, colCount))
    .filter((row) => row.some(Boolean));
  if (!headers.some(Boolean) && !rows.length) return null;
  const caption = cleanCell(table.caption || "") || null;
  return {
    index: Number.isInteger(table.index) ? table.index : index,
    caption,
    headers,
    rows,
    n_rows: rows.length,
    n_cols: colCount,
    method: table.method || null,
  };
}

export function normalizeExtractedTables(tables = []) {
  const out = [];
  for (const item of Array.isArray(tables) ? tables : []) {
    if (out.length >= MAX_TABLES_PER_DOC) break;
    const normalized = normalizeExtractedTable(item, out.length);
    if (normalized) out.push({ ...normalized, index: out.length });
  }
  return out;
}

/** Flatten all cell text for search / haystack (lowercased by caller if needed). */
export function tablesToSearchText(tables = []) {
  const parts = [];
  for (const table of normalizeExtractedTables(tables)) {
    if (table.caption) parts.push(table.caption);
    parts.push(...table.headers.filter(Boolean));
    for (const row of table.rows) {
      parts.push(...row.filter(Boolean));
    }
  }
  return cleanExtractedText(parts.join(" "));
}

/** Short progressive-disclosure preview: first table header + first data row. */
export function previewFromTables(tables = []) {
  const list = normalizeExtractedTables(tables);
  if (!list.length) return "";
  const first = list[0];
  const head = first.headers.filter(Boolean).join(" · ");
  const sample = first.rows[0] ? first.rows[0].filter(Boolean).join(" · ") : "";
  const more = list.length > 1 || first.rows.length > 1
    ? ` · +${Math.max(0, first.rows.length - 1) + (list.length - 1) * Math.max(1, first.rows.length)} more`
    : "";
  let preview = sample
    ? `${list.length} table${list.length === 1 ? "" : "s"}: ${head} — ${sample}${more}`
    : `${list.length} table${list.length === 1 ? "" : "s"}: ${head}${more}`;
  if (preview.length > 280) preview = `${preview.slice(0, 277).trimEnd()}…`;
  return preview;
}

/**
 * Stamp T2 table fields onto a T0/T1 attachment row.
 * Never invents structure — empty extract is an honest no-tables / skip.
 */
export function stampAttachmentTables(attachment, extract = {}) {
  const base = attachment && typeof attachment === "object" ? { ...attachment } : {};
  const classification = classifyAttachmentForTables(base);
  const tables = normalizeExtractedTables(extract.tables || extract.extracted_tables || []);
  const status = extract.status
    || (tables.length ? "ok" : (classification.eligible ? "ok" : "skipped"));
  const reason = tables.length
    ? null
    : (extract.reason || classification.reason || "no_tables");
  const method = extract.method || (tables[0]?.method) || null;

  return {
    ...base,
    tables_status: tables.length ? "ok" : status,
    tables_reason: tables.length ? null : reason,
    tables_method: tables.length ? (method || classification.class || null) : method,
    tables_count: tables.length,
    tables_preview: tables.length ? previewFromTables(tables) : null,
    extracted_tables: tables.length ? tables : null,
    tables_extracted_at: extract.extracted_at
      || (tables.length ? new Date().toISOString() : null),
  };
}

/** Build the attachment-tables slice that feeds the D1 notices haystack. */
export function attachmentTablesForHaystack(attachments = []) {
  const parts = [];
  for (const item of Array.isArray(attachments) ? attachments : []) {
    const text = tablesToSearchText(item?.extracted_tables || []);
    if (!text) continue;
    parts.push(text.toLowerCase());
  }
  if (!parts.length) return "";
  return `[${TABLE_PROVENANCE}] ${parts.join(" ¦ ")}`;
}

/**
 * Merge base haystack with attachment table cell text, replacing any prior
 * attachment-tables slice so re-runs stay idempotent.
 * Preserves a trailing attachment-text slice when present (T1).
 */
export function mergeHaystackWithAttachmentTables(baseHaystack, attachments = []) {
  const raw = String(baseHaystack || "");
  // Peel any prior tables marker; leave attachment-text intact.
  const withoutTables = raw
    .replace(new RegExp(`\\s*\\[?${TABLE_PROVENANCE}\\]?[\\s\\S]*?(?=\\s*\\[attachment-text\\]|$)`, "i"), "")
    .replace(/\s*¦\s*$/, "")
    .trim();
  const attach = attachmentTablesForHaystack(attachments);
  if (!attach) return withoutTables;
  if (!withoutTables) return attach;
  // Prefer tables before attachment-text so both markers stay parseable.
  const textMatch = withoutTables.match(/(\s*¦?\s*\[attachment-text\][\s\S]*)$/i);
  if (textMatch) {
    const head = withoutTables.slice(0, textMatch.index).replace(/\s*¦\s*$/, "").trim();
    const tail = textMatch[1].trim();
    return [head, attach, tail].filter(Boolean).join(" ¦ ");
  }
  return `${withoutTables} ¦ ${attach}`;
}

/**
 * Full haystack merge for T0/T1/T2: base → tables → text.
 * Callers that already merged T1 text can use mergeHaystackWithAttachmentTables alone.
 */
export function mergeHaystackWithAttachmentLayers(baseHaystack, attachments = [], {
  mergeText,
} = {}) {
  let next = String(baseHaystack || "");
  next = mergeHaystackWithAttachmentTables(next, attachments);
  if (typeof mergeText === "function") {
    next = mergeText(next, attachments);
  }
  return next;
}

export function matchAttachmentTablesEvidence(tableText, terms = []) {
  const text = cleanExtractedText(tableText || "");
  if (!text) return null;
  const hay = text.toLowerCase();
  let best = null;
  for (const term of terms || []) {
    const needle = String(term || "").trim();
    if (!needle) continue;
    const idx = hay.indexOf(needle.toLowerCase());
    if (idx !== -1 && (best === null || idx < best.index)) {
      best = { term: needle, index: idx };
    }
  }
  if (!best) return null;
  const RADIUS = 70;
  const start = Math.max(0, best.index - RADIUS);
  const end = Math.min(text.length, best.index + best.term.length + RADIUS);
  return {
    field: "attachment-tables",
    provenance: TABLE_PROVENANCE,
    term: best.term,
    before: (start > 0 ? "…" : "") + text.slice(start, best.index),
    hit: text.slice(best.index, best.index + best.term.length),
    after: text.slice(best.index + best.term.length, end) + (end < text.length ? "…" : ""),
  };
}

export function joinAttachmentTablesText(attachments = []) {
  return (Array.isArray(attachments) ? attachments : [])
    .map((item) => tablesToSearchText(item?.extracted_tables || []))
    .filter(Boolean)
    .join("\n\n");
}

/** Public API fields for one attachment (omit empty table blobs). */
export function publicAttachmentTableFields(attachment = {}) {
  if (!attachment || typeof attachment !== "object") return {};
  const tables = normalizeExtractedTables(attachment.extracted_tables || []);
  if (!tables.length) {
    if (attachment.tables_status && attachment.tables_status !== "ok") {
      return {
        tables_status: attachment.tables_status,
        tables_reason: attachment.tables_reason || null,
        tables_method: attachment.tables_method || null,
        tables_count: 0,
        tables_preview: null,
      };
    }
    return {};
  }
  return {
    tables_status: "ok",
    tables_reason: null,
    tables_method: attachment.tables_method || tables[0]?.method || null,
    tables_count: tables.length,
    tables_preview: previewFromTables(tables),
    extracted_tables: tables,
  };
}

/**
 * Measured storage decision helper — pure criteria for the JSON-vs-parquet choice.
 * Used by tests + the decision record; not a runtime switch.
 */
export function recommendTableStorage({
  docsWithTables = 0,
  totalTables = 0,
  totalCells = 0,
  payloadBytes = 0,
  needsCrossDocSql = false,
  ciMustInstallDuckdb = false,
} = {}) {
  // Thresholds documented in docs/adr/attachment-tables-storage.md
  const PARQUET_DOCS = 500;
  const PARQUET_TABLES = 2_000;
  const PARQUET_BYTES = 5_000_000;
  const reasons = [];
  if (docsWithTables >= PARQUET_DOCS) reasons.push(`docs_with_tables>=${PARQUET_DOCS}`);
  if (totalTables >= PARQUET_TABLES) reasons.push(`total_tables>=${PARQUET_TABLES}`);
  if (payloadBytes >= PARQUET_BYTES) reasons.push(`payload_bytes>=${PARQUET_BYTES}`);
  if (needsCrossDocSql) reasons.push("cross_doc_sql_required");
  if (reasons.length && !ciMustInstallDuckdb) {
    return {
      format: "parquet+duckdb",
      reasons,
      scale: { docsWithTables, totalTables, totalCells, payloadBytes },
    };
  }
  return {
    format: "json",
    reasons: reasons.length
      ? [`deferred:${reasons.join(",")}`, "json_wins_at_current_scale_or_ci_weight"]
      : [
        "corpus_small",
        "product_serves_precomputed_json",
        "no_cross_doc_sql_yet",
        "avoid_ci_parquet_toolchain",
      ],
    scale: { docsWithTables, totalTables, totalCells, payloadBytes },
    parquet_threshold: {
      docs_with_tables: PARQUET_DOCS,
      total_tables: PARQUET_TABLES,
      payload_bytes: PARQUET_BYTES,
      or_cross_doc_sql: true,
    },
  };
}
