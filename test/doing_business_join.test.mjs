// Doing Business Search Entities (72mk-a8z7) join recon characterization.
//
//   node --test test/doing_business_join.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDoingBusinessIndex,
  doingBusinessProfilePayload,
  joinVendorToDoingBusiness,
  normalizeDoingBusinessDate,
  normalizeDoingBusinessEntity,
  normalizePhone,
  ownershipStructureLabel,
} from "../worker/src/lib/doing_business_join.mjs";
import { loadSourceContracts } from "../tools/source_contracts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/doing_business/join_cases.json"), "utf8"),
);
const receipt = JSON.parse(
  readFileSync(
    join(
      ROOT,
      "site/data/doing_business_sources/verification_receipts/doing_business_entities_2026-07-30.json",
    ),
    "utf8",
  ),
);

const entityRows = cases.cases
  .map((c) => c.entity)
  .filter(Boolean);
const index = buildDoingBusinessIndex(entityRows);

test("normalizeDoingBusinessDate maps truncated 00YY years to 20YY", () => {
  assert.equal(normalizeDoingBusinessDate("0009-05-16T00:00:00.000"), "2009-05-16");
  assert.equal(normalizeDoingBusinessDate("2016-11-28T00:00:00.000"), "2016-11-28");
  assert.equal(normalizeDoingBusinessDate(""), null);
  assert.equal(normalizeDoingBusinessDate(null), null);
});

test("normalizePhone formats 10-digit numbers", () => {
  assert.equal(normalizePhone("7182872600"), "718-287-2600");
  assert.equal(normalizePhone("17182872600"), "718-287-2600");
  assert.equal(normalizePhone(""), null);
});

test("ownershipStructureLabel maps known codes", () => {
  assert.equal(ownershipStructureLabel("COR"), "Corporation");
  assert.equal(ownershipStructureLabel("llc"), "Limited liability company");
  assert.equal(ownershipStructureLabel("ZZZ"), "ZZZ");
});

test("strict stem join accepts name-variant matches and skips short stems", () => {
  assert.equal(
    joinVendorToDoingBusiness("Camba Inc.", index)?.method,
    "vendor_stem",
  );
  assert.equal(
    joinVendorToDoingBusiness("Camba Inc.", index)?.entity.organization_name,
    "CAMBA  INC",
  );
  assert.equal(joinVendorToDoingBusiness("1030 Production Services LLC", index), null);
  // 3M COMPANY is in the fixture index but stem length 2 is rejected at normalize time
  // (entity not indexed) and at join time (vendor stem too short).
  assert.equal(joinVendorToDoingBusiness("3M Company", index), null);
  assert.equal(normalizeDoingBusinessEntity({
    organization_name: "3M COMPANY",
    ownership_structure_code: "COR",
  }), null);
});

test("field-case fixtures match the accepted/rejected strategy table", () => {
  for (const c of cases.cases) {
    const hit = joinVendorToDoingBusiness(c.vendor.vendor_name, index);
    if (c.expect === "joined") {
      assert.ok(hit, c.id);
      assert.equal(hit.method, c.method, c.id);
      assert.equal(hit.entity.organization_name, c.entity.organization_name, c.id);
    } else {
      assert.equal(hit, null, c.id);
    }
  }
});

test("profile payload omits internal stem and carries catalog link", () => {
  const hit = joinVendorToDoingBusiness("Camba Inc.", index);
  const payload = doingBusinessProfilePayload(hit);
  assert.equal(payload.source, "doing-business-entities");
  assert.equal(payload.organization_name, "CAMBA  INC");
  assert.equal(payload.ownership_structure_code, "COR");
  assert.equal(payload.ownership_structure, "Corporation");
  assert.equal(payload.organization_phone, "718-287-2600");
  assert.equal(payload.doing_business_start_date, "2009-05-16");
  assert.equal(payload.catalog, "https://data.cityofnewyork.us/d/72mk-a8z7");
  assert.equal("stem" in payload, false);
});

test("verification receipt records measured rates above usefulness threshold", () => {
  const jm = receipt.join_measurement;
  assert.equal(jm.usefulness_threshold, 0.3);
  assert.ok(jm.rates.modern_awards_stem_notices.rate >= 0.3);
  assert.ok(jm.rates.modern_awards_stem_vendors.rate >= 0.3);
  assert.match(jm.verdict, /Above usefulness threshold/i);
  assert.equal(receipt.dataset.ein_bin_pin_column, false);
  assert.equal(receipt.dataset.row_count, 10787);
  assert.equal(receipt.dataset.unique_stems, 10750);
  assert.equal(receipt.field_cases.joined_camba_start_normalized, "2009-05-16");
});

test("source contract is live edge-materialized with matching measurement", () => {
  const registry = loadSourceContracts();
  const contract = registry.contracts.find((c) => c.id === "doing-business-entities");
  assert.ok(contract);
  assert.equal(contract.status, "live");
  assert.equal(contract.delivery_tier, "edge-materialized");
  assert.equal(contract.dataset_id, "72mk-a8z7");
  assert.equal(contract.join_measurement.rates.modern_awards_stem_notices.rate, 0.7042);
  assert.ok(contract.join_measurement.rates.modern_awards_stem_notices.rate >= 0.3);
});
