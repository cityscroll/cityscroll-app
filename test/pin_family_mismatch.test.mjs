/**
 * PIN-family Checkbook ↔ PASSPort identity classification.
 * verify: node --test test/pin_family_mismatch.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildPinFamilyReview,
  classifyPinFamilyEvidence,
  classifyPinFamilyRow,
  isPinFamilyIdMismatch,
  isPublicSameContractCrosswalkRow,
  parseFmsContractId,
} from "../entity_resolution/cross_domain/pin_family_mismatch.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("parses compact Checkbook and hyphenated PASSPort FMS ids", () => {
  assert.deepEqual(parseFmsContractId("CTA184120277200151"), {
    type: "CTA1", agency: "841", form: "compact",
  });
  assert.deepEqual(parseFmsContractId("MMA1-841-20248803767"), {
    type: "MMA1", agency: "841", form: "hyphen",
  });
  assert.deepEqual(parseFmsContractId("CT101720261414447"), {
    type: "CT1", agency: "017", form: "compact",
  });
  assert.equal(parseFmsContractId("not-an-id").type, null);
});

test("CTA vs MMA1 with the same vendor is related-instrument by document type", () => {
  const row = classifyPinFamilyRow({
    status: "matched",
    join_method: "pin_epin_exact",
    checkbook_contract_id: "CTA184120277200151",
    passport_contract_id: "MMA1-841-20248803767",
    checkbook_pin: "84120P8912KXLR001",
    passport_epin: "84120P8912KXLR001",
  }, {
    checkbookContracts: [{
      contract_id: "CTA184120277200151",
      prime_vendor: "WSP USA INC",
      agency: "Department of Transportation",
      current: 3744130.46,
      start: "2025-10-24",
      end: "2028-10-10",
    }],
    passportContracts: [{
      contract_id: "MMA1-841-20248803767",
      vendor: "WSP USA INC",
      agency: "DEPARTMENT OF TRANSPORTATION",
      current_amount: 10000000,
      start_date: "12/02/2023",
      end_date: "12/01/2027",
      title: "Design Related Services Renewal",
    }],
  });
  assert.equal(row.identity_class, "related_instrument");
  assert.equal(row.rule, "fms_document_type_mismatch");
  assert.equal(row.label_source, "rule");
});

test("same-vendor day-adjacent renewal is related-instrument, not same contract", () => {
  const row = classifyPinFamilyRow({
    status: "matched",
    join_method: "pin_strip_suffix",
    checkbook_contract_id: "CT184120278801195",
    passport_contract_id: "CT1-841-20248807583",
    checkbook_pin: "84123B0029001R001",
    passport_epin: "84123B0029001",
  }, {
    checkbookContracts: [{
      contract_id: "CT184120278801195",
      prime_vendor: "METROEXPRESS SERVICES INC",
      current: 8396750,
      start: "2026-06-20",
      end: "2028-06-19",
    }],
    passportContracts: [{
      contract_id: "CT1-841-20248807583",
      vendor: "METROEXPRESS SERVICES INC",
      current_amount: 8396750,
      start_date: "06/20/2024",
      end_date: "06/19/2026",
    }],
  });
  assert.equal(row.identity_class, "related_instrument");
  assert.equal(row.rule, "successor_term");
});

test("different vendors on the same PIN stay on the human queue", () => {
  const row = classifyPinFamilyRow({
    status: "matched",
    join_method: "pin_epin_exact",
    checkbook_contract_id: "CT101720261414447",
    passport_contract_id: "CT1-017-20268805610",
    checkbook_pin: "01726E0001001",
    passport_epin: "01726E0001001",
  }, {
    checkbookContracts: [{
      contract_id: "CT101720261414447",
      prime_vendor: "DTN LLC",
      current: 95000,
      start: "2026-06-01",
      end: "2027-05-31",
    }],
    passportContracts: [{
      contract_id: "CT1-017-20268805610",
      vendor: "S & J TOUR & BUS INC",
      current_amount: 3297120,
      start_date: "01/27/2026",
      end_date: "03/27/2026",
      title: "Warming Bus Services",
    }],
  });
  assert.equal(row.identity_class, "needs_review");
  assert.equal(row.rule, null);
  assert.match(row.rationale, /different vendors/i);
});

test("LKB vs Lockwood Kessler stays human because the stem does not match", () => {
  const classified = classifyPinFamilyEvidence({
    vendor_same: false,
    term_gap_days: 1,
    checkbook: { fms: { type: "MMA1" } },
    passport: { fms: { type: "MMA1" } },
  });
  assert.equal(classified.identity_class, "needs_review");
});

test("exact contract-id matches stay public; PIN-family id mismatches do not", () => {
  assert.equal(isPublicSameContractCrosswalkRow({
    status: "matched", join_method: "contract_id_exact",
  }), true);
  assert.equal(isPublicSameContractCrosswalkRow({
    status: "matched", join_method: "pin_epin_exact",
  }), false);
  assert.equal(isPinFamilyIdMismatch({
    status: "matched",
    join_method: "pin_epin_exact",
    checkbook_contract_id: "CTA1",
    passport_contract_id: "MMA1",
  }), true);
});

test("committed review artifact classifies 42 PIN-family mismatches as 36 auto + 6 human", () => {
  const crosswalk = JSON.parse(readFileSync(join(ROOT, "site/data/passport_checkbook_crosswalk.json"), "utf8"));
  const spine = JSON.parse(readFileSync(join(ROOT, "site/data/procurement_spine_sources.json"), "utf8"));
  const committed = JSON.parse(readFileSync(join(ROOT, "site/data/pin_family_mismatch_review.json"), "utf8"));
  const rebuilt = buildPinFamilyReview({
    crosswalk,
    observed_on: crosswalk.observed_on,
    generated_at: committed.generated_at,
    passportContracts: spine.rows.passport_contracts,
    checkbookContracts: spine.rows.checkbook_contracts,
  });
  assert.equal(committed.metrics.pin_family_id_mismatches, 42);
  assert.equal(committed.metrics.auto_related_instrument, 36);
  assert.equal(committed.metrics.needs_review, 6);
  assert.equal(committed.metrics.by_rule.fms_document_type_mismatch, 15);
  assert.equal(committed.metrics.by_rule.successor_term, 18);
  assert.equal(committed.metrics.by_rule.later_term_renewal, 3);
  assert.deepEqual(rebuilt.metrics, committed.metrics);
  const queue = committed.pairs.filter((pair) => pair.identity_class === "needs_review");
  assert.equal(queue.length, 6);
  assert.ok(queue.every((pair) => pair.evidence.vendor_same === false));
  assert.ok(queue.some((pair) => pair.evidence.checkbook.vendor === "DTN LLC"));
  assert.ok(queue.some((pair) => pair.evidence.checkbook.vendor === "LKB Engineering PLLC"));
});
