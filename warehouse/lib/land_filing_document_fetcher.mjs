/**
 * LDP-24: the ZAP filing-document collector's own binding of the
 * publisher-neutral document-fetcher interface
 * (warehouse/lib/document_processing.mjs, LDP-33) to this pipeline. This
 * module supplies the storage namespace and parser version LDP-24 uses; it
 * holds no private copy of the hash-preserving fetch/content-addressed
 * storage logic itself -- that logic lives once, in the shared interface,
 * exactly as SEQRA-04's warehouse/lib/seqra_document_fetcher.mjs already
 * does for CEQR Access.
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

export const LAND_FILING_DOCUMENT_FETCH_RECEIPT_SCHEMA = "cityscroll.land_filing_document_fetch_receipt.v1";
export const LAND_FILING_DOCUMENT_FETCH_PARSER_VERSION = "ldp24_zap_filing_document_fetcher.v1";
const STORAGE_NAMESPACE = "zap-filing-documents";

/**
 * Compute the content-addressed storage location for a document's bytes:
 * warehouse/raw/zap-filing-documents/documents/<sha256-hex>.<ext>. Re-fetching
 * byte-identical content resolves to the same path, so a document observed
 * twice (e.g. the same package re-submitted under a new publisher id) is
 * stored once, never duplicated under two different names.
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
    schema: LAND_FILING_DOCUMENT_FETCH_RECEIPT_SCHEMA,
    fetchId,
    sourceId,
    requestedAt,
    requestUrlOrQuery,
    httpStatus,
    retrievedAt,
    contentType,
    bytes,
    rawObjectPath,
    parserVersion: LAND_FILING_DOCUMENT_FETCH_PARSER_VERSION,
    warnings,
    latencyMs,
    purpose,
  });
}

/**
 * Fetch one document's bytes via an injected `httpGet` (so tests never touch
 * the network), store them content-addressed under
 * `<projectRoot>/warehouse/raw/zap-filing-documents/documents/`, and return
 * the bytes alongside their fetch receipt. `httpGet(url)` must resolve to
 * `{ status, headers: Map|Headers-like, bytes: Buffer }`.
 */
export async function fetchAndStoreDocument({ url, sourceId = "zap_outcomes", httpGet, projectRoot, fetchId, purpose = "document_fetch" }) {
  return fetchAndStoreDocumentGeneric({
    url,
    sourceId,
    httpGet,
    projectRoot,
    fetchId,
    storageNamespace: STORAGE_NAMESPACE,
    parserVersion: LAND_FILING_DOCUMENT_FETCH_PARSER_VERSION,
    schema: LAND_FILING_DOCUMENT_FETCH_RECEIPT_SCHEMA,
    purpose,
  });
}
