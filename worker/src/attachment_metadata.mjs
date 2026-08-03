import materialization from "./data/attachment_metadata_lookup.json" with { type: "json" };
import {
  cleanExtractedText,
  joinAttachmentTexts,
  mergeHaystackWithAttachmentText,
  publicAttachmentTextFields,
  TEXT_PROVENANCE,
} from "./lib/attachment_text.mjs";

const MAX_BODY_BYTES = 2_000_000;
const MAX_NOTICES = 100;
const MAX_ATTACHMENTS_PER_NOTICE = 20;
const MAX_TEXT_CHARS = 50_000;
const GETFILE_HOST = "a856-cityrecord.nyc.gov";

function json(value, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function cleanText(value, max = 500) {
  const text = value == null ? "" : String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function cleanLongText(value, max = MAX_TEXT_CHARS) {
  return cleanExtractedText(value, max) || null;
}

export function normalizeAttachment(value, requestId = null) {
  if (!value || typeof value !== "object") return null;
  let parsed;
  try { parsed = new URL(String(value.url || "")); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.hostname !== GETFILE_HOST || !/^\/Search\/GetFile$/i.test(parsed.pathname)) return null;
  const rid = cleanText(requestId || value.request_id, 40);
  const documentId = cleanText(
    value.document_id || parsed.searchParams.get("documentId") || parsed.searchParams.get("DocumentID"),
    80,
  );
  if (!rid || !documentId) return null;
  const bytes = Number.isInteger(value.bytes) && value.bytes >= 0 ? value.bytes : null;
  const textFields = publicAttachmentTextFields({
    extracted_text: value.extracted_text,
    text_status: value.text_status,
    text_reason: value.text_reason,
    text_method: value.text_method,
    text_preview: value.text_preview,
  });
  return {
    request_id: rid,
    document_id: documentId,
    title: cleanText(value.title),
    url: parsed.href,
    content_type: cleanText(value.content_type, 120),
    bytes,
    source: value.source === "portal" ? "portal" : "dataset",
    ...textFields,
  };
}

function preferRicher(current, next) {
  if (!current) return next;
  // Portal title wins over bare dataset URL; extracted text is additive richness.
  if (next.source === "portal" && current.source !== "portal") return { ...current, ...next, extracted_text: next.extracted_text || current.extracted_text };
  if (!current.title && next.title) return { ...current, ...next, extracted_text: next.extracted_text || current.extracted_text };
  if (!current.extracted_text && next.extracted_text) return { ...current, ...next };
  if (next.extracted_text && (current.extracted_text || "").length < next.extracted_text.length) {
    return { ...current, ...next };
  }
  return current;
}

function normalizeList(values, requestId) {
  const byId = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const attachment = normalizeAttachment(value, requestId);
    if (!attachment) continue;
    byId.set(attachment.document_id, preferRicher(byId.get(attachment.document_id), attachment));
  }
  return [...byId.values()].slice(0, MAX_ATTACHMENTS_PER_NOTICE);
}

export function bundledAttachments(requestId) {
  return normalizeList(materialization.notices?.[String(requestId)] || [], String(requestId));
}

export function mergeAttachments(requestId, datasetUrls = [], materialized = []) {
  const byUrl = new Map();
  const candidates = [
    ...bundledAttachments(requestId),
    ...normalizeList(materialized, requestId),
  ];
  for (const url of Array.isArray(datasetUrls) ? datasetUrls : []) {
    const candidate = normalizeAttachment({ request_id: requestId, url, source: "dataset" }, requestId);
    if (candidate) candidates.unshift(candidate);
  }
  for (const attachment of candidates) {
    const key = attachment.document_id || attachment.url;
    byUrl.set(key, preferRicher(byUrl.get(key), attachment));
  }
  return [...byUrl.values()].slice(0, 8);
}

async function readBoundedJson(request) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError("body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function ensureSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS notice_attachments (
    request_id TEXT NOT NULL, document_id TEXT NOT NULL, title TEXT, url TEXT NOT NULL,
    content_type TEXT, bytes INTEGER, source TEXT NOT NULL, observed_at TEXT NOT NULL,
    text_status TEXT, text_reason TEXT, text_method TEXT, text_chars INTEGER,
    text_preview TEXT, extracted_text TEXT, text_extracted_at TEXT,
    PRIMARY KEY (request_id, document_id))`).run();
  // Idempotent T1 column add for older D1 instances that already have T0 rows.
  for (const col of [
    "text_status TEXT",
    "text_reason TEXT",
    "text_method TEXT",
    "text_chars INTEGER",
    "text_preview TEXT",
    "extracted_text TEXT",
    "text_extracted_at TEXT",
  ]) {
    try {
      await db.prepare(`ALTER TABLE notice_attachments ADD COLUMN ${col}`).run();
    } catch { /* column already exists */ }
  }
  await db.prepare(`CREATE TABLE IF NOT EXISTS attachment_ingest_receipts (
    run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
    window_start TEXT NOT NULL, window_end TEXT NOT NULL, notices_seen INTEGER NOT NULL,
    notices_scraped INTEGER NOT NULL, attachments_found INTEGER NOT NULL,
    source_cliff_policy TEXT NOT NULL, received_at TEXT NOT NULL)`).run();
}

/** Feed extracted attachment text into the D1 notices haystack (search index). */
export async function refreshNoticeAttachmentHaystack(db, requestId, attachments) {
  if (!db || !requestId) return;
  try {
    const row = await db.prepare("SELECT haystack FROM notices WHERE request_id = ?")
      .bind(requestId).first();
    if (!row) return; // notice not yet mirrored — next ingest can re-merge
    const next = mergeHaystackWithAttachmentText(row.haystack || "", attachments);
    if (next === (row.haystack || "")) return;
    await db.prepare("UPDATE notices SET haystack = ? WHERE request_id = ?")
      .bind(next, requestId).run();
  } catch (error) {
    console.warn("attachment haystack refresh skipped", JSON.stringify({
      request_id: requestId,
      error: String(error?.message || error),
      provenance: TEXT_PROVENANCE,
    }));
  }
}

export async function loadAttachmentMetadata(db, requestIds) {
  const ids = [...new Set(requestIds.map(String).filter(Boolean))];
  const out = new Map(ids.map((id) => [id, bundledAttachments(id)]));
  if (!db || !ids.length) return out;
  try {
    const placeholders = ids.map(() => "?").join(",");
    const { results = [] } = await db.prepare(
      `SELECT request_id, document_id, title, url, content_type, bytes, source,
              text_status, text_reason, text_method, text_chars, text_preview,
              extracted_text, text_extracted_at
       FROM notice_attachments WHERE request_id IN (${placeholders}) ORDER BY request_id, document_id`,
    ).bind(...ids).all();
    const grouped = new Map();
    for (const row of results) {
      const id = String(row.request_id);
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(row);
    }
    for (const id of ids) out.set(id, normalizeList(grouped.get(id) || out.get(id), id));
  } catch (error) {
    // Older schema without text columns: fall back to T0 columns only.
    try {
      const placeholders = ids.map(() => "?").join(",");
      const { results = [] } = await db.prepare(
        `SELECT request_id, document_id, title, url, content_type, bytes, source
         FROM notice_attachments WHERE request_id IN (${placeholders}) ORDER BY request_id, document_id`,
      ).bind(...ids).all();
      const grouped = new Map();
      for (const row of results) {
        const id = String(row.request_id);
        if (!grouped.has(id)) grouped.set(id, []);
        grouped.get(id).push(row);
      }
      for (const id of ids) out.set(id, normalizeList(grouped.get(id) || out.get(id), id));
    } catch (inner) {
      console.warn("attachment metadata read unavailable", JSON.stringify({ error: String(inner?.message || inner) }));
    }
  }
  return out;
}

export async function handleAttachmentMetadata(request, env) {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const url = new URL(request.url);
  if (url.pathname === "/attachment-metadata/receipt") {
    if (!env.DB) return json({ error: "attachment batch receipt unavailable" }, 503);
    try {
      const receipt = await env.DB.prepare(`SELECT run_id, started_at, finished_at, window_start,
        window_end, notices_seen, notices_scraped, attachments_found, source_cliff_policy, received_at
        FROM attachment_ingest_receipts ORDER BY finished_at DESC LIMIT 1`).first();
      if (!receipt) return json({ error: "attachment batch receipt unavailable" }, 503);
      return json({ ok: true, receipt });
    } catch {
      return json({ error: "attachment batch receipt unavailable" }, 503);
    }
  }
  const requestId = cleanText(url.searchParams.get("id"), 40);
  if (!requestId || !/^\d{8,20}$/.test(requestId)) return json({ error: "invalid id" }, 400);
  const metadata = await loadAttachmentMetadata(env.DB, [requestId]);
  const attachments = metadata.get(requestId) || [];
  return Response.json(
    {
      request_id: requestId,
      n_attachments: attachments.length,
      n_with_text: attachments.filter((item) => item.text_status === "ok" && item.extracted_text).length,
      attachments,
    },
    { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=86400" } },
  );
}

export async function handleAdminAttachmentMetadata(request, env) {
  const { checkAdminKey } = await import("./admin.mjs");
  const auth = checkAdminKey(request, env);
  if (!auth.ok) return auth.res;
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body;
  try { body = await readBoundedJson(request); }
  catch (error) { return json({ error: error instanceof RangeError ? "body too large" : "invalid json" }, 400); }
  const notices = Array.isArray(body?.notices) ? body.notices : [];
  if (!body?.receipt || notices.length > MAX_NOTICES) return json({ error: "invalid batch" }, 400);

  await ensureSchema(env.DB);
  const observedAt = new Date().toISOString();
  let attachments = 0;
  let withText = 0;
  for (const notice of notices) {
    const requestId = cleanText(notice?.request_id, 40);
    if (!requestId) return json({ error: "invalid request_id" }, 400);
    const normalized = normalizeList(notice.attachments, requestId);
    attachments += normalized.length;
    withText += normalized.filter((item) => item.extracted_text).length;
    const statements = [env.DB.prepare("DELETE FROM notice_attachments WHERE request_id = ?").bind(requestId)];
    for (const item of normalized) {
      statements.push(env.DB.prepare(`INSERT INTO notice_attachments
        (request_id, document_id, title, url, content_type, bytes, source, observed_at,
         text_status, text_reason, text_method, text_chars, text_preview, extracted_text, text_extracted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          item.request_id,
          item.document_id,
          item.title,
          item.url,
          item.content_type,
          item.bytes,
          item.source,
          observedAt,
          item.text_status || null,
          item.text_reason || null,
          item.text_method || null,
          item.text_chars ?? null,
          item.text_preview || null,
          cleanLongText(item.extracted_text),
          item.text_extracted_at || (item.extracted_text ? observedAt : null),
        ));
    }
    await env.DB.batch(statements);
    // Search index: attachment contents become findable with attachment-text provenance marker.
    await refreshNoticeAttachmentHaystack(env.DB, requestId, normalized);
  }

  const receipt = body.receipt;
  await env.DB.prepare(`INSERT INTO attachment_ingest_receipts
    (run_id, started_at, finished_at, window_start, window_end, notices_seen,
     notices_scraped, attachments_found, source_cliff_policy, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET finished_at=excluded.finished_at,
      notices_seen=excluded.notices_seen, notices_scraped=excluded.notices_scraped,
      attachments_found=excluded.attachments_found, received_at=excluded.received_at`)
    .bind(
      cleanText(receipt.run_id, 100),
      cleanText(receipt.started_at || observedAt, 40),
      cleanText(receipt.finished_at || observedAt, 40),
      cleanText(receipt.window_start || "", 20) || "t1",
      cleanText(receipt.window_end || "", 20) || "t1",
      Number(receipt.notices_seen || receipt.inventory_seen || notices.length || 0),
      Number(receipt.notices_scraped || receipt.docs_attempted || 0),
      Number(receipt.attachments_found || receipt.docs_extracted || attachments || 0),
      cleanText(receipt.source_cliff_policy || "dataset_pre_2025_portal_2025_plus", 80),
      observedAt,
    ).run();
  return json({
    ok: true,
    notices: notices.length,
    attachments,
    with_text: withText,
    search_index: "haystack_attachment_text",
    provenance: TEXT_PROVENANCE,
  });
}

export { joinAttachmentTexts, TEXT_PROVENANCE };
