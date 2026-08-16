import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildCityRecordRuleProjectionIndex,
  materializeCityRecordSearchDocument,
  projectCityRecordSearchObject,
} from "../site/city_record_search_producers.mjs";

const RULES = JSON.parse(readFileSync(
  new URL("../site/data/rules_domain_observations.json", import.meta.url),
  "utf8",
));
const RULE_INDEX = buildCityRecordRuleProjectionIndex(RULES);

const MOSQUITO = {
  request_id: "20260710020",
  title: "Pesticides and Mosquito Control Products",
  section: "Public Comment on Contract Awards",
  notice_type: "Notice",
  description: "E-PIN: 81626S0021001.",
};

test("stable City Record award syntax goes through the procurement object producer", () => {
  const produced = projectCityRecordSearchObject(MOSQUITO, { ruleIndex: RULE_INDEX });
  assert.equal(produced.outcome, "indexed");
  assert.equal(produced.producer, "city_record_procurement_object");
  assert.deepEqual(produced.object, {
    object_ref: "procurement:81626S0021001",
    object_type: "procurement",
    domain: "contracts",
    canonical_href: "/browse/contracts/?mode=award&q=81626S0021001",
    process_role: "award",
  });
  assert.deepEqual(produced.evidence_refs, ["notice:20260710020"]);

  const document = materializeCityRecordSearchDocument(MOSQUITO, { ruleIndex: RULE_INDEX });
  assert.equal(document.object_type, "procurement");
  assert.equal(document.domain, "contracts");
  assert.deepEqual(document.source_observation_refs, ["notice:20260710020"]);
  assert.equal(document.classification.method, "canonical_procurement_projection");
  assert.deepEqual(document.provenance.evidence_hrefs, ["/notices/20260710020"]);
});

test("rules are admitted from the bounded rule projection, not a section switch", () => {
  const projectedRule = RULES.rows.find((row) => row.request_id === "20260728026");
  assert.ok(projectedRule, "fixture rule projection");

  const document = materializeCityRecordSearchDocument({
    request_id: projectedRule.request_id,
    title: projectedRule.short_title,
    section: "Other Public Notices",
    notice_type: projectedRule.type_of_notice_description,
  }, { ruleIndex: RULE_INDEX });

  assert.equal(document.outcome, "indexed");
  assert.equal(document.object_ref, "rulemaking:notice:20260728026");
  assert.equal(document.object_type, "rulemaking");
  assert.equal(document.domain, "rules");
  assert.equal(document.canonical_href, "/browse/rules/?q=20260728026");
  assert.equal(document.process_role, "public_process");
  assert.equal(document.classification.method, "canonical_rule_projection");
  assert.match(document.classification.basis, /rules_domain_observations/);
  assert.deepEqual(document.source_observation_refs, ["notice:20260728026"]);
});

test("unknown, ambiguous, and section-shaped observations stay evidence-only with receipts", () => {
  const cases = [
    {
      request_id: "unknown-rule",
      title: "Proposed Rule without a materialized rule projection",
      section: "Agency Rules",
      notice_type: "Public Hearings",
    },
    {
      ...MOSQUITO,
      request_id: "ambiguous-award",
      description: "E-PIN: 81626S0021001; E-PIN: 81626S0021002",
    },
    {
      request_id: "unsupported",
      title: "Publisher category without a registered object",
      section: "Other Public Notices",
    },
  ];

  for (const observation of cases) {
    const produced = projectCityRecordSearchObject(observation, { ruleIndex: RULE_INDEX });
    assert.equal(produced.outcome, "evidence_only", observation.request_id);
    assert.equal(produced.object, null, observation.request_id);
    assert.ok(produced.receipt.reason, observation.request_id);

    const document = materializeCityRecordSearchDocument(observation, { ruleIndex: RULE_INDEX });
    assert.equal(document.object_type, "unclassified", observation.request_id);
    assert.equal(document.domain, null, observation.request_id);
    assert.equal(document.canonical_href, `/notices/${observation.request_id}`, observation.request_id);
    assert.equal(document.classification.method, "fail_closed", observation.request_id);
  }
});

test("materialized attachment text changes recall evidence but never object classification", () => {
  const baseline = materializeCityRecordSearchDocument(MOSQUITO, { ruleIndex: RULE_INDEX });
  const enriched = materializeCityRecordSearchDocument({
    ...MOSQUITO,
    attachment_text: "The award includes rodenticide application guidance.",
    attachment_tables_text: "Chemical | maximum concentration",
    attachments: [{
      request_id: MOSQUITO.request_id,
      document_id: "DOC-1",
      text_status: "extracted",
      tables_status: "extracted",
    }],
  }, { ruleIndex: RULE_INDEX });

  for (const field of ["object_ref", "object_type", "domain", "canonical_href", "process_role", "classification"]) {
    assert.deepEqual(enriched[field], baseline[field], field);
  }
  assert.doesNotMatch(baseline.search_text, /rodenticide/i);
  assert.match(enriched.search_text, /rodenticide application guidance/i);
  assert.match(enriched.search_text, /maximum concentration/i);
  assert.deepEqual(enriched.provenance.search_text_sources, [
    "notice",
    "attachment_text",
    "attachment_tables_text",
  ]);
  assert.deepEqual(enriched.provenance.attachment_evidence_refs, [
    "attachment:20260710020:DOC-1",
  ]);
});
