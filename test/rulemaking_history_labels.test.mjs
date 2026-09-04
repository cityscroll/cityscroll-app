import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRulemakingObjects } from "../worker/src/lib/rulemaking.mjs";
import { renderRulemakingDocument } from "../site/rulemaking_document.mjs";
import { READER_SOURCE_FIELD_LABELS, sourceFieldLabel } from "../site/reader_surface_labels.mjs";

const SUBJECT = "rulemaking:dot:bicycle-racks";
const RULES_URL = "https://rules.cityofnewyork.us/rule/city-owned-bicycle-racks/";

const RAW_FIELDS = ["pubDate", "city_record.event_date", "hearing_date_1", "comment_by_date", "city_record.notice_date"];
const UNKNOWN_FIELD = "future_schema_key_v9";

function rows() {
  return [
    {
      request_id: "20260317026",
      agency: "DOT",
      title: "DOT Proposed Rules Relating to City-Owned Bicycle Racks",
      notice_date: "2026-03-25T00:00:00.000",
      stage: "hearing",
      rulemaking_subject_ref: SUBJECT,
      rulemaking_join: { matched: true, confidence: "high", notice_count: 2 },
      nyc_rules: { url: RULES_URL, title: "City-Owned Bicycle Racks", summary: "Amends the bicycle rack rules.", hearing_date: "2026-04-24" },
      events: [
        { event_type: "public_hearing", valid_at: "2026-04-24", source_url: RULES_URL, status: "occurred", source_field: "hearing_date_1" },
        { event_type: "comment_deadline", valid_at: "2026-04-24", source_url: RULES_URL, status: "occurred", source_field: "comment_by_date" },
        { event_type: "effective", valid_at: "2026-08-13", source_url: RULES_URL, status: "occurred", source_field: "city_record.event_date" },
        { event_type: "published", valid_at: "2026-08-14", source_url: RULES_URL, status: "occurred", source_field: UNKNOWN_FIELD },
      ],
    },
    {
      request_id: "20260706041",
      agency: "DOT",
      title: "Notice of Adoption: City-Owned Bicycle Racks",
      notice_date: "2026-07-14T00:00:00.000",
      stage: "effective",
      rulemaking_subject_ref: SUBJECT,
      rulemaking_join: { matched: true, confidence: "high", notice_count: 2 },
      events: [],
    },
  ];
}

function visibleText(html) {
  return html.replace(/<[^>]+>/g, " ");
}

test("approved source fields map to fixed reader labels; anything else has none", () => {
  assert.deepEqual(RAW_FIELDS.map(sourceFieldLabel), [
    "publication date", "event date", "hearing date", "comment deadline", "notice publication date",
  ]);
  assert.equal(sourceFieldLabel(UNKNOWN_FIELD), null);
  for (const field of ["constructor", "__proto__", "toString"]) {
    assert.equal(sourceFieldLabel(field), null);
  }
  assert.equal(sourceFieldLabel("Hearing_Date_1"), null, "no case folding or humanizing of unknown spellings");
  assert.equal(sourceFieldLabel(""), null);
  assert.equal(sourceFieldLabel(undefined), null);
  assert.equal(Object.keys(READER_SOURCE_FIELD_LABELS).length, RAW_FIELDS.length);
});

test("rule history shows readable provenance labels and never a raw field identifier", () => {
  const [object] = buildRulemakingObjects(rows(), { now: "2026-08-27" });
  const html = renderRulemakingDocument(object);
  const text = visibleText(html);

  assert.match(text, /hearing date/);
  assert.match(text, /comment deadline/);
  assert.match(text, /event date/);
  for (const raw of RAW_FIELDS) {
    assert.doesNotMatch(text, new RegExp(raw.replace(".", "\\.")), `${raw} must not appear as copy`);
  }
  assert.doesNotMatch(text, /future_schema_key_v9|future schema key v9|Future Schema Key V9/);

  // Provenance is retained machine-readably and the official-source links are unchanged.
  assert.match(html, /data-source-field="hearing_date_1"/);
  assert.match(html, /data-source-field="city_record\.event_date"/);
  assert.match(html, /data-source-field="future_schema_key_v9"/);
  const items = html.match(/<li class="rule-history-event" [^]*?<\/li>/g) || [];
  assert.ok(items.length >= 3, "history events rendered");
  for (const item of items) {
    assert.match(item, /Open source/, "every observed event keeps its source link");
  }
  assert.match(html, new RegExp(RULES_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
});

test("events with an unknown or absent source field render the source label alone", () => {
  const plain = rows();
  plain[0].events = [
    { event_type: "public_hearing", valid_at: "2026-04-24", source_url: RULES_URL, status: "occurred" },
    { event_type: "effective", valid_at: "2026-08-13", source_url: RULES_URL, status: "occurred", source_field: UNKNOWN_FIELD },
    { event_type: "published", valid_at: "2026-08-14", source_url: RULES_URL, status: "occurred", source_field: "constructor" },
  ];
  const [object] = buildRulemakingObjects(plain, { now: "2026-08-27" });
  const html = renderRulemakingDocument(object);
  const metas = html.match(/<p class="rule-history-event-meta">[^]*?<\/p>/g) || [];
  assert.match(html, /data-source-field="constructor"/);
  assert.doesNotMatch(visibleText(html), /constructor|function|\[native code\]/);
  assert.ok(metas.length >= 2, "history event meta rendered");
  for (const meta of metas) {
    const text = visibleText(meta).replace(/\s+/g, " ").trim();
    assert.doesNotMatch(text, /·\s*·/, `no dangling separator: ${text}`);
    assert.doesNotMatch(text, /^·|·$/, `no leading or trailing separator: ${text}`);
    assert.doesNotMatch(text, /future_schema_key_v9/);
  }
});
