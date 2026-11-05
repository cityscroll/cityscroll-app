import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  MAX_DOCUMENT_BYTES,
  boundedHttpGet,
  buildProcurementDocumentShard,
  createNavigatorObservationState,
  observeNavigatorRfxDocuments,
  parseNavigatorRfxHtml,
} from "../warehouse/lib/navigator_rfx_documents.mjs";
import { buildRfxPackageDocumentSurface } from "../worker/src/lib/rfx_documents_join.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(ROOT, "test/fixtures/navigator_rfx_documents");
const ANONYMOUS_HTML = readFileSync(path.join(FIXTURE_DIR, "anonymous-rfx.html"), "utf8");
const EXPECTED = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "expected-shard.json"), "utf8"));
const PDF_A = Buffer.from("%PDF-1.7\npublic fixture a");
const PDF_B = Buffer.from("%PDF-1.7\npublic fixture b");
const BASE_ROW = Object.freeze({
  rfp_id: "37728",
  bpm_id: "37402",
  epin: "84627B0012",
  procurement_name: "Maintenance and Repair of Automated Controls",
  agency: "DEPARTMENT OF PARKS AND RECREATION",
});

function headers(values = {}) {
  const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: (key) => normalized[String(key).toLowerCase()] ?? null };
}

function response(bytes, options = {}) {
  return {
    status: options.status ?? 200,
    headers: headers({ "content-type": options.contentType || "application/pdf", ...options.headers }),
    bytes: Buffer.from(bytes),
    finalUrl: options.finalUrl,
    redirected: options.redirected ?? false,
  };
}

function oneDocumentHtml({
  displayedId = "037402",
  round = "1",
  url = "https://webserver-mocs-prd.lfr.cloud/c/public_document/download?documentId=9001",
  label = "Solicitation document",
} = {}) {
  return `<!doctype html><title>Public RFx (${displayedId}) - Lot : / Round : ${round}: PASSPort</title><a href="${url}">${label}</a>`;
}

function extractorWithPages(
  pages = [{ page_number: 1, status: "ok", reason: null, text: "Public solicitation text", ocr_required: false, ocr_attempted: false }],
  pdfLibrary = "pypdf 5.9.0",
) {
  return async () => ({ status: "ok", reason: null, method: "pdf_text_layer_per_page", pdf_library: pdfLibrary, pages });
}

async function runObservation({
  html = oneDocumentHtml(),
  rows = [BASE_ROW],
  targets = [BASE_ROW.rfp_id],
  documentResponse = response(PDF_A),
  state = createNavigatorObservationState(),
  extractor = extractorWithPages(),
  extractorVersion = "page-extractor.v1",
  pdfLibraryVersion = "pypdf 5.9.0",
  maxDocumentBytes = MAX_DOCUMENT_BYTES,
  httpGet: customHttpGet = null,
} = {}) {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "navigator-rfx-documents-"));
  const timestamps = [
    "2026-11-05T12:00:00.000Z",
    "2026-11-05T12:00:01.000Z",
    "2026-11-05T12:00:02.000Z",
    "2026-11-05T12:00:03.000Z",
    "2026-11-05T12:00:04.000Z",
  ];
  let tick = 0;
  const httpGet = customHttpGet || (async (_url, request) => (
    request.kind === "navigator"
      ? response(Buffer.from(html), { contentType: "text/html" })
      : documentResponse
  ));
  try {
    const result = await observeNavigatorRfxDocuments({
      targetRfpIds: targets,
      rfxRows: rows,
      httpGet,
      projectRoot,
      state,
      extractor,
      extractorVersion,
      pdfLibraryVersion,
      ontologyVersion: "procurement-documents.v1",
      rulesVersion: "observation-only.v1",
      now: () => timestamps[Math.min(tick++, timestamps.length - 1)],
      maxDocumentBytes,
    });
    return { result, projectRoot };
  } catch (error) {
    rmSync(projectRoot, { recursive: true, force: true });
    throw error;
  }
}

function cleanup(run) {
  rmSync(run.projectRoot, { recursive: true, force: true });
}

function publicRowFields(row) {
  return Object.fromEntries([
    "document_id",
    "label",
    "official_url",
    "sha256",
    "bytes",
    "page_count",
    "pages_with_text",
    "ocr_required_pages",
  ].map((key) => [key, row[key]]));
}

test("saved anonymous HTML preserves round identity and the two official document links", () => {
  const parsed = parseNavigatorRfxHtml(ANONYMOUS_HTML, { navigatorUrl: EXPECTED.source.navigator_url });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.displayed_id, EXPECTED.subject.displayed_id);
  assert.equal(parsed.round_label, EXPECTED.subject.round_label);
  assert.deepEqual(
    parsed.documents,
    EXPECTED.rows.map(({ document_id, label, official_url }) => ({ document_id, label, official_url })),
  );
});

test("the generated shard contract retains the measured public row fields exactly", () => {
  const shard = buildProcurementDocumentShard({
    subject: EXPECTED.subject,
    observation: {
      access_mode: EXPECTED.source.access_mode,
      round_label: EXPECTED.subject.round_label,
      capture_receipt: { request_url: EXPECTED.source.navigator_url, retrieved_at: EXPECTED.source.observed_at },
    },
    rows: EXPECTED.rows,
  });
  assert.deepEqual(shard.rows.map(publicRowFields), EXPECTED.rows);
  assert.notEqual(shard.subject.rfp_id, shard.subject.bpm_id);
  assert.equal(shard.subject.displayed_id, `0${shard.subject.bpm_id}`);
});

test("positive acquisition stores bytes by hash, extracts pages, and retains a complete capture receipt", async () => {
  const run = await runObservation();
  try {
    assert.equal(run.result.failures.length, 0);
    const shard = run.result.shards.get(BASE_ROW.rfp_id);
    assert.equal(shard.rows.length, 1);
    const row = shard.rows[0];
    assert.match(row.raw_object_path, /^warehouse\/raw\/passport-navigator\/documents\/[a-f0-9]{64}\.pdf$/);
    assert.equal(row.page_count, 1);
    assert.equal(row.pages_with_text, 1);
    assert.deepEqual(row.ocr_required_pages, []);
    assert.equal(row.capture_receipt.access_mode, "anonymous-direct-http");
    assert.equal(row.capture_receipt.request_url, row.official_url);
    assert.equal(row.capture_receipt.final_url, row.official_url);
    assert.equal(row.capture_receipt.status, 200);
    assert.equal(row.capture_receipt.bytes, PDF_A.length);
    assert.match(row.capture_receipt.sha256, /^[a-f0-9]{64}$/);
    assert.equal(row.capture_receipt.requested_at, "2026-11-05T12:00:02.000Z");
    assert.equal(row.capture_receipt.retrieved_at, "2026-11-05T12:00:03.000Z");
    assert.equal(row.capture_receipt.pdf_library_version, "pypdf 5.9.0");
    assert.equal(shard.subject.rfp_id, BASE_ROW.rfp_id);
    assert.equal(shard.subject.bpm_id, BASE_ROW.bpm_id);
    assert.equal(shard.subject.displayed_id, "037402");
    assert.equal(shard.subject.round_label, "1");
  } finally {
    cleanup(run);
  }
});

test("login HTML is an access_required failure and admits no document", async () => {
  const login = '<html><form action="/login"><input type="password"></form></html>';
  const run = await runObservation({ html: login });
  try {
    assert.deepEqual(run.result.failures.map((entry) => entry.type), ["access_required"]);
    assert.equal(run.result.manifest.row_count, 0);
  } finally {
    cleanup(run);
  }
});

test("redirect, off-host, oversized, and non-PDF responses are typed failures with no row", async (t) => {
  const cases = [
    {
      name: "redirect",
      expected: "redirect_rejected",
      documentResponse: response(PDF_A, { status: 302, finalUrl: "https://passport.cityofnewyork.us/login" }),
    },
    {
      name: "off-host",
      expected: "host_rejected",
      html: oneDocumentHtml({ url: "https://example.invalid/document.pdf?documentId=9001" }),
    },
    {
      name: "declared oversize",
      expected: "oversize_declared",
      documentResponse: response(PDF_A, { headers: { "content-length": MAX_DOCUMENT_BYTES + 1 } }),
    },
    {
      name: "streamed oversize",
      expected: "oversize_streamed",
      documentResponse: response(Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 1)),
    },
    {
      name: "signature",
      expected: "non_pdf_signature",
      documentResponse: response(Buffer.from("not a PDF")),
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const run = await runObservation(item);
      try {
        const shard = run.result.shards.get(BASE_ROW.rfp_id);
        assert.equal(shard.rows.length, 0);
        assert.deepEqual(run.result.failures.map((entry) => entry.type), [item.expected]);
      } finally {
        cleanup(run);
      }
    });
  }
});

test("bounded HTTP rejects declared and streamed oversize bodies before admission", async () => {
  const declared = await boundedHttpGet("https://public.example/document", {
    maxBytes: 4,
    fetchImpl: async () => new Response("x", { headers: { "content-length": "5" } }),
  });
  assert.equal(declared.failure.type, "oversize_declared");

  const streamed = await boundedHttpGet("https://public.example/document", {
    maxBytes: 4,
    fetchImpl: async () => new Response("12345"),
  });
  assert.equal(streamed.failure.type, "oversize_streamed");
});

test("an unknown rfp_id fails before any request and produces no shard", async () => {
  let requests = 0;
  const run = await runObservation({
    targets: ["99999"],
    httpGet: async () => { requests += 1; throw new Error("must not request"); },
  });
  try {
    assert.equal(requests, 0);
    assert.deepEqual(run.result.failures.map((entry) => entry.type), ["unknown_rfp_id"]);
    assert.equal(run.result.shards.size, 0);
  } finally {
    cleanup(run);
  }
});

test("two rounds sharing an EPIN remain separate rfp_id shards", async () => {
  const rows = [
    { ...BASE_ROW, rfp_id: "51001", bpm_id: "700", epin: "SHARED-EPIN" },
    { ...BASE_ROW, rfp_id: "51002", bpm_id: "700", epin: "SHARED-EPIN" },
  ];
  const projectRoot = mkdtempSync(path.join(tmpdir(), "navigator-rounds-"));
  const httpGet = async (url, request) => {
    if (request.kind === "navigator") {
      const round = url.endsWith("51001") ? "1" : "2";
      return response(Buffer.from(oneDocumentHtml({ displayedId: "000700", round })), { contentType: "text/html" });
    }
    return response(url.includes("9001") ? PDF_A : PDF_B);
  };
  try {
    const result = await observeNavigatorRfxDocuments({
      targetRfpIds: rows.map((row) => row.rfp_id),
      rfxRows: rows,
      httpGet,
      projectRoot,
      extractor: extractorWithPages(),
      extractorVersion: "page-extractor.v1",
      pdfLibraryVersion: "pypdf 5.9.0",
      ontologyVersion: "procurement-documents.v1",
      rulesVersion: "observation-only.v1",
    });
    assert.deepEqual([...result.shards.keys()], ["51001", "51002"]);
    assert.equal(result.shards.get("51001").subject.round_label, "1");
    assert.equal(result.shards.get("51002").subject.round_label, "2");
    assert.equal(result.shards.get("51001").subject.epin, result.shards.get("51002").subject.epin);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("identical bytes under two URLs store once and retain two observations without a second parse", async () => {
  const html = `<!doctype html><title>Public RFx (037402) - Lot : / Round : 1: PASSPort</title>
    <a href="https://webserver-mocs-prd.lfr.cloud/c/public_document/download?documentId=9001">First URL</a>
    <a href="https://webserver-mocs-prd.lfr.cloud/c/public_document/download?documentId=9002">Second URL</a>`;
  let extractionRuns = 0;
  const run = await runObservation({
    html,
    extractor: async () => {
      extractionRuns += 1;
      return extractorWithPages()(PDF_A);
    },
  });
  try {
    const rows = run.result.shards.get(BASE_ROW.rfp_id).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].sha256, rows[1].sha256);
    assert.equal(rows[0].raw_object_path, rows[1].raw_object_path);
    assert.notEqual(rows[0].official_url, rows[1].official_url);
    assert.equal(extractionRuns, 1);
    assert.equal(run.result.state.extractions.size, 1);
  } finally {
    cleanup(run);
  }
});

test("a parser or PDF-library change appends an extraction and retains the old result", async () => {
  const state = createNavigatorObservationState();
  const first = await runObservation({ state, extractorVersion: "page-extractor.v1", pdfLibraryVersion: "pypdf 5.9.0" });
  try {
    const second = await runObservation({
      state,
      extractorVersion: "page-extractor.v2",
      pdfLibraryVersion: "pypdf 6.0.0",
      extractor: extractorWithPages(undefined, "pypdf 6.0.0"),
    });
    try {
      const histories = second.result.shards.get(BASE_ROW.rfp_id).rows[0].extractions;
      assert.equal(histories.length, 2);
      assert.deepEqual(histories.map((entry) => entry.extraction_key.extractor), ["page-extractor.v1", "page-extractor.v2"]);
      assert.deepEqual(histories.map((entry) => entry.extraction_key.pdf_library), ["pypdf 5.9.0", "pypdf 6.0.0"]);
      assert.equal(state.extraction_runs, 2);
    } finally {
      cleanup(second);
    }
  } finally {
    cleanup(first);
  }
});

test("a text-less page stays ocr_required and does not invoke OCR or a model", async () => {
  const run = await runObservation({
    extractor: extractorWithPages([
      { page_number: 1, status: "extract_failed", reason: "empty_text_layer", text: "", ocr_required: true, ocr_attempted: false },
    ]),
  });
  try {
    const row = run.result.shards.get(BASE_ROW.rfp_id).rows[0];
    assert.equal(row.pages_with_text, 0);
    assert.deepEqual(row.ocr_required_pages, [1]);
    const extraction = [...run.result.state.extractions.values()][0];
    assert.equal(extraction.pages[0].ocr_attempted, false);
    assert.equal(extraction.pages[0].measured, false);
  } finally {
    cleanup(run);
  }
});

test("Navigator observation does not change the public RFx-dump document verdict", () => {
  assert.deepEqual(buildRfxPackageDocumentSurface(BASE_ROW), {
    status: "not_published",
    source: "city-record-getfile",
    urls: [],
    count: 0,
    reason: "public_rfx_data_has_no_document_urls",
    city_record_getfile: "https://a856-cityrecord.nyc.gov/Search/GetFile",
    request_id: null,
  });
});
