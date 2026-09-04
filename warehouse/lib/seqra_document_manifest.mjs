/**
 * SEQRA-04: the per-review document manifest.
 *
 * A manifest entry is minted the moment a document *link* is discovered
 * (during a search-result or project-detail-page probe) and only later
 * gains a `document_key` once the hash-preserving fetcher
 * (warehouse/lib/seqra_document_fetcher.mjs) has actually retrieved and
 * hashed the bytes. This two-step lifecycle -- discovered, then fetched --
 * is deliberate: a manifest is a claim about what CEQR Access's search
 * surfaced, which must exist and be inspectable even for a candidate this
 * pipeline has not yet (or could not) fetch.
 */
import { buildReviewDocumentKey } from "./seqra_stable_keys.mjs";

export const SEQRA_DOCUMENT_MANIFEST_SCHEMA = "cityscroll.seqra_review_document_manifest.v1";

export const MANIFEST_ENTRY_STATUSES = Object.freeze([
  "discovered_not_yet_fetched",
  "fetched",
  "fetch_failed",
]);

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required and must be a non-empty string`);
  return value;
}

/**
 * Mint a manifest entry for a document link this pipeline has observed on a
 * CEQR Access search-result or project-detail page, before any fetch has
 * been attempted.
 */
export function buildDiscoveredManifestEntry({
  reviewKey,
  candidateUrl,
  linkText = null,
  discoveredAt,
  discoveryFetchId,
  sourceId = "ceqr_access",
} = {}) {
  requireNonEmptyString(reviewKey, "reviewKey");
  if (!reviewKey.startsWith("environmental_review:")) {
    throw new Error(`reviewKey must be an environmental_review stable key, got ${JSON.stringify(reviewKey)}`);
  }
  requireNonEmptyString(candidateUrl, "candidateUrl");
  requireNonEmptyString(discoveredAt, "discoveredAt");
  requireNonEmptyString(discoveryFetchId, "discoveryFetchId");
  return Object.freeze({
    schema: "cityscroll.seqra_review_document_manifest_entry.v1",
    review_key: reviewKey,
    candidate_url: candidateUrl,
    link_text: linkText,
    discovered_at: discoveredAt,
    discovery_fetch_id: discoveryFetchId,
    source_id: sourceId,
    status: "discovered_not_yet_fetched",
    document_key: null,
    content_hash: null,
    fetch_id: null,
  });
}

/** Advance a manifest entry to `fetched` once the fetcher has hashed real bytes. */
export function markManifestEntryFetched(entry, { documentType, issuedDate, contentHash, fetchId } = {}) {
  if (entry.status !== "discovered_not_yet_fetched") {
    throw new Error(`markManifestEntryFetched: entry for ${entry.candidate_url} is not in discovered_not_yet_fetched (got ${entry.status})`);
  }
  const documentKey = buildReviewDocumentKey({ reviewKey: entry.review_key, documentType, issuedDate, contentHash });
  return Object.freeze({
    ...entry,
    status: "fetched",
    document_key: documentKey,
    content_hash: contentHash,
    fetch_id: fetchId,
  });
}

/** Advance a manifest entry to `fetch_failed` -- the candidate stays listed, never silently dropped. */
export function markManifestEntryFetchFailed(entry, { fetchId, reason } = {}) {
  if (entry.status !== "discovered_not_yet_fetched") {
    throw new Error(`markManifestEntryFetchFailed: entry for ${entry.candidate_url} is not in discovered_not_yet_fetched (got ${entry.status})`);
  }
  return Object.freeze({ ...entry, status: "fetch_failed", fetch_id: fetchId, fetch_failure_reason: reason ?? "unknown" });
}

export function buildReviewDocumentManifest({ reviewKey, generatedAt, entries = [] } = {}) {
  requireNonEmptyString(reviewKey, "reviewKey");
  requireNonEmptyString(generatedAt, "generatedAt");
  for (const entry of entries) {
    if (entry.review_key !== reviewKey) {
      throw new Error(`buildReviewDocumentManifest: entry for ${entry.candidate_url} belongs to review_key ${entry.review_key}, not ${reviewKey}`);
    }
  }
  const byStatus = { discovered_not_yet_fetched: 0, fetched: 0, fetch_failed: 0 };
  for (const entry of entries) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
  return Object.freeze({
    schema: SEQRA_DOCUMENT_MANIFEST_SCHEMA,
    review_key: reviewKey,
    generated_at: generatedAt,
    document_count: entries.length,
    counts_by_status: byStatus,
    entries: Object.freeze([...entries]),
  });
}
