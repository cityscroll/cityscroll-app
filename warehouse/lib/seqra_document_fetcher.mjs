/**
 * SEQRA-04: the hash-preserving document fetcher.
 *
 * Every parsed page in this pipeline must resolve to immutable stored source
 * bytes through a recorded fetch receipt (card acceptance A2). This module
 * makes that structurally true rather than a convention someone has to
 * remember: `documentRawObjectPath` computes a content-addressed (sha256
 * -keyed) storage location under warehouse/raw/, and `buildDocumentFetchReceipt`
 * always carries the resulting content_hash and raw_object_path together, so
 * a caller can never construct a processing record referencing bytes that
 * were not actually written to that exact path.
 *
 * `fetchAndStoreDocument` (network + filesystem IO) takes an injected
 * `httpGet` so tests can drive the hashing/storage/receipt contract without
 * a real HTTP request; `documentRawObjectPath` and `buildDocumentFetchReceipt`
 * are pure and independently testable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildFetchReceipt, contentHashOf, sha256Hex } from "./seqra_fetch_receipt.mjs";

export const SEQRA_DOCUMENT_FETCH_PARSER_VERSION = "seqra04_ceqr_access_document_fetcher.v1";

/**
 * Compute the content-addressed storage location for a document's bytes:
 * warehouse/raw/seqra-ceqr-access/documents/<sha256-hex>.<ext>. Re-fetching
 * byte-identical content resolves to the same path (a safe, idempotent
 * overwrite of identical bytes), so a document observed twice is stored
 * once, never duplicated under two different names.
 */
export function documentRawObjectPath({ bytes, extension = "bin" }) {
  const hex = sha256Hex(bytes);
  return { hex, relPath: path.posix.join("warehouse/raw/seqra-ceqr-access/documents", `${hex}.${extension}`) };
}

/** Build the fetch receipt for one document retrieval; pure, no IO. */
export function buildDocumentFetchReceipt({
  fetchId,
  sourceId,
  requestedAt,
  requestUrlOrQuery,
  httpStatus,
  retrievedAt,
  contentType,
  bytes,
  rawObjectPath,
  warnings = [],
  latencyMs = null,
  purpose = "document_fetch",
}) {
  const byteCount = bytes ? bytes.length : 0;
  const contentHash = bytes ? contentHashOf(bytes) : null;
  return buildFetchReceipt({
    fetchId,
    sourceId,
    requestedAt,
    requestUrlOrQuery,
    httpStatus,
    retrievedAt,
    contentType,
    byteCount,
    contentHash,
    rawObjectPath,
    rowOrDocumentCount: bytes ? 1 : 0,
    paginationComplete: true,
    parserVersion: SEQRA_DOCUMENT_FETCH_PARSER_VERSION,
    warnings,
    latencyMs,
    purpose,
  });
}

function extensionFromContentType(contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("pdf")) return "pdf";
  if (ct.includes("html")) return "html";
  if (ct.includes("plain")) return "txt";
  return "bin";
}

/**
 * Fetch one document's bytes via an injected `httpGet` (so tests never touch
 * the network), store them content-addressed under
 * `<projectRoot>/warehouse/raw/seqra-ceqr-access/documents/`, and return the
 * bytes alongside their fetch receipt. `httpGet(url)` must resolve to
 * `{ status, headers: Map|Headers-like, bytes: Buffer }`.
 */
export async function fetchAndStoreDocument({ url, sourceId = "ceqr_access", httpGet, projectRoot, fetchId, purpose = "document_fetch" }) {
  const requestedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  let result;
  let errorMessage = null;
  try {
    result = await httpGet(url);
  } catch (error) {
    errorMessage = `request failed: ${error.message}`;
  }
  const latencyMs = Date.now() - startedAtMs;
  const retrievedAt = new Date().toISOString();

  if (errorMessage || !result?.bytes) {
    const receipt = buildDocumentFetchReceipt({
      fetchId,
      sourceId,
      requestedAt,
      requestUrlOrQuery: url,
      httpStatus: result?.status ?? null,
      retrievedAt,
      contentType: null,
      bytes: null,
      rawObjectPath: null,
      warnings: [errorMessage ?? "no bytes returned"],
      latencyMs,
      purpose,
    });
    return { ok: false, bytes: null, fetchReceipt: receipt };
  }

  const contentType = typeof result.headers?.get === "function" ? result.headers.get("content-type") : result.headers?.["content-type"] ?? null;
  const extension = extensionFromContentType(contentType);
  const { hex, relPath } = documentRawObjectPath({ bytes: result.bytes, extension });
  const absPath = path.join(projectRoot, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, result.bytes);

  const warnings = [];
  if (result.status != null && (result.status < 200 || result.status >= 300)) warnings.push(`non-2xx http_status ${result.status}`);

  const receipt = buildDocumentFetchReceipt({
    fetchId,
    sourceId,
    requestedAt,
    requestUrlOrQuery: url,
    httpStatus: result.status ?? null,
    retrievedAt,
    contentType,
    bytes: result.bytes,
    rawObjectPath: relPath,
    warnings,
    latencyMs,
    purpose,
  });

  return { ok: result.status == null || (result.status >= 200 && result.status < 300), bytes: result.bytes, contentHash: `sha256:${hex}`, rawObjectPath: relPath, fetchReceipt: receipt };
}
