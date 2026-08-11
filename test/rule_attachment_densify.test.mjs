import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  compactCitationLawKeys,
  expandCitationKeyParents,
  extractRuleEvidenceStamp,
  isStrongCitationKey,
} from "../site/rule_evidence_stamps.mjs";
import {
  evaluateRuleEvidence,
  resolveMandateObservation,
  OBSERVATION_STATUS,
} from "../site/process_conformance.mjs";
import { densifyRulesFromAttachmentText } from "../tools/densify_rule_evidence_attachments.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test/fixtures/rule_attachment_text.json");

test("citation keys expand parents and reject bare section:1 as strong evidence", () => {
  const mandateKeys = compactCitationLawKeys("New York City Charter § 753(e)(2)");
  assert.ok(mandateKeys.includes("nyc-charter:753(e)(2)"));
  assert.ok(mandateKeys.includes("nyc-charter:753"));
  assert.equal(isStrongCitationKey("nyc-charter:753"), true);
  assert.equal(isStrongCitationKey("section:1"), false);
  assert.equal(isStrongCitationKey("section:753"), false);
  assert.equal(isStrongCitationKey("section:16-306(b)(1)"), true);

  const inverted = compactCitationLawKeys(
    "Section 753 and Section 1043(g) of the New York City Charter authorize this rule.",
  );
  assert.ok(inverted.includes("nyc-charter:753"));
  assert.ok(inverted.includes("nyc-charter:1043(g)") || inverted.includes("nyc-charter:1043"));
});

test("attachment densify stamps clear mandate_rule publication for CWZ gold case", () => {
  const textById = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const rulesDoc = {
    schema_version: 2,
    rows: [{
      request_id: "20260605008",
      agency_name: "Sanitation",
      short_title: "DSNY Final Rule re Implementation Dates for the Brooklyn North and Upper Manhattan Commercial Waste Zones",
      start_date: "2026-06-11T00:00:00.000",
      type_of_notice_description: "Notice",
      section_name: "Agency Rules",
      source_system: "city_record",
      rule_evidence: {
        schema: "cityscroll.rule_evidence_stamp.v1",
        topic_keys: ["dsny", "commercial", "waste", "zones"],
        body_topic_keys: [],
        citation_keys: [],
        lifecycle_status: "adopted",
        effective_date: null,
        adoption_date: null,
        negative_evidence: [],
      },
    }],
  };
  const { doc, densified } = densifyRulesFromAttachmentText(rulesDoc, textById, { force: true });
  assert.equal(densified, 1);
  const stamp = doc.rows[0].rule_evidence;
  assert.ok(stamp.body_topic_keys.includes("commercial"));
  assert.ok(stamp.body_topic_keys.includes("waste"));
  assert.ok(stamp.citation_keys.some((key) => key.includes("753") || key.includes("charter")));

  const mandate = {
    agency_id: "sanitation",
    duty_text: "Regulate the conduct of businesses authorized to collect commercial waste in commercial waste zones and establish and enforce specified standards and requirements.",
    deliverable_type: "rulemaking",
    citation: "New York City Charter § 753(e)(2)",
  };
  const candidate = {
    agency_id: "sanitation",
    agency_name: "Sanitation",
    request_id: "20260605008",
    label: doc.rows[0].short_title,
    when: "2026-06-11",
    signal_kind: "rule_filing",
    body_topic_keys: stamp.body_topic_keys,
    citation_keys: stamp.citation_keys,
    tokens: stamp.topic_keys,
    lifecycle_status: stamp.lifecycle_status,
    negative_evidence: [],
  };
  const evidence = evaluateRuleEvidence(mandate, candidate);
  assert.equal(evidence.citation_law_match, true);
  assert.ok(evidence.rule_body_overlap.includes("commercial"));
  assert.equal(evidence.publication_eligible, true);

  const obs = resolveMandateObservation(mandate, [candidate], { asOf: "2026-08-01" });
  assert.equal(obs.status, OBSERVATION_STATUS.OBSERVED);
  assert.equal(obs.observed_record.request_id, "20260605008");
});

test("weak section-only citation overlap does not publish", () => {
  const evidence = evaluateRuleEvidence({
    agency_id: "sanitation",
    duty_text: "The commissioner may not allow a rule prohibiting a supplemental sanitation service provider from placing refuse.",
    citation: "§ 1, subdivision e, paragraph 3(a)",
  }, {
    agency_id: "sanitation",
    label: "DSNY Final Rule re Implementation Dates for Commercial Waste Zones",
    when: "2026-06-11",
    signal_kind: "rule_filing",
    body_topic_keys: ["sanitation", "take", "commercial", "waste"],
    citation_keys: expandCitationKeyParents(["section:1", "nyc-charter:1043"]),
    tokens: ["sanitation", "commercial", "waste", "zones"],
    negative_evidence: [],
  });
  assert.equal(evidence.citation_law_match, false);
  assert.equal(evidence.publication_eligible, false);
});

test("extractRuleEvidenceStamp from inverted charter prose emits scheme keys", () => {
  const stamp = extractRuleEvidenceStamp({
    short_title: "Commercial Waste Zone Implementation",
    additional_description_1:
      "Section 753 and Section 1043(g) of the New York City Charter authorize DSNY to make this proposed rule about commercial waste zones.",
  });
  assert.ok(stamp.citation_keys.includes("nyc-charter:753"));
  assert.ok(stamp.body_topic_keys.includes("commercial"));
});
