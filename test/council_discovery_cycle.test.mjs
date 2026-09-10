import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  COUNCIL_DISCOVERY_CYCLE_STEPS,
  COUNCIL_DISCOVERY_HEALTH_DEFINITIONS,
  INSITE_CALENDAR_KEY_KIND,
  PUBLISHER_EVENT_KEY_KIND,
  WORKER_COUNCIL_THEN_SHARED_MEETINGS,
  runCouncilDiscoveryCycle,
} from "../worker/src/lib/council_discovery_cycle.mjs";
import { orderFirstClassArtifacts } from "../tools/first_class_refresh.mjs";
import {
  classifyPathRead,
  INSITE_CALENDAR_ID,
  MEETING_ID,
  PUBLISHER_EVENT_ID,
  SCHEMA as READBACK_SCHEMA,
} from "../tools/council_discovery_launch_readback.mjs";
import { productionPathObservation } from "../tools/lib/production_provenance.mjs";

const upcomingFixture = JSON.parse(readFileSync(new URL("./fixtures/legistar/upcoming_contracts_22691.json", import.meta.url)));
const peerFixture = JSON.parse(readFileSync(new URL("./fixtures/legistar/peer_meeting_identity.json", import.meta.url)));
const PINNED_NOW = new Date("2026-09-09T12:00:00.000Z");
const PUBLISHER_MEETING_ID = `meeting:nyc_legistar_events:${upcomingFixture.event.EventId}`;

function itemsFor(event) {
  const id = String(event.EventId);
  return new Map([[id, { rows: upcomingFixture.event_items.map((item) => ({ ...item, EventItemEventId: event.EventId })), fetchError: null }]]);
}

test("publisher EventId 22691 is distinct from InSite calendar 1439673", () => {
  assert.equal(String(upcomingFixture.event.EventId), "22691");
  assert.equal(String(upcomingFixture.insite_calendar.meeting_id), "1439673");
  assert.notEqual(String(upcomingFixture.event.EventId), String(upcomingFixture.insite_calendar.meeting_id));
  assert.equal(peerFixture.publisher_identity.event_id, "22691");
  assert.equal(peerFixture.publisher_identity.insite_calendar.meeting_id, "1439673");
  assert.equal(PUBLISHER_EVENT_KEY_KIND, "event_id");
  assert.equal(INSITE_CALENDAR_KEY_KIND, "insite_calendar_meeting_id");
});

test("A1: a newly observed eligible event reaches every shared consumer in one cycle", () => {
  const newEvent = {
    ...upcomingFixture.event,
    EventId: 22999,
    EventDate: "2026-09-24T00:00:00",
    EventBodyName: "Committee on Contracts",
    EventInSiteURL: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=22999",
  };
  const result = runCouncilDiscoveryCycle({
    eventRows: [upcomingFixture.event, newEvent],
    itemsByEventId: new Map([
      ...itemsFor(upcomingFixture.event),
      ...itemsFor(newEvent),
    ]),
    now: PINNED_NOW,
    watchKeywords: ["M/WBE"],
  });
  assert.equal(result.publishable, true);
  assert.deepEqual(COUNCIL_DISCOVERY_CYCLE_STEPS.map((step) => step.id), [
    "council-acquisition", "shared-meetings", "route-slices", "search", "now", "alert-replay",
  ]);
  assert.ok(result.steps.every((step) => step.observed === true));
  const fresh = result.observations.find((row) => row.publisher_key.event_id === "22999");
  assert.ok(fresh);
  for (const consumer of ["shared-meetings", "route-slices", "search", "now", "alert-replay"]) {
    assert.equal(fresh.consumers[consumer], true, consumer);
  }
  const pinned = result.observations.find((row) => row.meeting_id === PUBLISHER_MEETING_ID);
  assert.ok(pinned);
  assert.equal(pinned.publisher_key.event_id, "22691");
});

test("A5: the 2026-09-09 fixture still proves the Contracts hearing end to end", () => {
  const result = runCouncilDiscoveryCycle({
    eventRows: [upcomingFixture.event],
    itemsByEventId: itemsFor(upcomingFixture.event),
    now: PINNED_NOW,
  });
  assert.equal(result.view.meetings[0].meeting_id, PUBLISHER_MEETING_ID);
  assert.equal(result.view.meetings[0].identity.event_id, "22691");
  assert.equal(result.health.upcoming.value, 1);
  assert.equal(result.health.standalone.value, 1);
  assert.equal(result.health.exactly_joined.value, 0);
  assert.equal(result.health.collection_suppressed.value, 0);
  assert.equal(result.health.last_successful_observation.value, result.view.generated_at);
  for (const key of Object.keys(COUNCIL_DISCOVERY_HEALTH_DEFINITIONS)) {
    assert.equal(typeof result.health[key].definition, "string");
    assert.ok(result.health[key].definition.length > 20);
  }
});

test("A2: exact join reports joined and collection-suppressed counts", () => {
  const result = runCouncilDiscoveryCycle({
    eventRows: [upcomingFixture.event],
    itemsByEventId: itemsFor(upcomingFixture.event),
    cityRecordRows: peerFixture.after_exact_join.city_record_notices,
    now: PINNED_NOW,
  });
  assert.equal(result.health.exactly_joined.value, 1);
  assert.equal(result.health.standalone.value, 0);
  assert.equal(result.health.collection_suppressed.value, 1);
  const legistar = result.shared.rows.find((row) => row.meeting_id === PUBLISHER_MEETING_ID);
  assert.equal(legistar.collection_visibility, "suppressed");
});

test("A3: a failed acquisition retains last-known-good and never publishes zero as complete", () => {
  const prior = runCouncilDiscoveryCycle({
    eventRows: [upcomingFixture.event],
    itemsByEventId: itemsFor(upcomingFixture.event),
    now: PINNED_NOW,
  }).view;
  const failed = runCouncilDiscoveryCycle({
    eventRows: [],
    now: PINNED_NOW,
    previousUpcoming: prior,
  });
  assert.equal(failed.publishable, false);
  assert.equal(failed.retained_last_known_good, true);
  assert.equal(failed.published_zero_as_complete, false);
  assert.equal(failed.view.meetings[0].meeting_id, PUBLISHER_MEETING_ID);
  assert.ok(["unavailable", "stale"].includes(failed.health.status));
  assert.equal(failed.health.upcoming.value, 1);
});

test("A6: first-class refresh orders Council acquisition before shared meetings", () => {
  const registry = JSON.parse(readFileSync(new URL("../site/data/source_contracts.json", import.meta.url)));
  const ordered = orderFirstClassArtifacts(registry.first_class_artifacts);
  const upcoming = ordered.findIndex((row) => row.id === "upcoming-council-meetings");
  const shared = ordered.findIndex((row) => row.id === "shared-meetings");
  assert.ok(upcoming >= 0 && shared > upcoming);
  const sharedArtifact = registry.first_class_artifacts.find((row) => row.id === "shared-meetings");
  assert.deepEqual(sharedArtifact.depends_on, ["upcoming-council-meetings"]);
  const serialized = JSON.stringify(registry.first_class_artifacts);
  assert.equal(serialized.includes("22691"), false);
});

test("Worker scheduled source lists Council acquisition before shared hearings", () => {
  const worker = readFileSync(new URL("../worker/src/worker.mjs", import.meta.url), "utf8");
  const morning = worker.slice(worker.indexOf('event.cron === "0 8 * * *"'), worker.indexOf('event.cron === "0 10 * * *"'));
  const digest = worker.slice(worker.indexOf("Council Events acquisition precedes"));
  for (const block of [morning, digest]) {
    const acquire = block.indexOf("refreshMeetingOutcomes(env)");
    const hearings = block.indexOf("refreshHearings(env");
    assert.ok(acquire >= 0 && hearings > acquire, "Council acquisition must precede shared hearings");
  }
  assert.deepEqual(WORKER_COUNCIL_THEN_SHARED_MEETINGS, ["refreshMeetingOutcomes", "refreshHearings"]);
});

test("A4: a missing live path is not-yet-observed, never passed", () => {
  const path = { id: "canonical-detail", url: "https://cityscroll.org/meetings/missing", needles: [PUBLISHER_EVENT_ID], forbidden: [] };
  const missing = classifyPathRead({ path, status: 404, body: "Not found" });
  assert.equal(missing.state, "not-yet-observed");
  assert.notEqual(missing.state, "passed");
  const confused = classifyPathRead({
    path: { ...path, forbidden: [`LEGID=${INSITE_CALENDAR_ID}`] },
    status: 200,
    body: `EventId ${INSITE_CALENDAR_ID} LEGID=${INSITE_CALENDAR_ID}`,
  });
  assert.equal(confused.state, "failed");
  const passed = classifyPathRead({
    path: { id: "canonical-detail", url: path.url, needles: [MEETING_ID, PUBLISHER_EVENT_ID], forbidden: [`EventId ${INSITE_CALENDAR_ID}`] },
    status: 200,
    body: `${MEETING_ID} EventId ${PUBLISHER_EVENT_ID} 2026-09-23`,
  });
  assert.equal(passed.state, "passed");
  assert.throws(() => productionPathObservation({
    id: "ics", url: "https://example.test", state: "passed", status: 404, assertion: "no",
  }));
  assert.equal(READBACK_SCHEMA, "cityscroll.council_discovery_launch_readback.v1");
});
