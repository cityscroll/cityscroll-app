// Card 2 (procurement-pursuit-decision): the provenance-safe opportunity
// window. Pins Fixture A from
// test/fixtures/procurement_pursuit_decision/fixture-ledger.json (exact
// PASSPort release_date -> due_date = 35 calendar days), its City
// Record-only variant (34 calendar days, never labeled "Response window"),
// missing/invalid-boundary fail-closed behavior, preserved
// solicitation_procurement_method rule-floor outputs, DST/leap/month/year
// boundary-stable date math, and the banned-verdict-language guard on
// display copy.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OPPORTUNITY_WINDOW_KIND,
  PROCUREMENT_OPPORTUNITY_WINDOW_SCHEMA,
  deriveProcurementOpportunityWindow,
  opportunityWindowDisplayLine,
  procurementOpportunityWindow,
} from "../site/procurement_opportunity_window.mjs";
import {
  extractSolicitationProcurementMethod,
  RESPONSE_FLOOR_KIND,
} from "../site/solicitation_procurement_method.mjs";

const BANNED_VERDICT_WORDS = /\b(compliant|noncompliant|suspicious|wired|preselected|fake)\b/i;

// Fixture A identity, per the fixture ledger.
const PROCUREMENT_ID = "procurement:epin-2026-07";
const RFX_REF = "passport_public_rfx:rfx:EPIN-2026-07:1001";
const CITY_RECORD_REF = "city_record:20260701001";

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

function cityRecordObservation(snapshot = {}) {
  return {
    source_observation_ref: CITY_RECORD_REF,
    source_system: "city_record",
    source_system_id: "20260701001",
    ingested_at: "2026-07-02T10:00:00Z",
    snapshot: {
      request_id: "20260701001",
      short_title: "Playground reconstruction solicitation",
      type_of_notice_description: "Solicitation Notice",
      additional_description_1: "Pre-bid conference: 07/22/2026 at 10:00 a.m. Questions deadline: 07/29/2026.",
      start_date: "2026-07-02",
      due_date: "2026-08-05",
      ...snapshot,
    },
  };
}

function procurementObject(refs) {
  return { procurement_id: PROCUREMENT_ID, source_observation_refs: refs };
}

test("Fixture A: exact PASSPort release -> due is a response_window of exactly 35 calendar days", () => {
  const object = procurementObject([RFX_REF, CITY_RECORD_REF]);
  const observations = [rfxObservation(), cityRecordObservation()];
  const window = procurementOpportunityWindow(object, observations);
  assert.equal(window.schema, PROCUREMENT_OPPORTUNITY_WINDOW_SCHEMA);
  assert.equal(window.available, true);
  assert.equal(window.kind, OPPORTUNITY_WINDOW_KIND.RESPONSE_WINDOW);
  assert.equal(window.start_date, "2026-07-01");
  assert.equal(window.due_date, "2026-08-05");
  assert.equal(window.days, 35);
  assert.equal(window.day_unit, "calendar_days");
  assert.equal(window.source_system, "passport_public_rfx");
  assert.equal(window.source_observation_ref, RFX_REF);
  assert.equal(window.derivation, "release_date_to_due_date");
  assert.equal(window.confidence, "high");
  assert.equal(window.label, "Response window: 35 calendar days");
});

test("Fixture A: an exact PASSPort pair wins even when a City Record observation is also present (rule 1 over rule 2)", () => {
  const object = procurementObject([RFX_REF, CITY_RECORD_REF]);
  const observations = [rfxObservation(), cityRecordObservation()];
  const window = procurementOpportunityWindow(object, observations);
  assert.equal(window.kind, OPPORTUNITY_WINDOW_KIND.RESPONSE_WINDOW);
  assert.notEqual(window.kind, OPPORTUNITY_WINDOW_KIND.NOTICE_TO_DUE_WINDOW);
});

test("City-Record-only variant of Fixture A: publication -> due is a notice_to_due_window of exactly 34 calendar days, never Response window", () => {
  const object = procurementObject([CITY_RECORD_REF]);
  const observations = [cityRecordObservation()];
  const window = procurementOpportunityWindow(object, observations);
  assert.equal(window.available, true);
  assert.equal(window.kind, OPPORTUNITY_WINDOW_KIND.NOTICE_TO_DUE_WINDOW);
  assert.equal(window.start_date, "2026-07-02");
  assert.equal(window.due_date, "2026-08-05");
  assert.equal(window.days, 34);
  assert.equal(window.source_system, "city_record");
  assert.equal(window.source_observation_ref, CITY_RECORD_REF);
  assert.equal(window.derivation, "city_record_publication_to_due_date");
  assert.equal(window.label, "Notice-to-due window: 34 calendar days");
  assert.doesNotMatch(window.label, /response window/i);
});

test("A PASSPort observation without an exact release_date/due_date pair does not block the City Record notice-to-due fallback", () => {
  const object = procurementObject([RFX_REF, CITY_RECORD_REF]);
  const observations = [rfxObservation({ release_date: null, due_date: null }), cityRecordObservation()];
  const window = procurementOpportunityWindow(object, observations);
  assert.equal(window.kind, OPPORTUNITY_WINDOW_KIND.NOTICE_TO_DUE_WINDOW);
  assert.equal(window.days, 34);
});

test("Missing-due variant: a release present with no due date is Window unavailable, never a 0-day window or a floor comparison", () => {
  const window = deriveProcurementOpportunityWindow({
    passport_release_date: "2026-07-01",
    passport_due_date: null,
    passport_source_observation_ref: RFX_REF,
  });
  assert.equal(window.available, false);
  assert.equal(window.kind, null);
  assert.equal(window.days, null);
  assert.equal(window.reason, "missing_due_date");
  assert.equal(window.label, "Window unavailable");
  assert.notEqual(window.days, 0);

  const rule = extractSolicitationProcurementMethod({
    section_name: "Procurement",
    type_of_notice_description: "Solicitation",
  });
  const line = opportunityWindowDisplayLine(window, rule.response_floor);
  assert.equal(line, "Window unavailable");
  assert.doesNotMatch(line, /\d+\s+calendar days · applicable rule floor/);
});

test("An invalid due_date on an otherwise-complete PASSPort pair fails closed instead of substituting a City Record boundary", () => {
  const object = procurementObject([RFX_REF, CITY_RECORD_REF]);
  const observations = [
    rfxObservation({ release_date: "07/01/2026", due_date: "13/45/2026" }),
    cityRecordObservation(),
  ];
  const window = procurementOpportunityWindow(object, observations);
  assert.equal(window.available, false);
  assert.equal(window.reason, "invalid_date");
});

test("No source observations at all is Window unavailable with an explicit reason", () => {
  const window = procurementOpportunityWindow({ procurement_id: PROCUREMENT_ID, source_observation_refs: [] }, []);
  assert.equal(window.available, false);
  assert.equal(window.reason, "no_qualifying_observation");
});

test("An award-shaped object with no PASSPort RFx / City Record observations never derives an opportunity window", () => {
  const object = {
    procurement_id: "procurement:award-example",
    source_observation_refs: ["checkbook_contracts:c1"],
  };
  const observations = [{
    source_observation_ref: "checkbook_contracts:c1",
    source_system: "checkbook_contracts",
    snapshot: { contract_amount: 250000, vendor_name: "Acme Snow & Ice LLC" },
  }];
  const window = procurementOpportunityWindow(object, observations);
  assert.equal(window.available, false);
});

test("Preserved method fixtures pair correctly with the window display line: default 20-day competitive floor", () => {
  const window = deriveProcurementOpportunityWindow({
    passport_release_date: "2026-07-01",
    passport_due_date: "2026-08-05",
    passport_source_observation_ref: RFX_REF,
  });
  const rule = extractSolicitationProcurementMethod({
    section_name: "Procurement",
    type_of_notice_description: "Solicitation",
    additional_description_1: "This is a standard competitive sealed bid procurement.",
  });
  assert.equal(rule.response_floor.kind, RESPONSE_FLOOR_KIND.DEFAULT_COMPETITIVE);
  assert.equal(rule.response_floor.days, 20);
  const line = opportunityWindowDisplayLine(window, rule.response_floor);
  assert.equal(line, "Published response window: 35 calendar days · applicable rule floor: 20 calendar days");
  assert.doesNotMatch(line, BANNED_VERDICT_WORDS);
});

test("Preserved method fixtures pair correctly with the window display line: Section 6-129 27-day floor", () => {
  const window = deriveProcurementOpportunityWindow({
    passport_release_date: "2026-07-01",
    passport_due_date: "2026-08-05",
    passport_source_observation_ref: RFX_REF,
  });
  const rule = extractSolicitationProcurementMethod({
    section_name: "Procurement",
    type_of_notice_description: "Solicitation",
    additional_description_1: "This procurement is subject to participation goals for M/WBE firms under Admin. Code Section 6-129.",
  });
  assert.equal(rule.response_floor.kind, RESPONSE_FLOOR_KIND.SECTION_6_129);
  assert.equal(rule.response_floor.days, 27);
  const line = opportunityWindowDisplayLine(window, rule.response_floor);
  assert.equal(line, "Published response window: 35 calendar days · applicable rule floor: 27 calendar days");
  assert.doesNotMatch(line, BANNED_VERDICT_WORDS);
});

test("Preserved method fixtures pair correctly with the window display line: accelerated 3-business-day floor", () => {
  const window = deriveProcurementOpportunityWindow({
    passport_release_date: "2026-07-01",
    passport_due_date: "2026-07-06",
    passport_source_observation_ref: RFX_REF,
  });
  const rule = extractSolicitationProcurementMethod({
    section_name: "Procurement",
    type_of_notice_description: "Solicitation",
    additional_description_1: "This solicitation is being conducted pursuant to the Accelerated Procurement Method.",
  });
  assert.equal(rule.response_floor.kind, RESPONSE_FLOOR_KIND.ACCELERATED);
  assert.equal(rule.response_floor.days, 3);
  assert.equal(rule.response_floor.day_unit, "business_days");
  const line = opportunityWindowDisplayLine(window, rule.response_floor);
  assert.equal(line, "Published response window: 5 calendar days · applicable rule floor: 3 business days");
  assert.doesNotMatch(line, BANNED_VERDICT_WORDS);
});

test("A rule floor is display-paired, never a compliance verdict, across every rendered line in this suite", () => {
  const lines = [
    opportunityWindowDisplayLine(
      deriveProcurementOpportunityWindow({ passport_release_date: "2026-07-01", passport_due_date: "2026-08-05" }),
      { days: 27, day_unit: "calendar_days" },
    ),
    opportunityWindowDisplayLine(
      deriveProcurementOpportunityWindow({ city_record_start_date: "2026-07-02", city_record_due_date: "2026-08-05" }),
      { days: 20, day_unit: "calendar_days" },
    ),
    opportunityWindowDisplayLine(deriveProcurementOpportunityWindow({}), { days: 20, day_unit: "calendar_days" }),
  ];
  for (const line of lines) assert.doesNotMatch(line, BANNED_VERDICT_WORDS);
});

test("Date math is stable across a leap-year February", () => {
  const window = deriveProcurementOpportunityWindow({
    passport_release_date: "2028-02-01",
    passport_due_date: "2028-03-01",
  });
  // 2028 is a leap year: Feb has 29 days, so Feb 1 -> Mar 1 spans 29 days.
  assert.equal(window.days, 29);
});

test("Date math is stable across a non-leap-year February", () => {
  const window = deriveProcurementOpportunityWindow({
    passport_release_date: "2026-02-01",
    passport_due_date: "2026-03-01",
  });
  assert.equal(window.days, 28);
});

test("Date math is stable across a month boundary", () => {
  const window = deriveProcurementOpportunityWindow({
    passport_release_date: "2026-01-20",
    passport_due_date: "2026-02-05",
  });
  assert.equal(window.days, 16);
});

test("Date math is stable across a year boundary", () => {
  const window = deriveProcurementOpportunityWindow({
    passport_release_date: "2026-12-20",
    passport_due_date: "2027-01-05",
  });
  assert.equal(window.days, 16);
});

test("Date math is stable across the US spring-forward DST transition regardless of the runner's local timezone", () => {
  const originalTz = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    const window = deriveProcurementOpportunityWindow({
      passport_release_date: "2026-03-01",
      passport_due_date: "2026-03-15",
    });
    assert.equal(window.days, 14);
  } finally {
    if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
  }
});

test("Date math does not depend on the runner's local timezone at all", () => {
  const originalTz = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14, no US DST
    const utcPlus14 = deriveProcurementOpportunityWindow({
      passport_release_date: "2026-07-01",
      passport_due_date: "2026-08-05",
    });
    process.env.TZ = "Pacific/Midway"; // UTC-11
    const utcMinus11 = deriveProcurementOpportunityWindow({
      passport_release_date: "2026-07-01",
      passport_due_date: "2026-08-05",
    });
    assert.equal(utcPlus14.days, 35);
    assert.equal(utcMinus11.days, 35);
  } finally {
    if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
  }
});

test("An out-of-range calendar date fails closed rather than silently rolling over to a different day", () => {
  const window = deriveProcurementOpportunityWindow({
    passport_release_date: "2026-02-30",
    passport_due_date: "2026-03-15",
  });
  assert.equal(window.available, false);
  assert.equal(window.reason, "invalid_date");
});

test("A due date on or before the start date fails closed instead of a zero or negative-day window", () => {
  const sameDay = deriveProcurementOpportunityWindow({
    passport_release_date: "2026-07-01",
    passport_due_date: "2026-07-01",
  });
  assert.equal(sameDay.available, false);
  assert.equal(sameDay.reason, "due_before_start");

  const backwards = deriveProcurementOpportunityWindow({
    passport_release_date: "2026-08-05",
    passport_due_date: "2026-07-01",
  });
  assert.equal(backwards.available, false);
  assert.equal(backwards.reason, "due_before_start");
});
