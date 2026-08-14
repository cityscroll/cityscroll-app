import assert from "node:assert/strict";
import { test } from "node:test";

import { joinCommunityBoardSourceRecord, joinCommunityBoardSourceRecords } from "../site/community_board_source_join.mjs";

const notice = {
  request_id: "20260814001",
  body_id: "bronx-cb-01",
  event_date: "2026-08-12",
  matter_tokens: ["C260001ZSM"],
};

const source = {
  schema: "cityscroll.community_board_source_record.v1",
  source_url: "https://board.example/minutes",
  board_id: "bronx-cb-01",
  body_id: "bronx-cb-01",
  body_evidence: { board_id: "bronx-cb-01", basis: "publisher_record" },
  record_kind: "document",
  record_id: "minutes-1",
  source_record_id: "minutes-1",
  document_id: "minutes-1",
  date: "2026-08-12",
  category: "minutes",
  title: "C260001ZSM full board minutes",
  format: "pdf",
  publisher_identifier: "C260001ZSM",
  publisher_matter_ids: ["C260001ZSM"],
  observed_receipt: { status: "ok", observed_at: "2026-08-14T12:00:00Z" },
};

test("official join requires exact board, date, and publisher identifier", () => {
  const joined = joinCommunityBoardSourceRecord(notice, source, { asOf: "2026-08-14T12:00:00Z" });
  assert.equal(joined.status, "official");
  assert.equal(joined.official, true);
  assert.equal(joined.join.method, "exact_board_date_publisher_identifier");
  assert.deepEqual(joined.join.evidence, ["exact_board_identity", "exact_date", "publisher_identifier"]);
  assert.equal(joined.provenance.observed_receipt.status, "ok");
});

test("address-only and title-only matches stay unknown", () => {
  for (const candidate of [
    { ...source, publisher_identifier: null, publisher_matter_ids: [], title: "C260001ZSM full board minutes" },
    { ...source, publisher_identifier: null, publisher_matter_ids: [], address: "1 Main Street", title: "Different title" },
  ]) {
    const result = joinCommunityBoardSourceRecord(notice, candidate, { asOf: "2026-08-14T12:00:00Z" });
    assert.equal(result.status, "unknown");
    assert.equal(result.official, false);
    assert.equal(result.join.matched, false);
  }
});

test("mismatched body/date/identifier, stale, and ambiguous sources never become official", () => {
  assert.equal(joinCommunityBoardSourceRecord({ ...notice, body_id: "brooklyn-cb-01" }, source, { asOf: "2026-08-14T12:00:00Z" }).reason, "board_identity_mismatch");
  assert.equal(joinCommunityBoardSourceRecord({ ...notice, event_date: "2026-08-13" }, source, { asOf: "2026-08-14T12:00:00Z" }).reason, "date_mismatch");
  assert.equal(joinCommunityBoardSourceRecord(notice, { ...source, publisher_identifier: "OTHER", publisher_matter_ids: ["OTHER"] }, { asOf: "2026-08-14T12:00:00Z" }).reason, "publisher_identifier_mismatch");
  assert.equal(joinCommunityBoardSourceRecord(notice, { ...source, observed_receipt: { status: "ok", observed_at: "2026-01-01T00:00:00Z" } }, { asOf: "2026-08-14T12:00:00Z", maxAgeDays: 30 }).reason, "source_stale");

  const ambiguous = joinCommunityBoardSourceRecords(notice, [source, { ...source, record_id: "minutes-2", source_record_id: "minutes-2" }], { asOf: "2026-08-14T12:00:00Z" });
  assert.equal(ambiguous.status, "unknown");
  assert.equal(ambiguous.reason, "ambiguous_source_records");
});
