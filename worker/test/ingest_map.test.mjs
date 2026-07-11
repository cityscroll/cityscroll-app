// Unit tests for the Socrata→D1 ingest mapping (src/ingest.mjs) — the honest-data
// rules live here as columns, so the mapping is where they must be pinned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapRow, cleanAmount, toDateISO, toDateTimeISO, docUrls } from "../src/ingest.mjs";

test("cleanAmount: strips $/commas, flags the corrupt tail invalid (EDA $96T row)", () => {
  assert.deepEqual(cleanAmount("$1,234,567.89"), { amount: 1234567.89, valid: 1 });
  assert.deepEqual(cleanAmount("96100000000000"), { amount: 96100000000000, valid: 0 }); // $96.1T data-entry error
  assert.equal(cleanAmount("6680000000").valid, 1); // $6.68B — the legit maximum must stay valid
  assert.deepEqual(cleanAmount("0"), { amount: 0, valid: 0 });
  assert.deepEqual(cleanAmount(null), { amount: null, valid: 0 });
  assert.deepEqual(cleanAmount("N/A"), { amount: null, valid: 0 });
});

test("date parsing: ISO timestamps and MM/DD/YYYY both normalize", () => {
  assert.equal(toDateISO("2026-07-10T00:00:00.000"), "2026-07-10");
  assert.equal(toDateISO("7/4/2026"), "2026-07-04");
  assert.equal(toDateISO(null), null);
  assert.deepEqual(toDateTimeISO("2090-12-31T00:00:00"), { iso: "2090-12-31 00:00:00", year: 2090 });
  assert.deepEqual(toDateTimeISO("1/2/2027 10:00 AM"), { iso: "2027-01-02 00:00:00", year: 2027 });
});

test("docUrls: entity-decodes and keeps only http(s)", () => {
  const raw = "https://a856-cityrecord.nyc.gov/Search/GetFile?x=1&amp;y=2, javascript:alert(1), http://b.example/f";
  assert.deepEqual(docUrls(raw), [
    "https://a856-cityrecord.nyc.gov/Search/GetFile?x=1&y=2",
    "http://b.example/f",
  ]);
});

test("mapRow: full row maps with honest fields + lowercased haystack + raw preserved", () => {
  const row = {
    request_id: "20260701001",
    section_name: "Procurement",
    agency_name: "DEPT OF PARKS & RECREATION",
    type_of_notice_description: "Award",
    category_description: "Construction/Construction Services",
    short_title: "Playground Renovation",
    additional_description_1: "Scope: renovate playground",
    contract_amount: "$2,500,000",
    start_date: "2026-07-01T00:00:00.000",
    due_date: "2090-01-01T00:00:00.000", // rolling placeholder
    pin: "8462026PLAY",
  };
  const m = mapRow(row);
  assert.equal(m.request_id, "20260701001");
  assert.equal(m.contract_amount, 2500000);
  assert.equal(m.contract_amount_valid, 1);
  assert.equal(m.due_year, 2090); // downstream renders "rolling", never a fake date
  assert.equal(m.start_date, "2026-07-01");
  assert.ok(m.haystack.includes("playground renovation"));
  assert.ok(m.haystack.includes("dept of parks"));
  assert.deepEqual(JSON.parse(m.raw), row); // raw row survives for schema-drift recovery
});

test("mapRow: missing request_id maps to null (caller skips the row)", () => {
  assert.equal(mapRow({ short_title: "x" }).request_id, null);
});
