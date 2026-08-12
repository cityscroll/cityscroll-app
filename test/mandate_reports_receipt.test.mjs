import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  FILING_RECEIPT_LABEL,
  MANDATE_REPORTS_RECEIPT_METHOD,
  agencyMandateReportsPath,
  buildMandateReportsReceiptView,
  isReportDeliverable,
  renderMandateReportsReceiptSection,
} from "../site/mandate_reports_receipt.mjs";
import {
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";
import { OBSERVATION_STATUS } from "../site/process_conformance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PARKS = "parks-and-recreation";

const intelligence = JSON.parse(
  readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"),
);
const certification = JSON.parse(
  readFileSync(join(ROOT, "site/data/exam_certification_constellation.json"), "utf8"),
);
const obligations = existsSync(join(ROOT, "site/data/agency_obligations_lookup.json"))
  ? JSON.parse(readFileSync(join(ROOT, "site/data/agency_obligations_lookup.json"), "utf8"))
  : null;
const processConformance = existsSync(join(ROOT, "site/data/process_conformance_lookup.json"))
  ? JSON.parse(readFileSync(join(ROOT, "site/data/process_conformance_lookup.json"), "utf8"))
  : null;

test("report deliverable filter accepts report aliases", () => {
  assert.equal(isReportDeliverable("report"), true);
  assert.equal(isReportDeliverable("required-report"), true);
  assert.equal(isReportDeliverable("required_report"), true);
  assert.equal(isReportDeliverable("rulemaking"), false);
  assert.equal(isReportDeliverable("program"), false);
});

test("shareable path anchors Mandates → Required Reports card", () => {
  assert.equal(
    agencyMandateReportsPath(PARKS),
    "/agencies/parks-and-recreation/#mandates-reports",
  );
});

test("bridge lists Parks report mandates from live materialization", () => {
  assert.ok(obligations, "agency_obligations_lookup.json required");
  const view = buildMandateReportsReceiptView(PARKS, {
    obligationsLookup: obligations,
  });
  assert.equal(view.status, "matched");
  assert.equal(view.method, MANDATE_REPORTS_RECEIPT_METHOD);
  assert.ok(view.counts.report_mandates >= 1, "Parks has report mandates");
  assert.ok(view.mandates.every((m) => m.deliverable_type === "report"));
  assert.ok(view.mandates.every((m) => m.duty_text));
  assert.match(view.share_path, /#mandates-reports$/);
  assert.match(view.report_mandates_follow_href, /lens=mandates|deliverable/);
  // No fabricated receipts on live Parks corpus when process-conformance has none.
  for (const m of view.mandates) {
    if (!m.filing_receipt) {
      assert.equal(m.observation_status, null);
    }
  }
});

test("filing receipt surfaces when process-conformance observes a report filing", () => {
  const view = buildMandateReportsReceiptView("buildings", {
    obligationsLookup: {
      by_agency: {
        buildings: {
          obligations: [
            {
              obligation_id: "demo-report-1",
              duty_text: "Submit an annual building safety report to the mayor and the council",
              deliverable_type: "report",
              citation: "Local Law demo",
              deadline: { computed_date: "2025-12-31", text: "by December 31, 2025" },
              source: { legistar_url: "https://example.test/law" },
            },
            {
              obligation_id: "demo-report-2",
              duty_text: "Publish a quarterly crane inspection study",
              deliverable_type: "report",
              citation: "Local Law demo 2",
              deadline: { computed_date: "2026-06-01" },
              source: { legistar_url: "https://example.test/law2" },
            },
          ],
        },
      },
    },
    conformanceItems: [
      {
        mandate_id: "demo-report-1",
        observation: {
          status: OBSERVATION_STATUS.OBSERVED,
          label: "Evidence found",
          observed_record: {
            request_id: "20251215001",
            label: "Annual Building Safety Report for Calendar Year 2025",
            when: "2025-12-15",
            href: "#notice/20251215001",
            signal_kind: "report_or_study",
          },
        },
      },
      {
        mandate_id: "demo-report-2",
        observation: {
          status: OBSERVATION_STATUS.EXPECTED_NOT_YET_OBSERVED,
          label: "Expected; no matching evidence in current sources",
          observed_record: null,
        },
      },
    ],
  });
  assert.equal(view.status, "matched");
  assert.equal(view.counts.report_mandates, 2);
  assert.equal(view.counts.filing_receipts, 1);
  // Receipt rows sort first.
  assert.equal(view.mandates[0].mandate_id, "demo-report-1");
  assert.equal(view.mandates[0].filing_receipt.request_id, "20251215001");
  assert.equal(view.mandates[1].filing_receipt, null);

  const html = renderMandateReportsReceiptSection(view);
  assert.match(html, /id="mandates-reports"/);
  assert.match(html, /data-agency-constellation-card="mandates-reports"/);
  assert.match(html, new RegExp(FILING_RECEIPT_LABEL));
  assert.match(html, /#notice\/20251215001/);
  assert.match(html, /Annual Building Safety Report/);
  assert.match(html, /data-has-filing-receipt="1"/);
  assert.match(html, /Watch report mandates/);
  assert.match(html, /Share this view/);
  // Unmatched mandate still lists duty + deadline; no doubt-sowing absence copy.
  assert.match(html, /quarterly crane inspection study/);
  assert.match(html, /deadline 2026-06-01/);
  assert.doesNotMatch(html, /not yet filed|not yet shown|expected, not yet|disclaimer|fabricat/i);
  assert.doesNotMatch(html, />Statutory obligations</i);
  assert.match(html, /Report mandates/);
});

test("empty bridge omits HTML rather than shipping absence copy", () => {
  const view = buildMandateReportsReceiptView("campaign-finance-board", {
    obligationsLookup: { by_agency: {} },
  });
  assert.equal(view.status, "empty");
  assert.equal(renderMandateReportsReceiptSection(view), "");
});

test("Parks constellation document surfaces Required Reports receipt card", () => {
  assert.ok(obligations, "agency_obligations_lookup.json required");
  const view = buildAgencyConstellationView(PARKS, {
    intelligence,
    certification,
    obligations,
    process_conformance: processConformance,
  });
  assert.ok(view.mandates_reports);
  assert.equal(view.mandates_reports.status, "matched");
  assert.ok(view.mandates_reports.counts.report_mandates >= 1);
  assert.match(view.mandates_reports_href, /#mandates-reports$/);

  const html = renderAgencyConstellationDocument(view);
  assert.match(html, /id="mandates-reports"/);
  // Parks has zero filing receipts — honest title omits "Filing receipts".
  if ((view.mandates_reports.counts?.filing_receipts || 0) === 0) {
    assert.match(html, /Report mandates/);
    assert.doesNotMatch(html, /Report mandates · Filing receipts/);
  } else {
    assert.match(html, /Report mandates · Filing receipts/);
  }
  assert.match(html, /data-agency-constellation-card="mandates-reports"/);
  assert.match(html, /data-bridge-side="report-mandates"/);
  assert.match(html, /Watch report mandates/);
  // Per-row Source law matter edge (agency browse is section chrome only).
  assert.match(html, /data-mandate-edge="source_law"/);
  // No disclaimerslop on the public surface.
  assert.doesNotMatch(html, /not a compliance verdict|not verified identity|fabricat/i);
  assert.deepEqual(detectNodePageCruft(html), []);
});
