#!/usr/bin/env node
// Renders real production output for the procurement-pursuit-decision Card 0
// baseline: procurement-detail documents for Fixtures A and D, the current
// single-watch and multi-watch rollup email HTML, and a plain summary of the
// fixture ledger. Used only by
// tools/capture_procurement_pursuit_decision_baseline.py; nothing here is a
// served route or a build artifact, and no production module is changed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { procurementProcessEvents } from "../site/procurement_process_events.mjs";
import { recordsFromMtaOpportunityFixtures } from "../warehouse/lib/mta_opportunities.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { subDigestHtml, rollupDigestHtml } from "../worker/src/alerts.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TODAY = "2026-08-02";

// ----- Fixture A: dense exact-join solicitation (procurement:epin-2026-07) -----
const A_PROCUREMENT_ID = "procurement:epin-2026-07";
const A_RFX_REF = "passport_public_rfx:rfx:EPIN-2026-07:1001";
const A_SOLICITATION_REF = "city_record:20260701001";

function rfxObservation() {
  return {
    source_observation_ref: A_RFX_REF,
    source_system: "passport_public_rfx",
    source_system_id: "rfx:EPIN-2026-07:1001",
    ingested_at: "2026-07-01T10:00:00Z",
    snapshot: {
      rfp_id: "1001",
      epin: "EPIN-2026-07",
      procurement_name: "Playground reconstruction",
      agency: "Department of Parks and Recreation",
      rfx_status: "Released",
      release_date: "07/01/2026",
      due_date: "08/05/2026",
      official_url: "https://passport.example/rfx/1001",
    },
  };
}

function cityRecordObservation() {
  return {
    source_observation_ref: A_SOLICITATION_REF,
    source_system: "city_record",
    source_system_id: "20260701001",
    ingested_at: "2026-07-02T10:00:00Z",
    snapshot: {
      request_id: "20260701001",
      short_title: "Playground reconstruction solicitation",
      type_of_notice_description: "Solicitation Notice",
      additional_description_1: "Pre-bid conference: 07/22/2026 at 10:00 a.m. Questions deadline: 07/29/2026.",
    },
  };
}

function fixtureADetailHtml() {
  const refs = [A_RFX_REF, A_SOLICITATION_REF];
  const observations = [rfxObservation(), cityRecordObservation()];
  const object = {
    procurement_id: A_PROCUREMENT_ID,
    source_observation_refs: refs,
    identity_keys: { epins: ["EPIN-2026-07"] },
  };
  object.process_events = procurementProcessEvents(object, observations);
  return renderProcurementDocument(object, observations, { today: "2026-07-10" });
}

// ----- Fixture D: sparse real solicitation (procurement:solicitation:S48020) -----
function fixtureDDetailHtml() {
  const fixturesPath = new URL(
    "../warehouse/fixtures/authority-native-procurement/mta-opportunities.v1.json",
    import.meta.url,
  );
  const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));
  const records = recordsFromMtaOpportunityFixtures(fixtures);
  const model = buildSharedProcurementReadModel({ sourceRecords: records, generatedAt: fixtures.retrieved_at });
  const object = model.rows.find((row) => row.procurement_id === "procurement:solicitation:S48020");
  if (!object) throw new Error("Fixture D (procurement:solicitation:S48020) not found in the shared read model");
  return renderProcurementDocument(object, model.observations);
}

// ----- Email previews: Fixtures C (solicitation) and E (award control) -----
const FIXTURE_C_ROW = {
  request_id: "FIX-PREV-SOL-1",
  short_title: "Fixture street materials",
  agency_name: "Department of Transportation",
  type_of_notice_description: "Solicitation",
  due_date: "2026-08-10",
  additional_description_1:
    "Vendors must download the solicitation documents at https://example.com/rfps before submitting.",
};
const FIXTURE_E_ROW = {
  request_id: "FIX-PREV-AWD-1",
  short_title: "Fixture award",
  type_of_notice_description: "Award",
  vendor_name: "Acme Snow & Ice LLC",
  contract_amount: 250000,
  pin: "PIN-PREV-1",
};
const FIXTURE_D_DIGEST_ROW = {
  procurement_id: "procurement:solicitation:S48020",
  short_title: "CBTC for 6th Ave Line, 63rd St Line and DeKalb Interlocking",
  agency_name: "MTA Construction & Development",
  primary_stage: "solicitation",
};

function wrapEmailHtml(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head><body style="margin:0;padding:24px;background:#f4f6fb">
<div style="max-width:640px;margin:0 auto;background:#fff;padding:24px;border-radius:8px">${bodyHtml}</div>
</body></html>`;
}

function emailSingleWatchHtml() {
  // A money-lens solicitation watch compiles with a single query kind — "rfp"
  // for a Solicitation-scoped filter, "award" for an Award-scoped filter
  // (worker/src/lib/compile.mjs:442-473); a single watch never mixes both
  // notice types in one section, so this preview uses Fixture C alone.
  const body = subDigestHtml(
    "DOT solicitations I'm watching",
    "rfp",
    [FIXTURE_C_ROW],
    "https://api.cityscroll.org/u/test-unsub",
    "2026-08-01",
    "https://api.cityscroll.org",
    [],
    "en",
    ["street materials"],
    null,
    "",
    null,
    null,
    TODAY,
    false,
  );
  return wrapEmailHtml("Single-watch digest preview", body);
}

function emailMultiWatchRollupHtml() {
  const body = rollupDigestHtml({
    sections: [
      { label: "DOT solicitations", kind: "rfp", freshRows: [FIXTURE_C_ROW], new: 1, action: "match" },
      { label: "MTA C&D solicitations", kind: "rfp", freshRows: [FIXTURE_D_DIGEST_ROW], new: 1, action: "match" },
      { label: "Award watch", kind: "award", freshRows: [FIXTURE_E_ROW], new: 1, action: "match" },
    ],
    wantingCount: 3,
    watchCount: 3,
    unsubAllUrl: "https://api.cityscroll.org/u/all-test",
    manageUrl: "https://api.cityscroll.org/manage",
    today: TODAY,
  });
  return wrapEmailHtml("Multi-watch rollup preview", body);
}

// ----- Fixture-ledger summary -----
function fixtureLedgerSummaryHtml() {
  const ledgerPath = new URL(
    "../test/fixtures/procurement_pursuit_decision/fixture-ledger.json",
    import.meta.url,
  );
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const esc = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const rows = ledger.fixtures.map((f) => {
    const surfaces = (f.ui_surfaces_exercised || []).map(esc).join("<br>");
    const unknowns = (f.expected_unknowns || []).length
      ? f.expected_unknowns.map(esc).join("<br>")
      : "<em>none asserted</em>";
    return `<tr>
      <td style="padding:8px;border:1px solid #ddd;font-weight:600">${esc(f.id)}</td>
      <td style="padding:8px;border:1px solid #ddd">${esc(f.name)}</td>
      <td style="padding:8px;border:1px solid #ddd">${esc(f.description)}</td>
      <td style="padding:8px;border:1px solid #ddd;font-size:12px">${unknowns}</td>
      <td style="padding:8px;border:1px solid #ddd;font-size:12px">${surfaces}</td>
    </tr>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fixture ledger summary</title></head>
<body style="font-family:system-ui,sans-serif;margin:0;padding:24px">
<h1 style="font-size:20px">procurement-pursuit-decision fixture ledger</h1>
<p style="color:#555;font-size:13px">Baseline revision: ${esc(ledger.baseline_revision)}</p>
<table style="border-collapse:collapse;width:100%;font-size:13px">
<thead><tr>
  <th style="padding:8px;border:1px solid #ddd;text-align:left">ID</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:left">Name</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:left">Description</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:left">Expected unknowns</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:left">UI surfaces exercised</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>
</body></html>`;
}

const cases = {
  "procurement-detail-fixture-a": fixtureADetailHtml(),
  "procurement-detail-fixture-d": fixtureDDetailHtml(),
  "email-single-watch": emailSingleWatchHtml(),
  "email-multi-watch-rollup": emailMultiWatchRollupHtml(),
  "fixture-ledger-summary": fixtureLedgerSummaryHtml(),
};

process.stdout.write(JSON.stringify(cases));
