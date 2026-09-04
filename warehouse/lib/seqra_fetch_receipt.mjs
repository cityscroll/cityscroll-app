/**
 * SEQRA-04: the one fetch-receipt shape every CEQR Access probe and document
 * fetch in this pipeline emits, matching the commission's SOURCE RECEIPTS
 * contract field-for-field (fetch_id, source_id, requested_at,
 * request_url_or_query, http_status, retrieved_at, source_vintage,
 * content_type, byte_count, content_hash, raw_object_path,
 * row_or_document_count, pagination_complete, parser_version, warnings) --
 * the same fifteen fields `tools/build_seqra_source_inventory.mjs`'s
 * `fetchAndReceipt` already emits for SEQRA-01. Centralized here so the
 * discovery probe and the document fetcher can never drift apart on shape.
 *
 * Pure and IO-free: every field is supplied by the caller, who owns the
 * actual network request. `buildFetchReceipt` only validates and normalizes.
 *
 * `sha256Hex`/`contentHashOf` are the publisher-neutral hasher (LDP-33,
 * warehouse/lib/document_processing.mjs) and are re-exported here so existing
 * importers of this file are unaffected by that move.
 */
export { sha256Hex, contentHashOf } from "./document_processing.mjs";

export const SEQRA_FETCH_RECEIPT_SCHEMA = "cityscroll.seqra_fetch_receipt.v1";

const REQUIRED_STRING_FIELDS = [
  "fetchId",
  "sourceId",
  "requestedAt",
  "requestUrlOrQuery",
  "retrievedAt",
  "parserVersion",
];

/**
 * Build one fetch receipt. `httpStatus` may be `null` when a request never
 * completed (e.g. a timeout) -- callers must still emit a receipt for an
 * attempted-but-failed fetch rather than silently dropping the attempt, so a
 * discovery receipt's history is a complete account of what was tried.
 */
export function buildFetchReceipt(input = {}) {
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = input[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`buildFetchReceipt: ${field} is required and must be a non-empty string`);
    }
  }
  if (input.httpStatus != null && !Number.isInteger(input.httpStatus)) {
    throw new Error("buildFetchReceipt: httpStatus must be an integer or null");
  }
  if (input.byteCount != null && (!Number.isFinite(input.byteCount) || input.byteCount < 0)) {
    throw new Error("buildFetchReceipt: byteCount must be a non-negative number or null");
  }
  return Object.freeze({
    schema: SEQRA_FETCH_RECEIPT_SCHEMA,
    fetch_id: input.fetchId,
    source_id: input.sourceId,
    requested_at: input.requestedAt,
    request_url_or_query: input.requestUrlOrQuery,
    http_status: input.httpStatus ?? null,
    retrieved_at: input.retrievedAt,
    source_vintage: input.sourceVintage ?? input.retrievedAt,
    content_type: input.contentType ?? null,
    byte_count: input.byteCount ?? null,
    content_hash: input.contentHash ?? null,
    raw_object_path: input.rawObjectPath ?? null,
    row_or_document_count: Number.isFinite(input.rowOrDocumentCount) ? input.rowOrDocumentCount : 0,
    pagination_complete: input.paginationComplete !== false,
    parser_version: input.parserVersion,
    warnings: Object.freeze([...(input.warnings ?? [])]),
    latency_ms: Number.isFinite(input.latencyMs) ? input.latencyMs : null,
    purpose: input.purpose ?? null,
  });
}

/** Deterministic fetch_id: `${prefix}-${counter, zero-padded to 4}`. */
export function makeFetchIdSequence(prefix) {
  let counter = 0;
  return function nextFetchId() {
    counter += 1;
    return `${prefix}-${String(counter).padStart(4, "0")}`;
  };
}
