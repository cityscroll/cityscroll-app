import assert from "node:assert/strict";
import test from "node:test";

import { HEARINGS_KV_KEY } from "../worker/src/hearings.mjs";
import { handleMcp } from "../worker/src/mcp.mjs";
import { MEETINGS_BROWSE_CAPABILITY_REFERENCE } from "../capabilities/meetings.mjs";

const model = {
  schema: "cityscroll.shared_meeting_read_model.v1",
  version: 1,
  generated_at: "2026-09-30T12:00:00Z",
  freshness: { generated_at: "2026-09-30T12:00:00Z", checked_at: "2026-09-30T12:00:00Z" },
  sources: { city_record: { status: "available", row_count: 2 } },
  rows: [
    {
      object_type: "meeting", meeting_id: "meeting:city_record:anchor-1", source_system: "city_record",
      title: "Evening meeting", event_date: "2026-10-01T17:00:00-04:00", attendance_mode: "hybrid",
      schedule: { status: "resolved", precision: "exact_time", starts_at: "2026-10-01T17:00:00-04:00", timezone: "America/New_York" },
      source_receipt: { status: "ok", observed_at: "2026-09-30T12:00:00Z" },
    },
    {
      object_type: "meeting", meeting_id: "meeting:city_record:anchor-2", source_system: "city_record",
      title: "Date-only meeting", event_date: "2026-10-03", attendance_mode: "remote",
      schedule: { status: "date_only", precision: "date_only", raw_date: "2026-10-03", timezone: "America/New_York" },
      source_receipt: { status: "ok", observed_at: "2026-09-30T12:00:00Z" },
    },
  ],
};

function env() {
  const values = new Map([[HEARINGS_KV_KEY, JSON.stringify(model)]]);
  return {
    ALERT_STATE: { get: async (key) => values.get(key) || null },
    SUBS: { get: async () => "0", put: async () => {} },
  };
}

async function call(argumentsValue) {
  const response = await handleMcp(
    new Request("https://api.cityscroll.org/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "198.51.100.10" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browse_meetings", arguments: argumentsValue } }),
    }),
    env(),
  );
  return response.json();
}

test("MCP browse_meetings is a peer adapter over the shared structured result", async () => {
  const result = await call({
    from: "2026-10-01",
    to: "2026-10-31",
    availability: { timezone: "America/New_York", windows: [{ weekdays: [1, 2, 3, 4, 5], start: "17:00" }, { weekdays: [0, 6] }] },
    attendance_modes: ["hybrid", "remote"],
    limit: 10,
  });
  assert.equal(result.result.structuredContent.capability_reference, MEETINGS_BROWSE_CAPABILITY_REFERENCE);
  assert.deepEqual(result.result.structuredContent.results.map((row) => row.meeting_id), ["meeting:city_record:anchor-1"]);
  assert.equal(result.result.structuredContent.coverage.exclusions.unknown_start, 1);
  assert.match(result.result.content[0].text, /structured/i);
});

test("MCP browse rejects invalid zones and unknown fields instead of widening the query", async () => {
  const invalidZone = await call({ availability: { timezone: "Mars/Olympus", windows: [{ weekdays: [0] }] } });
  assert.equal(invalidZone.result.isError, true);
  assert.match(invalidZone.result.content[0].text, /invalid_timezone/);
  const unknownField = await call({ source_contract: "not-a-supported-filter" });
  assert.equal(unknownField.result.isError, true);
  assert.match(unknownField.result.content[0].text, /does not accept|invalid/i);
});
