/**
 * Digest meetings redirect contract for OATH trial calendar rows.
 *
 * Shadow rehearsal 2026-09-16T10:10Z reported render_error on
 * digest:aa5e959dd1746b1a138c2b13 with evidence
 * "invalid digest redirect id for meetings". The rollup meetings section
 * calls digestRedirectUrl with each row's request_id (the meeting_id). OATH
 * session ids that embed the proceeding label with spaces are rejected by
 * the route idShape, aborting the digest build.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { rollupDigestHtml, subDigestHtml } from "../src/alerts.mjs";
import {
  digestPermalinkUrl,
  digestRedirectUrl,
  normalizeDigestId,
} from "../src/lib/digest_routes.mjs";
import { parseRedirect } from "../src/lib/stats.mjs";
import { parseOathTrialCsv } from "../../site/oath_trial_calendar.mjs";

const SHARED_MEETING_READ_MODEL = JSON.parse(
  readFileSync(new URL("../../site/data/shared_meeting_read_model.json", import.meta.url), "utf8"),
);
const CAPTURED_OATH_CSV = readFileSync(
  new URL("../../test/fixtures/oath/daily-calendar-2026-09-15.csv", import.meta.url),
  "utf8",
);
const OATH_SOURCE_URL = "https://www.nyc.gov/site/oath/trials/trial-calendar.page";

function oathTrialRowsFromReadModel(model = SHARED_MEETING_READ_MODEL) {
  return (model.rows || []).filter((row) => row?.source_system === "oath_trial_calendar");
}

function digestMeetingRow(row) {
  return {
    ...row,
    request_id: row.meeting_id,
    start_date: row.source_receipt?.observed_at || row.event_date,
  };
}

function assertDigestSafeMeetingId(meetingId, label) {
  assert.equal(typeof meetingId, "string", label);
  assert.ok(meetingId.startsWith("meeting:oath_trial_calendar:"), label);
  assert.equal(normalizeDigestId("meetings", meetingId), meetingId, label);
  const redirect = digestRedirectUrl("https://api.cityscroll.org", "meetings", meetingId);
  assert.deepEqual(parseRedirect(new URL(redirect).pathname), { kind: "meetings", id: meetingId }, label);
  assert.equal(
    digestPermalinkUrl("meetings", meetingId),
    `https://cityscroll.org/meetings/${encodeURIComponent(meetingId)}`,
    label,
  );
}

test("OATH rows in the shared meeting read model carry digest-safe meeting ids", () => {
  const oathRows = oathTrialRowsFromReadModel();
  assert.ok(oathRows.length > 0, "expected OATH trial rows in the shared meeting read model");

  const sample = oathRows[0];
  assert.equal(sample.source_system, "oath_trial_calendar");
  assertDigestSafeMeetingId(sample.meeting_id, sample.meeting_id);
  assert.doesNotMatch(sample.meeting_id, /\s/);

  for (const row of oathRows) {
    assertDigestSafeMeetingId(row.meeting_id, row.meeting_id);
  }
});

test("rollup and single-sub meetings sections render current OATH rows without redirect errors", () => {
  const sample = oathTrialRowsFromReadModel()[0];
  assert.ok(sample);
  const row = digestMeetingRow(sample);

  const rollup = rollupDigestHtml({
    sections: [{
      label: "OATH trials",
      kind: "meetings",
      new: 1,
      freshRows: [row],
      action: "match",
    }],
    wantingCount: 1,
    watchCount: 1,
    unsubAllUrl: "https://api.cityscroll.org/unsubscribe?token=all",
    manageUrl: "https://cityscroll.org/prefs?token=m",
    lang: "en",
    today: "2026-09-16",
    totalNew: 1,
    since: "2026-09-15",
  });
  assert.match(rollup, /data-digest-item="1"/);
  assert.match(rollup, /\/meetings\/meeting%3Aoath_trial_calendar%3A/);
  assert.doesNotMatch(rollup, /City Record/);

  const single = subDigestHtml(
    "OATH trials",
    "meetings",
    [row],
    "https://api.cityscroll.org/unsubscribe?token=x",
    "2026-09-15",
  );
  assert.match(single, /data-digest-item="1"/);
  assert.match(single, /\/meetings\/meeting%3Aoath_trial_calendar%3A/);
  assert.match(single, /View meeting details/);
});

test("captured OATH calendar parser emits digest-safe session ids that resolve to /meetings/", () => {
  const parsed = parseOathTrialCsv(CAPTURED_OATH_CSV, {
    sourceUrl: OATH_SOURCE_URL,
    sourceRevision: "fixture",
    observedAt: "2026-09-15T12:00:00.000Z",
  });
  assert.equal(parsed.records.length, 145);
  const withLabel = parsed.records.find((row) => /scheduled/i.test(row.proceeding_type || ""));
  assert.ok(withLabel, "expected a retained trial row with a proceeding label");
  assertDigestSafeMeetingId(withLabel.meeting_id, withLabel.meeting_id);
  assert.equal(withLabel.meeting_id.includes(" "), false);
});
