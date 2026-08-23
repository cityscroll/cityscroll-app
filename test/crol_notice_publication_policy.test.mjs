import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MONEY_HONESTY_CAP } from "../site/agency_vendor_rollup.mjs";
import {
  CROL_AWARD_PUBLICATION_LOOKBACK_DAYS,
  CROL_AWARD_PUBLICATION_POLICY,
  CROL_NOTICE_VALID_AMOUNT_MAX,
  crolAwardPublicationFloor,
  crolNoticeAmountIsValid,
  describeCrolAwardPublication,
  matchesCrolAwardPublication,
} from "../site/crol_notice_publication_policy.mjs";
import { yearAgoISO } from "../tools/lib/batch_precompute_snapshots.mjs";
import { procurementSourceRecordsFromMaterializations } from "../tools/build_shared_procurement_read_model.mjs";
import { selectCheckbookContractsForGraph } from "../warehouse/lib/checkbook_contracts.mjs";

const NOW = "2026-08-18T04:05:51.552Z";

test("CROL award publication reuses the Money honesty cap and 365-day floor", () => {
  assert.equal(CROL_NOTICE_VALID_AMOUNT_MAX, MONEY_HONESTY_CAP);
  assert.equal(CROL_NOTICE_VALID_AMOUNT_MAX, 10_000_000_000);
  assert.equal(CROL_AWARD_PUBLICATION_LOOKBACK_DAYS, 365);
  const now = new Date("2026-08-01T15:00:00Z");
  assert.equal(crolAwardPublicationFloor(now), yearAgoISO(now));
  assert.equal(crolAwardPublicationFloor(now), "2025-08-01");
  assert.equal(crolNoticeAmountIsValid(1), true);
  assert.equal(crolNoticeAmountIsValid(10_000_000_000), false);
  assert.equal(crolNoticeAmountIsValid(0), false);
});

test("PASSPort contracts are served by identity while CROL remains a notice policy", () => {
  const passport = {
    contract_id: "CT1-NEG-1",
    epin: "85025M0001001",
    status: "Registered",
    current_amount: 42_000,
    registration_date: "12/01/2025",
    procurement_method: "MWBE Non Competitive Small Purchase",
  };
  const stale = {
    ...passport,
    contract_id: "CT1-OLD-1",
    epin: "85020M0001001",
    registration_date: "01/15/2024",
  };
  const overCap = {
    ...passport,
    contract_id: "CT1-CAP-1",
    current_amount: 10_000_000_000,
  };
  assert.equal(matchesCrolAwardPublication(passport, { now: NOW }), true);
  assert.equal(matchesCrolAwardPublication(stale, { now: NOW }), false);
  assert.equal(matchesCrolAwardPublication(overCap, { now: NOW }), false);

  const records = procurementSourceRecordsFromMaterializations({
    generated_at: NOW,
    rows: {
      checkbook_contracts: [],
      passport_contracts: [stale, overCap, passport],
    },
  }, { rows: [] });
  const snapshots = records
    .filter((row) => row.source_system === "passport_public_contracts")
    .map((row) => JSON.parse(row.normalized_snapshot));
  assert.deepEqual(
    snapshots.map((row) => row.contract_id).sort(),
    ["CT1-CAP-1", "CT1-NEG-1", "CT1-OLD-1"],
  );
  assert.equal(describeCrolAwardPublication({ now: NOW }).row_cap, null);
  assert.equal(describeCrolAwardPublication({ now: NOW }).policy, CROL_AWARD_PUBLICATION_POLICY);
  assert.match(describeCrolAwardPublication({ now: NOW }).coverage, /not a citywide inventory/i);
});

test("Checkbook graph publication drops the numeric cap in favor of the CROL Award window", () => {
  const rows = [
    { contract_id: "CT-NEW-1", pin: "111", current: 50_000, registered: "2026-07-01" },
    { contract_id: "CT-NEW-2", pin: "222", current: 60_000, registered: "2026-06-01" },
    { contract_id: "CT-OLD-1", pin: "333", current: 70_000, registered: "2024-01-01" },
    { contract_id: "CT-CAP-1", pin: "444", current: 10_000_000_000, registered: "2026-07-02" },
  ];
  const uncapped = selectCheckbookContractsForGraph(rows, [], [], { now: NOW });
  assert.equal(uncapped.cap, null);
  assert.equal(uncapped.selected_rows, 2);
  assert.deepEqual(uncapped.rows.map((row) => row.contract_id).sort(), ["CT-NEW-1", "CT-NEW-2"]);
  assert.match(uncapped.strategy, /City Record Award publication/i);
  assert.doesNotMatch(uncapped.strategy, /half the cap/);

  const capped = selectCheckbookContractsForGraph(rows, [], [], { now: NOW, cap: 1 });
  assert.equal(capped.cap, 1);
  assert.equal(capped.selected_rows, 1);
});

test("production spine admits CROL-window PASSPort rows that the 500-row prefix dropped", () => {
  const spine = JSON.parse(readFileSync(new URL("../site/data/procurement_spine_sources.json", import.meta.url)));
  const records = procurementSourceRecordsFromMaterializations(spine, { rows: [] });
  const passport = records.filter((row) => row.source_system === "passport_public_contracts");
  assert.equal(passport.length, spine.rows.passport_contracts.length);
  const under100k = passport.filter((row) => {
    const snapshot = JSON.parse(row.normalized_snapshot);
    const amount = Number(snapshot.current_amount || snapshot.award_amount || 0);
    return amount > 0 && amount <= 100_000;
  });
  assert.ok(under100k.length > 2, `expected more than two PASSPort-only ≤$100k rows, got ${under100k.length}`);
});
