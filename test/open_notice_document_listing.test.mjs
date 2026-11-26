import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MAX_DOCUMENT_BYTES } from "../warehouse/lib/navigator_rfx_documents.mjs";
import {
  BASIS,
  LISTING_COVERAGE_SCHEMA,
  LISTING_SCHEMA,
  REASON_CODES,
  buildOpenNoticeDocumentListings,
  listNavigatorDocuments,
  matchCorroboratedTitle,
  normalizeTitleForCorroboration,
  parsePublisherClock,
} from "../tools/lib/open_notice_document_listing.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PARKS_HTML = readFileSync(
  path.join(ROOT, "test/fixtures/open_notice_document_listing/navigator-typed.html"),
  "utf8",
);
const AS_OF = "2026-11-16";

function notice(overrides = {}) {
  return {
    request_id: "20260901018",
    pin: "85827Y1399",
    short_title: "IT Consulting Services",
    start_date: "2026-09-01T00:00:00.000",
    due_date: "2026-11-20T14:00:00.000",
    ...overrides,
  };
}

function round(overrides = {}) {
  return {
    rfp_id: "38224",
    bpm_id: "382240",
    epin: "85827Y1399",
    procurement_name: "IT Consulting Services",
    release_date: "9/1/2026",
    due_date: "11/20/2026 2:00:00 PM",
    ...overrides,
  };
}

function page({ displayed = "0382240", roundLabel = "1", files }) {
  const rows = files.map((file) => (
    `<tr data-object-type="rfp"><td><a href="https://webserver-mocs-prd.lfr.cloud/c/public_document/download?documentId=${file.id}">${file.name}</a></td><td>${file.type}</td></tr>`
  )).join("");
  return `<!doctype html><title>Example (${displayed}) - Lot : / Round : ${roundLabel}: PASSPort</title><table>${rows}</table>`;
}

function recordFor(artifact, requestId) {
  const entry = artifact.notices.find((row) => row.request_id === requestId);
  assert.ok(entry, requestId);
  return entry.coverage.documents_listed;
}

test("a strictly bound notice lists public files, and size and pages stay unmeasured until observed", () => {
  const html = page({
    files: [
      { id: "100", name: "Scope of Work", type: "RFx Document" },
      { id: "101", name: "Addendum 1", type: "Addendum Document" },
    ],
  });
  const artifact = buildOpenNoticeDocumentListings({
    notices: [notice()],
    rfxRows: [round()],
    navigatorByRfpId: { 38224: html },
    asOf: AS_OF,
    observedAt: "2026-11-17T05:00:00.000Z",
  });
  assert.equal(artifact.schema, LISTING_SCHEMA);
  assert.equal(artifact.state, "measured");
  assert.equal(artifact.documents_listed_coverage.schema, LISTING_COVERAGE_SCHEMA);
  assert.equal(artifact.available, 1);
  assert.equal(artifact.missing, 0);
  assert.equal(artifact.available + artifact.missing, artifact.open_notices);
  const record = recordFor(artifact, "20260901018");
  assert.equal(record.key, "documents_listed");
  assert.equal(record.state, "available");
  assert.equal(record.reason, null);
  assert.deepEqual(record.source, { name: "passport_navigator_rfx" });
  assert.equal(record.as_of, AS_OF);
  assert.equal(record.data.binding, "corroborated");
  assert.deepEqual(record.data.basis, [...BASIS]);
  assert.equal(record.data.file_count, 2);
  assert.equal(record.data.page_count_total, null);
  assert.equal(record.data.files[0].name, "Scope of Work");
  assert.equal(record.data.files[0].type, "RFx Document");
  assert.equal(record.data.files[0].size_bytes, null);
  assert.equal(record.data.files[0].size_unit, "bytes");
  assert.equal(record.data.files[0].size_state, "not_measured");
  assert.equal(record.data.files[0].page_count, null);
  assert.equal(record.data.files[0].page_unit, "pages");
  assert.equal(record.data.files[0].page_state, "not_measured");
  assert.equal(record.data.files[1].type, "Addendum Document");
  assert.equal(artifact.documents_listed_coverage.files_listed, 2);
  assert.equal(artifact.documents_listed_coverage.files_pages_measured, 0);
  assert.doesNotMatch(JSON.stringify({ reason: record.reason, source: record.source, key: record.key }), /[<>]/);
});

test("an observation fills size and pages, an oversize file is listed and not read, and a spreadsheet has no page count", () => {
  const html = page({
    files: [
      { id: "100", name: "Scope &lt;of&gt; Work", type: "RFx Document" },
      { id: "150", name: "Unread book", type: "RFx Document" },
      { id: "200", name: "Capital book", type: "RFx Document" },
      { id: "300", name: "Price sheet", type: "RFx Document" },
    ],
  });
  const artifact = buildOpenNoticeDocumentListings({
    notices: [notice()],
    rfxRows: [round()],
    navigatorByRfpId: { 38224: html },
    fileObservations: {
      100: { size_bytes: 304598, content_type: "application/pdf", filename: "Scope.pdf", page_count: 8 },
      150: { content_type: "application/pdf", oversize: true, page_count: 10 },
      200: { size_bytes: MAX_DOCUMENT_BYTES + 1, content_type: "application/pdf", page_count: 3784 },
      300: { size_bytes: 14000, content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "prices.xlsx", page_count: 3 },
    },
    asOf: AS_OF,
  });
  const files = recordFor(artifact, "20260901018").data.files;
  assert.equal(files[0].name, "Scope <of> Work");
  assert.equal(files[0].file_kind, "pdf");
  assert.equal(files[0].size_bytes, 304598);
  assert.equal(files[0].page_count, 8);
  assert.equal(files[0].page_state, "measured");
  assert.equal(files[1].size_bytes, null);
  assert.equal(files[1].page_count, null);
  assert.equal(files[1].page_state, "oversize");
  assert.equal(files[2].size_bytes, MAX_DOCUMENT_BYTES + 1);
  assert.equal(files[2].page_count, null);
  assert.equal(files[2].page_state, "oversize");
  assert.equal(files[3].file_kind, "spreadsheet");
  assert.equal(files[3].page_count, null);
  assert.equal(files[3].page_state, "not_applicable");
  assert.equal(recordFor(artifact, "20260901018").data.page_count_total, null);
  assert.equal(artifact.documents_listed_coverage.files_oversize, 2);
  assert.equal(artifact.documents_listed_coverage.files_pages_measured, 1);
});

test("page total is the sum only when every file is measured or not a page-bearing file", () => {
  const html = page({
    files: [
      { id: "100", name: "Scope", type: "RFx Document" },
      { id: "300", name: "Price sheet", type: "RFx Document" },
    ],
  });
  const artifact = buildOpenNoticeDocumentListings({
    notices: [notice()],
    rfxRows: [round()],
    navigatorByRfpId: { 38224: html },
    fileObservations: {
      100: { size_bytes: 1000, content_type: "application/pdf", page_count: 8 },
      300: { size_bytes: 1000, filename: "prices.xlsx" },
    },
    asOf: AS_OF,
  });
  assert.equal(recordFor(artifact, "20260901018").data.page_count_total, 8);
});

test("the retained Navigator page binds when the round id matches, and names the real file types", () => {
  const listed = listNavigatorDocuments(PARKS_HTML);
  assert.equal(listed.ok, true);
  assert.equal(listed.displayed_id, "037402");
  assert.deepEqual(listed.documents.map((file) => [file.document_id, file.type]), [
    ["257022302", "Addendum Document"],
    ["253289498", "RFx Document"],
    ["253286611", "RFx Document"],
  ]);
  const artifact = buildOpenNoticeDocumentListings({
    notices: [notice({
      request_id: "20261015010",
      pin: "84627B0012",
      short_title: "Maintenance and Repair of Automated Logic WebCTRL and Carrier",
      start_date: "2026-10-21T00:00:00.000",
      due_date: "2026-11-09T14:00:00.000",
    })],
    rfxRows: [round({
      rfp_id: "37728",
      bpm_id: "37402",
      epin: "84627B0012",
      procurement_name: "Maintenance and Repair of Automated Logic WebCTRL and Carrier",
      release_date: "10/21/2026",
      due_date: "11/9/2026 2:00:00 PM",
    })],
    navigatorByRfpId: { 37728: PARKS_HTML },
    asOf: AS_OF,
  });
  const record = recordFor(artifact, "20261015010");
  assert.equal(record.state, "available");
  assert.equal(record.data.files.length, 3);
  assert.equal(record.data.files[1].name, "Bid Opening Information(6)");
  assert.equal(record.data.displayed_id, "037402");
});

test("a notice stays in the list when the binding is not strict", () => {
  const html = page({ files: [{ id: "100", name: "Scope", type: "RFx Document" }] });
  const cases = [
    [notice({ request_id: "1", pin: "" }), [round()], "no_pin"],
    [notice({ request_id: "2", pin: "NOTAPIN" }), [round()], "pin_not_joined"],
    [notice({ request_id: "3", pin: "85827Y001" }), [round({ epin: "85827Y0011" })], "pin_not_joined"],
    [notice({ request_id: "4" }), [round(), round({ rfp_id: "99999", due_date: "11/21/2026 2:00:00 PM" })], "ambiguous_epin"],
    [notice({ request_id: "5", short_title: "A different title" }), [round()], "title_mismatch"],
    [notice({ request_id: "6", start_date: "2026-09-02T00:00:00.000" }), [round()], "release_date_mismatch"],
    [notice({ request_id: "7", due_date: "2026-11-20T15:00:00.000" }), [round()], "due_datetime_mismatch"],
  ];
  for (const [row, rows, reason] of cases) {
    const artifact = buildOpenNoticeDocumentListings({
      notices: [row],
      rfxRows: rows,
      navigatorByRfpId: { 38224: html, 99999: html },
      asOf: AS_OF,
    });
    const record = recordFor(artifact, row.request_id);
    assert.equal(record.state, "missing", row.request_id);
    assert.equal(record.data.reason_code, reason, row.request_id);
    assert.equal(record.reason.length > 0, true);
    assert.equal(record.data.files.length, 0);
    assert.doesNotMatch(record.reason, /[<>]/);
    const summed = Object.values(artifact.documents_listed_coverage.by_reason).reduce((sum, n) => sum + n, 0);
    assert.equal(summed, artifact.missing);
  }
});

test("identical duplicate rows collapse, and a matched round with no page read stays unmatched", () => {
  const collapsed = buildOpenNoticeDocumentListings({
    notices: [notice()],
    rfxRows: [round(), round()],
    navigatorByRfpId: { 38224: page({ files: [{ id: "100", name: "Scope", type: "RFx Document" }] }) },
    asOf: AS_OF,
  });
  assert.equal(recordFor(collapsed, "20260901018").state, "available");
  const unread = buildOpenNoticeDocumentListings({
    notices: [notice()],
    rfxRows: [round()],
    navigatorByRfpId: {},
    asOf: AS_OF,
  });
  assert.equal(recordFor(unread, "20260901018").data.reason_code, "navigator_not_observed");
});

test("a displayed id that does not match the round, a login page, and an empty file table stay missing", () => {
  const mismatch = buildOpenNoticeDocumentListings({
    notices: [notice()],
    rfxRows: [round({ bpm_id: "111" })],
    navigatorByRfpId: { 38224: page({ displayed: "0382240", files: [{ id: "100", name: "Scope", type: "RFx Document" }] }) },
    asOf: AS_OF,
  });
  assert.equal(recordFor(mismatch, "20260901018").data.reason_code, "navigator_identity_mismatch");
  const login = buildOpenNoticeDocumentListings({
    notices: [notice()],
    rfxRows: [round()],
    navigatorByRfpId: { 38224: "<form id=\"login\"><input type=\"password\"></form>" },
    asOf: AS_OF,
  });
  assert.equal(recordFor(login, "20260901018").data.reason_code, "navigator_unavailable");
  assert.equal(recordFor(login, "20260901018").data.failure, "access_required");
  const empty = buildOpenNoticeDocumentListings({
    notices: [notice()],
    rfxRows: [round()],
    navigatorByRfpId: { 38224: page({ files: [] }) },
    asOf: AS_OF,
  });
  assert.equal(recordFor(empty, "20260901018").data.reason_code, "no_public_files");
});

test("a failed or empty PASSPort read still publishes every notice and is not a measured zero", () => {
  for (const [failure, reason] of [[ "rfx-http-503", "rfx_unavailable" ], [ null, "rfx_empty" ]]) {
    const artifact = buildOpenNoticeDocumentListings({
      notices: [notice(), notice({ request_id: "20260901019", pin: "" })],
      rfxRows: failure ? [] : [],
      rfxFailure: failure,
      asOf: AS_OF,
    });
    assert.equal(artifact.state, "unavailable");
    assert.equal(artifact.available, 0);
    assert.equal(artifact.missing, 2);
    assert.equal(artifact.documents_listed_coverage.state, "unavailable");
    for (const entry of artifact.notices) {
      assert.equal(entry.coverage.documents_listed.state, "missing");
      assert.equal(entry.coverage.documents_listed.data.reason_code, reason);
    }
  }
});

test("publisher clocks match the one retained due-time pair, and every reason code is present", () => {
  assert.equal(parsePublisherClock("11/9/2026 2:00:00 PM").stamp, "2026-11-09T14:00:00");
  assert.equal(parsePublisherClock("2026-11-09T14:00:00.000").stamp, "2026-11-09T14:00:00");
  assert.equal(parsePublisherClock("10/21/2026").day, "2026-10-21");
  const artifact = buildOpenNoticeDocumentListings({
    notices: [notice({ pin: "" })],
    rfxRows: [round()],
    asOf: AS_OF,
  });
  assert.deepEqual(Object.keys(artifact.documents_listed_coverage.by_reason), [...REASON_CODES]);
});

test("whitespace in a title still matches, and a listing over the byte bound is refused", () => {
  const artifact = buildOpenNoticeDocumentListings({
    notices: [notice({ short_title: "IT   Consulting\nServices" })],
    rfxRows: [round({ procurement_name: " IT Consulting Services " })],
    navigatorByRfpId: { 38224: page({ files: [{ id: "100", name: "Scope", type: "RFx Document" }] }) },
    asOf: AS_OF,
  });
  assert.equal(recordFor(artifact, "20260901018").state, "available");
  const files = Array.from({ length: 5000 }, (_, index) => ({
    id: String(200000 + index),
    name: "n".repeat(500),
    type: "RFx Document",
  }));
  assert.throws(() => buildOpenNoticeDocumentListings({
    notices: [notice()],
    rfxRows: [round()],
    navigatorByRfpId: { 38224: page({ files }) },
    asOf: AS_OF,
  }), (error) => error.code === "listing_oversize");
});

test("strict normalized title corroboration strips framing and matched EPIN prefixes while rejecting unrelated titles", () => {
  assert.equal(normalizeTitleForCorroboration("Bid Extension: 85625B0011-CSB General Construction RC Man. & Bronx", "85625B0011"), "csb general construction rc man and bronx");
  assert.equal(matchCorroboratedTitle("IT Consulting Services", "IT Consulting Services", "85827Y1399"), "exact");

  // City Record framing prefix + PASSPort EPIN prefix
  assert.equal(matchCorroboratedTitle(
    "Bid Extension: Leveraging Ground-Scanning Technology",
    "85827Y1399-Leveraging Ground-Scanning Technology",
    "85827Y1399",
  ), "normalized");

  // Case + EPIN prefix on single-word commodity
  assert.equal(matchCorroboratedTitle("Antifreeze", "85727B0026-ANTIFREEZE", "85727B0026"), "normalized");

  // Agency project code containment (DEP BEPA/BEDC pattern)
  assert.equal(matchCorroboratedTitle(
    "82627B0009-BEPA: GI-CONS-4: Installation of green infrastructure at various NYC Parks",
    "82627B0009-BEPA: GI-CONS-4",
    "82627B0009",
  ), "normalized");

  // Address/borough abbreviation token overlap
  assert.equal(matchCorroboratedTitle(
    "Electrical System Replacement - 156 South 9th Street, Brooklyn",
    "80626B0039-Electrical System Replacement - 156 S 9 St BK",
    "80626B0039",
  ), "normalized");

  // Negative controls: unrelated titles, generic 1-word containment, and zero-overlap code-only titles must stay rejected.
  assert.equal(matchCorroboratedTitle("A different title", "IT Consulting Services", "85827Y1399"), null);
  assert.equal(matchCorroboratedTitle("Services", "IT Consulting Services", "85827Y1399"), null);
  assert.equal(matchCorroboratedTitle("Supply of Computers", "Supply of Furniture", "85827Y1399"), null);
  assert.equal(matchCorroboratedTitle(
    "Correction: Construction Management Services for the Rehabilitation of the Wallkill Blow-off Chamber",
    "82627P0005-BEDC-CAT-523-CM",
    "82627P0005",
  ), null);

  // End-to-end binding still requires single round, exact release day, exact due time, and Navigator displayed_id match.
  const html = page({ files: [{ id: "100", name: "Scope of Work", type: "RFx Document" }] });
  const artifact = buildOpenNoticeDocumentListings({
    notices: [
      notice({
        request_id: "20260901018",
        short_title: "Bid Extension: IT Consulting Services",
      }),
      notice({
        request_id: "20260901019",
        pin: "82627P0005",
        short_title: "Correction: Construction Management Services for Wallkill",
      }),
    ],
    rfxRows: [
      round({ procurement_name: "85827Y1399-IT Consulting Services" }),
      round({ rfp_id: "40000", bpm_id: "400000", epin: "82627P0005", procurement_name: "82627P0005-BEDC-CAT-523-CM" }),
    ],
    navigatorByRfpId: { 38224: html, 40000: html },
    asOf: AS_OF,
  });
  const bound = recordFor(artifact, "20260901018");
  assert.equal(bound.state, "available");
  assert.deepEqual(bound.data.basis, [...BASIS]);
  assert.equal(recordFor(artifact, "20260901019").data.reason_code, "title_mismatch");
});
