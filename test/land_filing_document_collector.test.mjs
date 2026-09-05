/**
 * LDP-24: a real collector wired to the LDP-23 `land_use_filing_document`
 * contract, over LDP-22's untruncated ZAP filing-document extraction.
 *
 * Verify: node --test test/land_filing_document_collector.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  collectLandFilingDocuments,
  linkContentDuplicates,
  mapCensusClassification,
  normalizeZapSourceId,
  reconcileFirstObservedAt,
  retrieveLandFilingDocument,
} from "../warehouse/lib/land_filing_document_collector.mjs";
import { projectLandUseFilingAsOf } from "../ontology/land_use_filing.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-05T00:00:00.000Z";

function artifactItem({ id, name, docs, packageType }) {
  return {
    type: packageType !== undefined ? "packages" : "artifacts",
    id,
    attributes: {
      "dcp-name": name,
      ...(packageType !== undefined ? { "dcp-packagetype": packageType, "dcp-packageid": id } : { "dcp-artifactsid": id }),
      documents: docs,
    },
  };
}

function projectPayload(projectId, included) {
  return { data: { type: "projects", id: projectId, attributes: {} }, included };
}

test("collects an untruncated manifest: a 45-document project keeps all 45, including position 41", () => {
  const included = Array.from({ length: 45 }, (_, i) => artifactItem({
    id: `artifact-${i + 1}`,
    name: `2024K0286_Exhibit_${i + 1}`,
    docs: [{ name: `Exhibit ${i + 1}.pdf`, serverRelativeUrl: `/EXHIBIT${String(i + 1).padStart(3, "0")}AAAAAAAA`, timeCreated: T0 }],
  }));
  const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  assert.equal(manifest.document_count, 45, "no truncation at 40 in the warehouse manifest");
  const position41 = manifest.documents.find((d) => d.original_name === "Exhibit 41.pdf");
  assert.ok(position41, "the document at position 41 must survive intact");
  assert.equal(position41.publisher_document_id, "EXHIBIT041AAAAAAAA");
});

test("same-name/different-ID documents remain distinct, never merged", () => {
  const included = [
    artifactItem({ id: "artifact-a", name: "2024K0286_Notice", docs: [{ name: "Notice of Certification.pdf", serverRelativeUrl: "/AAAAAAAAAAAAAAAAAAAAA", timeCreated: T0 }] }),
    artifactItem({ id: "artifact-b", name: "2024K0286_Notice_v2", docs: [{ name: "Notice of Certification.pdf", serverRelativeUrl: "/BBBBBBBBBBBBBBBBBBBBB", timeCreated: T0 }] }),
  ];
  const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  assert.equal(manifest.document_count, 2);
  assert.notEqual(manifest.documents[0].document_id, manifest.documents[1].document_id);
  assert.equal(manifest.documents[0].original_name, manifest.documents[1].original_name);
});

test("misleading filename: two distinct publisher groups sharing one deceptive title stay distinct", () => {
  const included = [
    artifactItem({ id: "artifact-real-rer", name: "2024K0286_Racial Equity Report", docs: [{ name: "RER.pdf", serverRelativeUrl: "/REALRERDOCUMENTID0001", timeCreated: T0 }] }),
    artifactItem({ id: "artifact-fake-rer", name: "2024K0286_Racial Equity Report", docs: [{ name: "RER.pdf", serverRelativeUrl: "/DIFFERENTBYTESID00002", timeCreated: T0 }] }),
  ];
  const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  assert.equal(manifest.document_count, 2, "a shared misleading title must not collapse two distinct publisher documents");
  for (const doc of manifest.documents) assert.equal(doc.document_type, "racial_equity_report");
});

test("a rotating/signed retrieval token collapses to one identity, not two rows", () => {
  const included = [
    artifactItem({ id: "artifact-a", name: "2024K0286_Term_Sheet", docs: [{ name: "Term Sheet.pdf", serverRelativeUrl: "/STABLEPATHID00001?sig=aaa", timeCreated: T0 }] }),
    artifactItem({ id: "artifact-b", name: "2024K0286_Term_Sheet_Mirror", docs: [{ name: "Term Sheet.pdf", serverRelativeUrl: "/STABLEPATHID00001?sig=bbb", timeCreated: T0 }] }),
  ];
  const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  assert.equal(manifest.document_count, 1, "the same underlying document under two rotating tokens is one identity");
  assert.equal(manifest.documents[0].publisher_document_id, "STABLEPATHID00001");
  assert.ok(!manifest.documents[0].canonical_public_url?.includes("sig="), "a signed/transient token must never enter the canonical reference");
});

test("normalizeZapSourceId strips a signed query string and a fragment, keeping the stable path", () => {
  assert.equal(normalizeZapSourceId("/ABCDEFGH12345678?sig=xyz"), "ABCDEFGH12345678");
  assert.equal(normalizeZapSourceId("ABCDEFGH12345678#frag"), "ABCDEFGH12345678");
  assert.equal(normalizeZapSourceId(""), null);
  assert.equal(normalizeZapSourceId(null), null);
});

test("a document with no publisher source id stays explicit and reachable, never dropped", () => {
  const included = [
    artifactItem({ id: "artifact-a", name: "2024K0286_Mystery", docs: [{ name: "Untitled scan.pdf", timeCreated: T0 }] }),
  ];
  const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  assert.equal(manifest.document_count, 1);
  assert.equal(manifest.unidentified_count, 1);
  assert.match(manifest.documents[0].publisher_document_id, /^unidentified:/);
  assert.ok(manifest.warnings.some((w) => w.includes("carries no publisher source id")));
});

test("a malformed relationship item is skipped explicitly, never crashes the collector", () => {
  const included = [
    null,
    { type: "artifacts" }, // no attributes, no documents[]
    { type: "not-a-real-zap-type", attributes: { documents: [{ name: "should be ignored.pdf", serverRelativeUrl: "/IGNOREDID000000001" }] } },
    artifactItem({ id: "artifact-good", name: "2024K0286_Good", docs: [{ name: "Good.pdf", serverRelativeUrl: "/GOODDOCUMENTID000001", timeCreated: T0 }] }),
  ];
  const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  assert.equal(manifest.document_count, 1, "only the well-formed artifact contributes a document");
  assert.equal(manifest.documents[0].original_name, "Good.pdf");
  assert.ok(manifest.warnings.length > 0, "the malformed artifacts item with no documents[] must be reported, not silently swallowed");
});

test("a malformed top-level payload reports ok:false explicitly rather than an empty-but-clean manifest", () => {
  const manifest = collectLandFilingDocuments({ data: { type: "not-projects" } }, { projectId: "2024K0286", observedAt: T0 });
  assert.equal(manifest.ok, false);
  assert.equal(manifest.document_count, 0);
});

test("deterministic rerun: an unchanged payload reuses first_observed_at and mints the same document_id", () => {
  const included = [artifactItem({ id: "artifact-a", name: "2024K0286_Stable", docs: [{ name: "Stable.pdf", serverRelativeUrl: "/STABLEDOCUMENTID00001", timeCreated: T0 }] })];
  const payload = projectPayload("2024K0286", included);
  const first = collectLandFilingDocuments(payload, { projectId: "2024K0286", observedAt: T0 });
  const second = collectLandFilingDocuments(payload, { projectId: "2024K0286", observedAt: T1, previousDocuments: first.documents });
  assert.equal(second.documents[0].document_id, first.documents[0].document_id);
  assert.equal(second.documents[0].first_observed_at, T0);
});

test("same publisher id resurfacing with a different publisher_created_at is a genuinely new, coexisting occurrence (same-name/different-hash re-upload)", () => {
  const v1 = [artifactItem({ id: "artifact-a", name: "2024K0286_Package", packageType: 7, docs: [{ name: "Package v1.pdf", serverRelativeUrl: "/REUPLOADEDDOCID00001", timeCreated: T0 }] })];
  const v2 = [artifactItem({ id: "artifact-a", name: "2024K0286_Package", packageType: 7, docs: [{ name: "Package v1.pdf", serverRelativeUrl: "/REUPLOADEDDOCID00001", timeCreated: T1 }] })];
  const first = collectLandFilingDocuments(projectPayload("2024K0286", v1), { projectId: "2024K0286", observedAt: T0 });
  const second = collectLandFilingDocuments(projectPayload("2024K0286", v2), { projectId: "2024K0286", observedAt: T1, previousDocuments: first.documents });
  assert.notEqual(second.documents[0].document_id, first.documents[0].document_id, "a re-upload under the same publisher id must mint a distinct document_id");
  assert.equal(second.documents[0].publisher_document_id, first.documents[0].publisher_document_id);
  assert.equal(second.documents[0].first_observed_at, T1);
});

test("explicit publisher relationship type (packages) classifies at high confidence without any title-token guess", () => {
  const included = [artifactItem({ id: "pkg-1", name: "2024K0286_Filed LU Package_1", packageType: 100000001, docs: [{ name: "Package.pdf", serverRelativeUrl: "/PACKAGEDOCUMENTID0001", timeCreated: T0 }] })];
  const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  const doc = manifest.documents[0];
  assert.equal(doc.document_type, "filed_land_use_package");
  assert.equal(doc.classification.method, "explicit_publisher_type_or_group");
  assert.equal(doc.classification.confidence, "high");
});

test("mapCensusClassification: a census document_type outside LDP-23's enum lands on 'other' with the finer match preserved as evidence", () => {
  const mapped = mapCensusClassification({ document_type: "docket", method: "title_token_strong", confidence: "medium", matched_token: "docket" });
  assert.equal(mapped.document_type, "other");
  assert.equal(mapped.classification.method, "title_token_plus_markers");
  assert.ok(mapped.classification.evidence.some((e) => e.includes("docket")));
});

test("mapCensusClassification: no_match never invents a document_type or non-empty evidence", () => {
  const mapped = mapCensusClassification({ document_type: "unknown", method: "no_match", confidence: "low" });
  assert.equal(mapped.document_type, "unknown");
  assert.equal(mapped.classification.method, "unknown");
  assert.deepEqual(mapped.classification.evidence, []);
});

test("linkContentDuplicates links exact byte duplicates without ever removing an entry", () => {
  const included = [
    artifactItem({ id: "artifact-a", name: "2024K0286_Copy_A", docs: [{ name: "Same file.pdf", serverRelativeUrl: "/COPYADOCUMENTID000001", timeCreated: T0 }] }),
    artifactItem({ id: "artifact-b", name: "2024K0286_Copy_B", docs: [{ name: "Same file.pdf", serverRelativeUrl: "/COPYBDOCUMENTID000001", timeCreated: T0 }] }),
  ];
  const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  const withHashes = manifest.documents.map((doc, i) => ({ ...doc, bytes_sha256: "a".repeat(64) }));
  const linked = linkContentDuplicates(withHashes);
  assert.equal(linked.length, 2, "both entries must remain -- an exact duplicate is linked, never erased");
  assert.equal(linked[0].content_duplicate_of, null);
  assert.equal(linked[1].content_duplicate_of, linked[0].document_id);
});

test("linkContentDuplicates leaves documents with no hash (not yet fetched) untouched", () => {
  const documents = [{ document_id: "a", bytes_sha256: null, content_duplicate_of: null }, { document_id: "b", bytes_sha256: null, content_duplicate_of: null }];
  const linked = linkContentDuplicates(documents);
  assert.deepEqual(linked, documents);
});

test("reconcileFirstObservedAt reuses the prior clock only when publisher_created_at also matches", () => {
  const previousByPublisherId = new Map([["pub-1", [{ first_observed_at: T0, publisher_created_at: T0 }]]]);
  assert.equal(reconcileFirstObservedAt({ previousByPublisherId, publisherDocumentId: "pub-1", publisherCreatedAt: T0, observedAt: T1 }), T0);
  assert.equal(reconcileFirstObservedAt({ previousByPublisherId, publisherDocumentId: "pub-1", publisherCreatedAt: T1, observedAt: T1 }), T1);
  assert.equal(reconcileFirstObservedAt({ previousByPublisherId, publisherDocumentId: "pub-unseen", publisherCreatedAt: T0, observedAt: T1 }), T1);
});

test("retrieveLandFilingDocument: a failed fetch reports fetch_failed explicitly and stays reachable", async () => {
  const included = [artifactItem({ id: "artifact-a", name: "2024K0286_Broken", docs: [{ name: "Broken.pdf", serverRelativeUrl: "/BROKENDOCUMENTID00001", timeCreated: T0 }] })];
  const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  const httpGet = async () => { throw new Error("connection reset"); };
  const result = await retrieveLandFilingDocument(manifest.documents[0], { httpGet, projectRoot: "/tmp/does-not-matter", fetchId: "ldp24-test-fetch-0001" });
  assert.equal(result.retrieval_status, "fetch_failed");
  assert.equal(result.original_name, "Broken.pdf", "a failed fetch keeps the document identifiable, not dropped");
});

test("retrieveLandFilingDocument: no canonical reference is unavailable, not silently skipped", async () => {
  const doc = { canonical_public_url: null, publisher_document_id: "x", retrieval_status: "not_attempted" };
  const result = await retrieveLandFilingDocument(doc, {});
  assert.equal(result.retrieval_status, "unavailable");
});

test("as-of: a document first observed after the cutoff is excluded from the projection", () => {
  const early = [artifactItem({ id: "artifact-a", name: "2024K0286_Early", docs: [{ name: "Early.pdf", serverRelativeUrl: "/EARLYDOCUMENTID000001", timeCreated: T0 }] })];
  const manifestT0 = collectLandFilingDocuments(projectPayload("2024K0286", early), { projectId: "2024K0286", observedAt: T0, availableToPublicAt: T0 });

  const both = [
    ...early,
    artifactItem({ id: "artifact-b", name: "2024K0286_Late", docs: [{ name: "Late.pdf", serverRelativeUrl: "/LATEDOCUMENTID0000001", timeCreated: T1 }] }),
  ];
  const manifestT1 = collectLandFilingDocuments(projectPayload("2024K0286", both), {
    projectId: "2024K0286", observedAt: T1, availableToPublicAt: T1, previousDocuments: manifestT0.documents,
  });

  const asOfT0 = projectLandUseFilingAsOf({ documents: manifestT1.documents, cutoff: T0 });
  assert.equal(asOfT0.documents.length, 1);
  assert.equal(asOfT0.documents[0].original_name, "Early.pdf");

  const asOfT1 = projectLandUseFilingAsOf({ documents: manifestT1.documents, cutoff: T1 });
  assert.equal(asOfT1.documents.length, 2);
});

test("retrieveLandFilingDocument: a successful fetch records an immutable hash, receipt, and distinguishes garbled from clean quality (OCR/layout quality)", async () => {
  const included = [
    artifactItem({ id: "artifact-clean", name: "2024K0286_Clean", docs: [{ name: "Clean.pdf", serverRelativeUrl: "/CLEANDOCUMENTID000001", timeCreated: T0 }] }),
    artifactItem({ id: "artifact-garbled", name: "2024K0286_Garbled", docs: [{ name: "Garbled.pdf", serverRelativeUrl: "/GARBLEDDOCUMENTID0001", timeCreated: T0 }] }),
  ];
  const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  const clean = manifest.documents.find((d) => d.original_name === "Clean.pdf");
  const garbled = manifest.documents.find((d) => d.original_name === "Garbled.pdf");

  const cleanText = "This is a review by the Department of City Planning for a project in the city, and shall be considered by the board.";
  const garbledText = "��� zzqx wvbk ���";

  const httpGetFor = (text) => async () => ({ status: 200, headers: { get: () => "application/pdf" }, bytes: Buffer.from(text, "utf8") });

  await withTempDir("ldp24-test", async (projectRoot) => {
    const cleanResult = await retrieveLandFilingDocument(clean, {
      httpGet: httpGetFor(cleanText), projectRoot, fetchId: "ldp24-test-fetch-clean", extractText: (bytes) => bytes.toString("utf8"),
    });
    const garbledResult = await retrieveLandFilingDocument(garbled, {
      httpGet: httpGetFor(garbledText), projectRoot, fetchId: "ldp24-test-fetch-garbled", extractText: (bytes) => bytes.toString("utf8"),
    });

    assert.equal(cleanResult.retrieval_status, "fetched");
    assert.match(cleanResult.bytes_sha256, /^[0-9a-f]{64}$/);
    assert.ok(cleanResult.immutable_receipt, "a fetched document must carry a retrieval receipt reference");
    assert.equal(cleanResult.layout_quality, "high");
    assert.equal(garbledResult.retrieval_status, "fetched");
    assert.equal(garbledResult.layout_quality, "low");
    assert.notEqual(cleanResult.bytes_sha256, garbledResult.bytes_sha256);
  });
});
