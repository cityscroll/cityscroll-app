/**
 * PIN-sibling browse grouping.
 * verify: node --test test/pin_sibling_grouping.test.mjs test/procurement_browse_parity.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyBrowsePinSiblingPair,
  contractIdKey,
  groupPinSiblingRows,
  pinSiblingReviewIndex,
  pinsShareFamily,
} from "../site/pin_sibling_grouping.mjs";
import { rowMatchesProcurementMode } from "../site/browse_view.mjs";

function row(overrides = {}) {
  return {
    procurement_id: "procurement:contract:CT1",
    contract_id: "CT1",
    pin: "85021B0087",
    vendor_name: "TAMEER INC",
    contract_amount: 1440000,
    short_title: "City Record award",
    procurement_stages: ["award"],
    ...overrides,
  };
}

const tameerAward = row({
  procurement_id: "procurement:contract:CT185020218800001",
  contract_id: "CT185020218800001",
  pin: "85021B0087",
  request_id: "20210101001",
  contract_amount: 1_440_000,
  short_title: "Large City Record award",
  source_systems: ["city_record"],
});
const tameerPassport = row({
  procurement_id: "procurement:contract:CT185020228802305",
  contract_id: "CT185020228802305",
  pin: "85021B0087001C011",
  request_id: undefined,
  contract_amount: 26112.93,
  short_title: "Contract CT185020228802305",
  procurement_stages: ["registered"],
  source_systems: ["passport_public_contracts"],
});

const dtn = row({
  procurement_id: "procurement:contract:CT101720261414447",
  contract_id: "CT101720261414447",
  pin: "01726E0001001",
  vendor_name: "DTN LLC",
  contract_amount: 95000,
  short_title: "Weather data",
});
const warmingBus = row({
  procurement_id: "procurement:contract:CT101720268805610",
  contract_id: "CT101720268805610",
  pin: "01726E0001001",
  vendor_name: "S & J TOUR & BUS INC",
  contract_amount: 3297120,
  short_title: "Warming Bus Services",
});

const needsReview = {
  pairs: [{
    pair_id: "pf:CT101720261414447::CT1-017-20268805610",
    identity_class: "needs_review",
    label_source: "human",
    rule: null,
    evidence: {
      pin: "01726E0001001",
      checkbook: { contract_id: "CT101720261414447" },
      passport: { contract_id: "CT1-017-20268805610" },
    },
  }],
};

const relatedInstrument = {
  pairs: [{
    pair_id: "pf:CT105620278800862::CT1-056-20238800566",
    identity_class: "related_instrument",
    label_source: "rule",
    rule: "successor_term",
    evidence: {
      pin: "05618B8222KXLR002",
      checkbook: { contract_id: "CT105620278800862" },
      passport: { contract_id: "CT1-056-20238800566" },
    },
  }],
};

test("TAMEER City Record award and PASSPort-only registration share a PIN family", () => {
  assert.equal(pinsShareFamily("85021B0087", "85021B0087001C011"), true);
  assert.equal(pinsShareFamily("HSR2026", "HSR2026"), false);
  assert.equal(pinsShareFamily("85021B0087", "85021B0099"), false);
});

test("same-vendor PIN-family rows cluster as related instruments without merging ids", () => {
  const entries = groupPinSiblingRows([tameerAward, tameerPassport, row({
    procurement_id: "procurement:contract:UNRELATED",
    contract_id: "CT199999999999999",
    pin: "99999P0001",
    vendor_name: "OTHER VENDOR INC",
  })]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, "related_instrument");
  assert.equal(entries[0].identity_class, "related_instrument");
  assert.deepEqual(entries[0].procurement_ids.sort(), [
    tameerAward.procurement_id,
    tameerPassport.procurement_id,
  ].sort());
  assert.equal(entries[0].members.length, 2);
  assert.equal(new Set(entries[0].members.map((item) => item.procurement_id)).size, 2);
  assert.equal(entries[1].kind, "item");
  assert.equal(entries[1].item.procurement_id, "procurement:contract:UNRELATED");
});

test("p7 needs_review distinct-vendor pairs stay separate related-candidates", () => {
  const classified = classifyBrowsePinSiblingPair(dtn, warmingBus, pinSiblingReviewIndex(needsReview));
  assert.equal(classified.identity_class, "related_candidate");
  const entries = groupPinSiblingRows([dtn, warmingBus], { review: needsReview });
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.kind === "item"));
  assert.equal(entries[0].candidate.identity_class, "related_candidate");
  assert.equal(entries[1].candidate.identity_class, "related_candidate");
  assert.notEqual(entries[0].item.procurement_id, entries[1].item.procurement_id);
});

test("p7 related_instrument contract-id pairs cluster even when browse PINs differ in form", () => {
  const checkbook = row({
    procurement_id: "procurement:contract:CT105620278800862",
    contract_id: "CT105620278800862",
    pin: "05618B8222KXLR002",
    vendor_name: "GLOCK INC",
  });
  const passport = row({
    procurement_id: "procurement:contract:CT105620238800566",
    contract_id: "CT1-056-20238800566",
    pin: "05618B8222KXLR001",
    vendor_name: "GLOCK INC",
  });
  assert.equal(contractIdKey("CT1-056-20238800566"), "CT105620238800566");
  const entries = groupPinSiblingRows([checkbook, passport], { review: relatedInstrument });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "related_instrument");
  assert.equal(entries[0].label_source, "review");
  assert.equal(entries[0].members.length, 2);
});

test("Open RFPs mode still excludes registered PASSPort-only rows", () => {
  assert.equal(rowMatchesProcurementMode(tameerPassport, "open"), false);
  assert.equal(rowMatchesProcurementMode(tameerPassport, "award"), true);
  assert.equal(rowMatchesProcurementMode({
    type_of_notice_description: "Solicitation",
    procurement_stages: ["solicitation"],
  }, "open"), true);
});

test("committed p7 review still holds the six distinct-vendor pairs out of related-instrument clusters", () => {
  const review = JSON.parse(readFileSync(new URL("../site/data/pin_family_mismatch_review.json", import.meta.url), "utf8"));
  const queue = review.pairs.filter((pair) => pair.identity_class === "needs_review");
  assert.equal(queue.length, 6);
  const rows = queue.flatMap((pair) => [
    row({
      procurement_id: `procurement:contract:${pair.evidence.checkbook.contract_id}`,
      contract_id: pair.evidence.checkbook.contract_id,
      pin: pair.evidence.pin,
      vendor_name: pair.evidence.checkbook.vendor,
    }),
    row({
      procurement_id: `procurement:contract:${pair.evidence.passport.contract_id}`,
      contract_id: pair.evidence.passport.contract_id,
      pin: pair.evidence.epin || pair.evidence.pin,
      vendor_name: pair.evidence.passport.vendor,
    }),
  ]);
  const entries = groupPinSiblingRows(rows, { review });
  assert.ok(entries.every((entry) => entry.kind === "item"));
  assert.equal(entries.filter((entry) => entry.candidate).length, rows.length);
});
