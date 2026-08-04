import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  agencyKey,
  measureFranchiseMocsPlanJoin,
  noticePublishedIdentifiers,
} from "../tools/lib/franchise_mocs_plan_join.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const notice = {
  request_id: "20260716022",
  agency_name: "Parks and Recreation",
  short_title: "Outdoor cafe concession (Solicitation # B385-SB-2025)",
  start_date: "2026-07-24",
  franchise_join_keys: ["solicitation:b385-sb-2025"],
};

test("franchise MOCS bridge normalizes the published solicitation identifier", () => {
  assert.deepEqual(noticePublishedIdentifiers(notice), ["B385SB2025"]);
  assert.equal(agencyKey("Department of Parks and Recreation"), agencyKey("Parks and Recreation"));
});

test("an exact plan identifier can pass only when notice-side usefulness clears the gate", () => {
  const plan = {
    source_record_id: "mocs_ll1:FY27NDPR1",
    source: "mocs_ll1",
    agency: "Department of Parks and Recreation",
    description: "Outdoor cafe concession",
    term_start: "2027-01-01",
    published_identifiers: ["B385-SB-2025"],
  };
  const result = measureFranchiseMocsPlanJoin([notice], [plan]);
  assert.equal(result.join_measurement.joined, 1);
  assert.equal(result.join_measurement.rate, 1);
  assert.equal(result.join_measurement.materialize, true);
  assert.equal(result.edges.length, 1);
});

test("unreviewed title similarity cannot create a plan edge", () => {
  const plan = {
    source_record_id: "mocs_ll63:FY27NDPR2",
    source: "mocs_ll63",
    agency: "Department of Parks and Recreation",
    description: "Outdoor cafe concession transmitter park Brooklyn",
    term_start: "2027-01-01",
    published_identifiers: [],
  };
  const fuzzyNotice = {
    ...notice,
    short_title: "Outdoor cafe concession transmitter park Brooklyn",
    franchise_join_keys: [],
  };
  const result = measureFranchiseMocsPlanJoin([fuzzyNotice], [plan]);
  assert.equal(result.join_measurement.joined, 0);
  assert.equal(result.join_measurement.materialize, false);
  assert.equal(result.join_measurement.unreviewed_candidates, 1);
  assert.deepEqual(result.edges, []);
});

test("production receipt stops MOCS plan context on the franchise surface", () => {
  const receipt = JSON.parse(readFileSync(join(
    ROOT,
    "site/data/franchise_concession_sources/verification_receipts/franchise_mocs_plans_2026-08-04.json",
  ), "utf8"));
  assert.equal(receipt.mode, "production");
  assert.equal(receipt.sample.size, 100);
  assert.equal(receipt.source_inventory.mocs_plan_rows, 11566);
  assert.equal(receipt.join_measurement.joined, 0);
  assert.equal(receipt.join_measurement.materialize, false);
  assert.equal(receipt.join_measurement.gate_status, "stopped_below_threshold");
  assert.deepEqual(receipt.edges, []);
});
