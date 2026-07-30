// Characterization for Current Solicitations (3khw-qi8f) → lifecycle join.
// Real field cases from the public Open Data view (request_ids verified 2026-07-30).
//
//   node --test test/current_solicitations.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDocumentLinks,
  normalizeSolicitationRow,
  joinSolicitationEnrichment,
  documentsStatusFor,
  applySolicitationDetail,
  CURRENT_SOLICITATIONS_DATASET,
  CURRENT_SOLICITATIONS_SOURCE,
} from "../worker/src/lib/current_solicitations.mjs";
import { assembleLifecycle } from "../worker/src/lib/checkbook_lifecycle.mjs";

// Real rows from 3khw-qi8f (Citywide Administrative Services package with documents).
const ROW_WITH_DOCS = {
  request_id: "20240816113",
  start_date: "2024-10-01T00:00:00.000",
  agency_name: "Citywide Administrative Services",
  type_of_notice_description: "Solicitation",
  short_title: "Correction: 85725P0001-New York City Centralized Construction Mentor Program",
  selection_method_description: "Competitive Sealed Proposals",
  pin: "85725P0001",
  due_date: "2024-10-07T10:30:00.000",
  document_links: {
    url: "https://a856-cityrecord.nyc.gov/Search/GetFile?SectionID=6&amp;RequestStatus=Archived&amp;RequestID=20240816113&amp;DocumentID=38698",
  },
};

// Real current DCAS solicitation without package document_links on the view.
const ROW_NO_DOCS = {
  request_id: "20260709023",
  start_date: "2026-07-10T00:00:00.000",
  agency_name: "Citywide Administrative Services",
  type_of_notice_description: "Solicitation",
  short_title: "Correction: 85726B0067-2600056- FORKLIFTS DIESEL",
  pin: "85726B0067",
  due_date: "2026-08-19T10:30:00.000",
};

test("dataset id is the gap-registry Current Solicitations view", () => {
  assert.equal(CURRENT_SOLICITATIONS_DATASET, "3khw-qi8f");
  assert.equal(CURRENT_SOLICITATIONS_SOURCE, "ocp-current-solicitations");
});

test("parseDocumentLinks unescapes entities and splits multi-doc URLs", () => {
  assert.deepEqual(
    parseDocumentLinks({
      url: "https://a856-cityrecord.nyc.gov/Search/GetFile?SectionID=6&amp;RequestStatus=Archived&amp;RequestID=20240816113&amp;DocumentID=38698,https://example.nyc/doc2",
    }),
    [
      "https://a856-cityrecord.nyc.gov/Search/GetFile?SectionID=6&RequestStatus=Archived&RequestID=20240816113&DocumentID=38698",
      "https://example.nyc/doc2",
    ],
  );
  assert.deepEqual(parseDocumentLinks(null), []);
  assert.deepEqual(parseDocumentLinks(""), []);
});

test("request_id join matches real package row and flips documents to matched", () => {
  const notice = {
    request_id: "20240816113",
    agency_name: "Citywide Administrative Services",
    pin: "85725P0001",
    type_of_notice_description: "Solicitation",
    short_title: "Mentor Program",
    start_date: "2024-10-01",
  };
  const enrichment = joinSolicitationEnrichment(notice, [ROW_WITH_DOCS, ROW_NO_DOCS]);
  assert.equal(enrichment.status, "matched");
  assert.equal(enrichment.basis, "request_id");
  assert.equal(enrichment.match.request_id, "20240816113");
  assert.equal(enrichment.match.n_documents, 1);
  assert.equal(documentsStatusFor(enrichment), "matched");

  const detail = applySolicitationDetail({
    request_id: notice.request_id,
    agency: notice.agency_name,
    title: notice.short_title,
    pin: notice.pin,
  }, enrichment);
  assert.equal(detail.documents_status, "matched");
  assert.equal(detail.n_documents, 1);
  assert.match(detail.documents[0], /^https:\/\/a856-cityrecord\.nyc\.gov\//);
  assert.equal(detail.due_date, ROW_WITH_DOCS.due_date);
});

test("matched row without documents stays unmatched on the documents sub-slot", () => {
  const notice = {
    request_id: "20260709023",
    agency_name: "Citywide Administrative Services",
    pin: "85726B0067",
    type_of_notice_description: "Solicitation",
  };
  const enrichment = joinSolicitationEnrichment(notice, [ROW_NO_DOCS]);
  assert.equal(enrichment.status, "matched");
  assert.equal(documentsStatusFor(enrichment), "unmatched");
  const detail = applySolicitationDetail({ request_id: notice.request_id }, enrichment);
  assert.equal(detail.documents_status, "unmatched");
  assert.equal(detail.n_documents, 0);
  assert.equal(detail.due_date, ROW_NO_DOCS.due_date);
});

test("pin+agency join links an award notice to a prior solicitation package", () => {
  const award = {
    request_id: "20251299999",
    agency_name: "Citywide Administrative Services",
    pin: "85725P0001",
    type_of_notice_description: "Award",
    short_title: "Mentor Program Award",
    vendor_name: "ACME CORP",
    contract_amount: 100000,
    start_date: "2025-01-15",
  };
  const enrichment = joinSolicitationEnrichment(award, [ROW_WITH_DOCS]);
  assert.equal(enrichment.status, "matched");
  assert.equal(enrichment.basis, "pin+agency");

  const lifecycle = assembleLifecycle(award, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
    currentSolicitation: { status: "ok", rows: [ROW_WITH_DOCS] },
  });
  const sol = lifecycle.timeline.find((s) => s.stage === "solicitation");
  assert.ok(sol, "award with PIN join gains a solicitation stage");
  assert.equal(sol.status, "matched");
  assert.equal(sol.source, CURRENT_SOLICITATIONS_SOURCE);
  assert.equal(sol.documents_status, "matched");
  assert.equal(sol.detail.n_documents, 1);
  assert.equal(lifecycle.solicitation_enrichment.status, "matched");
});

test("assembleLifecycle solicitation notice surfaces documents_status on the stage", () => {
  const notice = {
    request_id: "20240816113",
    agency_name: "Citywide Administrative Services",
    pin: "85725P0001",
    type_of_notice_description: "Solicitation",
    short_title: "Mentor Program",
    start_date: "2024-10-01",
  };
  const withDocs = assembleLifecycle(notice, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
    currentSolicitation: { status: "ok", rows: [ROW_WITH_DOCS] },
  });
  const sol = withDocs.timeline.find((s) => s.stage === "solicitation");
  assert.equal(sol.documents_status, "matched");
  assert.equal(sol.detail.n_documents, 1);

  const missing = assembleLifecycle(notice, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
    currentSolicitation: { status: "ok", rows: [] },
  });
  const solGap = missing.timeline.find((s) => s.stage === "solicitation");
  assert.equal(solGap.documents_status, "unmatched");
  assert.equal(missing.solicitation_enrichment.status, "unmatched");

  const unreachable = assembleLifecycle(notice, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
    currentSolicitation: { status: "error", rows: [] },
  });
  assert.equal(
    unreachable.timeline.find((s) => s.stage === "solicitation").documents_status,
    "unknown",
  );
});

test("normalizeSolicitationRow preserves contact and selection method", () => {
  const n = normalizeSolicitationRow({
    ...ROW_WITH_DOCS,
    contact_name: "Sukhjeet Singh",
    email: "suksingh@dcas.nyc.gov",
  });
  assert.equal(n.contact_name, "Sukhjeet Singh");
  assert.equal(n.email, "suksingh@dcas.nyc.gov");
  assert.equal(n.selection_method_description, "Competitive Sealed Proposals");
  assert.equal(n.source, CURRENT_SOLICITATIONS_SOURCE);
});
