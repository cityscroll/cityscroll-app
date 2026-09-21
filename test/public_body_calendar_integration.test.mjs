import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPublicBodyCalendarIndex,
} from "../site/public_body_calendar_integration.mjs";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import { meetingsBrowseFromModel } from "../capabilities/meetings.mjs";
import { scopedMeetingWatchEvaluation } from "../worker/src/lib/compile.mjs";

const NOW = "2026-10-01T12:00:00Z";
const OBSERVED = "2026-10-01T10:00:00Z";
const CONTRACTS = [
  "nycps_pep",
  "ccrb_board",
  "brooklyn_borough_board",
  "brooklyn_bp_ulurp",
  "hplus_h_cab",
];

function meeting(contract, publisherIdentifier, eventDate, options = {}) {
  const sourceUrl = options.source_url || `https://official.example/${contract}/${publisherIdentifier}`;
  return {
    source_contract_id: contract,
    publisher_identifier: publisherIdentifier,
    source_url: sourceUrl,
    official_source_url: sourceUrl,
    source_receipt: { schema: "cityscroll.meeting_source_receipt.v1", source_url: sourceUrl, observed_at: OBSERVED, status: "ok" },
    event_date: eventDate,
    timezone: "America/New_York",
    temporal_basis: options.temporal_basis || "explicit_instance",
    schedule_basis: options.schedule_basis || options.temporal_basis || "publisher_event",
    title: options.title || `${contract} meeting`,
    venue: options.venue || { name: "Official civic venue" },
    ...options,
  };
}

function sourceRows() {
  return {
    nycps_pep: { rows: [meeting("nycps_pep", "pep-2026-10-05", "2026-10-05T18:00:00")], generated_at: OBSERVED },
    ccrb_board: { rows: [meeting("ccrb_board", "ccrb-2026-10-06", "2026-10-06T16:00:00")], generated_at: OBSERVED },
    brooklyn_borough_board: { rows: [meeting("brooklyn_borough_board", "bbb-2026-10-07", "2026-10-07T18:00:00")], generated_at: OBSERVED },
    brooklyn_bp_ulurp: { rows: [meeting("brooklyn_bp_ulurp", "ulurp-2026-10-08", "2026-10-08T18:00:00")], generated_at: OBSERVED },
    hplus_h_cab: { rows: [meeting("hplus_h_cab", "cabrini:2026-10-09", "2026-10-09T18:00:00", {
      temporal_basis: "published_recurrence",
      schedule_basis: "published_recurrence",
      source_raw_values: { derived: true, temporal_basis: "published_recurrence" },
    })], generated_at: OBSERVED },
  };
}

test("A1: all five admitted calendars flow through browse, coverage, availability, and watch preview", () => {
  const index = buildPublicBodyCalendarIndex({
    sources: sourceRows(),
    observations: CONTRACTS.map((source_contract_id) => ({ source_contract_id, observed_at: OBSERVED, row_count: 1 })),
    now: NOW,
  });
  const model = buildSharedMeetingReadModel({ publicBodyCalendarIndex: index, now: NOW, generatedAt: NOW });
  const browse = meetingsBrowseFromModel(model, { limit: 10 });
  const browseContracts = [...new Set(browse.results.map((row) => row.source_contract_id))].sort();
  assert.deepEqual(browseContracts, CONTRACTS.slice().sort(), "unrestricted structured browse includes each admitted contract");
  assert.deepEqual(
    model.sources.public_body_calendar.contract_coverage.map((entry) => entry.source_contract_id),
    CONTRACTS,
    "coverage metadata names all five contracts in registry order",
  );
  assert.equal(model.rows.find((row) => row.source_contract_id === "hplus_h_cab").temporal_basis, "published_recurrence", "recurrence projection remains labeled in the read model");

  const watch = scopedMeetingWatchEvaluation({ availability: {
    timezone: "America/New_York",
    windows: [{ weekdays: [1, 2, 3, 4, 5], start: "17:00" }],
  } }, "2026-10-01", model.rows);
  assert.equal(watch.rows.length, 4, "applicable availability returns the four evening occurrences");
  assert.equal(watch.availability.excluded, 1, "the 4 PM occurrence is excluded by the same availability evaluator");
});

test("A1: stale and failed contracts remain visible in coverage instead of becoming empty", () => {
  const index = buildPublicBodyCalendarIndex({
    sources: {
      nycps_pep: { rows: [], generated_at: OBSERVED },
      ccrb_board: { rows: [], coverage: [{ source_contract_id: "ccrb_board", status: "failed" }] },
    },
    observations: [
      { source_contract_id: "nycps_pep", observed_at: "2026-09-29T10:00:00Z", row_count: 0 },
      { source_contract_id: "ccrb_board", status: "failed", observed_at: OBSERVED },
      { source_contract_id: "brooklyn_borough_board", observed_at: OBSERVED, row_count: 0 },
      { source_contract_id: "brooklyn_bp_ulurp", observed_at: "2026-09-29T10:00:00Z", row_count: 0 },
      { source_contract_id: "hplus_h_cab", observed_at: OBSERVED, row_count: 0 },
    ],
    now: NOW,
  });
  assert.deepEqual(
    index.coverage.map((entry) => entry.status),
    ["stale", "failed", "fresh-empty", "stale", "fresh-empty"],
    "stale, failed, and fresh-empty states stay distinct in coverage metadata",
  );
});

test("A3: explicit occurrence supersession retires only the matching recurrence projection", () => {
  const derived = meeting("hplus_h_cab", "cabrini:2026-10-09", "2026-10-09T18:00:00", {
    temporal_basis: "published_recurrence",
    schedule_basis: "published_recurrence",
  });
  const explicit = meeting("hplus_h_cab", "cabrini-explicit-2026-10-09", "2026-10-09T18:30:00");
  const other = meeting("hplus_h_cab", "cabrini:2026-11-13", "2026-11-13T18:00:00", {
    temporal_basis: "published_recurrence",
    schedule_basis: "published_recurrence",
  });
  const index = buildPublicBodyCalendarIndex({
    sources: { hplus_h_cab: { rows: [derived, explicit, other] } },
    supersessions: [{
      superseded_meeting_id: "meeting:public_body_calendar:hplus_h_cab:cabrini:2026-10-09",
      replacement_meeting_id: "meeting:public_body_calendar:hplus_h_cab:cabrini-explicit-2026-10-09",
      evidence: { source_url: explicit.source_url },
    }],
    now: NOW,
  });
  assert.deepEqual(index.rows.map((row) => row.publisher_identifier).sort(), ["cabrini-explicit-2026-10-09", "cabrini:2026-11-13"], "supersession removes only the matching derived occurrence");
  assert.equal(index.supersessions[0].relation, "explicit_instance_supersedes_published_recurrence", "supersession carries an explicit evidence relation");
});
