import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveRuleEvents,
  normalizeRuleItem,
  parseRssItems,
} from "../src/lib/rules.mjs";

const NOW = new Date("2026-08-01T12:00:00Z");

function parseItem(fields = "") {
  const xml = `<rss><channel><item>
    <title>Commercial meter parking</title>
    <link>https://rules.cityofnewyork.us/rule/meter-parking/</link>
    <pubDate>Thu, 23 Jul 2026 16:18:07 +0000</pubDate>
    <agency_name>DOT</agency_name>
    ${fields}
  </item></channel></rss>`;
  return normalizeRuleItem(parseRssItems(xml)[0]);
}

test("rules event spine preserves comment, hearing, adoption, and effective as distinct events", () => {
  const rule = parseItem(`
    <rule_status>1</rule_status>
    <comment_by_date>20260820</comment_by_date>
    <hearing_date_1>20260818</hearing_date_1>
    <rule_adoption_date>20261015</rule_adoption_date>
    <content:encoded><![CDATA[
      <em>Rule Effective Date:</em> <strong>10-15-2026</strong>
    ]]></content:encoded>`);

  assert.equal(rule.adoption_published_at, "2026-07-23T16:18:07.000Z");
  assert.equal(rule.effective_date, "2026-10-15");
  const events = deriveRuleEvents(rule, NOW);
  assert.deepEqual(events.map((event) => event.event_type), [
    "public_hearing",
    "comment_close",
    "adoption",
    "effective",
  ]);
  assert.equal(events.find((event) => event.event_type === "comment_close").valid_at, "2026-08-20");
  assert.equal(events.find((event) => event.event_type === "adoption").published_at, "2026-07-23T16:18:07.000Z");
  assert.equal(events.find((event) => event.event_type === "adoption").valid_at, null);
  assert.equal(events.find((event) => event.event_type === "effective").valid_at, "2026-10-15");
});

test("comment close exposes date-precision valid time and alert metadata without inventing a clock time", () => {
  const event = deriveRuleEvents(parseItem("<comment_by_date>20260820</comment_by_date>"), NOW)
    .find((candidate) => candidate.event_type === "comment_close");

  assert.deepEqual(event, {
    event_type: "comment_close",
    valid_at: "2026-08-20",
    valid_at_precision: "day",
    valid_timezone: "America/New_York",
    source_field: "comment_by_date",
    source_url: "https://rules.cityofnewyork.us/rule/meter-parking/",
    status: "scheduled",
    alert: {
      eligible: true,
      trigger_field: "valid_at",
      lead_days: [14, 3, 1, 0],
    },
  });
});

test("missing lifecycle dates stay absent from the event list", () => {
  const events = deriveRuleEvents(parseItem(), NOW);
  assert.deepEqual(events.map((event) => event.event_type), ["proposal_published"]);
});
