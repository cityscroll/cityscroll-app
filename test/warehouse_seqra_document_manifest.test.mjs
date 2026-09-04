import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDiscoveredManifestEntry,
  buildReviewDocumentManifest,
  markManifestEntryFetchFailed,
  markManifestEntryFetched,
} from "../warehouse/lib/seqra_document_manifest.mjs";

const REVIEW_KEY = "environmental_review:ceqr:26DCP139X";

describe("seqra_document_manifest", () => {
  it("mints a discovered entry with no document_key until fetched", () => {
    const entry = buildDiscoveredManifestEntry({
      reviewKey: REVIEW_KEY,
      candidateUrl: "https://a002-ceqraccess.nyc.gov/ceqr/document/123",
      discoveredAt: "2026-09-04T00:00:00.000Z",
      discoveryFetchId: "seqra04-discovery-fetch-0003",
    });
    assert.equal(entry.status, "discovered_not_yet_fetched");
    assert.equal(entry.document_key, null);
  });

  it("rejects a reviewKey that is not an environmental_review stable key", () => {
    assert.throws(() => buildDiscoveredManifestEntry({
      reviewKey: "not-a-review-key",
      candidateUrl: "https://example.com/doc",
      discoveredAt: "2026-09-04T00:00:00.000Z",
      discoveryFetchId: "fetch-1",
    }));
  });

  it("advances an entry to fetched with a derived document_key once bytes are hashed", () => {
    const entry = buildDiscoveredManifestEntry({
      reviewKey: REVIEW_KEY,
      candidateUrl: "https://a002-ceqraccess.nyc.gov/ceqr/document/123",
      discoveredAt: "2026-09-04T00:00:00.000Z",
      discoveryFetchId: "seqra04-discovery-fetch-0003",
    });
    const fetched = markManifestEntryFetched(entry, {
      documentType: "deis",
      issuedDate: "2024-03-01",
      contentHash: "sha256:abcdefabcdef1234567890",
      fetchId: "seqra04-doc-fetch-0001",
    });
    assert.equal(fetched.status, "fetched");
    assert.equal(fetched.document_key, `review_document:${REVIEW_KEY}:deis:2024-03-01:abcdefabcdef`);
  });

  it("refuses to re-mark an already-fetched entry", () => {
    const entry = buildDiscoveredManifestEntry({
      reviewKey: REVIEW_KEY,
      candidateUrl: "https://a002-ceqraccess.nyc.gov/ceqr/document/123",
      discoveredAt: "2026-09-04T00:00:00.000Z",
      discoveryFetchId: "fetch-1",
    });
    const fetched = markManifestEntryFetched(entry, { documentType: "deis", issuedDate: "2024-03-01", contentHash: "sha256:abcdefabcdef1234567890", fetchId: "fetch-2" });
    assert.throws(() => markManifestEntryFetched(fetched, { documentType: "deis", issuedDate: "2024-03-01", contentHash: "sha256:abcdefabcdef1234567890", fetchId: "fetch-3" }));
  });

  it("marks a fetch failure without dropping the candidate from the manifest", () => {
    const entry = buildDiscoveredManifestEntry({
      reviewKey: REVIEW_KEY,
      candidateUrl: "https://a002-ceqraccess.nyc.gov/ceqr/document/404",
      discoveredAt: "2026-09-04T00:00:00.000Z",
      discoveryFetchId: "fetch-1",
    });
    const failed = markManifestEntryFetchFailed(entry, { fetchId: "fetch-2", reason: "http_404" });
    assert.equal(failed.status, "fetch_failed");
    assert.equal(failed.candidate_url, entry.candidate_url);
  });

  it("builds a manifest and rejects an entry whose review_key does not match", () => {
    const entry = buildDiscoveredManifestEntry({
      reviewKey: "environmental_review:ceqr:99ZZZ999Z",
      candidateUrl: "https://a002-ceqraccess.nyc.gov/ceqr/document/999",
      discoveredAt: "2026-09-04T00:00:00.000Z",
      discoveryFetchId: "fetch-1",
    });
    assert.throws(() => buildReviewDocumentManifest({ reviewKey: REVIEW_KEY, generatedAt: "2026-09-04T00:00:00.000Z", entries: [entry] }));
  });

  it("reports counts_by_status across a mixed manifest", () => {
    const discovered = buildDiscoveredManifestEntry({ reviewKey: REVIEW_KEY, candidateUrl: "https://example.com/a", discoveredAt: "2026-09-04T00:00:00.000Z", discoveryFetchId: "fetch-1" });
    const fetched = markManifestEntryFetched(
      buildDiscoveredManifestEntry({ reviewKey: REVIEW_KEY, candidateUrl: "https://example.com/b", discoveredAt: "2026-09-04T00:00:00.000Z", discoveryFetchId: "fetch-1" }),
      { documentType: "deis", issuedDate: "2024-03-01", contentHash: "sha256:abcdefabcdef1234567890", fetchId: "fetch-2" },
    );
    const manifest = buildReviewDocumentManifest({ reviewKey: REVIEW_KEY, generatedAt: "2026-09-04T00:00:00.000Z", entries: [discovered, fetched] });
    assert.equal(manifest.document_count, 2);
    assert.equal(manifest.counts_by_status.discovered_not_yet_fetched, 1);
    assert.equal(manifest.counts_by_status.fetched, 1);
  });
});
