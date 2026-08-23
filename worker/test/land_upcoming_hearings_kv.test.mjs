/**
 * Land upcoming-hearings KV cutover: zap-outcome records → ALERT_STATE, committed floor.
 *
 *   node --test worker/test/land_upcoming_hearings_kv.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  handleLandUpcomingHearings,
  LAND_UPCOMING_HEARINGS_KV_KEY,
  refreshLandUpcomingHearings,
} from "../src/land_upcoming_hearings.mjs";
import {
  committedLandUpcomingHearingsFloor,
  loadLandUpcomingHearingsSnapshot,
  parseLandUpcomingHearingsRecord,
} from "../src/lib/land_upcoming_hearings_kv.mjs";
import { hearingsFromZapOutcomeRecord } from "../../tools/lib/land_upcoming_hearings.mjs";
import { kvKey } from "../src/zap_outcomes.mjs";

const FLOOR = committedLandUpcomingHearingsFloor();
const NOW = new Date("2026-08-23T08:00:00.000Z");

function memoryKV(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async put(key, value) {
      values.set(key, value);
    },
  };
}

function outcomeRecord(projectId, hearingDate = "2026-09-15") {
  return {
    project_id: projectId,
    project_name: "Real Project",
    public_status: "In Public Review",
    portal_url: `https://zap.planning.nyc.gov/projects/${projectId}`,
    open_data: { borough: "Queens" },
    hearing_logistics: [{
      schema_version: 1,
      source: "zap-api-dispositions",
      project_id: projectId,
      project_name: "Real Project",
      hearing_date: hearingDate,
      hearing_at: `${hearingDate}T18:30:00.000Z`,
      venue_address: "120-55 Queens Blvd",
      attendance_modes: ["in_person"],
      parse_status: "parsed",
      provenance: {
        field: "dcp-publichearinglocation",
        source: "zap-api-dispositions",
        derived: [],
      },
    }],
    milestones: [{
      id: "milestone-1",
      title: "CPC Public Meeting - Public Hearing",
      source_title: "CPC Public Meeting - Public Hearing",
      time: { basis: "review_meeting", value: "2026-09-20" },
      review_meeting_at: "2026-09-20T14:00:00.000Z",
    }],
  };
}

function sodaListFetch(ids) {
  return async (url) => {
    const href = String(url);
    if (!href.includes("hgx4-8ukb.json")) {
      throw new Error(`unexpected fetch ${href}`);
    }
    return {
      ok: true,
      json: async () => ids.map((project_id) => ({ project_id })),
    };
  };
}

test("committed floor has the shape Land already consumes", () => {
  assert.equal(FLOOR.schema_version, 2);
  assert.ok(Array.isArray(FLOOR.hearings));
  assert.ok(FLOOR.generated_at);
  const parsed = parseLandUpcomingHearingsRecord(JSON.stringify(FLOOR));
  assert.equal(parsed.hearings.length, FLOOR.hearings.length);
});

test("cold, empty, unparseable, and failed KV fall back to the committed snapshot", async () => {
  const none = await loadLandUpcomingHearingsSnapshot({});
  assert.equal(none.source, "committed_floor");
  assert.equal(none.record.schema_version, 2);
  assert.ok(Array.isArray(none.record.hearings));

  const empty = await loadLandUpcomingHearingsSnapshot({ ALERT_STATE: memoryKV() });
  assert.equal(empty.source, "committed_floor");

  const garbage = await loadLandUpcomingHearingsSnapshot({
    ALERT_STATE: memoryKV({ [LAND_UPCOMING_HEARINGS_KV_KEY]: "not-json" }),
  });
  assert.equal(garbage.source, "committed_floor");

  const synthetic = await loadLandUpcomingHearingsSnapshot({
    ALERT_STATE: memoryKV({
      [LAND_UPCOMING_HEARINGS_KV_KEY]: JSON.stringify({
        schema_version: 2,
        generated_at: "2099-01-01T00:00:00.000Z",
        hearings: [{
          project_id: "FIX1",
          project_name: "Fixture Street Rezoning",
          hearing_date: "2026-09-15",
          source: "fixture",
        }],
      }),
    }),
  });
  assert.equal(synthetic.source, "committed_floor");

  const throwing = await loadLandUpcomingHearingsSnapshot({
    ALERT_STATE: { async get() { throw new Error("kv down"); } },
  });
  assert.equal(throwing.source, "committed_floor");
  assert.ok(Array.isArray(throwing.record.hearings));
});

test("GET /land-upcoming-hearings serves KV when present and the floor when not", async () => {
  const live = {
    schema_version: 2,
    generated_at: "2099-01-01T00:00:00.000Z",
    hearings: FLOOR.hearings.slice(0, 1),
  };
  const kvHit = await handleLandUpcomingHearings(
    new Request("https://api.cityscroll.org/land-upcoming-hearings"),
    { ALERT_STATE: memoryKV({ [LAND_UPCOMING_HEARINGS_KV_KEY]: JSON.stringify(live) }) },
  );
  assert.equal(kvHit.status, 200);
  const kvBody = await kvHit.json();
  assert.equal(kvBody.schema_version, 2);
  assert.equal(kvBody.generated_at, "2099-01-01T00:00:00.000Z");
  assert.equal(kvBody.hearings.length, 1);
  assert.equal("stale" in kvBody, true);

  const floorHit = await handleLandUpcomingHearings(
    new Request("https://api.cityscroll.org/land-upcoming-hearings"),
    { ALERT_STATE: memoryKV() },
  );
  assert.equal(floorHit.status, 200);
  const floorBody = await floorHit.json();
  assert.equal(floorBody.schema_version, 2);
  assert.ok(Array.isArray(floorBody.hearings));
  assert.equal(floorBody.hearings.length, FLOOR.hearings.length);

  const noBinding = await handleLandUpcomingHearings(
    new Request("https://api.cityscroll.org/land-upcoming-hearings"),
    {},
  );
  assert.equal(noBinding.status, 200);
  assert.equal((await noBinding.json()).hearings.length, FLOOR.hearings.length);
});

test("refresh derives upcoming hearings from zap-outcome KV plus the SODA id list", async () => {
  const id = "2024Q0292";
  const kv = memoryKV({ [kvKey(id)]: JSON.stringify(outcomeRecord(id)) });
  const result = await refreshLandUpcomingHearings(
    { ALERT_STATE: kv },
    { fetchImpl: sodaListFetch([id]), now: NOW, fillMissingMax: 0 },
  );
  assert.equal(result.status, "success");
  assert.ok(result.upcoming_count >= 1);
  const stored = parseLandUpcomingHearingsRecord(kv.values.get(LAND_UPCOMING_HEARINGS_KV_KEY));
  assert.ok(stored);
  assert.equal(stored.schema_version, 2);
  assert.equal(stored.materialization.mode, "kv_zap_outcomes");
  assert.ok(stored.hearings.every((row) => row.project_id === id));
  assert.ok(stored.hearings.some((row) => row.source === "zap-api-dispositions"));
});

test("cold zap-outcome KV skips the write so GET keeps the committed floor", async () => {
  const kv = memoryKV();
  const result = await refreshLandUpcomingHearings(
    { ALERT_STATE: kv },
    { fetchImpl: sodaListFetch(["2024Q0292"]), now: NOW, fillMissingMax: 0 },
  );
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "insufficient-outcomes");
  assert.equal(kv.values.has(LAND_UPCOMING_HEARINGS_KV_KEY), false);
});

test("hearingsFromZapOutcomeRecord keeps stamped logistics and accepted milestones", () => {
  const extracted = hearingsFromZapOutcomeRecord(outcomeRecord("2024Q0292"));
  assert.ok(extracted.hearings.some((row) => row.source === "zap-api-dispositions"));
  assert.ok(extracted.hearings.some((row) => row.event_class === "cpc_public_hearing"));
});

test("scheduled land refresh is a public SODA list plus KV, not a secret-bearing path", () => {
  const worker = readFileSync(new URL("../src/worker.mjs", import.meta.url), "utf8");
  const impl = readFileSync(new URL("../src/land_upcoming_hearings.mjs", import.meta.url), "utf8");
  assert.match(worker, /event\.cron === "0 8 \* \* \*"/);
  assert.match(worker, /refreshLandUpcomingHearings\(env\)/);
  assert.match(impl, /listPrewarmProjectIds/);
  assert.match(impl, /hearingsFromZapOutcomeRecord/);
  assert.doesNotMatch(impl, /process\.env|SECRET|API_KEY|LEGISTAR|token=/i);
});
