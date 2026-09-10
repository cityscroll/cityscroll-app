import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { handleAdminCouncilDiscoveryHealth } from "../src/admin.mjs";
import { HEARINGS_KV_KEY } from "../src/hearings.mjs";
import { UPCOMING_COUNCIL_MEETINGS_KV_KEY } from "../src/lib/upcoming_council_meetings.mjs";
import { COUNCIL_DISCOVERY_HEALTH_SCHEMA } from "../src/lib/council_discovery_health.mjs";

const upcoming = JSON.parse(readFileSync(new URL("../../site/data/upcoming_council_meetings.json", import.meta.url)));

function kv(values) {
  return { get: async (key) => values.get(key) ?? null };
}

test("admin Council discovery health is operator-only and reports bounded population metrics", async () => {
  const env = {
    ADMIN_KEY: "secret",
    ALERT_STATE: kv(new Map([
      [UPCOMING_COUNCIL_MEETINGS_KV_KEY, JSON.stringify(upcoming)],
      [HEARINGS_KV_KEY, JSON.stringify({ rows: upcoming.meetings.map((meeting) => ({
        meeting_id: meeting.meeting_id,
        source_system: "nyc_legistar_events",
        event_id: meeting.identity.event_id,
        collection_visibility: "visible",
      })) })],
    ])),
  };
  const denied = await handleAdminCouncilDiscoveryHealth(new Request("https://w/admin/council-discovery-health"), env);
  assert.equal(denied.status, 401);
  const ok = await handleAdminCouncilDiscoveryHealth(
    new Request("https://w/admin/council-discovery-health?key=secret"),
    env,
  );
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.schema, COUNCIL_DISCOVERY_HEALTH_SCHEMA);
  assert.equal(typeof body.upcoming.value, "number");
  assert.equal(typeof body.standalone.value, "number");
  assert.equal(typeof body.exactly_joined.value, "number");
  assert.equal(typeof body.collection_suppressed.value, "number");
  assert.equal(typeof body.truncated.value, "number");
  assert.ok(body.last_successful_observation.value);
  assert.ok(body.upcoming.definition);
});
