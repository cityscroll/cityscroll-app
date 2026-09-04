/**
 * SEQRA-03: shared engine for the six structured-source adapters (CEQR
 * Projects, CEQR Milestones, ZAP Projects, ZAP BBL, DEC ENB notice metadata,
 * DEC DART). This module holds only the reusable, source-agnostic
 * mechanism -- hashing, fetch-receipt shape, paginated-walk completeness,
 * schema-drift detection, and named-vintage raw-snapshot immutability. Every
 * per-source field list, dataset id, and parser lives in
 * warehouse/lib/seqra_structured_adapter_sources.mjs; every fs/network side
 * effect and receipt assembly lives in
 * tools/build_seqra_structured_adapters.mjs.
 *
 * The vintage model: a vintage label names one immutable, already-captured
 * fetch. There is no "refresh a vintage" operation -- re-fetching a named
 * vintage means re-reading the raw bytes retained the first time that label
 * was used (retainRawSnapshot refuses a second write under the same label
 * whose bytes differ), so A1 (identical hashes on re-run) holds by
 * construction rather than by hoping a live publisher returns the same
 * bytes twice. New source state always gets a new vintage label.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SEQRA_ADAPTER_FETCH_RECEIPT_SCHEMA = "cityscroll.seqra_adapter_fetch_receipt.v1";
export const SEQRA_ADAPTER_PARSER_VERSION = "seqra_structured_adapter.v1";

/** A publisher schema change: a field this adapter depends on is no longer advertised. */
export class SeqraSchemaDriftError extends Error {
  constructor(sourceId, missingFields, observedFields) {
    super(
      `${sourceId}: schema drift -- the publisher no longer exposes required field(s) ` +
      `${missingFields.join(", ")} (observed: ${observedFields.length ? observedFields.join(", ") : "none"})`,
    );
    this.name = "SeqraSchemaDriftError";
    this.sourceId = sourceId;
    this.missingFields = missingFields;
    this.observedFields = observedFields;
  }
}

/** A bounded page walk hit its page cap while the last page was still full. */
export class SeqraPaginationIncompleteError extends Error {
  constructor(sourceId, pagesFetched, rowCount, maxPages) {
    super(
      `${sourceId}: pagination incomplete after ${pagesFetched} page(s) / ${rowCount} row(s) -- ` +
      `hit the ${maxPages}-page bound while the last page was still full; refusing to report a ` +
      `possibly-truncated population as the whole one`,
    );
    this.name = "SeqraPaginationIncompleteError";
    this.sourceId = sourceId;
    this.pagesFetched = pagesFetched;
    this.rowCount = rowCount;
    this.maxPages = maxPages;
  }
}

/** A named vintage already holds different raw bytes than this fetch produced. */
export class SeqraVintageImmutableError extends Error {
  constructor(sourceId, vintage, rawObjectPath) {
    super(
      `${sourceId}: vintage "${vintage}" already has retained raw bytes at ${rawObjectPath} that do ` +
      `not match this fetch -- a vintage is immutable once captured; use a new vintage label for new ` +
      `source state, never overwrite an existing one`,
    );
    this.name = "SeqraVintageImmutableError";
    this.sourceId = sourceId;
    this.vintage = vintage;
    this.rawObjectPath = rawObjectPath;
  }
}

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function contentHashOf(text) {
  return `sha256:${sha256Hex(text)}`;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function stableJson(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

/**
 * A publisher schema change must fail the adapter visibly (A3) rather than
 * silently parsing whatever fields happen to still be there. `observedFields`
 * should come from the publisher's own dataset metadata (authoritative
 * column list), never from the sparsely-null fields of one sampled row.
 */
export function assertNoSchemaDrift({ sourceId, requiredFields, observedFields }) {
  const present = new Set(observedFields);
  const missing = requiredFields.filter((field) => !present.has(field));
  if (missing.length) throw new SeqraSchemaDriftError(sourceId, missing, [...observedFields].sort());
}

export function buildFetchReceipt({
  fetchId,
  sourceId,
  requestedAt,
  requestUrlOrQuery,
  httpStatus,
  retrievedAt,
  sourceVintage,
  contentType,
  byteCount,
  contentHash,
  rawObjectPath,
  rowOrDocumentCount,
  paginationComplete,
  parserVersion = SEQRA_ADAPTER_PARSER_VERSION,
  warnings = [],
}) {
  return {
    schema: SEQRA_ADAPTER_FETCH_RECEIPT_SCHEMA,
    fetch_id: fetchId,
    source_id: sourceId,
    requested_at: requestedAt,
    request_url_or_query: requestUrlOrQuery,
    http_status: httpStatus,
    retrieved_at: retrievedAt,
    source_vintage: sourceVintage,
    content_type: contentType,
    byte_count: byteCount,
    content_hash: contentHash,
    raw_object_path: rawObjectPath,
    row_or_document_count: rowOrDocumentCount,
    pagination_complete: paginationComplete,
    parser_version: parserVersion,
    warnings,
  };
}

/**
 * Retain one raw page's bytes under a named vintage. The first write for a
 * (sourceId, vintage, slug) triple is canonical; every later call with the
 * same triple must reproduce byte-identical text or the vintage is treated
 * as corrupted (SeqraVintageImmutableError) rather than silently overwritten.
 *
 * `rootAbs` is the absolute directory raw snapshots are written under for
 * this run (a gitignored live-fetch cache, or a committed fixtures tree --
 * the caller decides); `rootRel` is the repo-relative prefix recorded on
 * `raw_object_path` in fetch receipts.
 */
export function retainRawSnapshot({ rootAbs, rootRel, sourceId, vintage, slug, text }) {
  const relPath = path.posix.join(rootRel, sourceId, vintage, `${slug}.json`);
  const absPath = path.join(rootAbs, sourceId, vintage, `${slug}.json`);
  const contentHash = contentHashOf(text);
  const byteCount = Buffer.byteLength(text, "utf8");
  if (existsSync(absPath)) {
    const existing = readFileSync(absPath, "utf8");
    if (existing !== text) throw new SeqraVintageImmutableError(sourceId, vintage, relPath);
  } else {
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, text);
  }
  return { rawObjectPath: relPath, byteCount, contentHash };
}

export function readRawSnapshot({ rootAbs, sourceId, vintage, slug }) {
  const absPath = path.join(rootAbs, sourceId, vintage, `${slug}.json`);
  if (!existsSync(absPath)) return null;
  return readFileSync(absPath, "utf8");
}

/**
 * Walk a paginated source to completion. `fetchPage(offset, limit)` returns
 * `{ rows, ...pageMeta }` for one page. The walk is "complete" only when a
 * page returns fewer rows than `pageSize` (a short/empty page proves there
 * is nothing more within this fetch's declared scope); if the page cap is
 * hit while the last page was still full, the walk throws rather than
 * returning a receipt that could be misread as the whole population (G2).
 */
export async function paginateToCompletion({ sourceId, pageSize, maxPages, fetchPage }) {
  const pages = [];
  let offset = 0;
  while (true) {
    if (pages.length >= maxPages) {
      const rowCount = pages.reduce((sum, page) => sum + page.rows.length, 0);
      throw new SeqraPaginationIncompleteError(sourceId, pages.length, rowCount, maxPages);
    }
    // eslint-disable-next-line no-await-in-loop
    const page = await fetchPage(offset, pageSize);
    pages.push(page);
    offset += page.rows.length;
    if (page.rows.length < pageSize) break;
  }
  return { pages, rows: pages.flatMap((page) => page.rows), paginationComplete: true };
}
