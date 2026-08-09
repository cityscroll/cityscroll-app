import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MEETING_MATTER_STAMP_LIMITS,
  MEETING_MATTER_STAMP_SCHEMA,
  extractMeetingMatterStamp,
} from "../site/meeting_matter_stamps.mjs";

const fixtures = JSON.parse(readFileSync(
  new URL("./fixtures/meeting_matter_stamps.json", import.meta.url),
  "utf8",
));
const committedMeetings = JSON.parse(readFileSync(
  new URL("../site/data/meetings_domain_observations.json", import.meta.url),
  "utf8",
));

for (const fixture of fixtures) {
  test(`pure meeting matter stamp: ${fixture.name}`, () => {
    const first = extractMeetingMatterStamp(fixture.row);
    const second = extractMeetingMatterStamp(structuredClone(fixture.row));
    assert.deepEqual(first, second);
    for (const [key, expected] of Object.entries(fixture.expected)) {
      for (const value of expected) assert.ok(first[key].includes(value), `${key} includes ${value}`);
      if (expected.length === 0) assert.deepEqual(first[key], []);
    }
  });
}

test("contact-heavy fixture does not retain contact identity", () => {
  const fixture = fixtures.find((row) => row.name === "contact-heavy body");
  assert.doesNotMatch(JSON.stringify(extractMeetingMatterStamp(fixture.row)), /Jordan|Example|applicant/i);
});

test("meeting matter stamps are bounded compact data without prose or contacts", () => {
  const syntheticEmail = ["privacy", "example.invalid"].join("@");
  const stamp = extractMeetingMatterStamp({
    additional_description_1: `${"The matter concerns sidewalk cafe construction. ".repeat(100)} Email ${syntheticEmail} or call 555-0199.`,
  });
  assert.equal(stamp.schema, MEETING_MATTER_STAMP_SCHEMA);
  assert.ok(stamp.subject_tokens.length <= MEETING_MATTER_STAMP_LIMITS.subject_tokens);
  assert.ok(stamp.matter_ids.length <= MEETING_MATTER_STAMP_LIMITS.matter_ids);
  assert.deepEqual(Object.keys(stamp).sort(), ["matter_ids", "schema", "subject_tokens"]);
  assert.ok(stamp.subject_tokens.every((token) => /^[a-z0-9]{4,40}$/.test(token)));
  assert.ok(stamp.matter_ids.every((value) => /^(?:bsa|pdc|ulurp|zap):[A-Z0-9-]+$/.test(value)));
  assert.doesNotMatch(JSON.stringify(stamp), /privacy|example\.invalid|555-0199|testify/i);
});

test("committed meetings snapshot contains stamps and never retains source body fields", () => {
  assert.equal(committedMeetings.meeting_matter_stamp_schema, MEETING_MATTER_STAMP_SCHEMA);
  const forbiddenFields = new Set([
    "additional_description_1", "additional_description_2", "additional_description_3",
    "other_info_1", "other_info_2", "other_info_3",
    "printout_1", "printout_2", "printout_3",
    "body", "description", "email", "phone", "testimony",
  ]);
  for (const row of committedMeetings.rows) {
    for (const key of Object.keys(row)) assert.ok(!forbiddenFields.has(key), `forbidden snapshot field ${key}`);
    const stamp = row.matter_subject;
    assert.equal(stamp.schema, MEETING_MATTER_STAMP_SCHEMA);
    assert.ok(stamp.subject_tokens.length <= MEETING_MATTER_STAMP_LIMITS.subject_tokens);
    assert.ok(stamp.matter_ids.length <= MEETING_MATTER_STAMP_LIMITS.matter_ids);
  }
  assert.doesNotMatch(JSON.stringify(committedMeetings), /additional_description|other_info|printout/i);
});
