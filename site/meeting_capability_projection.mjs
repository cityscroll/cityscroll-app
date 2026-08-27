// Static-first adapter for meeting documents. The page receives its row from
// the committed shared model; this projection applies the same exact-id,
// source, coverage, and freshness contract used by HTTP and MCP.

import {
  MEETING_GET_CAPABILITY_REFERENCE,
  meetingGetFromModel,
  validateMeetingGetOutput,
} from "../capabilities/meetings.mjs";

const MEETING_UI_READ_MODEL_SCHEMA = "cityscroll.shared_meeting_read_model.v1";

export function canonicalMeetingResult(record = {}, model = {}) {
  const meetingId = String(record.meeting_id || "").trim();
  if (!meetingId) return null;
  const sourceSystem = record.source_system || "unknown";
  const sourceRecordId = record.source_record_id || record.request_id || meetingId;
  const canonicalRecord = {
    object_type: "meeting",
    ...record,
    source_receipt: record.source_receipt || {
      schema: "cityscroll.meeting_source_receipt.v1",
      source_url: record.source_url || null,
      observed_at: record.source_receipt?.observed_at || model.generated_at || null,
      status: "ok",
      fetch_status: "snapshot",
      reason: null,
    },
    source_record: record.source_record || {
      source_system: sourceSystem,
      identifier: sourceRecordId,
      url: record.source_url || null,
      receipt: record.source_receipt || null,
    },
  };
  const result = meetingGetFromModel({
    schema: MEETING_UI_READ_MODEL_SCHEMA,
    version: 1,
    generated_at: model.generated_at || canonicalRecord.source_receipt?.observed_at || null,
    freshness: model.freshness || {
      generated_at: model.generated_at || canonicalRecord.source_receipt?.observed_at || null,
      checked_at: canonicalRecord.source_receipt?.observed_at || null,
    },
    sources: model.sources || {
      [sourceSystem]: {
        source_system: sourceSystem,
        status: "available",
        available: true,
        generated_at: canonicalRecord.source_receipt?.observed_at || null,
        row_count: 1,
      },
    },
    rows: [canonicalRecord],
  }, { meetingId });
  return validateMeetingGetOutput(result, { meetingId });
}

export function canonicalMeetingForRender(record = {}, model = {}) {
  const result = canonicalMeetingResult(record, model);
  return result?.availability === "available" ? result.meeting : null;
}

/** Project a static meeting collection through the same bounded get contract. */
export function canonicalMeetingsForRender(records = [], model = {}) {
  return (Array.isArray(records) ? records : []).map((record) => {
    const result = canonicalMeetingResult(record, model);
    return result?.availability === "available" ? result.meeting : record;
  });
}

export { MEETING_GET_CAPABILITY_REFERENCE };
