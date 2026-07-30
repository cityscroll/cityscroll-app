// Characterization tests for informal notice translation invariants.
// Field cases: numbers, dollar amounts, dates, PINs, Request IDs, agency names, addresses
// must survive translation verbatim; any mismatch → no translation shown.
//
//   node --test test/translate_invariants.test.mjs   (from worker/)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractInvariants,
  checkInvariants,
  noticeSourceText,
  noticeMeta,
} from "../src/lib/translate_invariants.mjs";

// ---------------------------------------------------------------------------
// Field case fixtures (realistic City Record shapes)
// ---------------------------------------------------------------------------

const HPD_DEMOLITION = {
  request_id: "20220314107",
  start_date: "2022-03-18",
  agency_name: "Housing Preservation and Development",
  short_title: "IMMEDIATE EMERGENCY DEMOLITION OF 28 W 130th St, MANHATTAN (DM00121 E-6038R)",
  pin: "80622E0016001",
  contract_amount: 550000,
  additional_description_1:
    "Emergency demolition at 28 W 130th St. Contract amount $550,000. Due 2022-04-01.",
  address_to_request: "100 Gold Street, New York, NY 10038",
};

const DOT_RFP = {
  request_id: "20260625017",
  start_date: "2026-06-25",
  agency_name: "Department of Transportation",
  short_title: "Request for Proposals — Bridge Inspection Services, Brooklyn",
  pin: "84126B0042001",
  contract_amount: 1250000,
  additional_description_1:
    "The Department of Transportation seeks proposals for bridge inspection. Estimated value $1,250,000. Proposals due March 15, 2026. Contact at 55 Water Street.",
  due_date: "2026-03-15T17:00:00.000",
};

// ---------------------------------------------------------------------------
// extractInvariants — field cases
// ---------------------------------------------------------------------------

test("field case: dollar amounts are extracted as written", () => {
  const inv = extractInvariants(noticeSourceText(HPD_DEMOLITION), noticeMeta(HPD_DEMOLITION));
  assert.ok(inv.money.includes("$550,000"), `money=${JSON.stringify(inv.money)}`);
});

test("field case: large $1,250,000 amount extracted", () => {
  const inv = extractInvariants(noticeSourceText(DOT_RFP), noticeMeta(DOT_RFP));
  assert.ok(inv.money.includes("$1,250,000"), `money=${JSON.stringify(inv.money)}`);
});

test("field case: ISO and written dates extracted", () => {
  const hpd = extractInvariants(noticeSourceText(HPD_DEMOLITION), noticeMeta(HPD_DEMOLITION));
  assert.ok(hpd.dates.includes("2022-04-01"), `hpd dates=${JSON.stringify(hpd.dates)}`);
  assert.ok(hpd.dates.includes("2022-03-18"), "start_date from meta");

  const dot = extractInvariants(noticeSourceText(DOT_RFP), noticeMeta(DOT_RFP));
  assert.ok(dot.dates.includes("March 15, 2026"), `dot dates=${JSON.stringify(dot.dates)}`);
  assert.ok(dot.dates.includes("2026-03-15"), "due_date date portion from meta");
});

test("field case: PIN and Request ID from meta always required", () => {
  const inv = extractInvariants(noticeSourceText(HPD_DEMOLITION), noticeMeta(HPD_DEMOLITION));
  assert.deepEqual(inv.pins, ["80622E0016001"]);
  assert.deepEqual(inv.requestIds, ["20220314107"]);
});

test("field case: agency name from meta is an invariant", () => {
  const inv = extractInvariants(noticeSourceText(DOT_RFP), noticeMeta(DOT_RFP));
  assert.ok(inv.agencies.includes("Department of Transportation"));
});

test("field case: street addresses extracted from text and meta", () => {
  const inv = extractInvariants(noticeSourceText(HPD_DEMOLITION), noticeMeta(HPD_DEMOLITION));
  assert.ok(
    inv.addresses.some((a) => /130th/i.test(a) || /Gold Street/i.test(a)),
    `addresses=${JSON.stringify(inv.addresses)}`,
  );
  assert.ok(inv.addresses.includes("100 Gold Street, New York, NY 10038"));
});

test("field case: multi-digit numbers that are not money still extract", () => {
  const text = "Contract PIN reference 80622E0016001 covers parcel 12345 only.";
  const inv = extractInvariants(text, { pin: "80622E0016001" });
  assert.ok(inv.numbers.includes("12345") || inv.all.includes("12345"));
  assert.ok(inv.pins.includes("80622E0016001"));
});

// ---------------------------------------------------------------------------
// checkInvariants — pass / fail
// ---------------------------------------------------------------------------

test("checkInvariants: good Spanish-style translation keeps every token", () => {
  const source = noticeSourceText(HPD_DEMOLITION);
  const meta = noticeMeta(HPD_DEMOLITION);
  // Deliberate informal translation that preserves every invariant verbatim.
  const translated = [
    "DEMOLICIÓN DE EMERGENCIA INMEDIATA DE 28 W 130th St, MANHATTAN (DM00121 E-6038R)",
    "Demolición de emergencia en 28 W 130th St. Monto del contrato $550,000. Vence 2022-04-01.",
    "Housing Preservation and Development",
    "PIN 80622E0016001",
    "Request ID 20220314107",
    "100 Gold Street, New York, NY 10038",
    "Publicado 2022-03-18",
  ].join("\n");

  const result = checkInvariants(source, translated, meta);
  assert.equal(result.ok, true, `missing=${JSON.stringify(result.missing)}`);
  assert.deepEqual(result.missing, []);
});

test("checkInvariants: missing dollar amount → fail closed", () => {
  const source = noticeSourceText(DOT_RFP);
  const meta = noticeMeta(DOT_RFP);
  const bad = [
    "Solicitud de propuestas — inspección de puentes, Brooklyn",
    "El Department of Transportation busca propuestas. Valor estimado 1250000 dólares.", // $ form lost
    "PIN 84126B0042001",
    "20260625017",
    "March 15, 2026",
    "2026-03-15",
    "55 Water Street",
    "2026-06-25",
  ].join("\n");

  const result = checkInvariants(source, bad, meta);
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((m) => m.includes("1,250,000") || m.includes("$1,250,000")));
});

test("checkInvariants: rewritten agency name → fail closed (CPC-class failure)", () => {
  const source = "CPC hearing on March 15, 2026 regarding $50,000 study.";
  const meta = {
    request_id: "20260101001",
    pin: "85026P0001001",
    agency_name: "City Planning Commission",
    start_date: "2026-01-01",
  };
  // Classic machine-translation failure mode: agency replaced with a wrong expansion.
  const bad = "Chinese Communist Party hearing on March 15, 2026 regarding $50,000 study. PIN 85026P0001001. 20260101001. 2026-01-01.";
  const result = checkInvariants(source, bad, meta);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes("City Planning Commission"));
});

test("checkInvariants: missing PIN → fail closed", () => {
  const source = noticeSourceText(HPD_DEMOLITION);
  const meta = noticeMeta(HPD_DEMOLITION);
  const almost = [
    "DEMOLICIÓN DE EMERGENCIA INMEDIATA DE 28 W 130th St, MANHATTAN (DM00121 E-6038R)",
    "Demolición de emergencia en 28 W 130th St. Monto del contrato $550,000. Vence 2022-04-01.",
    "Housing Preservation and Development",
    // pin omitted on purpose
    "Request ID 20220314107",
    "100 Gold Street, New York, NY 10038",
    "2022-03-18",
  ].join("\n");

  const result = checkInvariants(source, almost, meta);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes("80622E0016001"));
});

test("checkInvariants: missing Request ID → fail closed", () => {
  const source = noticeSourceText(DOT_RFP);
  const meta = noticeMeta(DOT_RFP);
  const almost = [
    "Request for Proposals — Bridge Inspection Services, Brooklyn",
    "Department of Transportation $1,250,000 March 15, 2026 2026-03-15 55 Water Street",
    "PIN 84126B0042001",
    "2026-06-25",
    // request_id omitted
  ].join("\n");

  const result = checkInvariants(source, almost, meta);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes("20260625017"));
});

test("checkInvariants: missing street address → fail closed", () => {
  const source = "Work at 79 Rivington Street for $12,000 due 2026-07-01.";
  const meta = {
    request_id: "20260701099",
    pin: "80626P0099001",
    agency_name: "Department of Parks and Recreation",
    address: "79 Rivington Street",
    due_date: "2026-07-01",
  };
  const bad = "Trabajo por $12,000 con vencimiento 2026-07-01. Department of Parks and Recreation. PIN 80626P0099001. 20260701099.";
  const result = checkInvariants(source, bad, meta);
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((m) => /Rivington/i.test(m)));
});

test("checkInvariants: empty translation fails when source has invariants", () => {
  const result = checkInvariants(noticeSourceText(HPD_DEMOLITION), "", noticeMeta(HPD_DEMOLITION));
  assert.equal(result.ok, false);
  assert.ok(result.missing.length > 0);
});

test("checkInvariants: empty source with no meta is vacuously ok", () => {
  const result = checkInvariants("", "cualquier texto");
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

// ---------------------------------------------------------------------------
// noticeSourceText / noticeMeta shape adapters
// ---------------------------------------------------------------------------

test("noticeSourceText joins title + description fields from SODA or D1 shapes", () => {
  const soda = noticeSourceText({
    short_title: "Title",
    additional_description_1: "Desc",
    other_info_1: "Other",
  });
  assert.match(soda, /Title/);
  assert.match(soda, /Desc/);
  assert.match(soda, /Other/);

  const d1 = noticeSourceText({
    short_title: "Title",
    description: "Desc",
    other_info: "Other",
  });
  assert.equal(soda, d1);
});

test("noticeMeta maps agency / address aliases", () => {
  const fromD1 = noticeMeta({
    request_id: "1",
    agency: "Department of Sanitation",
    event_addr1: "1 Centre Street",
  });
  assert.equal(fromD1.agency_name, "Department of Sanitation");
  assert.equal(fromD1.address, "1 Centre Street");
});
