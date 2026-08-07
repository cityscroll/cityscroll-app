// PASSPort RFx package-document join recon characterization.
//
//   node --test test/rfx_documents_join.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CITY_RECORD_GETFILE_HOST,
  CITY_RECORD_GETFILE_URL,
  RFX_PUBLIC_COLUMNS,
  USEFULNESS_THRESHOLD,
  buildRfxPackageDocumentSurface,
  extractRfxDocumentUrls,
  isCityRecordGetFileUrl,
  measureRfxDocumentJoin,
  rfxRowHasPackageDocuments,
} from "../worker/src/lib/rfx_documents_join.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT = JSON.parse(
  readFileSync(
    join(
      ROOT,
      "site/data/passport_sources/verification_receipts/passport_rfx_documents_2026-07-30.json",
    ),
    "utf8",
  ),
);

const SAMPLE_RFX = [
  {
    rfp_id: "1",
    epin: "81026B0003",
    epin_norm: "81026B0003",
    procurement_name: "Sample RFx",
    agency: "DEPARTMENT OF TRANSPORTATION",
    rfx_status: "Released",
    release_date: "7/1/2026",
    due_date: "8/1/2026",
    main_commodity: "Services",
    procurement_method: "Competitive Sealed Bid",
  },
  {
    rfp_id: "2",
    epin: "82626B0066",
    epin_norm: "82626B0066",
    procurement_name: "Another",
    agency: "DEP",
    rfx_status: "Released",
  },
];

test("public RFx schema has no document URL columns", () => {
  assert.ok(RFX_PUBLIC_COLUMNS.includes("epin"));
  assert.ok(RFX_PUBLIC_COLUMNS.includes("procurement_name"));
  assert.equal(
    RFX_PUBLIC_COLUMNS.some((c) => /url|document|file|attachment/i.test(c)),
    false,
  );
  assert.deepEqual(extractRfxDocumentUrls(SAMPLE_RFX[0]), []);
  assert.equal(rfxRowHasPackageDocuments(SAMPLE_RFX[0]), false);
});

test("RFx package-document surface is explicit when the dump has no document URLs", () => {
  const surface = buildRfxPackageDocumentSurface(SAMPLE_RFX[0], { requestId: "20260701001" });
  assert.equal(surface.status, "not_published");
  assert.equal(surface.source, "city-record-getfile");
  assert.equal(surface.count, 0);
  assert.equal(surface.request_id, "20260701001");
  assert.equal(surface.city_record_getfile, CITY_RECORD_GETFILE_URL);
});

test("RFx package-document surface accepts future URL-bearing rows", () => {
  const surface = buildRfxPackageDocumentSurface({
    ...SAMPLE_RFX[0],
    package_url: "https://example.nyc.gov/rfp/package.pdf",
  });
  assert.deepEqual(surface, {
    status: "matched",
    source: "passport-public-rfx",
    urls: ["https://example.nyc.gov/rfp/package.pdf"],
    count: 1,
    city_record_getfile: CITY_RECORD_GETFILE_URL,
  });
});

test("kill-criterion sample: EPIN joins, document URL join is 0%", () => {
  // 50-notice kill sample shape: pins that match RFx + pins that do not.
  const notices = [
    { pin: "81026B0003" },
    { pin: "82626B0066" },
    { pin: "TGI-RED-AdaptiveReus" },
    { pin: "26-00128R" },
    { pin: "RFQ 2027-001" },
  ];
  // Pad to 50 with unjoinable pins so rates stay honest to the kill shape.
  while (notices.length < 50) notices.push({ pin: `NOJOIN${notices.length}` });

  const m = measureRfxDocumentJoin(notices, SAMPLE_RFX);
  assert.equal(m.total, 50);
  assert.equal(m.epin_joined, 2);
  assert.equal(m.document_url_joined, 0);
  assert.equal(m.document_url_join_rate, 0);
  assert.equal(m.document_urls_useful, false);
  assert.ok(m.epin_join_rate > 0);
  assert.ok(m.document_url_join_rate < USEFULNESS_THRESHOLD);
});

test("even 100% EPIN join fails the document usefulness threshold without URLs", () => {
  const notices = SAMPLE_RFX.map((r) => ({ pin: r.epin }));
  const m = measureRfxDocumentJoin(notices, SAMPLE_RFX);
  assert.equal(m.epin_joined, 2);
  assert.equal(m.epin_join_rate, 1);
  assert.equal(m.document_url_joined, 0);
  assert.equal(m.document_urls_useful, false);
});

test("hypothetical URL-bearing RFx row would count as a document join", () => {
  const withUrl = {
    ...SAMPLE_RFX[0],
    // Not present in the public dump; fixture only for the positive path.
    package_url: "https://example.nyc.gov/rfp/package.pdf",
  };
  assert.deepEqual(extractRfxDocumentUrls(withUrl), [
    "https://example.nyc.gov/rfp/package.pdf",
  ]);
  const m = measureRfxDocumentJoin([{ pin: "81026B0003" }], [withUrl]);
  assert.equal(m.document_url_joined, 1);
  assert.equal(m.document_urls_useful, true);
});

test("City Record GetFile recognizer pins the class-(b) pointer host", () => {
  assert.equal(CITY_RECORD_GETFILE_HOST, "a856-cityrecord.nyc.gov");
  assert.equal(
    isCityRecordGetFileUrl(
      "https://a856-cityrecord.nyc.gov/Search/GetFile?SectionID=6&RequestID=20241002118&DocumentID=38714",
    ),
    true,
  );
  assert.equal(
    isCityRecordGetFileUrl("https://data.cityofnewyork.us/d/3khw-qi8f"),
    false,
  );
});

test("verification receipt records kill-criterion failure and stop rule", () => {
  assert.equal(RECEIPT.schema_version, 1);
  assert.equal(RECEIPT.observed_on, "2026-07-30");
  assert.ok(RECEIPT.source_contracts.includes("passport-public-rfx"));

  const kill = RECEIPT.kill_criterion;
  assert.equal(kill.universe_n, 50);
  assert.equal(kill.rfx_document_url_join.joined, 0);
  assert.equal(kill.rfx_document_url_join.rate, 0);
  assert.ok(kill.rfx_epin_join.rate >= 0.3);
  assert.equal(kill.verdict, "stop_no_document_materialization");

  const modern = RECEIPT.join_measurement.rates.modern_solicitation_document_url;
  assert.equal(modern.joined, 0);
  assert.equal(modern.total, 1470);
  assert.equal(modern.rate, 0);

  assert.equal(RECEIPT.companion_fills.ocp_document_links_2025_plus.rate, 0);
  assert.equal(RECEIPT.companion_fills.city_record_document_links_2025_plus.rate, 0);
  assert.match(
    RECEIPT.product_decision,
    /not_published|City Record|GetFile|below/i,
  );
});
