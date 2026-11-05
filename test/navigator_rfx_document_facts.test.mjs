import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  projectNavigatorDocumentFacts,
  readNavigatorDocumentFacts,
  summarizeNavigatorDocumentFacts,
} from "../warehouse/lib/navigator_rfx_document_facts.mjs";
import {
  boundedHttpGet,
  buildProcurementDocumentShard,
  createNavigatorObservationState,
  isAllowedNavigatorDocumentUrl,
  looksLikeLoginHtml,
  observeNavigatorRfxDocuments,
} from "../warehouse/lib/navigator_rfx_documents.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(ROOT, "test/fixtures/navigator_rfx_document_facts");
const PAGES = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "pages.json"), "utf8"));
const EXPECTED_TEXT = readFileSync(path.join(FIXTURE_DIR, "expected.json"), "utf8");
const EXPECTED = JSON.parse(EXPECTED_TEXT);
const CONTROLS = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "controls.json"), "utf8"));

function documentById(documentId) {
  return PAGES.documents.find((document) => document.document_id === documentId);
}

function expectedById(documentId) {
  return EXPECTED.documents.find((document) => document.document_id === documentId);
}

function publicReading(document, projection) {
  return {
    document_id: document.document_id,
    sections: projection.sections,
    events: projection.events,
    facts: projection.facts,
    abstentions: projection.abstentions,
  };
}

function extractionFor(document, overrides = {}) {
  return {
    extraction_key: {
      sha256: overrides.sha256 || document.document_id.padStart(64, "0"),
      extractor: overrides.extractor || "page-extractor.v1",
      pdf_library: overrides.pdfLibrary || "pypdf 5.9.0",
      ontology_version: overrides.ontology || "procurement-documents.v1",
      rules_version: overrides.rules || "document-facts.v1",
    },
    page_count: document.page_count,
    pages: document.pages,
  };
}

test("A1: recognized public templates replay every section, event, fact, and abstention byte-for-byte", () => {
  const actual = {
    schema: EXPECTED.schema,
    source: EXPECTED.source,
    documents: PAGES.documents.map((document) => publicReading(
      document,
      readNavigatorDocumentFacts({ document, pages: document.pages, pageCount: document.page_count }),
    )),
  };
  assert.equal(`${JSON.stringify(actual, null, 2)}\n`, EXPECTED_TEXT);

  const opening = actual.documents[0];
  assert.deepEqual(opening.events.map((event) => [event.id, event.local]), [
    ["response-deadline", "2026-11-09T14:00:00"],
    ["bid-opening", "2026-11-09T15:00:00"],
  ]);
});

test("A2: applicability boundaries refuse keyword-only requirements and preserve uncertainty", () => {
  const contractDocument = documentById("253286611");
  const projection = readNavigatorDocumentFacts({
    document: contractDocument,
    pages: contractDocument.pages,
    pageCount: contractDocument.page_count,
  });
  const facts = new Map(projection.facts.map((fact) => [fact.id, fact]));

  for (const id of ["bid-bond", "bid-security", "performance-bond", "payment-bond"]) {
    assert.equal(facts.get(id).applicability, "not_applicable", id);
  }
  assert.equal(facts.get("maintenance-guaranty-security").applicability, "conflicting");
  assert.equal(facts.get("mwbe-goals").applicability, "unknown");
  assert.equal(facts.get("mwbe-waiver-deadline").applicability, "conditional");
  assert.equal(facts.get("partial-payment").applicability, "informational");
  assert.deepEqual(projection.abstentions.map((row) => row.id), [
    "pre-bid-conference",
    "site-visit",
    "bid-security-toc",
    "performance-bond-toc",
  ]);
  assert.ok(projection.abstentions.every((row) => row.creates_task === false));

  const unknownPage = { page_number: 1, text: "Performance Bond required", ocr_required: false };
  const unknown = readNavigatorDocumentFacts({
    document: { document_id: "public-control", label: "Unknown template", page_count: 1 },
    pages: [unknownPage],
    pageCount: 1,
  });
  assert.deepEqual(unknown.sections, []);
  assert.deepEqual(unknown.events, []);
  assert.deepEqual(unknown.facts, []);
  assert.equal(unknown.abstentions[0].id, "unrecognized-template");

  const scannedPage = { page_number: 1, text: "", ocr_required: true, ocr_attempted: false };
  const scanned = readNavigatorDocumentFacts({
    document: { document_id: "scan-control", label: "Scanned page", page_count: 1 },
    pages: [scannedPage],
    pageCount: 1,
  });
  assert.equal(scannedPage.ocr_required, true);
  assert.equal(scanned.facts.length, 0);
});

test("A2: all twelve synthetic packet controls stay explicit at their owning boundaries", async () => {
  assert.deepEqual(CONTROLS.cases.map((entry) => entry.id), [
    "login-html",
    "redirect-login",
    "oversize",
    "off-host",
    "round-mismatch",
    "unknown-binding",
    "scanned-page",
    "amendment-conflict",
    "unsigned-form",
    "repeated-bytes",
    "parser-change",
    "missing-price",
  ]);

  assert.equal(looksLikeLoginHtml(CONTROLS.cases[0].input.body), true);
  const redirected = await boundedHttpGet("https://public.example/document", {
    maxBytes: 20,
    fetchImpl: async () => new Response(null, {
      status: CONTROLS.cases[1].input.http_status,
      headers: { location: CONTROLS.cases[1].input.location },
    }),
  });
  assert.equal(redirected.failure.type, "redirect_rejected");
  const oversized = await boundedHttpGet("https://public.example/document", {
    maxBytes: 4,
    fetchImpl: async () => new Response("x", { headers: { "content-length": "5" } }),
  });
  assert.equal(oversized.failure.type, "oversize_declared");
  assert.equal(isAllowedNavigatorDocumentUrl(CONTROLS.cases[3].input.url), false);

  const roundOne = buildProcurementDocumentShard({
    subject: { rfp_id: "51001", epin: CONTROLS.cases[4].input.epin, round_label: "1" },
    observation: {},
    rows: [],
  });
  const roundTwo = buildProcurementDocumentShard({
    subject: { rfp_id: "51002", epin: CONTROLS.cases[4].input.epin, round_label: "2" },
    observation: {},
    rows: [],
  });
  assert.notEqual(roundOne.subject.rfp_id, roundTwo.subject.rfp_id);
  assert.equal(roundOne.subject.epin, roundTwo.subject.epin);

  let requests = 0;
  const unknown = await observeNavigatorRfxDocuments({
    targetRfpIds: ["99999"],
    rfxRows: [],
    httpGet: async () => { requests += 1; throw new Error("must not request"); },
    projectRoot: ROOT,
    extractor: async () => ({ status: "ok", pages: [] }),
    extractorVersion: "page-extractor.v1",
    pdfLibraryVersion: "pypdf 5.9.0",
    ontologyVersion: "procurement-documents.v1",
    rulesVersion: "document-facts.v1",
  });
  assert.equal(requests, 0);
  assert.deepEqual(unknown.failures.map((entry) => entry.type), ["unknown_rfp_id"]);

  const scanned = readNavigatorDocumentFacts({
    document: { page_count: 1 },
    pages: [{ ...CONTROLS.cases[6].input, ocr_required: true }],
    pageCount: 1,
  });
  assert.equal(scanned.facts.length, 0);
  assert.equal(scanned.abstentions[0].id, "unrecognized-template");

  const dueObservations = [CONTROLS.cases[7].input.old_due, CONTROLS.cases[7].input.new_due];
  assert.equal(new Set(dueObservations).size, 2);
  assert.equal(CONTROLS.cases[7].input.supersedes, null);

  const contract = readNavigatorDocumentFacts({
    document: documentById("253286611"),
    pages: documentById("253286611").pages,
    pageCount: 237,
  });
  assert.equal(contract.sections.find((section) => section.id === "agreement").standing, "proposed");

  const state = createNavigatorObservationState();
  const source = PAGES.documents[0];
  const first = projectNavigatorDocumentFacts({ document: source, extraction: extractionFor(source), state });
  const repeated = projectNavigatorDocumentFacts({ document: source, extraction: extractionFor(source), state });
  const parserChanged = projectNavigatorDocumentFacts({
    document: source,
    extraction: extractionFor(source, { extractor: "page-extractor.v2" }),
    state,
  });
  assert.equal(first.receipt.cache_hit, false);
  assert.equal(repeated.receipt.cache_hit, true);
  assert.equal(parserChanged.receipt.cache_hit, false);
  assert.equal(contract.facts.some((fact) => fact.value === 0), false);
});

test("A3: readings report denominators, abstentions, latency, stored bytes, and cache hits", () => {
  const state = createNavigatorObservationState();
  let clock = 0;
  const nowMilliseconds = () => clock++;
  const rows = PAGES.documents.map((document) => {
    const result = projectNavigatorDocumentFacts({
      document,
      extraction: extractionFor(document),
      state,
      nowMilliseconds,
    });
    return {
      ...document,
      ...result.projection,
      reading_receipt: result.receipt,
    };
  });
  const repeated = projectNavigatorDocumentFacts({
    document: PAGES.documents[0],
    extraction: extractionFor(PAGES.documents[0]),
    state,
    nowMilliseconds,
  });
  assert.equal(repeated.receipt.cache_hit, true);
  assert.equal(repeated.receipt.stored_bytes, 0);
  assert.ok(repeated.receipt.projection_bytes > 0);
  assert.equal(state.fact_projection_runs, 2);
  assert.equal(state.fact_cache_hits, 1);

  const restoredState = createNavigatorObservationState([], [...state.fact_projections.values()]);
  const restored = projectNavigatorDocumentFacts({
    document: PAGES.documents[0],
    extraction: extractionFor(PAGES.documents[0]),
    state: restoredState,
    nowMilliseconds,
  });
  assert.equal(restored.receipt.cache_hit, true);
  assert.equal(restoredState.fact_projection_runs, 0);

  const metrics = summarizeNavigatorDocumentFacts(rows);
  assert.equal(metrics.documents, 2);
  assert.equal(metrics.pages, 238);
  assert.equal(metrics.sectioned_pages, 237);
  assert.equal(metrics.sections, 13);
  assert.equal(metrics.events, 2);
  assert.equal(metrics.facts, 30);
  assert.equal(metrics.abstentions, 4);
  assert.equal(metrics.model_calls, 0);
  assert.equal(metrics.ocr_pages_selected, 0);
  assert.equal(metrics.latency_ms, 2);
  assert.ok(metrics.stored_bytes > 0);
  assert.equal(metrics.cache_hits, 0);
  assert.equal(metrics.cache_misses, 2);
  assert.equal(metrics.per_role.reduce((sum, row) => sum + row.denominator, 0), 34);
  assert.ok(metrics.per_role.every((row) => row.denominator === row.fact_count + row.abstention_count));

  const parserChange = projectNavigatorDocumentFacts({
    document: PAGES.documents[0],
    extraction: extractionFor(PAGES.documents[0], { extractor: "page-extractor.v2" }),
    state,
    nowMilliseconds,
  });
  assert.equal(parserChange.receipt.cache_hit, false);
  assert.equal(state.fact_projection_runs, 3);
});

test("the observation pipeline attaches the deterministic reading to generated rows", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "solicitation-reading-"));
  const opening = documentById("253289498");
  const contract = documentById("253286611");
  const openingBytes = Buffer.from("%PDF-1.7\nopening-public-fixture");
  const contractBytes = Buffer.from("%PDF-1.7\ncontract-public-fixture");
  const html = `<!doctype html><title>Public RFx (037402) - Lot : / Round : 1: PASSPort</title>
    <a href="https://webserver-mocs-prd.lfr.cloud/c/public_document/download?documentId=${opening.document_id}">${opening.label}</a>
    <a href="https://webserver-mocs-prd.lfr.cloud/c/public_document/download?documentId=${contract.document_id}">${contract.label}</a>`;
  const headers = { get: (name) => name.toLowerCase() === "content-type" ? "application/pdf" : null };
  const fullContractPages = Array.from({ length: contract.page_count }, (_, index) => (
    contract.pages.find((page) => page.page_number === index + 1)
      || { page_number: index + 1, status: "ok", reason: null, text: "Public solicitation page.", ocr_required: false, ocr_attempted: false }
  ));
  const extractor = async (bytes) => ({
    status: "ok",
    reason: null,
    method: "pdf_text_layer_per_page",
    pdf_library: "pypdf 5.9.0",
    pages: bytes.equals(openingBytes) ? opening.pages : fullContractPages,
  });
  const httpGet = async (_url, request) => {
    if (request.kind === "navigator") {
      return { status: 200, headers: { get: () => "text/html" }, bytes: Buffer.from(html), finalUrl: _url };
    }
    const bytes = _url.includes(opening.document_id) ? openingBytes : contractBytes;
    return { status: 200, headers, bytes, finalUrl: _url };
  };
  let tick = 0;
  try {
    const result = await observeNavigatorRfxDocuments({
      targetRfpIds: ["37728"],
      rfxRows: [{
        rfp_id: "37728",
        bpm_id: "37402",
        epin: "84627B0012",
        procurement_name: "Maintenance and Repair of Automated Controls",
        agency: "DEPARTMENT OF PARKS AND RECREATION",
      }],
      httpGet,
      projectRoot,
      extractor,
      extractorVersion: "page-extractor.v1",
      pdfLibraryVersion: "pypdf 5.9.0",
      ontologyVersion: "procurement-documents.v1",
      rulesVersion: "document-facts.v1",
      now: () => `2026-11-05T12:00:0${Math.min(tick++, 9)}.000Z`,
      nowMilliseconds: (() => { let value = 0; return () => value++; })(),
    });
    assert.equal(result.failures.length, 0);
    assert.deepEqual(
      result.shards.get("37728").rows.map((row) => publicReading(row, row)),
      EXPECTED.documents,
    );
    assert.deepEqual(
      { documents: result.metrics.documents, sections: result.metrics.sections, events: result.metrics.events, facts: result.metrics.facts, abstentions: result.metrics.abstentions },
      { documents: 2, sections: 13, events: 2, facts: 30, abstentions: 4 },
    );
    assert.deepEqual(result.manifest.coverage, {
      documents: 2,
      pages: 238,
      contract_book_pages_sectioned: 237,
      facts: 30,
      events: 2,
      abstentions: 4,
    });
    assert.deepEqual(result.manifest.cost, { model_calls: 0, model_tokens: 0, ocr_pages: 0 });
    assert.equal(result.manifest.measurement.cache_hits, 0);
    assert.equal(result.manifest.measurement.cache_misses, 2);
    assert.ok(result.manifest.measurement.fact_bytes_stored > 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
