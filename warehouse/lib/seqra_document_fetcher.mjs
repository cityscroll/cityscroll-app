/**
 * SEQRA-04: CEQR Access's own binding of the publisher-neutral document
 * -fetcher interface (warehouse/lib/document_processing.mjs, LDP-33) to this
 * specific source. This module supplies the storage namespace, parser
 * version, and receipt schema this pipeline has always used, and holds no
 * private copy of the hash-preserving fetch/content-addressed storage logic
 * itself -- that logic lives once, in the shared interface.
 *
 * Every parsed page in this pipeline must resolve to immutable stored source
 * bytes through a recorded fetch receipt (card acceptance A2). That remains
 * structurally true here: `documentRawObjectPath` and
 * `buildDocumentFetchReceipt` always carry the resulting content_hash and
 * raw_object_path together, so a caller can never construct a processing
 * record referencing bytes that were not actually written to that exact
 * path.
 *
 * `fetchAndStoreDocument` (network + filesystem IO) takes an injected
 * `httpGet` so tests can drive the hashing/storage/receipt contract without
 * a real HTTP request; `documentRawObjectPath` and `buildDocumentFetchReceipt`
 * are pure and independently testable.
 */
import {
  buildDocumentFetchReceipt as buildDocumentFetchReceiptGeneric,
  documentRawObjectPath as documentRawObjectPathGeneric,
  fetchAndStoreDocument as fetchAndStoreDocumentGeneric,
} from "./document_processing.mjs";
import { SEQRA_FETCH_RECEIPT_SCHEMA } from "./seqra_fetch_receipt.mjs";

export const SEQRA_DOCUMENT_FETCH_PARSER_VERSION = "seqra04_ceqr_access_document_fetcher.v1";
const STORAGE_NAMESPACE = "seqra-ceqr-access";

/**
 * Compute the content-addressed storage location for a document's bytes:
 * warehouse/raw/seqra-ceqr-access/documents/<sha256-hex>.<ext>. Re-fetching
 * byte-identical content resolves to the same path (a safe, idempotent
 * overwrite of identical bytes), so a document observed twice is stored
 * once, never duplicated under two different names.
 */
export function documentRawObjectPath({ bytes, extension = "bin" }) {
  return documentRawObjectPathGeneric({ bytes, extension, storageNamespace: STORAGE_NAMESPACE });
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
  return buildDocumentFetchReceiptGeneric({
    schema: SEQRA_FETCH_RECEIPT_SCHEMA,
    fetchId,
    sourceId,
    requestedAt,
    requestUrlOrQuery,
    httpStatus,
    retrievedAt,
    contentType,
    bytes,
    rawObjectPath,
    parserVersion: SEQRA_DOCUMENT_FETCH_PARSER_VERSION,
    warnings,
    latencyMs,
    purpose,
  });
}

/**
 * Fetch one document's bytes via an injected `httpGet` (so tests never touch
 * the network), store them content-addressed under
 * `<projectRoot>/warehouse/raw/seqra-ceqr-access/documents/`, and return the
 * bytes alongside their fetch receipt. `httpGet(url)` must resolve to
 * `{ status, headers: Map|Headers-like, bytes: Buffer }`.
 */
export async function fetchAndStoreDocument({ url, sourceId = "ceqr_access", httpGet, projectRoot, fetchId, purpose = "document_fetch" }) {
  return fetchAndStoreDocumentGeneric({
    url,
    sourceId,
    httpGet,
    projectRoot,
    fetchId,
    storageNamespace: STORAGE_NAMESPACE,
    parserVersion: SEQRA_DOCUMENT_FETCH_PARSER_VERSION,
    schema: SEQRA_FETCH_RECEIPT_SCHEMA,
    purpose,
  });
}
