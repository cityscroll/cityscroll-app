import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  RULE_EVIDENCE_STAMP_SCHEMA,
  RULE_EVIDENCE_STAMP_LIMITS,
  extractRuleEvidenceStamp,
} from "../site/rule_evidence_stamps.mjs";

const fixtures = JSON.parse(readFileSync(
  new URL("./fixtures/rule_evidence_stamps.json", import.meta.url),
  "utf8",
));
const committedRules = JSON.parse(readFileSync(
  new URL("../site/data/rules_domain_observations.json", import.meta.url),
  "utf8",
));

for (const fixture of fixtures) {
  test(`pure rule evidence stamp: ${fixture.name}`, () => {
    const first = extractRuleEvidenceStamp(fixture.row);
    const second = extractRuleEvidenceStamp(structuredClone(fixture.row));
    assert.deepEqual(first, second);
    for (const [key, expected] of Object.entries(fixture.expected)) {
      if (Array.isArray(expected)) {
        for (const value of expected) assert.ok(first[key].includes(value), `${key} includes ${value}`);
      } else {
        assert.equal(first[key], expected);
      }
    }
  });
}

test("rule evidence stamps are bounded compact data with no source prose or contacts", () => {
  const syntheticEmail = ["example", "example.com"].join("@");
  const stamp = extractRuleEvidenceStamp({
    short_title: "Proposed Rule for Refrigeration Safety",
    additional_description_1: `${"refrigeration safety inspection ".repeat(80)} Email ${syntheticEmail} or call 555-0100 to submit testimony.`,
    other_info_1: "Testimony from Jane Public says this is excellent.",
  });
  assert.equal(stamp.schema, RULE_EVIDENCE_STAMP_SCHEMA);
  assert.ok(stamp.topic_keys.length <= RULE_EVIDENCE_STAMP_LIMITS.topic_keys);
  assert.ok(stamp.body_topic_keys.length <= RULE_EVIDENCE_STAMP_LIMITS.body_topic_keys);
  assert.ok(stamp.citation_keys.length <= RULE_EVIDENCE_STAMP_LIMITS.citation_keys);
  assert.ok(stamp.negative_evidence.length <= RULE_EVIDENCE_STAMP_LIMITS.negative_evidence);
  assert.doesNotMatch(JSON.stringify(stamp), /example\.com|555-0100|Jane Public|excellent|testimony/i);
  assert.deepEqual(Object.keys(stamp).sort(), [
    "adoption_date",
    "body_topic_keys",
    "citation_keys",
    "effective_date",
    "lifecycle_status",
    "negative_evidence",
    "schema",
    "topic_keys",
  ]);
});

test("committed rules snapshot contains only bounded evidence stamps, never source body fields", () => {
  assert.equal(committedRules.schema_version, 2);
  assert.equal(committedRules.rule_evidence_schema, RULE_EVIDENCE_STAMP_SCHEMA);
  const forbiddenFields = new Set([
    "additional_description_1", "additional_description_2", "additional_description_3",
    "other_info_1", "other_info_2", "other_info_3",
    "printout_1", "printout_2", "printout_3",
    "email", "phone", "testimony",
  ]);
  for (const row of committedRules.rows) {
    for (const key of Object.keys(row)) assert.ok(!forbiddenFields.has(key), `forbidden snapshot field ${key}`);
    const stamp = row.rule_evidence;
    assert.equal(stamp.schema, RULE_EVIDENCE_STAMP_SCHEMA);
    assert.ok(stamp.topic_keys.length <= RULE_EVIDENCE_STAMP_LIMITS.topic_keys);
    assert.ok(stamp.body_topic_keys.length <= RULE_EVIDENCE_STAMP_LIMITS.body_topic_keys);
    assert.ok(stamp.citation_keys.length <= RULE_EVIDENCE_STAMP_LIMITS.citation_keys);
    assert.ok(stamp.negative_evidence.length <= RULE_EVIDENCE_STAMP_LIMITS.negative_evidence);
    assert.ok(stamp.topic_keys.every((token) => /^[a-z0-9]{4,40}$/.test(token)));
    assert.ok(stamp.body_topic_keys.every((token) => /^[a-z0-9]{4,40}$/.test(token)));
    assert.ok(stamp.negative_evidence.every((value) => /^rule_[a-z_]+$/.test(value)));
    assert.ok(stamp.effective_date === null || /^\d{4}-\d{2}-\d{2}$/.test(stamp.effective_date));
    assert.ok(stamp.adoption_date === null || /^\d{4}-\d{2}-\d{2}$/.test(stamp.adoption_date));
  }
  assert.doesNotMatch(JSON.stringify(committedRules), /additional_description|other_info|printout/i);
});
