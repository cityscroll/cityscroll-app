// Characterization tests for the OCP Recent Contract Awards (qyyg-4tf5) side-car.
// Fixtures use real field shapes observed from the public SODA feed (request_id, pin,
// contract_amount, start_date, vendor_name) so join and corroboration rules stay honest.
//
//   node --test worker/test/ocp_awards.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeOcpAward,
  corroborateAward,
  joinOcpAward,
  attachOcpAward,
  parseAmount,
  dateOnly,
  OCP_SOURCE,
  OCP_DATASET_ID,
} from "../src/lib/ocp_awards.mjs";

// Real OCP rows (trimmed) from data.cityofnewyork.us/resource/qyyg-4tf5.json 2026-07-30.
const REAL_OCP_CATERING = {
  request_id: "20260723031",
  start_date: "2026-07-30T00:00:00.000",
  agency_name: "Health and Mental Hygiene",
  type_of_notice_description: "Award",
  short_title: "Catering Services",
  pin: "81626W0043001",
  contract_amount: "250000",
  vendor_name: "Make it Zesty LLC",
};

const REAL_OCP_HEAT_PUMP = {
  request_id: "20260724010",
  start_date: "2026-07-30T00:00:00.000",
  agency_name: "Citywide Administrative Services",
  type_of_notice_description: "Award",
  short_title: "Heat Pump Water Heaters",
  pin: "85726B0027001",
  contract_amount: "7977500",
  vendor_name: "Samuel17",
};

const REAL_OCP_SYEP = {
  request_id: "20260724015",
  start_date: "2026-07-30T00:00:00.000",
  agency_name: "Youth and Community Development",
  type_of_notice_description: "Award",
  short_title: "Summer Youth Employment Program NAQ: Career Ready",
  pin: "26026N0011014",
  contract_amount: "2540261",
  vendor_name: "Child Development Center - Mosholu Montefiore Community Center",
};

test("dataset id is the public OCP Recent Contract Awards view", () => {
  assert.equal(OCP_DATASET_ID, "qyyg-4tf5");
  assert.equal(OCP_SOURCE, "ocp-recent-awards");
});

test("normalizeOcpAward maps real SODA fields", () => {
  const n = normalizeOcpAward(REAL_OCP_CATERING);
  assert.equal(n.request_id, "20260723031");
  assert.equal(n.pin, "81626W0043001");
  assert.equal(n.date, "2026-07-30");
  assert.equal(n.amount, 250000);
  assert.equal(n.vendor, "Make it Zesty LLC");
  assert.equal(n.agency, "Health and Mental Hygiene");
});

test("parseAmount and dateOnly tolerate Socrata shapes", () => {
  assert.equal(parseAmount("1,350,608"), 1350608);
  assert.equal(parseAmount("$250,000.00"), 250000);
  assert.equal(parseAmount(null), null);
  assert.equal(dateOnly("2026-07-30T00:00:00.000"), "2026-07-30");
  assert.equal(dateOnly("2026-07-30"), "2026-07-30");
});

test("join by request_id: exact City Record award match (real field case)", () => {
  const notice = {
    request_id: "20260723031",
    start_date: "2026-07-30T00:00:00.000",
    agency_name: "Health and Mental Hygiene",
    type_of_notice_description: "Award",
    short_title: "Catering Services",
    pin: "81626W0043001",
    contract_amount: "250000",
    vendor_name: "Make it Zesty LLC",
  };
  const result = joinOcpAward(notice, [REAL_OCP_CATERING, REAL_OCP_HEAT_PUMP]);
  assert.equal(result.status, "matched");
  assert.equal(result.join_key, "request_id");
  assert.equal(result.detail.vendor, "Make it Zesty LLC");
  assert.equal(result.detail.amount, 250000);
  assert.ok(result.corroboration);
  assert.equal(result.corroboration.agree, true);
  assert.equal(result.corroboration.disagreements.length, 0);
});

test("join by pin: solicitation notice finds OCP award side-car", () => {
  const solicitation = {
    request_id: "20250101099",
    start_date: "2025-01-01T00:00:00.000",
    agency_name: "Citywide Administrative Services",
    type_of_notice_description: "Solicitation",
    short_title: "Heat Pump Water Heaters",
    pin: "85726B0027001",
  };
  const result = joinOcpAward(solicitation, [REAL_OCP_HEAT_PUMP, REAL_OCP_SYEP]);
  assert.equal(result.status, "matched");
  assert.equal(result.join_key, "pin");
  assert.equal(result.detail.request_id, "20260724010");
  // Solicitation has no City Record award amount — no corroboration claim.
  assert.equal(result.corroboration, null);
});

test("unmatched: OCP rows present but none share request_id or pin", () => {
  const notice = {
    request_id: "19990101001",
    type_of_notice_description: "Award",
    pin: "00000X0000000",
    contract_amount: "1",
    start_date: "1999-01-01",
  };
  const result = joinOcpAward(notice, [REAL_OCP_CATERING]);
  assert.equal(result.status, "unmatched");
  assert.equal(result.detail, null);
});

test("unknown when lookupStatus is error (reach failure, not a gap claim)", () => {
  const notice = { request_id: "20260723031", type_of_notice_description: "Award" };
  const result = joinOcpAward(notice, [], { lookupStatus: "error" });
  assert.equal(result.status, "unknown");
});

test("ambiguous: multiple OCP awards share a PIN", () => {
  const a = { ...REAL_OCP_SYEP, request_id: "20260724015" };
  const b = { ...REAL_OCP_SYEP, request_id: "20260724016", contract_amount: "100" };
  const notice = {
    request_id: "sol-only",
    type_of_notice_description: "Solicitation",
    pin: "26026N0011014",
  };
  const result = joinOcpAward(notice, [a, b]);
  assert.equal(result.status, "ambiguous");
  assert.ok(Array.isArray(result.candidates));
  assert.equal(result.candidates.length, 2);
});

test("corroboration: amount disagreement renders both sources (never prefer one)", () => {
  const city = { amount: 250000, date: "2026-07-30" };
  // Simulated OCP correction / lag case — same request, different amount.
  const ocp = normalizeOcpAward({
    ...REAL_OCP_CATERING,
    contract_amount: "275000",
  });
  const c = corroborateAward(city, ocp);
  assert.equal(c.agree, false);
  assert.equal(c.fields.amount.agree, false);
  assert.equal(c.fields.amount.city_record, 250000);
  assert.equal(c.fields.amount.ocp, 275000);
  assert.equal(c.fields.date.agree, true);
  assert.deepEqual(
    c.disagreements.map((d) => d.field),
    ["amount"],
  );
  const amountLayer = c.disagreements[0].claim_layer;
  assert.ok(amountLayer);
  assert.equal(amountLayer.assertions[0].classification, "source_assertion");
  assert.equal(amountLayer.assertions[1].classification, "source_assertion");
  assert.equal(amountLayer.interpretation.classification, "cityscroll_interpretation");
  assert.equal(amountLayer.interpretation.resolution, "unresolved");
  assert.equal(amountLayer.derived_conclusion, null);
});

test("corroboration: date disagreement keeps both dates", () => {
  const city = { amount: 7977500, date: "2026-07-29" };
  const ocp = normalizeOcpAward(REAL_OCP_HEAT_PUMP);
  const c = corroborateAward(city, ocp);
  assert.equal(c.agree, false);
  assert.equal(c.fields.date.city_record, "2026-07-29");
  assert.equal(c.fields.date.ocp, "2026-07-30");
  assert.equal(c.fields.amount.agree, true);
});

test("join surfaces corroboration disagreements on award notices", () => {
  const notice = {
    request_id: "20260723031",
    type_of_notice_description: "Award",
    pin: "81626W0043001",
    contract_amount: "999999", // deliberately differs from OCP 250000
    start_date: "2026-07-15T00:00:00.000", // deliberately differs
    vendor_name: "Make it Zesty LLC",
  };
  const result = joinOcpAward(notice, [REAL_OCP_CATERING]);
  assert.equal(result.status, "matched");
  assert.equal(result.corroboration.agree, false);
  const fields = result.corroboration.disagreements.map((d) => d.field).sort();
  assert.deepEqual(fields, ["amount", "date"]);
  // Both values present — product must render both, never drop one.
  const amount = result.corroboration.disagreements.find((d) => d.field === "amount");
  assert.equal(amount.city_record, 999999);
  assert.equal(amount.ocp, 250000);
});

test("attachOcpAward hangs the side-car on the lifecycle object", () => {
  const lifecycle = { pin: "x", timeline: [], ok: true };
  const side = joinOcpAward(
    { request_id: "20260723031", type_of_notice_description: "Award", contract_amount: "250000", start_date: "2026-07-30" },
    [REAL_OCP_CATERING],
  );
  const next = attachOcpAward(lifecycle, side);
  assert.equal(next.ocp_award.status, "matched");
  assert.equal(next.pin, "x");
  assert.ok(Array.isArray(next.timeline));
});
