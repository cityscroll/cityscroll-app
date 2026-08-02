import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attachCityRecordPublicHearingEvents,
  attachRulemakingSiblings,
  cityRecordPublicHearingEvent,
  deriveRuleEvents,
  isRulesPublicHearingNotice,
  normalizeCityRecordEventDate,
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

function crRecord(opts) {
  return {
    request_id: opts.request_id,
    agency: opts.agency || "Housing Preservation and Development",
    title: opts.title,
    notice_date: opts.notice_date || "2026-03-01T00:00:00.000",
    stage: opts.stage || "proposed",
    city_record: {
      request_id: opts.request_id,
      agency: opts.agency || "Housing Preservation and Development",
      title: opts.title,
      notice_date: opts.notice_date || "2026-03-01T00:00:00.000",
      notice_type: opts.notice_type || "Agency Rules",
      section_name: opts.section_name || "Agency Rules",
      event_date: opts.event_date || null,
    },
    nyc_rules: opts.nyc_rules || null,
    events: opts.events || [],
    join: opts.join || { matched: false },
  };
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

// ---------------------------------------------------------------------------
// City Record Public Hearings → public_hearing spine event
// ---------------------------------------------------------------------------

test("normalizeCityRecordEventDate keeps wall-clock times and collapses midnight to day", () => {
  assert.equal(normalizeCityRecordEventDate("2026-04-15T11:00:00.000"), "2026-04-15T11:00:00");
  assert.equal(normalizeCityRecordEventDate("2026-04-15T00:00:00.000"), "2026-04-15");
  assert.equal(normalizeCityRecordEventDate("2026-04-15"), "2026-04-15");
  assert.equal(normalizeCityRecordEventDate(null), null);
});

test("cityRecordPublicHearingEvent builds provenance from City Record Public Hearings", () => {
  const record = crRecord({
    request_id: "HEAR-1",
    title: "Public Hearing on Natural Gas Detectors",
    notice_type: "Public Hearings",
    event_date: "2026-04-20T10:00:00.000",
  });
  assert.equal(isRulesPublicHearingNotice(record), true);
  const event = cityRecordPublicHearingEvent(record, NOW);
  assert.equal(event.event_type, "public_hearing");
  assert.equal(event.valid_at, "2026-04-20T10:00:00");
  assert.equal(event.source_field, "city_record.event_date");
  assert.equal(event.provenance.source, "city_record");
  assert.equal(event.provenance.request_id, "HEAR-1");
  assert.match(event.source_url, /HEAR-1/);
});

test("non-hearing Agency Rules notice does not produce a public_hearing event", () => {
  const record = crRecord({
    request_id: "PROP-1",
    title: "Proposed Rule — Scaffold Fees",
    notice_type: "Notice",
    event_date: "2026-05-01T10:00:00.000", // stray date — still not a hearing notice
  });
  assert.equal(isRulesPublicHearingNotice(record), false);
  assert.equal(cityRecordPublicHearingEvent(record, NOW), null);
});

test("attachCityRecordPublicHearingEvents: matching hearing joins onto proposal sibling", () => {
  const proposal = crRecord({
    request_id: "20260301011",
    title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-03-01T00:00:00.000",
    stage: "comment-open",
    events: [{
      event_type: "proposal_published",
      valid_at: "2026-03-01T12:00:00.000Z",
      source_field: "pubDate",
    }],
  });
  const hearing = crRecord({
    request_id: "20260415011",
    title: "Public Hearing on Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-04-15T00:00:00.000",
    notice_type: "Public Hearings",
    event_date: "2026-04-20T10:00:00.000",
    stage: "hearing",
  });
  const unrelated = crRecord({
    request_id: "20260320099",
    title: "Proposed Rule — Lead-Based Paint Inspection Fees",
    notice_date: "2026-03-20T00:00:00.000",
  });

  const stitched = attachRulemakingSiblings([proposal, hearing, unrelated]);
  const enriched = attachCityRecordPublicHearingEvents(stitched, NOW);
  const byId = Object.fromEntries(enriched.map((r) => [r.request_id, r]));

  const propH = byId["20260301011"].events.find((e) => e.event_type === "public_hearing");
  assert.ok(propH);
  assert.equal(propH.provenance.request_id, "20260415011");
  assert.equal(propH.source_field, "city_record.event_date");

  const hearH = byId["20260415011"].events.find((e) => e.event_type === "public_hearing");
  assert.ok(hearH);
  assert.equal(hearH.valid_at, "2026-04-20T10:00:00");

  const unrelH = byId["20260320099"].events.find((e) => e.event_type === "public_hearing");
  assert.equal(unrelH, undefined);
});

test("attachCityRecordPublicHearingEvents: non-matching hearing does not join onto other rulemaking", () => {
  const proposal = crRecord({
    request_id: "P-GAS",
    title: "Proposed Rule — Natural Gas Detectors in Dwelling Units",
    notice_date: "2026-03-01T00:00:00.000",
  });
  const capaHearing = crRecord({
    request_id: "H-CAPA",
    title: "Public Hearing — Tenant Harassment Penalty Case 99-ABC",
    notice_date: "2026-04-02T00:00:00.000",
    notice_type: "Public Hearings",
    event_date: "2026-04-18T14:00:00.000",
  });

  const stitched = attachRulemakingSiblings([proposal, capaHearing]);
  const enriched = attachCityRecordPublicHearingEvents(stitched, NOW);
  const byId = Object.fromEntries(enriched.map((r) => [r.request_id, r]));

  // No high-confidence title stitch → separate subjects.
  assert.notEqual(byId["P-GAS"].rulemaking_subject_ref, byId["H-CAPA"].rulemaking_subject_ref);
  assert.equal(
    byId["P-GAS"].events.find((e) => e.event_type === "public_hearing"),
    undefined,
  );
  assert.ok(byId["H-CAPA"].events.find((e) => e.event_type === "public_hearing"));
});
