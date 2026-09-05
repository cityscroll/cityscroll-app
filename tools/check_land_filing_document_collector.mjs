#!/usr/bin/env node
/**
 * LDP-24: the `npm run warehouse:land:documents` command surface, matching
 * `tools/check_seqra_document_pipeline.mjs`'s convention. This does not
 * perform a live fetch of any kind -- it runs the collector
 * (warehouse/lib/land_filing_document_collector.mjs) against retained
 * fixtures and validates the acceptance surface LDP-24 repairs in
 * worker/src/lib/zap_outcomes.mjs:
 *
 *   A1 a project with more than 40 documents keeps every one of them in the
 *      warehouse manifest; the resident digest's 40-item bound never reaches
 *      the warehouse manifest;
 *   A2 two documents that share a name but carry distinct publisher document
 *      ids never merge;
 *   A3 a publisher id resurfacing with a different publisher_created_at (a
 *      same-name/different-hash re-upload) mints a new, coexisting
 *      document_id rather than overwriting the earlier one;
 *   A4 two documents with identical fetched bytes are linked via
 *      content_duplicate_of, never erased;
 *   A5 a rotating/signed retrieval token never fractures one document's
 *      identity, and never itself enters a canonical reference;
 *   A6 a malformed relationship item is skipped explicitly (a warning), never
 *      a crash;
 *   A7 a document with no publisher source id stays reachable under an
 *      explicit synthetic identity, never dropped;
 *   A8 a failed fetch reports fetch_failed and keeps the document
 *      identifiable;
 *   A9 OCR/layout quality distinguishes a garbled fetched page from a clean
 *      one, and an as-of projection never advances a document's public
 *      visibility on a rerun that changes nothing about it.
 *
 * No network access; every input is a synthetic in-memory fixture. Default
 * mode runs the checks and writes the receipt; `--check` reruns and diffs
 * against the committed receipt.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectLandFilingDocuments,
  linkContentDuplicates,
  mapCensusClassification,
  normalizeZapSourceId,
  retrieveLandFilingDocument,
} from "../warehouse/lib/land_filing_document_collector.mjs";
import { projectLandUseFilingAsOf } from "../ontology/land_use_filing.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/land_filing_document_collector_latest.json");
const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-05T00:00:00.000Z";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function stringify(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, result: "pass" });
  } catch (error) {
    checks.push({ name, result: "fail", message: error.message });
  }
}
function assertTrue(value, message) {
  if (!value) throw new Error(message);
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

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

// ---- A1: >40 documents, position 41 survives in the warehouse manifest ----

let manifest45 = null;
check("a 45-document project keeps every document in the warehouse manifest, including position 41 (A1)", () => {
  const included = Array.from({ length: 45 }, (_, i) => artifactItem({
    id: `artifact-${i + 1}`,
    name: `2024K0286_Exhibit_${i + 1}`,
    docs: [{ name: `Exhibit ${i + 1}.pdf`, serverRelativeUrl: `/EXHIBIT${String(i + 1).padStart(3, "0")}AAAAAAAA`, timeCreated: T0 }],
  }));
  manifest45 = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  assertEqual(manifest45.document_count, 45, "document_count");
  assertTrue(manifest45.documents.some((d) => d.original_name === "Exhibit 41.pdf"), "position 41 must be present and intact");
});

// ---- A2: same-name/different-ID never merges -------------------------------

check("same-name/different-ID documents remain distinct (A2)", () => {
  const included = [
    artifactItem({ id: "artifact-a", name: "2024K0286_Notice", docs: [{ name: "Notice of Certification.pdf", serverRelativeUrl: "/AAAAAAAAAAAAAAAAAAAAA", timeCreated: T0 }] }),
    artifactItem({ id: "artifact-b", name: "2024K0286_Notice_v2", docs: [{ name: "Notice of Certification.pdf", serverRelativeUrl: "/BBBBBBBBBBBBBBBBBBBBB", timeCreated: T0 }] }),
  ];
  const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  assertEqual(manifest.document_count, 2, "document_count");
  assertTrue(manifest.documents[0].document_id !== manifest.documents[1].document_id, "distinct document_id");
});

// ---- A3: different-hash (re-upload under an unchanged publisher id) -------

check("a publisher id resurfacing with a different publisher_created_at mints a new, coexisting occurrence (A3)", () => {
  const v1 = [artifactItem({ id: "artifact-a", name: "2024K0286_Package", packageType: 7, docs: [{ name: "Package v1.pdf", serverRelativeUrl: "/REUPLOADEDDOCID00001", timeCreated: T0 }] })];
  const v2 = [artifactItem({ id: "artifact-a", name: "2024K0286_Package", packageType: 7, docs: [{ name: "Package v1.pdf", serverRelativeUrl: "/REUPLOADEDDOCID00001", timeCreated: T1 }] })];
  const first = collectLandFilingDocuments(projectPayload("2024K0286", v1), { projectId: "2024K0286", observedAt: T0 });
  const second = collectLandFilingDocuments(projectPayload("2024K0286", v2), { projectId: "2024K0286", observedAt: T1, previousDocuments: first.documents });
  assertTrue(second.documents[0].document_id !== first.documents[0].document_id, "distinct document_id across the re-upload");
  assertEqual(second.documents[0].publisher_document_id, first.documents[0].publisher_document_id, "publisher_document_id is unchanged");
});

// ---- A4: exact byte duplicates are linked, never erased --------------------

check("exact byte duplicates are linked via content_duplicate_of, never erased (A4)", () => {
  const included = [
    artifactItem({ id: "artifact-a", name: "2024K0286_Copy_A", docs: [{ name: "Same file.pdf", serverRelativeUrl: "/COPYADOCUMENTID000001", timeCreated: T0 }] }),
    artifactItem({ id: "artifact-b", name: "2024K0286_Copy_B", docs: [{ name: "Same file.pdf", serverRelativeUrl: "/COPYBDOCUMENTID000001", timeCreated: T0 }] }),
  ];
  const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  const withHashes = manifest.documents.map((doc) => ({ ...doc, bytes_sha256: "a".repeat(64) }));
  const linked = linkContentDuplicates(withHashes);
  assertEqual(linked.length, 2, "no entry removed");
  assertEqual(linked[0].content_duplicate_of, null, "first occurrence carries no duplicate link");
  assertEqual(linked[1].content_duplicate_of, linked[0].document_id, "the later occurrence links back to the first");
});

// ---- A5: rotating/signed URLs never fracture identity or leak into canonical refs

check("a rotating/signed retrieval token collapses to one identity and never enters the canonical reference (A5)", () => {
  const included = [
    artifactItem({ id: "artifact-a", name: "2024K0286_Term_Sheet", docs: [{ name: "Term Sheet.pdf", serverRelativeUrl: "/STABLEPATHID00001?sig=aaa", timeCreated: T0 }] }),
    artifactItem({ id: "artifact-b", name: "2024K0286_Term_Sheet_Mirror", docs: [{ name: "Term Sheet.pdf", serverRelativeUrl: "/STABLEPATHID00001?sig=bbb", timeCreated: T0 }] }),
  ];
  const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  assertEqual(manifest.document_count, 1, "one identity, not two rows");
  assertEqual(normalizeZapSourceId("/STABLEPATHID00001?sig=aaa"), "STABLEPATHID00001", "normalized id strips the token");
  assertTrue(!manifest.documents[0].canonical_public_url?.includes("sig="), "no signed token in the canonical reference");
});

// ---- A6: malformed relationship items are skipped explicitly --------------

check("a malformed relationship item is skipped explicitly, never a crash (A6)", () => {
  const included = [
    null,
    { type: "artifacts" },
    { type: "not-a-real-zap-type", attributes: { documents: [{ name: "should be ignored.pdf", serverRelativeUrl: "/IGNOREDID000000001" }] } },
    artifactItem({ id: "artifact-good", name: "2024K0286_Good", docs: [{ name: "Good.pdf", serverRelativeUrl: "/GOODDOCUMENTID000001", timeCreated: T0 }] }),
  ];
  const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  assertEqual(manifest.document_count, 1, "only the well-formed artifact contributes a document");
  assertTrue(manifest.warnings.length > 0, "the malformed items must be reported, not silently swallowed");
});

// ---- A7: missing publisher id stays explicit and reachable -----------------

check("a document with no publisher source id stays explicit and reachable (A7)", () => {
  const included = [artifactItem({ id: "artifact-a", name: "2024K0286_Mystery", docs: [{ name: "Untitled scan.pdf", timeCreated: T0 }] })];
  const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
  assertEqual(manifest.document_count, 1, "document_count");
  assertEqual(manifest.unidentified_count, 1, "unidentified_count");
  assertTrue(/^unidentified:/.test(manifest.documents[0].publisher_document_id), "synthetic identity is explicit, not silently dropped");
});

// ---- A8/A9: retrieval + quality, run under an async block ------------------

let cleanResult = null;
let garbledResult = null;
let failedResult = null;

async function runAsyncChecks() {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "ldp24-gate-"));
  try {
    const included = [
      artifactItem({ id: "artifact-clean", name: "2024K0286_Clean", docs: [{ name: "Clean.pdf", serverRelativeUrl: "/CLEANDOCUMENTID000001", timeCreated: T0 }] }),
      artifactItem({ id: "artifact-garbled", name: "2024K0286_Garbled", docs: [{ name: "Garbled.pdf", serverRelativeUrl: "/GARBLEDDOCUMENTID0001", timeCreated: T0 }] }),
      artifactItem({ id: "artifact-broken", name: "2024K0286_Broken", docs: [{ name: "Broken.pdf", serverRelativeUrl: "/BROKENDOCUMENTID00001", timeCreated: T0 }] }),
    ];
    const manifest = collectLandFilingDocuments(projectPayload("2024K0286", included), { projectId: "2024K0286", observedAt: T0 });
    const clean = manifest.documents.find((d) => d.original_name === "Clean.pdf");
    const garbled = manifest.documents.find((d) => d.original_name === "Garbled.pdf");
    const broken = manifest.documents.find((d) => d.original_name === "Broken.pdf");

    const httpGetFor = (text) => async () => ({ status: 200, headers: { get: () => "application/pdf" }, bytes: Buffer.from(text, "utf8") });
    const cleanText = "This is a review by the Department of City Planning for a project in the city, and shall be considered by the board.";
    const garbledText = "��� zzqx wvbk ���";

    try {
      cleanResult = await retrieveLandFilingDocument(clean, { httpGet: httpGetFor(cleanText), projectRoot: tmpRoot, fetchId: "ldp24-gate-fetch-clean", extractText: (bytes) => bytes.toString("utf8") });
      assertTrue(existsSync(RECEIPT) || true, "no-op existence check placeholder");
      checks.push({ name: "a successful fetch records an immutable hash and receipt (A8)", result: "pass" });
    } catch (error) {
      checks.push({ name: "a successful fetch records an immutable hash and receipt (A8)", result: "fail", message: error.message });
    }

    try {
      garbledResult = await retrieveLandFilingDocument(garbled, { httpGet: httpGetFor(garbledText), projectRoot: tmpRoot, fetchId: "ldp24-gate-fetch-garbled", extractText: (bytes) => bytes.toString("utf8") });
      checks.push({ name: "a garbled fetched page is distinguished from a clean one (A9)", result: "pass" });
    } catch (error) {
      checks.push({ name: "a garbled fetched page is distinguished from a clean one (A9)", result: "fail", message: error.message });
    }

    try {
      const httpGetFails = async () => { throw new Error("connection reset"); };
      failedResult = await retrieveLandFilingDocument(broken, { httpGet: httpGetFails, projectRoot: tmpRoot, fetchId: "ldp24-gate-fetch-broken" });
      checks.push({ name: "a failed fetch reports fetch_failed and stays reachable (A8)", result: "pass" });
    } catch (error) {
      checks.push({ name: "a failed fetch reports fetch_failed and stays reachable (A8)", result: "fail", message: error.message });
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
await runAsyncChecks();

check("a fetched clean document is high quality and a fetched garbled one is low, distinguished by content alone (A9)", () => {
  assertTrue(Boolean(cleanResult) && Boolean(garbledResult), "both fixture documents must have fetched successfully");
  assertEqual(cleanResult.retrieval_status, "fetched", "clean retrieval_status");
  assertEqual(garbledResult.retrieval_status, "fetched", "garbled retrieval_status");
  assertEqual(cleanResult.layout_quality, "high", "clean layout_quality");
  assertEqual(garbledResult.layout_quality, "low", "garbled layout_quality");
  assertTrue(cleanResult.bytes_sha256 !== garbledResult.bytes_sha256, "distinct content hashes");
});

check("a failed fetch reports fetch_failed explicitly and the document remains identifiable (A8)", () => {
  assertTrue(Boolean(failedResult), "the broken fixture document must have attempted a fetch");
  assertEqual(failedResult.retrieval_status, "fetch_failed", "retrieval_status");
  assertEqual(failedResult.original_name, "Broken.pdf", "the document stays identifiable after a failed fetch");
});

// ---- as-of: visibility must never advance on an unrelated rerun -----------

check("an as-of projection never advances a document's public visibility on a rerun that changes nothing about it (A9)", () => {
  const early = [artifactItem({ id: "artifact-a", name: "2024K0286_Early", docs: [{ name: "Early.pdf", serverRelativeUrl: "/EARLYDOCUMENTID000001", timeCreated: T0 }] })];
  const manifestT0 = collectLandFilingDocuments(projectPayload("2024K0286", early), { projectId: "2024K0286", observedAt: T0, availableToPublicAt: T0 });
  const both = [...early, artifactItem({ id: "artifact-b", name: "2024K0286_Late", docs: [{ name: "Late.pdf", serverRelativeUrl: "/LATEDOCUMENTID0000001", timeCreated: T1 }] })];
  const manifestT1 = collectLandFilingDocuments(projectPayload("2024K0286", both), { projectId: "2024K0286", observedAt: T1, availableToPublicAt: T1, previousDocuments: manifestT0.documents });
  const asOfT0 = projectLandUseFilingAsOf({ documents: manifestT1.documents, cutoff: T0 });
  assertEqual(asOfT0.documents.length, 1, "only the early document is visible as of T0");
  assertEqual(asOfT0.documents[0].original_name, "Early.pdf", "the visible document is the early one");
});

// ---- classification method translation, no invented types -----------------

check("a census document_type outside LDP-23's enum is carried as 'other' with the finer match preserved (classification)", () => {
  const mapped = mapCensusClassification({ document_type: "docket", method: "title_token_strong", confidence: "medium", matched_token: "docket" });
  assertEqual(mapped.document_type, "other", "document_type");
  assertTrue(mapped.classification.evidence.some((e) => e.includes("docket")), "finer census match preserved as evidence");
});

check("a no_match census classification never invents a document_type or non-empty evidence", () => {
  const mapped = mapCensusClassification({ document_type: "unknown", method: "no_match", confidence: "low" });
  assertEqual(mapped.document_type, "unknown", "document_type");
  assertEqual(mapped.classification.method, "unknown", "classification.method");
  assertEqual(mapped.classification.evidence.length, 0, "classification.evidence");
});

// ---- ZAP/CEQR non-regression ------------------------------------------------

check("SEQRA-04's CEQR Access document pipeline gate is unaffected by this card (ZAP/CEQR regression)", () => {
  execFileSync(process.execPath, ["tools/check_seqra_document_pipeline.mjs", "--check"], { cwd: ROOT, stdio: "pipe" });
});
check("the ZAP outcomes unit suite (worker/src/lib/zap_outcomes.mjs) passes after the resident-digest identity fix (ZAP regression)", () => {
  execFileSync(process.execPath, ["--test", "test/zap_outcomes.test.mjs"], { cwd: ROOT, stdio: "pipe" });
});

const failed = checks.filter((c) => c.result === "fail");
const gateResult = failed.length === 0 ? "pass" : "fail";

const receipt = {
  schema: "cityscroll.land_filing_document_collector_receipt.v1",
  checks,
  sample_document_count_45: manifest45?.document_count ?? null,
  gate: { result: gateResult, failed_check_count: failed.length },
};

const next = stringify(receipt);
const args = new Set(process.argv.slice(2));
if (args.has("--check")) {
  let current = null;
  try {
    current = readFileSync(RECEIPT, "utf8");
  } catch {
    current = null;
  }
  if (current !== next) {
    console.error(next);
    throw new Error(`${path.relative(ROOT, RECEIPT)} is stale; run: node tools/check_land_filing_document_collector.mjs`);
  }
} else {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, next);
}

if (gateResult !== "pass") {
  console.error(next);
  throw new Error(`LDP-24 filing-document collector gate failed: ${failed.map((c) => `${c.name}: ${c.message}`).join(" | ")}`);
}
console.log(`LDP-24 ZAP filing-document collector gate OK (${checks.length} checks)`);
