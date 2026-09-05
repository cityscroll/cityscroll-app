/**
 * LDP-24: wires a real collector to the `land-use-filing-document` contract
 * LDP-23 registered (ontology/registry.v0.json, ontology/land_use_filing.mjs)
 * and LDP-22's census measured against
 * (warehouse/lib/land_filing_evidence_census.mjs#extractZapFilingManifest).
 *
 * This module is the warehouse-side, unbounded manifest: every artifact- and
 * package-kind document LDP-22's census extraction discovers on a ZAP
 * project is carried through to a typed `land_use_filing_document.v1` record,
 * never truncated and never deduped by name. It never replaces
 * worker/src/lib/zap_outcomes.mjs's own resident-facing document digest --
 * that module keeps its own bounded, id-deduped `documents` field for the
 * live API response (Bound only the resident digest, never the warehouse
 * manifest). CEQR Access links stay out of scope here: SEQRA-04 owns that
 * acquisition path, and the ontology's own `ceqr_document_link` document type
 * is not populated by this collector.
 *
 * Identity (per ontology/land_use_filing.mjs#landUseFilingDocumentId) is
 * derived from the project, the publisher's own document id, and the clock
 * this pipeline first observed it at -- never from a filename. Re-running
 * this collector against an unchanged project must not mint a new
 * `first_observed_at` for a document already seen: `previousDocuments` lets a
 * caller pass the last committed manifest so identity is stable across
 * reruns, and only a genuinely new publisher-document-id, or the same
 * publisher-document-id resurfacing with a different `publisher_created_at`
 * (a same-name/different-hash re-upload), mints a new occurrence.
 */
import { extractZapFilingManifest } from "./land_filing_evidence_census.mjs";
import {
  assessPageQuality,
  summarizeDocumentExtractionQuality,
} from "./document_processing.mjs";
import {
  LAND_FILING_DOCUMENT_FETCH_PARSER_VERSION,
  fetchAndStoreDocument,
} from "./land_filing_document_fetcher.mjs";
import {
  FILING_DOCUMENT_TYPES,
  buildLandUseFilingDocument,
} from "../../ontology/land_use_filing.mjs";
import { documentProxyUrl } from "../../worker/src/lib/zap_outcomes.mjs";

export const LAND_FILING_DOCUMENT_MANIFEST_SCHEMA = "cityscroll.land_filing_document_manifest.v1";
export const LDP24_CLASSIFIER_VERSION = "ldp24_zap_document_classifier.v1";
export const LDP24_DISCOVERY_ENDPOINT_TEMPLATE = "https://zap-api-production.herokuapp.com/projects/{project_id}";

// LDP-22's classifyZapArtifactGroup speaks a finer method vocabulary than the
// ontology's three-method classification_order; this is the one place that
// translation happens, so it can never drift between two private copies.
const CENSUS_METHOD_TO_ONTOLOGY_METHOD = Object.freeze({
  explicit_publisher_relationship_type: "explicit_publisher_type_or_group",
  title_token_strong: "title_token_plus_markers",
  no_match: "unknown",
});

/**
 * Strip a rotating/signed query string or fragment off a ZAP
 * `serverRelativeUrl`-derived source id before it becomes identity or a
 * canonical reference. A signed retrieval token is a retrieval detail, not a
 * document identity: the same underlying document fetched today and next
 * week under two different tokens must resolve to the same
 * publisher_document_id, never two.
 */
export function normalizeZapSourceId(rawSourceId) {
  const s = String(rawSourceId || "").trim();
  if (!s) return null;
  const stripped = s.split(/[?#]/)[0].trim().replace(/^\/+/, "");
  return stripped || null;
}

/**
 * Translate one LDP-22 census classification result into the ontology's
 * document_type + classification.method/evidence/confidence shape. A census
 * document_type outside the ontology's registered enum (e.g. a title-token
 * match like `docket` or `cpc_presentation` that LDP-23 never registered as
 * its own type) is carried forward as `other` with the finer-grained match
 * preserved in `evidence`, rather than silently dropped or forced into an
 * unrelated enum member.
 */
export function mapCensusClassification(censusClassification = {}) {
  const rawType = censusClassification.document_type ?? "unknown";
  const rawMethod = censusClassification.method ?? "no_match";
  const ontologyMethod = CENSUS_METHOD_TO_ONTOLOGY_METHOD[rawMethod] ?? "unknown";

  if (rawType === "unknown" || ontologyMethod === "unknown") {
    return {
      document_type: "unknown",
      classification: { method: "unknown", evidence: [], confidence: "unknown", classifier_version: LDP24_CLASSIFIER_VERSION },
    };
  }

  const documentType = FILING_DOCUMENT_TYPES.includes(rawType) ? rawType : "other";
  const evidence = [];
  if (rawType !== documentType) {
    evidence.push(`LDP-22 census classified this group as "${rawType}", which LDP-23's registered document_types does not name; carried forward as "other"`);
  }
  if (censusClassification.matched_token) {
    evidence.push(`ZAP publisher group title matched /${censusClassification.matched_token}/ (census document_type: ${rawType})`);
  }
  if (censusClassification.evidence?.relationship_type === "packages") {
    evidence.push(`explicit ZAP relationship type "packages" (dcp-packagetype=${JSON.stringify(censusClassification.evidence.package_type_raw ?? null)})`);
  }
  if (!evidence.length) evidence.push(`LDP-24 collector classification via census method "${rawMethod}"`);

  return {
    document_type: documentType,
    classification: {
      method: ontologyMethod,
      evidence,
      confidence: censusClassification.confidence ?? "unknown",
      classifier_version: LDP24_CLASSIFIER_VERSION,
    },
  };
}

/** The previously committed occurrence of a document, matched by publisher id AND publisher_created_at, or null for a genuinely new occurrence. */
function findMatchingPreviousDocument({ previousByPublisherId, publisherDocumentId, publisherCreatedAt = null }) {
  const previous = previousByPublisherId?.get(publisherDocumentId);
  if (!previous || !previous.length) return null;
  return previous.find((doc) => (doc.publisher_created_at ?? null) === publisherCreatedAt) ?? null;
}

/**
 * Resolve the `first_observed_at` clock for one publisher_document_id
 * against the last committed manifest for this project. Reuses the previous
 * occurrence's clock when the same document (same publisher id, same
 * publisher_created_at) was already observed -- deterministic reruns must
 * never mint a new identity for an unchanged document. A publisher id
 * resurfacing with a *different* publisher_created_at is a genuinely new
 * occurrence (a same-name/different-hash re-upload under an unchanged
 * publisher id) and gets this run's clock, coexisting with the earlier one.
 */
export function reconcileFirstObservedAt({ previousByPublisherId, publisherDocumentId, publisherCreatedAt = null, observedAt }) {
  const matching = findMatchingPreviousDocument({ previousByPublisherId, publisherDocumentId, publisherCreatedAt });
  return matching ? matching.first_observed_at : observedAt;
}

/**
 * Resolve both `first_observed_at` and `available_to_public_at` for one
 * document occurrence together. `available_to_public_at` must never advance
 * on a rerun for a document already observed: an as-of projection
 * (ontology/land_use_filing.mjs#projectLandUseFilingAsOf) over an unchanged
 * document must return the same visibility on every rerun, not silently
 * report it as newly available every time the collector happens to run.
 */
function reconcileDocumentClock({ previousByPublisherId, publisherDocumentId, publisherCreatedAt = null, observedAt, availableToPublicAtDefault }) {
  const matching = findMatchingPreviousDocument({ previousByPublisherId, publisherDocumentId, publisherCreatedAt });
  if (matching) return { firstObservedAt: matching.first_observed_at, availableToPublicAt: matching.available_to_public_at };
  return { firstObservedAt: observedAt, availableToPublicAt: availableToPublicAtDefault };
}

function indexPreviousDocumentsByPublisherId(previousDocuments, projectRef) {
  const byId = new Map();
  for (const doc of previousDocuments || []) {
    if (!doc || doc.project_ref !== projectRef) continue;
    if (!byId.has(doc.publisher_document_id)) byId.set(doc.publisher_document_id, []);
    byId.get(doc.publisher_document_id).push(doc);
  }
  return byId;
}

/**
 * Collect the complete, unbounded `land_use_filing_document.v1` manifest for
 * one ZAP project payload. Never truncates and never merges two documents
 * that carry distinct publisher_document_id/first_observed_at identity, no
 * matter how many entries the payload carries or how many share a name.
 */
export function collectLandFilingDocuments(payload, {
  projectId,
  observedAt,
  availableToPublicAt = observedAt,
  discoveryEndpoint,
  previousDocuments = [],
} = {}) {
  if (!projectId) throw new Error("collectLandFilingDocuments: projectId is required");
  if (!observedAt) throw new Error("collectLandFilingDocuments: observedAt is required");

  const projectRef = `project:${projectId}`;
  const endpoint = discoveryEndpoint || LDP24_DISCOVERY_ENDPOINT_TEMPLATE.replace("{project_id}", projectId);
  const manifest = extractZapFilingManifest(payload, { projectId });
  const previousByPublisherId = indexPreviousDocumentsByPublisherId(previousDocuments, projectRef);

  const warnings = [...manifest.warnings];
  let unidentifiedCount = 0;

  // Two raw entries can legitimately name the exact same underlying document
  // (e.g. the same file referenced from two artifact groups, or the same
  // path surfacing under two rotating signed tokens) -- once normalized,
  // those collapse to one identity key and must become one manifest entry,
  // never two rows sharing one document_id. A `seenAt` map (keyed by
  // publisher id + publisher_created_at, in first-seen order) implements
  // exactly that collapse while leaving every other, genuinely distinct
  // identity untouched.
  const seenAt = new Map();

  manifest.documents.forEach((rawDoc, index) => {
    const normalizedId = normalizeZapSourceId(rawDoc.source_id);
    let publisherDocumentId = normalizedId;
    if (!publisherDocumentId) {
      unidentifiedCount += 1;
      publisherDocumentId = `unidentified:${rawDoc.group_kind || "unknown"}:${rawDoc.group_id || "no-group"}:${index}`;
      warnings.push(
        `document at manifest index ${index} (name=${JSON.stringify(rawDoc.name)}) carries no publisher source id; ` +
        `assigned a synthetic identity (${publisherDocumentId}) so it stays reachable rather than dropped`,
      );
    }
    const publisherCreatedAt = rawDoc.time_created ?? null;
    const identityKey = `${publisherDocumentId}::${publisherCreatedAt ?? ""}`;
    if (seenAt.has(identityKey)) {
      warnings.push(`document at manifest index ${index} (name=${JSON.stringify(rawDoc.name)}) resolves to the same identity as an earlier entry in this payload (publisher_document_id=${publisherDocumentId}); collapsed, not duplicated`);
      return;
    }

    const { document_type: documentType, classification } = mapCensusClassification(rawDoc.classification);
    const { firstObservedAt, availableToPublicAt: resolvedAvailableToPublicAt } = reconcileDocumentClock({
      previousByPublisherId,
      publisherDocumentId,
      publisherCreatedAt,
      observedAt,
      availableToPublicAtDefault: availableToPublicAt,
    });
    const canonicalPublicUrl = normalizedId
      ? documentProxyUrl(rawDoc.group_kind === "artifacts" ? "artifact" : "package", normalizedId)
      : null;

    seenAt.set(identityKey, buildLandUseFilingDocument({
      project_ref: projectRef,
      document_type: documentType,
      publisher_group_id: rawDoc.group_id ?? null,
      publisher_group_title: rawDoc.group_title ?? null,
      publisher_document_id: publisherDocumentId,
      original_name: rawDoc.name || "(untitled document)",
      canonical_public_url: canonicalPublicUrl,
      discovery_endpoint: endpoint,
      publisher_created_at: publisherCreatedAt,
      first_observed_at: firstObservedAt,
      available_to_public_at: resolvedAvailableToPublicAt,
      retrieval_status: "not_attempted",
      classification,
    }));
  });

  const documents = [...seenAt.values()];

  return Object.freeze({
    schema: LAND_FILING_DOCUMENT_MANIFEST_SCHEMA,
    project_id: projectId,
    project_ref: projectRef,
    generated_at: observedAt,
    ok: manifest.ok,
    document_count: documents.length,
    unidentified_count: unidentifiedCount,
    documents: Object.freeze(documents),
    warnings: Object.freeze(warnings),
  });
}

/**
 * Link exact byte duplicates without ever removing an entry. Two documents
 * that hash identically (typically the same file re-hosted under two
 * publisher ids or two package versions) both remain first-class manifest
 * entries; every entry after the first sharing a hash gets
 * `content_duplicate_of` pointed at the first one's document_id.
 */
export function linkContentDuplicates(documents) {
  const firstIdByHash = new Map();
  return documents.map((doc) => {
    if (!doc.bytes_sha256) return doc;
    const existing = firstIdByHash.get(doc.bytes_sha256);
    if (!existing) {
      firstIdByHash.set(doc.bytes_sha256, doc.document_id);
      return doc;
    }
    if (existing === doc.document_id || doc.content_duplicate_of === existing) return doc;
    return Object.freeze({ ...doc, content_duplicate_of: existing });
  });
}

/**
 * Optionally fetch and hash one manifest entry's bytes through the LDP-33
 * seam (warehouse/lib/document_processing.mjs), advancing its
 * retrieval_status from `not_attempted` to `fetched` or `fetch_failed`.
 * Never invoked by `collectLandFilingDocuments` itself -- discovery and
 * retrieval stay two explicit steps, matching SEQRA-04's own
 * discovered/fetched lifecycle. A document with no canonical reference (no
 * derivable identity) is `unavailable`, not silently skipped.
 */
export async function retrieveLandFilingDocument(document, { httpGet, projectRoot, fetchId, extractText } = {}) {
  if (!document.canonical_public_url) {
    return Object.freeze({ ...document, retrieval_status: "unavailable" });
  }
  const result = await fetchAndStoreDocument({
    url: document.canonical_public_url,
    sourceId: document.publisher_document_id,
    httpGet,
    projectRoot,
    fetchId,
  });
  if (!result.ok) {
    return Object.freeze({
      ...document,
      retrieval_status: "fetch_failed",
      immutable_receipt: result.fetchReceipt.fetch_id,
    });
  }
  const text = typeof extractText === "function" ? extractText(result.bytes) : null;
  const pageAssessment = text != null ? { page_number: 1, ...assessPageQuality({ text }) } : null;
  const qualitySummary = pageAssessment ? summarizeDocumentExtractionQuality([pageAssessment]) : null;
  return Object.freeze({
    ...document,
    retrieval_status: "fetched",
    retrieved_at: result.fetchReceipt.retrieved_at,
    bytes_sha256: result.contentHash.replace(/^sha256:/, ""),
    byte_length: result.fetchReceipt.byte_count,
    immutable_receipt: result.fetchReceipt.fetch_id,
    extraction_version: LAND_FILING_DOCUMENT_FETCH_PARSER_VERSION,
    ocr_quality: "not_applicable",
    layout_quality: qualitySummary ? qualitySummary.overall_quality_state : "unknown",
  });
}
