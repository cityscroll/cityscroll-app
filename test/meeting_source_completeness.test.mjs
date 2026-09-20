import assert from "node:assert/strict";
import test from "node:test";

import {
  auditMeetingSourceCompleteness,
  MEETING_SOURCE_COMPLETENESS,
  meetingSourceFieldNames,
} from "../site/meeting_source_completeness.mjs";
import { MEETING_SOURCE_SYSTEMS } from "../site/meeting_object_contract.mjs";

test("source completeness covers every canonical producer and the generic family", () => {
  assert.deepEqual(Object.keys(MEETING_SOURCE_COMPLETENESS.producers).sort(), [
    "bsa_calendar",
    "city_record",
    "community_board",
    "legistar",
    "oath_trial_calendar",
    "pdc_calendar",
    "public_body_calendar",
  ]);
  assert.deepEqual(MEETING_SOURCE_SYSTEMS, [
    "city_record",
    "community_board",
    "nyc_legistar_events",
    "pdc_calendar",
    "bsa_calendar",
    "oath_trial_calendar",
    "public_body_calendar",
  ]);
  assert.deepEqual(auditMeetingSourceCompleteness().errors, []);
  for (const [producer, entry] of Object.entries(MEETING_SOURCE_COMPLETENESS.producers)) {
    assert.ok(entry.fields.length > 0, producer);
    for (const field of entry.fields) {
      for (const key of ["source_field", "source_seam", "materialized_as", "document_use", "search_use", "alert_use", "disposition"]) {
        assert.ok(field[key], `${producer}.${field.source_field}: ${key}`);
      }
    }
  }
  assert.ok(meetingSourceFieldNames("public_body_calendar").includes("source_contract_id"));
  assert.ok(meetingSourceFieldNames("pdc_calendar").includes("source_receipt"));
});

test("source completeness audit rejects a missing canonical producer", () => {
  const incomplete = {
    ...MEETING_SOURCE_COMPLETENESS,
    producers: { ...MEETING_SOURCE_COMPLETENESS.producers },
  };
  delete incomplete.producers.oath_trial_calendar;
  const result = auditMeetingSourceCompleteness(incomplete);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /oath_trial_calendar: producer is missing/);
});
