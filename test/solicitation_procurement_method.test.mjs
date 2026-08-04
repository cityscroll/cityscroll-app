import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RESPONSE_FLOOR_KIND,
  SOLICITATION_PROCUREMENT_METHOD_SCHEMA,
  deriveResponseFloor,
  extractAcceleratedProcurement,
  extractMwbeNoncompetitiveSmallPurchase,
  extractSection6129,
  extractSolicitationProcurementMethod,
} from "../worker/src/lib/solicitation_procurement_method.mjs";
import { extractNoticeFacts } from "../worker/src/lib/notice_facts.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/solicitation_procurement_method/real_notices.json", import.meta.url)
  )
);

function compactFloor(floor) {
  if (!floor) return null;
  return {
    kind: floor.kind,
    days: floor.days,
    day_unit: floor.day_unit,
    rule_source: floor.rule_source,
  };
}

function compact(pm) {
  return {
    section_6_129_present: !!pm.section_6_129?.present,
    goal_percent: pm.section_6_129?.goal_percent ?? null,
    ncsp_present: !!pm.mwbe_noncompetitive_small_purchase?.present,
    accelerated_present: !!pm.accelerated?.present,
    response_floor: compactFloor(pm.response_floor),
  };
}

for (const entry of fixture.cases) {
  test(`real solicitation ${entry.request_id}: procurement-method extraction`, () => {
    const pm = extractSolicitationProcurementMethod(entry.row);
    assert.equal(pm.schema, SOLICITATION_PROCUREMENT_METHOD_SCHEMA);
    assert.deepEqual(compact(pm), entry.expected);
    if (pm.section_6_129) {
      assert.equal(pm.section_6_129.source, "notice_body");
      assert.ok(pm.section_6_129.evidence.length >= 8);
      assert.match(pm.section_6_129.evidence, /6-129/i);
    }
    if (pm.mwbe_noncompetitive_small_purchase) {
      assert.ok(
        pm.mwbe_noncompetitive_small_purchase.source === "notice_body" ||
          pm.mwbe_noncompetitive_small_purchase.source === "selection_method"
      );
      assert.ok(pm.mwbe_noncompetitive_small_purchase.evidence.length >= 8);
    }
    if (pm.response_floor) {
      assert.equal(pm.response_floor.source, "derived");
      assert.ok(pm.response_floor.rule_cite.length > 20);
    }
  });
}

test("section 6-129 extracts goal percent when labeled", () => {
  const hit = extractSection6129(
    "This procurement is subject to participation goals for Minority-Owned Business Enterprises (MBEs) as required by Section 6-129 of the New York Administrative Code. The MWBE goal for this project is 30%."
  );
  assert.equal(hit.present, true);
  assert.equal(hit.goal_percent, 30);
  assert.equal(hit.participation_goals, true);
  assert.match(hit.evidence, /6-129/);
});

test("section 6-129 ignores state Article 15-A M/WBE goals without 6-129", () => {
  const miss = extractSection6129(
    "MWBE: Under Article 15A of The State of New York, the following M/WBE goals apply to this contract: M/WBE 32%."
  );
  assert.equal(miss, null);
});

test("M/WBE noncompetitive small purchase matches body and selection_method", () => {
  const body = extractMwbeNoncompetitiveSmallPurchase(
    "This solicitation is being made pursuant to the M/WBE Noncompetitive Small Purchase Method, Section 3-08 of the New York City Procurement Policy Board (PPB) Rules."
  );
  assert.equal(body.present, true);
  assert.equal(body.ppb_section, "3-08");
  assert.equal(body.source, "notice_body");

  const fromSelection = extractMwbeNoncompetitiveSmallPurchase("", {
    selection_method_description: "M/WBE Noncompetitive Small Purchase",
  });
  assert.equal(fromSelection.present, true);
  assert.equal(fromSelection.source, "selection_method");
});

test("accelerated procurement requires method cue, not schedule language", () => {
  const scheduleOnly = extractAcceleratedProcurement(
    "Proposers must show the ability to timely meet the project schedule or achieve an accelerated schedule and not exceed a guaranteed maximum price."
  );
  assert.equal(scheduleOnly, null);

  const method = extractAcceleratedProcurement(
    "This solicitation is being made pursuant to the Accelerated Procurement Method, Section 3-07 of the New York City Procurement Policy Board (PPB) Rules. Notice shall be published not less than three business days before the proposal due date."
  );
  assert.equal(method.present, true);
  assert.equal(method.ppb_section, "3-07");
  assert.match(method.evidence, /Accelerated Procurement/i);
});

test("response floor priority: accelerated > 6-129 > default solicitation", () => {
  assert.deepEqual(
    compactFloor(
      deriveResponseFloor({
        accelerated: { present: true, evidence: "Accelerated Procurement" },
        section_6_129: { present: true, evidence: "Section 6-129" },
        is_solicitation: true,
      })
    ),
    {
      kind: RESPONSE_FLOOR_KIND.ACCELERATED,
      days: 3,
      day_unit: "business_days",
      rule_source: "ppb_3_07_accelerated_3_business_days",
    }
  );

  assert.deepEqual(
    compactFloor(
      deriveResponseFloor({
        section_6_129: { present: true, evidence: "Section 6-129" },
        is_solicitation: true,
      })
    ),
    {
      kind: RESPONSE_FLOOR_KIND.SECTION_6_129,
      days: 27,
      day_unit: "calendar_days",
      rule_source: "admin_code_6_129_extended_27_calendar_days",
    }
  );

  assert.deepEqual(
    compactFloor(deriveResponseFloor({ is_solicitation: true })),
    {
      kind: RESPONSE_FLOOR_KIND.DEFAULT_COMPETITIVE,
      days: 20,
      day_unit: "calendar_days",
      rule_source: "ppb_competitive_default_20_calendar_days",
    }
  );

  assert.equal(deriveResponseFloor({ is_solicitation: false }), null);
});

test("full extract: accelerated solicitation yields 3-business-day floor", () => {
  const pm = extractSolicitationProcurementMethod({
    section_name: "Procurement",
    type_of_notice_description: "Solicitation",
    additional_description_1:
      "<p>This solicitation is being made pursuant to the Accelerated Procurement Method, Section 3-07 of the PPB Rules.</p>",
  });
  assert.equal(pm.accelerated.present, true);
  assert.deepEqual(compactFloor(pm.response_floor), {
    kind: RESPONSE_FLOOR_KIND.ACCELERATED,
    days: 3,
    day_unit: "business_days",
    rule_source: "ppb_3_07_accelerated_3_business_days",
  });
});

test("non-solicitation notices do not receive a default response floor", () => {
  const award = extractSolicitationProcurementMethod({
    section_name: "Procurement",
    type_of_notice_description: "Award",
    additional_description_1: "<p>Contract awarded to Acme Corp.</p>",
  });
  assert.equal(award.response_floor, null);
  assert.equal(award.section_6_129, null);
});

test("extractNoticeFacts nests procurement_method on structured facts", () => {
  const facts = extractNoticeFacts({
    section_name: "Procurement",
    type_of_notice_description: "Solicitation",
    additional_description_1:
      "This procurement is subject to Section 6-129 of the New York City Administrative Code. The MWBE goal for this project is 25%. PIN: 85026Y0001",
  });
  assert.ok(Array.isArray(facts.identifiers));
  assert.equal(facts.procurement_method.section_6_129.goal_percent, 25);
  assert.equal(facts.procurement_method.response_floor.days, 27);
});

test("fixture hand-check corpus covers all three response floors plus NCSP", () => {
  const floors = new Set(
    fixture.cases.map((c) => c.expected.response_floor?.kind).filter(Boolean)
  );
  assert.ok(floors.has(RESPONSE_FLOOR_KIND.SECTION_6_129));
  assert.ok(floors.has(RESPONSE_FLOOR_KIND.DEFAULT_COMPETITIVE));
  // Accelerated is rare in the live corpus; unit cases cover the third floor.
  assert.ok(fixture.cases.some((c) => c.expected.ncsp_present));
  assert.ok(fixture.cases.some((c) => c.expected.section_6_129_present));
  assert.equal(fixture.cases.length, 10);
});
