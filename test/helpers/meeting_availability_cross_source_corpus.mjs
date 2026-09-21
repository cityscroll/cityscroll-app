import assert from "node:assert/strict";
import fixture from "../fixtures/meeting_availability_cross_source_parity.json" with { type: "json" };

import { collapseMeetingDeliveryRows } from "../../site/meeting_delivery_identity.mjs";
import { validateMeetingAvailability } from "../../site/meeting_availability_filter.mjs";
import { HEARINGS_KV_KEY } from "../../worker/src/hearings.mjs";
import { MEETING_MANIFEST_KEY } from "../../worker/src/lib/route_read_model_kv.mjs";

export const CROSS_SOURCE_PARITY_FIXTURE = fixture;
export const TODAY = fixture.today;
export const AVAILABILITY = fixture.availability;
export const CANONICAL_AVAILABILITY = validateMeetingAvailability(AVAILABILITY).canonical;

const CORPUS_SLICE_KEY = "route-read-model:meetings:cross-source-parity:2026-10";

function sourceIdentity(row) {
  if (row.source === "public_body_calendar") {
    return `meeting:${row.source}:${row.contract}:${row.id}`;
  }
  return `meeting:${row.source}:${row.id}`;
}

function rowForCase(spec) {
  const meetingId = sourceIdentity(spec);
  const startsAt = spec.time ? `${spec.date}T${spec.time}:00` : null;
  const schedule = spec.schedule === "date_only"
    ? {
      status: "date_only", precision: "date_only", raw_date: spec.date, raw_time: null,
      timezone: "America/New_York", basis: "publisher_field",
    }
    : spec.schedule === "conflicted"
      ? {
        status: "conflicted", precision: "exact_time", raw_date: spec.date,
        raw_time: `${spec.time} / 18:30`, timezone: "America/New_York", basis: "publisher_event",
      }
      : spec.schedule === "invalid"
        ? {
          status: "invalid", precision: null, raw_date: spec.date, raw_time: spec.time,
          timezone: "America/New_York", basis: "publisher_field",
        }
        : {
          status: "resolved", precision: "exact_time", starts_at: startsAt,
          raw_date: spec.date, raw_time: spec.time, timezone: "America/New_York",
          basis: "publisher_field",
        };
  return {
    object_type: "meeting",
    meeting_id: meetingId,
    delivery_key: spec.delivery_key ? `meeting:${spec.source}:${spec.delivery_key}` : meetingId,
    source_system: spec.source,
    source_contract_id: spec.contract || null,
    board_id: spec.board_id || null,
    title: `${spec.source} ${spec.id}`,
    event_date: spec.schedule === "date_only" ? spec.date : startsAt,
    schedule,
    status: spec.lifecycle === "canceled" ? "canceled" : undefined,
    lifecycle: spec.lifecycle || "scheduled",
    sequence: spec.sequence ?? null,
    source_url: `https://official.example/${encodeURIComponent(spec.id)}`,
    source_receipt: {
      schema: "cityscroll.meeting_source_receipt.v1",
      source_url: `https://official.example/${encodeURIComponent(spec.id)}`,
      observed_at: "2026-10-01T12:00:00Z",
      status: spec.source_health || "ok",
      fetch_status: spec.source_health === "failed" ? "failed" : "snapshot",
    },
  };
}

export const CORPUS_ROWS = Object.freeze(fixture.cases.map(rowForCase));
export const PROJECTED_ROWS = Object.freeze(fixture.cases
  .filter((spec) => !["stale", "failed", "near_duplicate"].includes(spec.reason))
  .map(rowForCase));

export const EXPECTED_IDENTITIES = Object.freeze(fixture.expected.accepted_identities.slice().sort());
export const EXPECTED_EXCLUSION_COUNTS = Object.freeze({ ...fixture.expected.exclusion_counts });

function sourceCoverage() {
  return Object.fromEntries(Object.entries(fixture.source_coverage).map(([source, value]) => [source, {
    ...value,
    ...(source === "public_body_calendar" ? { contract_coverage: value.contracts } : {}),
  }]));
}

export function crossSourceModel() {
  const rows = collapseMeetingDeliveryRows(PROJECTED_ROWS);
  return {
    schema: "cityscroll.shared_meeting_read_model.v1",
    version: 1,
    generated_at: "2026-10-01T12:00:00Z",
    freshness: {
      generated_at: "2026-10-01T12:00:00Z",
      checked_at: "2026-10-01T12:00:00Z",
      sources: Object.fromEntries(Object.entries(fixture.source_coverage).map(([source, value]) => [source, value.status])),
    },
    sources: sourceCoverage(),
    rows,
    hearings: rows,
  };
}

export function crossSourceEnv() {
  const values = new Map([
    [HEARINGS_KV_KEY, JSON.stringify(crossSourceModel())],
    [MEETING_MANIFEST_KEY, JSON.stringify({
      schema_version: 1,
      kind: "meetings",
      version: "cross-source-parity-1",
      slices: { "2026-10": CORPUS_SLICE_KEY },
    })],
    [CORPUS_SLICE_KEY, JSON.stringify({ rows: PROJECTED_ROWS })],
  ]);
  const kv = { get: async (key) => values.get(key) ?? null, put: async () => {} };
  return { ALERT_STATE: kv, SUBS: { get: async () => "0", put: async () => {} } };
}

export function fixtureIdentity(spec) {
  return sourceIdentity(spec);
}

export function expectedExcludedIdentities() {
  return [...new Set(fixture.cases
    .filter((spec) => spec.expected !== "accepted")
    .map(fixtureIdentity))].sort();
}

export function assertCorpusShape() {
  assert.deepEqual([...new Set(fixture.cases.map((spec) => spec.anchor).filter(Boolean))].sort(), [
    "borough_board", "boundary_minute", "bsa", "canceled", "cb11", "ccrb", "h_plus_h",
    "pdc", "pep", "rescheduled", "weekend",
  ]);
  assert.ok(fixture.cases.some((spec) => spec.anchor === "boundary_minute"));
  assert.ok(fixture.cases.some((spec) => spec.anchor === "weekend"));
  assert.ok(fixture.cases.some((spec) => spec.reason === "date_only" || spec.schedule === "date_only"));
  assert.ok(fixture.cases.some((spec) => spec.schedule === "conflicted"));
  assert.ok(fixture.cases.some((spec) => spec.reason === "stale"));
  assert.ok(fixture.cases.some((spec) => spec.reason === "failed"));
  assert.ok(fixture.cases.some((spec) => spec.reason === "near_duplicate"));
  assert.ok(fixture.cases.some((spec) => spec.lifecycle === "canceled"));
}
