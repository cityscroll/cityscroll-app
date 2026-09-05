// Card 3 of the procurement-pursuit-decision workstream: a pursuit snapshot
// near the top of solicitation-stage procurement detail. Fixtures reused by
// id from test/fixtures/procurement_pursuit_decision/fixture-ledger.json
// (A, B, D, E) per that ledger's own instruction that later cards cite
// fixtures rather than invent new example data; cancelled/superseded
// variants are minimal, explicitly-labeled mutations of Fixture A/B built
// locally for this card's own evidence requirement (acceptance criterion 8).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PURSUIT_FIELD_STATUS,
  PURSUIT_UNVERIFIABLE_ROWS,
  buildPursuitSnapshot,
  pursuitSnapshotReady,
  renderPursuitSnapshotHtml,
} from "../site/procurement_pursuit_snapshot.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { procurementProcessEvents } from "../site/procurement_process_events.mjs";

const moneyHistorySource = readFileSync(new URL("../site/app/money-history.mjs", import.meta.url), "utf8");

/* ---------- Fixture A: dense exact-join solicitation (procurement object) ---------- */

const PROCUREMENT_ID = "procurement:epin-2026-07";
const RFX_REF = "passport_public_rfx:rfx:EPIN-2026-07:1001";
const SOLICITATION_REF = "city_record:20260701001";

function rfxObservation(snapshot = {}) {
  return {
    source_observation_ref: RFX_REF,
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
      ...snapshot,
    },
  };
}

function cityRecordObservation(snapshot = {}, ref = SOLICITATION_REF) {
  return {
    source_observation_ref: ref,
    source_system: "city_record",
    source_system_id: ref.split(":")[1],
    ingested_at: "2026-07-02T10:00:00Z",
    snapshot: {
      request_id: ref.split(":")[1],
      short_title: "Playground reconstruction solicitation",
      type_of_notice_description: "Solicitation Notice",
      additional_description_1: "Pre-bid conference: 07/22/2026 at 10:00 a.m. Questions deadline: 07/29/2026.",
      ...snapshot,
    },
  };
}

function fixtureADetailHtml(refs, observations) {
  const object = {
    procurement_id: PROCUREMENT_ID,
    source_observation_refs: refs,
    identity_keys: { epins: ["EPIN-2026-07"] },
  };
  object.process_events = procurementProcessEvents(object, observations);
  return renderProcurementDocument(object, observations, { today: "2026-07-10" });
}

test("Fixture A: dense solicitation renders a complete pursuit snapshot near the top of detail", () => {
  const html = fixtureADetailHtml([RFX_REF, SOLICITATION_REF], [rfxObservation(), cityRecordObservation()]);
  assert.ok(html.includes("pursuit-snapshot"), "pursuit snapshot section must render");
  assert.ok(html.indexOf("pursuit-snapshot") < html.indexOf("Contract facts"), "snapshot must sit above the existing lifecycle sections (rule 10)");
  assert.match(html, /Department of Parks and Recreation/);
  assert.match(html, /Playground reconstruction/);
  assert.match(html, /EPIN-2026-07/);
  assert.match(html, /Published response window: 35 calendar days/);
  assert.match(html, /Jul 22/); // pre-bid conference
  assert.match(html, /Jul 29/); // questions deadline
  assert.match(html, /Aug 5/); // due date
  assert.match(html, /PASSPort solicitation/);
  // Existing lifecycle/contract sections remain reachable below (rule 10).
  assert.match(html, /Contract facts/);
});

test("Fixture A: never announces its own materialization gaps (the shared node-page cruft gate)", () => {
  // renderProcurementDocument() throws via gateNodePageRender() if reader-
  // facing "not published"-style cruft appears anywhere in the page; a throw
  // here would mean this module's copy tripped that gate.
  assert.doesNotThrow(() => fixtureADetailHtml([RFX_REF, SOLICITATION_REF], [rfxObservation(), cityRecordObservation()]));
});

test("Fixture A: amount, method, and M/WBE are explicitly unobserved, never absent-looking negatives", () => {
  const snapshot = buildPursuitSnapshot(
    {
      short_title: "Playground reconstruction solicitation",
      agency_name: "Department of Parks and Recreation",
      type_of_notice_description: "Solicitation",
      due_date: "2026-08-05",
    },
    { opportunity_window: { available: false, label: "Window unavailable" } },
  );
  assert.equal(snapshot.decision_facts.amount.status, PURSUIT_FIELD_STATUS.NOT_OBSERVED);
  assert.equal(snapshot.decision_facts.method.status, PURSUIT_FIELD_STATUS.NOT_OBSERVED);
  assert.equal(snapshot.decision_facts.mwbe.status, PURSUIT_FIELD_STATUS.NOT_OBSERVED);
});

/* ---------- Fixture B: actionable City Record solicitation (notice row) ---------- */

const completeSolicitation = {
  short_title: "Computer-Assisted Mass Appraisal (CAMA) Modern Solution",
  type_of_notice_description: "Solicitation",
  agency_name: "Finance",
  due_date: "2026-08-17T14:00:00.000",
  request_id: "REQ-CAMA-1",
};

test("Fixture B: renders because it has a named identity, an agency, and an actionable due date", () => {
  assert.equal(pursuitSnapshotReady(completeSolicitation), true);
  const snapshot = buildPursuitSnapshot(completeSolicitation, {});
  assert.equal(snapshot.identity.agency.value, "Finance");
  assert.match(snapshot.identity.title.value, /CAMA/);
  assert.equal(snapshot.decision_facts.due_date.status, PURSUIT_FIELD_STATUS.OBSERVED);
  assert.equal(snapshot.decision_facts.due_date.value, "2026-08-17");
});

test("Fixture B: unavailable amount, M/WBE, and method are explicit unknowns, not absent-looking negatives", () => {
  const snapshot = buildPursuitSnapshot(completeSolicitation, {});
  assert.equal(snapshot.decision_facts.amount.status, PURSUIT_FIELD_STATUS.NOT_OBSERVED);
  assert.equal(snapshot.decision_facts.mwbe.status, PURSUIT_FIELD_STATUS.NOT_OBSERVED);
  assert.equal(snapshot.decision_facts.method.status, PURSUIT_FIELD_STATUS.NOT_OBSERVED);
  const html = renderPursuitSnapshotHtml(snapshot);
  assert.doesNotMatch(html, /\$0\b/);
  assert.match(html, /No published amount/);
  assert.match(html, /No published M\/WBE marker/);
});

/* ---------- Fixture D: sparse real MTA solicitation (native canonical object) ---------- */

async function fixtureDObjectAndObservations() {
  const fixtures = JSON.parse(readFileSync(
    new URL("../warehouse/fixtures/authority-native-procurement/mta-opportunities.v1.json", import.meta.url),
    "utf8",
  ));
  const { recordsFromMtaOpportunityFixtures } = await import("../warehouse/lib/mta_opportunities.mjs");
  const { buildSharedProcurementReadModel } = await import("../site/shared_procurement_read_model.mjs");
  const model = buildSharedProcurementReadModel({
    sourceRecords: recordsFromMtaOpportunityFixtures(fixtures),
    generatedAt: fixtures.retrieved_at,
  });
  const object = model.rows.find((row) => row.procurement_id === "procurement:solicitation:S48020");
  return { object, observations: model.observations };
}

test("Fixture D: sparse native solicitation renders identity + agency + stage without inventing amount or deadline", async () => {
  const { object, observations } = await fixtureDObjectAndObservations();
  assert.ok(object, "S48020 must exist in the shared read model");
  const html = renderProcurementDocument(object, observations);
  assert.ok(html.includes("pursuit-snapshot"), "a sparse native solicitation must still render the snapshot (rule 2 extension)");
  const snapshotHtml = html.slice(html.indexOf('<section class="pursuit-snapshot"'), html.indexOf("</section>") + "</section>".length);
  assert.match(snapshotHtml, /CBTC for 6th Ave Line/);
  assert.match(snapshotHtml, /MTA Construction (&amp;|&) Development/);
  assert.match(snapshotHtml, /Current opportunity/); // literal source status
  assert.match(snapshotHtml, /No published amount/);
  assert.match(snapshotHtml, /No published due date/);
  // The bid-opening date (10/16/2026) and the raw "$100M+" free text still
  // appear lower on the page in the existing "Contract facts" section (an
  // unrelated, pre-existing render this card does not change) -- the pursuit
  // snapshot itself must never surface either as an observed pursuit fact.
  assert.doesNotMatch(snapshotHtml, /10\/16\/2026/);
  assert.doesNotMatch(snapshotHtml, /\$100M\+/);
});

/* ---------- Fixture E: award control ---------- */

const awardControl = {
  request_id: "FIX-PREV-AWD-1",
  short_title: "Fixture award",
  type_of_notice_description: "Award",
  agency_name: "Department of Sanitation",
  vendor_name: "Acme Snow & Ice LLC",
  contract_amount: 250000,
  pin: "PIN-PREV-1",
};

test("Fixture E: the award control never renders a pursuit snapshot or a response CTA", () => {
  assert.equal(pursuitSnapshotReady(awardControl), false);
  assert.equal(buildPursuitSnapshot(awardControl, {}), null);
  assert.equal(renderPursuitSnapshotHtml(buildPursuitSnapshot(awardControl, {})), "");
});

test("Fixture E (as a bare procurement contract object): an award-only object gets no pursuit snapshot", () => {
  const ref = "city_record:20260703001";
  const object = { procurement_id: "procurement:contract:AWD1", source_observation_refs: [ref] };
  const observations = [{
    source_observation_ref: ref,
    source_system: "city_record",
    source_system_id: "20260703001",
    ingested_at: "2026-07-03T10:00:00Z",
    snapshot: {
      request_id: "20260703001",
      short_title: "Playground reconstruction award",
      type_of_notice_description: "Award",
      agency_name: "Department of Parks and Recreation",
      contract_amount: 250000,
      vendor_name: "Acme Builders",
    },
  }];
  const html = renderProcurementDocument(object, observations, { today: "2026-07-10" });
  assert.doesNotMatch(html, /pursuit-snapshot/);
});

test("a bid-opening-result native object (already past solicitation) gets no pursuit snapshot", () => {
  const ref = "mta_bid_results:mta-bid-results:AW-9Y:TDP-ASSOCIATES-INC";
  const object = { procurement_id: "procurement:solicitation:AW9Y", source_observation_refs: [ref] };
  const observations = [{
    source_observation_ref: ref,
    source_system: "mta_bid_results",
    source_system_id: "mta-bid-results:AW-9Y:TDP-ASSOCIATES-INC",
    ingested_at: "2026-08-28T14:00:00.000Z",
    snapshot: {
      source_system: "mta_bid_results",
      observation_type: "bid_opening_result",
      agency: "MTA Construction & Development",
      title: "Some bid-opened solicitation",
      solicitation_id: "AW9Y",
    },
  }];
  const html = renderProcurementDocument(object, observations, { today: "2026-07-10" });
  assert.doesNotMatch(html, /pursuit-snapshot/);
});

/* ---------- Cancelled / superseded coverage (acceptance criterion 8) ---------- */
// Minimal mutations of Fixture A/B -- not new ledger fixtures -- covering the
// two lifecycle states the ledger's five named fixtures did not need to
// exercise: a cancelled notice type is not a pursuit opportunity, and a
// materially changed (superseded) round still reflects only its own current
// published facts, never a stale prior round's dates.

test("cancelled: a City Record cancellation notice never gets a pursuit snapshot", () => {
  const cancelled = { ...completeSolicitation, type_of_notice_description: "Cancellation" };
  assert.equal(pursuitSnapshotReady(cancelled), false);
  assert.equal(buildPursuitSnapshot(cancelled, {}), null);
});

test("superseded: a later PASSPort round on the same canonical procurement reflects only its own current dates", () => {
  const supersedingRfx = rfxObservation({ due_date: "09/15/2026" }); // a later round, later due date
  const html = fixtureADetailHtml([RFX_REF, SOLICITATION_REF], [supersedingRfx, cityRecordObservation()]);
  assert.match(html, /Sep 15/);
  assert.doesNotMatch(html, /Aug 5/); // the superseded round's due date must not linger
});

/* ---------- Cannot-verify disclosure ---------- */

test("the cannot-verify disclosure is a fixed, closed list and never phrased as a failed requirement", () => {
  assert.equal(PURSUIT_UNVERIFIABLE_ROWS.length, 8);
  const html = renderPursuitSnapshotHtml(buildPursuitSnapshot(completeSolicitation, {}));
  for (const row of PURSUIT_UNVERIFIABLE_ROWS) {
    const expected = row.label.replace(/&/g, "&amp;");
    assert.ok(html.includes(expected), `missing cannot-verify row: ${row.label}`);
  }
  assert.doesNotMatch(html, /fail(ed|s)? (a )?requirement/i);
  assert.doesNotMatch(html, /\bno\b.*\brequirement/i);
});

/* ---------- money-history.mjs wiring (Fixtures B/C/E surface) ---------- */

test("money-history.mjs mounts the pursuit snapshot ahead of the response/action rail", () => {
  assert.match(moneyHistorySource, /import \{ buildPursuitSnapshot, renderPursuitSnapshotHtml \} from "\.\.\/procurement_pursuit_snapshot\.mjs"/);
  const renderDetail = moneyHistorySource.slice(
    moneyHistorySource.indexOf("function renderDetail"),
    moneyHistorySource.indexOf("// parseNL() itself lives"),
  );
  const headingAt = renderDetail.indexOf("solicitationContextHeadingHTML(r)");
  const snapshotAt = renderDetail.indexOf("pursuitSnapshotHTML(r)");
  const railAt = renderDetail.indexOf('id="dactions"');
  const responseAt = renderDetail.indexOf("buildApply(r,false)");
  assert.ok(headingAt >= 0 && snapshotAt >= 0 && railAt >= 0 && responseAt >= 0);
  assert.ok(headingAt < snapshotAt, "snapshot must mount after the notice heading");
  assert.ok(snapshotAt < railAt, "snapshot must mount ahead of the action rail mount point");
  assert.ok(snapshotAt < responseAt, "snapshot must mount ahead of the response affordance");
});

test("pursuitSnapshotHTML is gated the same way the response affordances already are", () => {
  const helper = moneyHistorySource.slice(
    moneyHistorySource.indexOf("function pursuitSnapshotHTML"),
    moneyHistorySource.indexOf("function renderDetail"),
  );
  assert.match(helper, /buildPursuitSnapshot\(r, \{/);
});
